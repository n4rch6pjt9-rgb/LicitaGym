-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260929145232_l3_permissoes_fornecedores_pdm.
-- Só SELECT em catálogo / funções has_*_privilege: não grava nada, não chama norm_txt.
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/l3_permissoes_fornecedores_pdm_acl_check.sql
-- Resultado esperado: a consulta 1 devolve todas as linhas com ok = true e total_falhas = 0 (falhas aparecem
-- primeiro); a consulta 2 só lista catmat_pdm_palavras / authenticated / SELECT; a consulta 3 não lista idx_licres_cnpj.
--
-- Valores esperados (coluna "esperado"):
--   fornecedores, econodata_consultas, licitacao_itens, licitacao_resultados
--     anon / authenticated / PUBLIC: nenhum privilégio (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER = false)
--     service_role: SELECT, INSERT, UPDATE, DELETE = true
--     RLS ligado (relrowsecurity = true); nenhuma policy para anon/authenticated/public
--   catmat_pdm_palavras
--     anon / PUBLIC: nenhum privilégio
--     authenticated: SELECT = true; INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER = false
--     service_role: SELECT, INSERT, UPDATE, DELETE = true
--     RLS ligado; policy catmat_pdm_palavras_select existe (SELECT, {authenticated}, using true)
--   views fornecedores_homologados, orgaos_compradores, homologacoes_itens (inalteradas)
--     anon / authenticated / PUBLIC: sem SELECT; service_role: SELECT = true; security_invoker=true
--   norm_txt(text): EXECUTE PUBLIC/anon/authenticated = false; service_role e postgres = true
--   sequences de identidade (econodata_consultas, catmat_pdm_palavras, licitacao_itens, licitacao_resultados):
--     USAGE/SELECT/UPDATE para anon/authenticated/PUBLIC = false
--   índices de licitacao_resultados em (fornecedor_cnpj): idx_licres_cnpj ausente;
--     licitacao_resultados_fornecedor_cnpj_idx presente (btree (fornecedor_cnpj))

-- 1) Checagens individuais ----------------------------------------------------------------------------------
with
privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fechadas(obj) as (values
  ('public.fornecedores'), ('public.econodata_consultas'),
  ('public.licitacao_itens'), ('public.licitacao_resultados')),
views_l0(obj) as (values
  ('public.fornecedores_homologados'), ('public.orgaos_compradores'), ('public.homologacoes_itens')),
seqs(obj) as (
  select pg_get_serial_sequence(t, 'id')
    from unnest(array['public.econodata_consultas', 'public.catmat_pdm_palavras',
                      'public.licitacao_itens', 'public.licitacao_resultados']) as t),
checks(grupo, objeto, papel, privilegio, esperado, atual) as (
  -- tabelas fechadas: nenhum privilégio para anon/authenticated/PUBLIC
  select 'tabela', f.obj, r.papel, p.p, false, has_table_privilege(r.papel, f.obj, p.p)
    from fechadas f cross join privs p
    cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
  union all
  -- tabelas fechadas + catmat_pdm_palavras: service_role lê e grava
  select 'tabela', o.obj, 'service_role', p.p, true, has_table_privilege('service_role', o.obj, p.p)
    from (select obj from fechadas union all select 'public.catmat_pdm_palavras') o
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
  union all
  -- catmat_pdm_palavras: anon/PUBLIC nada; authenticated só SELECT
  select 'tabela', 'public.catmat_pdm_palavras', r.papel, p.p,
         (r.papel = 'authenticated' and p.p = 'SELECT'),
         has_table_privilege(r.papel, 'public.catmat_pdm_palavras', p.p)
    from privs p cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
  union all
  -- views do L0 (inalteradas): só service_role
  select 'view', v.obj, r.papel, 'SELECT', (r.papel = 'service_role'), has_table_privilege(r.papel, v.obj, 'SELECT')
    from views_l0 v cross join (values ('anon'), ('authenticated'), ('public'), ('service_role')) r(papel)
  union all
  select 'view', c.oid::regclass::text, '-', 'security_invoker=true', true,
         coalesce('security_invoker=true' = any (c.reloptions), false)
    from pg_class c
   where c.oid in ('public.fornecedores_homologados'::regclass, 'public.orgaos_compradores'::regclass,
                   'public.homologacoes_itens'::regclass)
  union all
  -- RLS ligado
  select 'rls', c.oid::regclass::text, '-', 'relrowsecurity', true, c.relrowsecurity
    from pg_class c
   where c.oid in ('public.fornecedores'::regclass, 'public.econodata_consultas'::regclass,
                   'public.licitacao_itens'::regclass, 'public.licitacao_resultados'::regclass,
                   'public.catmat_pdm_palavras'::regclass)
  union all
  -- policies: nenhuma nas tabelas fechadas para anon/authenticated/public
  select 'policy', f.obj, '-', 'sem policy para anon/authenticated/public', true,
         not exists (select 1 from pg_policies pp
                      where pp.schemaname || '.' || pp.tablename = f.obj
                        and pp.roles && array['anon', 'authenticated', 'public']::name[])
    from fechadas f
  union all
  select 'policy', 'public.catmat_pdm_palavras', 'authenticated', 'catmat_pdm_palavras_select (SELECT, using true)', true,
         exists (select 1 from pg_policies pp
                  where pp.schemaname = 'public' and pp.tablename = 'catmat_pdm_palavras'
                    and pp.policyname = 'catmat_pdm_palavras_select' and pp.cmd = 'SELECT'
                    and pp.roles = array['authenticated']::name[] and pp.qual = 'true')
  union all
  -- norm_txt(text)
  select 'funcao', 'public.norm_txt(text)', r.papel, 'EXECUTE', r.papel in ('service_role', 'postgres'),
         has_function_privilege(r.papel, 'public.norm_txt(text)', 'EXECUTE')
    from (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('postgres')) r(papel)
  union all
  -- sequences de identidade
  select 'sequence', s.obj, r.papel, p.p, false, has_sequence_privilege(r.papel, s.obj, p.p)
    from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p)
    cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
   where s.obj is not null
  union all
  -- índices em licitacao_resultados(fornecedor_cnpj)
  select 'indice', 'public.idx_licres_cnpj', '-', 'ausente', true, to_regclass('public.idx_licres_cnpj') is null
  union all
  select 'indice', 'public.licitacao_resultados_fornecedor_cnpj_idx', '-', 'btree (fornecedor_cnpj)', true,
         exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'licitacao_resultados'
                    and indexname = 'licitacao_resultados_fornecedor_cnpj_idx'
                    and indexdef like '%USING btree (fornecedor_cnpj)')
)
select grupo, objeto, papel, privilegio, esperado, atual, (esperado = atual) as ok,
       count(*) filter (where esperado <> atual) over () as total_falhas
  from checks
 order by (esperado = atual), grupo, objeto, papel, privilegio;

-- 2) Conferência independente pela visão do information_schema: linhas de grant para anon/authenticated/PUBLIC.
-- Esperado: só catmat_pdm_palavras / authenticated / SELECT.
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privilegios
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name in ('fornecedores', 'econodata_consultas', 'licitacao_itens', 'licitacao_resultados',
                      'catmat_pdm_palavras', 'fornecedores_homologados', 'orgaos_compradores', 'homologacoes_itens')
   and grantee in ('anon', 'authenticated', 'PUBLIC')
 group by 1, 2
 order by 1, 2;

-- 3) Índices de licitacao_resultados (esperado: sem idx_licres_cnpj; com licitacao_resultados_fornecedor_cnpj_idx)
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename = 'licitacao_resultados'
 order by indexname;

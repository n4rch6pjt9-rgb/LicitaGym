-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260929145232_l3_permissoes_fornecedores_pdm.
-- Só SELECT em catálogo / funções has_*_privilege: não grava nada, não chama norm_txt. O único estado tocado é um
-- parâmetro de sessão (set_config 'l3_acl_check.*', não transacional, some ao fechar a conexão), usado para levar o
-- resultado da consulta 1 até o bloco final sem repetir a lista de checagens.
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/l3_permissoes_fornecedores_pdm_acl_check.sql
-- Também roda inteiro no SQL Editor do Supabase (mesma sessão para todos os comandos).
-- Resultado esperado: a consulta 1 devolve 193 linhas, todas com ok = true e total_falhas = 0 (falhas aparecem
-- primeiro); a consulta 2 só lista catmat_pdm_palavras / authenticated / SELECT; a consulta 3 não lista idx_licres_cnpj.
-- O bloco final (4) levanta EXCEPTION se houver qualquer falha ou se o total de checagens não for 193: com
-- ON_ERROR_STOP=1 o psql sai com código diferente de zero, depois de já ter impresso as consultas 1 a 3.
-- Objeto ausente (tabela, view, função ou sequence de identidade) NÃO é pulado: as checagens dele saem com
-- atual = NULL e ok = false (a sequence ausente aparece como "<tabela>.id: sequence ausente").
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
--     têm de existir; USAGE/SELECT/UPDATE para anon/authenticated/PUBLIC = false
--   índices de licitacao_resultados em (fornecedor_cnpj): idx_licres_cnpj ausente;
--     licitacao_resultados_fornecedor_cnpj_idx presente (btree (fornecedor_cnpj))

-- 0) Zera o resultado de uma execução anterior na mesma sessão (o bloco 4 falha se a consulta 1 não rodar).
select set_config('l3_acl_check.total', '', false) as reset_total,
       set_config('l3_acl_check.falhas', '', false) as reset_falhas;

-- 1) Checagens individuais ----------------------------------------------------------------------------------
-- to_regclass/to_regprocedure devolvem NULL para objeto ausente; nesse caso a checagem sai com atual = NULL
-- (ok = false) em vez de abortar ou de sumir do resultado.
with
privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
fechadas(obj) as (values
  ('public.fornecedores'), ('public.econodata_consultas'),
  ('public.licitacao_itens'), ('public.licitacao_resultados')),
views_l0(obj) as (values
  ('public.fornecedores_homologados'), ('public.orgaos_compradores'), ('public.homologacoes_itens')),
rls_tabs(obj) as (
  select obj from fechadas union all select 'public.catmat_pdm_palavras'),
seqs(tab, obj) as (
  select t, case when to_regclass(t) is not null
                  and exists (select 1 from pg_attribute a
                               where a.attrelid = to_regclass(t) and a.attname = 'id' and not a.attisdropped)
                 then pg_get_serial_sequence(t, 'id') end
    from unnest(array['public.econodata_consultas', 'public.catmat_pdm_palavras',
                      'public.licitacao_itens', 'public.licitacao_resultados']) as t),
checks(grupo, objeto, papel, privilegio, esperado, atual) as (
  -- tabelas fechadas: nenhum privilégio para anon/authenticated/PUBLIC
  select 'tabela', f.obj, r.papel, p.p, false,
         case when to_regclass(f.obj) is not null then has_table_privilege(r.papel, f.obj, p.p) end
    from fechadas f cross join privs p
    cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
  union all
  -- tabelas fechadas + catmat_pdm_palavras: service_role lê e grava
  select 'tabela', o.obj, 'service_role', p.p, true,
         case when to_regclass(o.obj) is not null then has_table_privilege('service_role', o.obj, p.p) end
    from rls_tabs o
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
  union all
  -- catmat_pdm_palavras: anon/PUBLIC nada; authenticated só SELECT
  select 'tabela', 'public.catmat_pdm_palavras', r.papel, p.p,
         (r.papel = 'authenticated' and p.p = 'SELECT'),
         case when to_regclass('public.catmat_pdm_palavras') is not null
              then has_table_privilege(r.papel, 'public.catmat_pdm_palavras', p.p) end
    from privs p cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
  union all
  -- views do L0 (inalteradas): só service_role
  select 'view', v.obj, r.papel, 'SELECT', (r.papel = 'service_role'),
         case when to_regclass(v.obj) is not null then has_table_privilege(r.papel, v.obj, 'SELECT') end
    from views_l0 v cross join (values ('anon'), ('authenticated'), ('public'), ('service_role')) r(papel)
  union all
  select 'view', v.obj, '-', 'security_invoker=true', true,
         case when c.oid is not null then coalesce('security_invoker=true' = any (c.reloptions), false) end
    from views_l0 v
    left join pg_class c on c.oid = to_regclass(v.obj)
  union all
  -- RLS ligado
  select 'rls', t.obj, '-', 'relrowsecurity', true, c.relrowsecurity
    from rls_tabs t
    left join pg_class c on c.oid = to_regclass(t.obj)
  union all
  -- policies: nenhuma nas tabelas fechadas para anon/authenticated/public
  select 'policy', f.obj, '-', 'sem policy para anon/authenticated/public', true,
         case when to_regclass(f.obj) is not null then
           not exists (select 1 from pg_policies pp
                        where pp.schemaname || '.' || pp.tablename = f.obj
                          and pp.roles && array['anon', 'authenticated', 'public']::name[]) end
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
         case when to_regprocedure('public.norm_txt(text)') is not null
              then has_function_privilege(r.papel, 'public.norm_txt(text)', 'EXECUTE') end
    from (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('postgres')) r(papel)
  union all
  -- sequences de identidade: sequence ausente não é pulada, as 9 checagens da tabela falham (atual = NULL)
  select 'sequence', coalesce(s.obj, s.tab || '.id: sequence ausente'), r.papel, p.p, false,
         case when s.obj is not null then has_sequence_privilege(r.papel, s.obj, p.p) end
    from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p)
    cross join (values ('anon'), ('authenticated'), ('public')) r(papel)
  union all
  -- índices em licitacao_resultados(fornecedor_cnpj)
  select 'indice', 'public.idx_licres_cnpj', '-', 'ausente', true, to_regclass('public.idx_licres_cnpj') is null
  union all
  select 'indice', 'public.licitacao_resultados_fornecedor_cnpj_idx', '-', 'btree (fornecedor_cnpj)', true,
         exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'licitacao_resultados'
                    and indexname = 'licitacao_resultados_fornecedor_cnpj_idx'
                    and indexdef like '%USING btree (fornecedor_cnpj)')
),
resultado as (
  select c.*, coalesce(c.esperado = c.atual, false) as ok from checks c
)
select grupo, objeto, papel, privilegio, esperado, atual, ok,
       count(*) filter (where not ok) over () as total_falhas,
       count(*) over () as total_checagens,
       -- guarda os totais na sessão para o bloco 4 (sem gravar nada no banco)
       set_config('l3_acl_check.falhas', (count(*) filter (where not ok) over ())::text, false) is not null
         and set_config('l3_acl_check.total', (count(*) over ())::text, false) is not null as totais_registrados
  from resultado
 order by ok, grupo, objeto, papel, privilegio;

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

-- 4) Resultado final: erro se houver falha (psql -v ON_ERROR_STOP=1 sai com código != 0) -------------------
do $$
declare
  v_total int := nullif(current_setting('l3_acl_check.total', true), '')::int;
  v_falhas int := nullif(current_setting('l3_acl_check.falhas', true), '')::int;
begin
  if v_total is null or v_falhas is null then
    raise exception 'L3 ACL CHECK: consulta 1 não rodou nesta sessão (totais ausentes)';
  end if;
  if v_total <> 193 then
    raise exception 'L3 ACL CHECK FALHOU: % checagens em vez de 193 (lista de checagens mudou ou perdeu linhas)', v_total;
  end if;
  if v_falhas > 0 then
    raise exception 'L3 ACL CHECK FALHOU: % de % checagens divergentes (% ok); ver linhas com ok = false na consulta 1',
      v_falhas, v_total, v_total - v_falhas;
  end if;
  raise notice 'L3 ACL CHECK OK: %/% checagens', v_total - v_falhas, v_total;
end $$;

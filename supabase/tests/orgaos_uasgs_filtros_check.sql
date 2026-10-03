-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260930130100_orgaos_uasgs_filtros.
-- Só SELECT em catálogo, funções has_*_privilege, leitura dos dicionários e chamadas das funções PURAS
-- (imutáveis/estáveis, sem escrita) sobre literais sintéticos. Não chama fn_orgaos_uasgs_classificar() nem
-- fn_escopo_match_atualizar(), não faz REFRESH, não cria tabela temporária.
-- Executar após aplicar a migration (a 1a também precisa estar aplicada), ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/orgaos_uasgs_filtros_check.sql
-- Resultado esperado: NOTICE "orgaos_uasgs_filtros_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION (exit code <> 0
-- com ON_ERROR_STOP=1).
--
-- O que confere:
--   dicionários:   4 tabelas, colunas/tipos, PK/UNIQUE/FK/CHECK, RLS ligado, nenhuma policy, seeds
--                  (53 tipos em 15 grupos, 9 de Segurança e Defesa; 116 regras = 108 órgão + 8 UASG;
--                  5 overrides; 232 termos) e impressão digital md5 do conteúdo (muda se alguém editar fora
--                  de migration; atualizar aqui quando uma migration nova mudar os seeds).
--   colunas:       19 novas em orgaos e 15 em uasgs, tipos e geradas; 19 constraints nomeadas (CHECK e FK).
--   índices:       14 de filtro/join + UNIQUE da MV.
--   MV/views:      mv_escopo_demanda (materializada); 3 views security_invoker; v_orgao_titular_cnpj sem raw.
--   grants:        anon/authenticated/PUBLIC sem nada (tabelas, MV, views, sequences, funções); service_role só
--                  SELECT em dicionários/MV/views, sem privilégio nas sequences, EXECUTE só nas 9 funções puras.
--   funções:       11 com search_path fixo, nenhuma SECURITY DEFINER.
--   comportamento: normalização, classificação, match e expressões geradas sobre literais sintéticos.

do $$
declare
  v_chk   record;
  n       int := 0;
  f       int := 0;
  v_expr  text;
  v_out   text;
  v_am    record;
  v_rx    text;
  v_ruins int;
begin
  for v_chk in
    with
    dic(obj) as (values ('public.orgao_tipos'), ('public.orgao_tipo_regras'), ('public.orgao_tipo_override'),
                        ('public.escopo_termos')),
    leitura(obj) as (select obj from dic union all values ('public.mv_escopo_demanda'), ('public.v_orgao_titular_cnpj'),
                     ('public.v_orgao_match_projeto'), ('public.v_licitacoes_filtro')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema: conferido à parte.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    papeis_fechados(papel) as (values ('anon'), ('authenticated'), ('public')),
    seqs(tab) as (values ('public.orgao_tipo_regras'), ('public.orgao_tipo_override'), ('public.escopo_termos')),
    funcs(sig, pura) as (values
      ('public.fn_txt_ascii(text)', true), ('public.fn_norm_item(text)', true), ('public.fn_norm_nome(text)', true),
      ('public.fn_escopo_item(text)', true), ('public.fn_escopo_pca(text)', true),
      ('public.fn_classifica_orgao(text,text,text,integer,integer,integer)', true),
      ('public.fn_classifica_uasg(text,text)', true), ('public.fn_esfera_canon(text,text,text,text,text)', true),
      ('public.fn_poder_canon(text,text)', true),
      ('public.fn_orgaos_uasgs_classificar()', false), ('public.fn_escopo_match_atualizar()', false)),
    esperadas(tabela, coluna, tipo, nao_nulo, gerada) as (values
      ('orgao_tipos', 'tipo_orgao', 'text', true, false),
      ('orgao_tipos', 'grupo_tipo', 'text', true, false),
      ('orgao_tipos', 'rotulo', 'text', true, false),
      ('orgao_tipos', 'grupo_rotulo', 'text', true, false),
      ('orgao_tipos', 'ordem_grupo', 'smallint', true, false),
      ('orgao_tipos', 'ordem', 'smallint', true, false),
      ('orgao_tipos', 'seguranca_defesa', 'boolean', false, true),
      ('orgao_tipo_regras', 'id', 'bigint', true, false),
      ('orgao_tipo_regras', 'prioridade', 'integer', true, false),
      ('orgao_tipo_regras', 'nivel', 'text', true, false),
      ('orgao_tipo_regras', 'tipo_orgao', 'text', true, false),
      ('orgao_tipo_regras', 'nome_regex', 'text', false, false),
      ('orgao_tipo_regras', 'nome_regex_exclui', 'text', false, false),
      ('orgao_tipo_regras', 'codigos_orgao', 'integer[]', false, false),
      ('orgao_tipo_regras', 'codigos_orgao_vinculado', 'integer[]', false, false),
      ('orgao_tipo_regras', 'tipos_administracao', 'integer[]', false, false),
      ('orgao_tipo_regras', 'aceita_tipo_adm_nulo', 'boolean', true, false),
      ('orgao_tipo_regras', 'naturezas', 'text[]', false, false),
      ('orgao_tipo_regras', 'natureza_regex', 'text', false, false),
      ('orgao_tipo_regras', 'esferas', 'text[]', false, false),
      ('orgao_tipo_regras', 'grupos_orgao_pai', 'text[]', false, false),
      ('orgao_tipo_regras', 'aceita_grupo_pai_nulo', 'boolean', true, false),
      ('orgao_tipo_regras', 'ativo', 'boolean', true, false),
      ('orgao_tipo_override', 'nivel', 'text', true, false),
      ('orgao_tipo_override', 'chave', 'text', true, false),
      ('orgao_tipo_override', 'tipo_orgao', 'text', true, false),
      ('orgao_tipo_override', 'motivo', 'text', true, false),
      ('escopo_termos', 'prioridade', 'integer', true, false),
      ('escopo_termos', 'nivel', 'text', true, false),
      ('escopo_termos', 'familia', 'text', false, false),
      ('escopo_termos', 'padrao', 'text', true, false),
      ('escopo_termos', 'janela_caracteres', 'integer', false, false),
      ('escopo_termos', 'ativo', 'boolean', true, false),
      ('orgaos', 'natureza_juridica', 'text', false, false),
      ('orgaos', 'pncp_esfera', 'text', false, false),
      ('orgaos', 'pncp_poder', 'text', false, false),
      ('orgaos', 'pncp_orgao_lido_em', 'timestamp with time zone', false, false),
      ('orgaos', 'tipo_orgao', 'text', false, false),
      ('orgaos', 'grupo_tipo', 'text', false, false),
      ('orgaos', 'tipo_orgao_origem', 'text', false, false),
      ('orgaos', 'tipo_orgao_regra_id', 'bigint', false, false),
      ('orgaos', 'esfera_canon', 'text', false, false),
      ('orgaos', 'poder_canon', 'text', false, false),
      ('orgaos', 'uf', 'text', false, false),
      ('orgaos', 'municipio_ibge', 'text', false, false),
      ('orgaos', 'localizacao_origem', 'text', false, false),
      ('orgaos', 'seguranca_defesa', 'boolean', false, true),
      ('orgaos', 'seguranca_defesa_uasgs', 'integer', true, false),
      ('orgaos', 'match_nivel', 'text', false, false),
      ('orgaos', 'match_projeto', 'boolean', false, true),
      ('orgaos', 'match_atualizado_em', 'timestamp with time zone', false, false),
      ('orgaos', 'classificado_em', 'timestamp with time zone', false, false),
      ('uasgs', 'tipo_orgao', 'text', false, false),
      ('uasgs', 'grupo_tipo', 'text', false, false),
      ('uasgs', 'tipo_orgao_origem', 'text', false, false),
      ('uasgs', 'tipo_orgao_regra_id', 'bigint', false, false),
      ('uasgs', 'esfera_canon', 'text', false, false),
      ('uasgs', 'poder_canon', 'text', false, false),
      ('uasgs', 'municipio_ibge', 'text', false, true),
      ('uasgs', 'cnpj_cpf_orgao_vinculado_norm', 'text', false, true),
      ('uasgs', 'pncp_municipio_ibge', 'text', false, false),
      ('uasgs', 'pncp_conferido_em', 'timestamp with time zone', false, false),
      ('uasgs', 'seguranca_defesa', 'boolean', false, true),
      ('uasgs', 'match_nivel', 'text', false, false),
      ('uasgs', 'match_projeto', 'boolean', false, true),
      ('uasgs', 'match_atualizado_em', 'timestamp with time zone', false, false),
      ('uasgs', 'classificado_em', 'timestamp with time zone', false, false)),
    cols as (
      select e.*, a.attname is not null as existe,
             format_type(a.atttypid, a.atttypmod) as tipo_atual, a.attnotnull, a.attgenerated::text as gen
        from esperadas e
        left join pg_attribute a
          on a.attrelid = to_regclass('public.' || e.tabela) and a.attname = e.coluna
         and a.attnum > 0 and not a.attisdropped),
    cons_esperadas(tabela, nome, tipo, def) as (values
      ('orgao_tipos', 'orgao_tipos_pkey', 'p', 'PRIMARY KEY (tipo_orgao)'),
      ('orgao_tipos', 'orgao_tipos_tipo_grupo_key', 'u', 'UNIQUE (tipo_orgao, grupo_tipo)'),
      ('orgao_tipo_regras', 'orgao_tipo_regras_pkey', 'p', 'PRIMARY KEY (id)'),
      ('orgao_tipo_regras', 'orgao_tipo_regras_prioridade_key', 'u', 'UNIQUE (nivel, prioridade)'),
      ('orgao_tipo_regras', 'orgao_tipo_regras_tipo_orgao_fkey', 'f', 'FOREIGN KEY (tipo_orgao) REFERENCES orgao_tipos(tipo_orgao)'),
      ('orgao_tipo_regras', 'orgao_tipo_regras_nivel_check', 'c', null),
      ('orgao_tipo_regras', 'orgao_tipo_regras_tem_condicao', 'c', null),
      ('orgao_tipo_override', 'orgao_tipo_override_pkey', 'p', 'PRIMARY KEY (id)'),
      ('orgao_tipo_override', 'orgao_tipo_override_key', 'u', 'UNIQUE (nivel, chave)'),
      ('orgao_tipo_override', 'orgao_tipo_override_tipo_orgao_fkey', 'f', 'FOREIGN KEY (tipo_orgao) REFERENCES orgao_tipos(tipo_orgao)'),
      ('orgao_tipo_override', 'orgao_tipo_override_nivel_check', 'c', null),
      ('escopo_termos', 'escopo_termos_pkey', 'p', 'PRIMARY KEY (id)'),
      ('escopo_termos', 'escopo_termos_prioridade_key', 'u', 'UNIQUE (prioridade)'),
      ('escopo_termos', 'escopo_termos_nivel_check', 'c', null),
      ('escopo_termos', 'escopo_termos_familia_check', 'c', null),
      ('escopo_termos', 'escopo_termos_familia_ck', 'c', null),
      ('orgaos', 'orgaos_natureza_juridica_check', 'c', null),
      ('orgaos', 'orgaos_pncp_esfera_check', 'c', null),
      ('orgaos', 'orgaos_pncp_poder_check', 'c', null),
      ('orgaos', 'orgaos_tipo_orgao_origem_check', 'c', null),
      ('orgaos', 'orgaos_esfera_canon_check', 'c', null),
      ('orgaos', 'orgaos_poder_canon_check', 'c', null),
      ('orgaos', 'orgaos_uf_check', 'c', null),
      ('orgaos', 'orgaos_municipio_ibge_check', 'c', null),
      ('orgaos', 'orgaos_localizacao_origem_check', 'c', null),
      ('orgaos', 'orgaos_match_nivel_check', 'c', null),
      ('orgaos', 'orgaos_tipo_orgao_regra_id_fkey', 'f', 'FOREIGN KEY (tipo_orgao_regra_id) REFERENCES orgao_tipo_regras(id) ON DELETE SET NULL'),
      ('orgaos', 'orgaos_tipo_grupo_fk', 'f', 'FOREIGN KEY (tipo_orgao, grupo_tipo) REFERENCES orgao_tipos(tipo_orgao, grupo_tipo)'),
      ('uasgs', 'uasgs_tipo_orgao_origem_check', 'c', null),
      ('uasgs', 'uasgs_esfera_canon_check', 'c', null),
      ('uasgs', 'uasgs_poder_canon_check', 'c', null),
      ('uasgs', 'uasgs_pncp_municipio_ibge_check', 'c', null),
      ('uasgs', 'uasgs_match_nivel_check', 'c', null),
      ('uasgs', 'uasgs_tipo_orgao_regra_id_fkey', 'f', 'FOREIGN KEY (tipo_orgao_regra_id) REFERENCES orgao_tipo_regras(id) ON DELETE SET NULL'),
      ('uasgs', 'uasgs_tipo_grupo_fk', 'f', 'FOREIGN KEY (tipo_orgao, grupo_tipo) REFERENCES orgao_tipos(tipo_orgao, grupo_tipo)')),
    idx_esperados(tabela, nome, sufixo) as (values
      ('orgaos', 'orgaos_grupo_tipo_idx',       'USING btree (grupo_tipo, tipo_orgao)'),
      ('orgaos', 'orgaos_esfera_poder_idx',     'USING btree (esfera_canon, poder_canon)'),
      ('orgaos', 'orgaos_uf_municipio_idx',     'USING btree (uf, municipio_ibge)'),
      ('orgaos', 'orgaos_seg_defesa_idx',       'USING btree (id) WHERE (seguranca_defesa OR (seguranca_defesa_uasgs > 0))'),
      ('orgaos', 'orgaos_match_idx',            'USING btree (match_nivel) WHERE (match_nivel IS NOT NULL)'),
      ('uasgs', 'uasgs_grupo_tipo_idx',         'USING btree (grupo_tipo, tipo_orgao)'),
      ('uasgs', 'uasgs_esfera_poder_idx',       'USING btree (esfera_canon, poder_canon)'),
      ('uasgs', 'uasgs_uf_municipio_ibge_idx',  'USING btree (sigla_uf, municipio_ibge)'),
      ('uasgs', 'uasgs_seg_defesa_idx',         'USING btree (codigo_uasg) WHERE seguranca_defesa'),
      ('uasgs', 'uasgs_match_idx',              'USING btree (match_nivel) WHERE (match_nivel IS NOT NULL)'),
      ('uasgs', 'uasgs_cnpj_codigo_idx',        'USING btree (cnpj_cpf_orgao_norm, codigo_uasg)'),
      ('uasgs', 'uasgs_cnpj_vinc_codigo_idx',   'USING btree (cnpj_cpf_orgao_vinculado_norm, codigo_uasg)'),
      ('licitacoes_externas', 'idx_licext_orgao_cnpj',     'USING btree (orgao_cnpj)'),
      ('licitacoes_externas', 'idx_licext_unidade_codigo', 'USING btree (((raw ->> ''unidade_codigo''::text)))'),
      ('mv_escopo_demanda', 'mv_escopo_demanda_key', 'USING btree (orgao_cnpj, COALESCE(unidade_codigo, ''''::text), fonte)')),
    checks(grupo, objeto, esperado, atual) as (
      select 'coluna', c.tabela || '.' || c.coluna,
             c.tipo || case when c.nao_nulo then ' not null' else ' null' end || case when c.gerada then ' gerada' else '' end,
             case when not c.existe then 'ausente'
                  else c.tipo_atual || case when c.attnotnull then ' not null' else ' null' end
                       || case when c.gen = 's' then ' gerada' else '' end end
        from cols c
      union all
      select 'constraint', ce.tabela || '.' || ce.nome, ce.tipo || coalesce(' ' || ce.def, ''),
             coalesce((select co.contype::text || case when ce.def is null then '' else ' ' || pg_get_constraintdef(co.oid) end
                         from pg_constraint co
                        where co.conrelid = to_regclass('public.' || ce.tabela) and co.conname = ce.nome), 'ausente')
        from cons_esperadas ce
      union all
      select 'indice', ie.tabela || '.' || ie.nome, ie.sufixo,
             coalesce((select substring(pg_get_indexdef(ic.oid) from 'USING .*$')
                         from pg_index i join pg_class ic on ic.oid = i.indexrelid
                        where i.indrelid = to_regclass('public.' || ie.tabela) and ic.relname = ie.nome), 'ausente')
        from idx_esperados ie
      union all
      select 'objeto', 'public.mv_escopo_demanda', 'm',
             coalesce((select c.relkind::text from pg_class c where c.oid = to_regclass('public.mv_escopo_demanda')), 'ausente')
      union all
      select 'objeto', v.obj || ' security_invoker', 'v true',
             coalesce((select c.relkind::text || ' ' || coalesce('security_invoker=true' = any (c.reloptions), false)::text
                         from pg_class c where c.oid = to_regclass(v.obj)), 'ausente')
        from (values ('public.v_orgao_titular_cnpj'), ('public.v_orgao_match_projeto'), ('public.v_licitacoes_filtro')) v(obj)
      union all
      select 'objeto', 'v_orgao_titular_cnpj sem raw/compras_raw', '0',
             case when to_regclass('public.v_orgao_titular_cnpj') is null then 'ausente'
                  else (select count(*)::text from pg_attribute a
                         where a.attrelid = to_regclass('public.v_orgao_titular_cnpj')
                           and a.attname in ('raw', 'compras_raw', 'payload_hash', 'compras_payload_hash')) end
      union all
      select 'rls', d.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(d.obj)), 'ausente')
        from dic d
      union all
      select 'policy', d.obj, '0',
             (select count(*)::text from pg_policies pp where pp.schemaname || '.' || pp.tablename = d.obj)
        from dic d
      union all
      select 'grant', l.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(l.obj), p.p)::text, 'ausente')
        from leitura l cross join privs p cross join papeis_fechados r
      union all
      select 'grant', l.obj || ' service_role ' || p.p, (p.p = 'SELECT')::text,
             coalesce(has_table_privilege('service_role', to_regclass(l.obj), p.p)::text, 'ausente')
        from leitura l cross join privs p
      union all
      select 'grant', 'information_schema.role_table_grants filtros anon/authenticated/PUBLIC', '0',
             (select count(*)::text from information_schema.role_table_grants g
               where g.table_schema = 'public'
                 and g.table_name in ('orgao_tipos', 'orgao_tipo_regras', 'orgao_tipo_override', 'escopo_termos',
                                      'mv_escopo_demanda', 'v_orgao_titular_cnpj', 'v_orgao_match_projeto', 'v_licitacoes_filtro')
                 and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
      union all
      select 'sequence', s.tab || '.id ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_sequence_privilege(r.papel, pg_get_serial_sequence(s.tab, 'id'), p.p)::text, 'ausente')
        from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p)
        cross join (values ('anon'), ('authenticated'), ('public'), ('service_role')) r(papel)
       where to_regclass(s.tab) is not null
      union all
      select 'sequence', s.tab || '.id existe', 'true', (to_regclass(s.tab) is not null)::text from seqs s
      union all
      select 'funcao', fn.sig || ' ' || r.papel || ' EXECUTE',
             (r.papel = 'service_role' and fn.pura)::text,
             coalesce(has_function_privilege(r.papel, to_regprocedure(fn.sig), 'EXECUTE')::text, 'ausente')
        from funcs fn cross join (values ('anon'), ('authenticated'), ('public'), ('service_role')) r(papel)
      union all
      select 'funcao', fn.sig || ' search_path fixo e não SECURITY DEFINER', 'true',
             coalesce((select (exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%') and not p.prosecdef)::text
                         from pg_proc p where p.oid = to_regprocedure(fn.sig)), 'ausente')
        from funcs fn
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  -- Seeds e comportamento: só roda se os dicionários e as funções existem (senão já contou como falha acima).
  if to_regclass('public.escopo_termos') is null or to_regprocedure('public.fn_escopo_item(text)') is null
     or to_regclass('public.orgao_tipo_override') is null or to_regclass('public.orgao_tipo_regras') is null then
    n := n + 1; f := f + 1;
    raise notice 'FALHA [seed/comportamento] dicionários ou funções ausentes: checagens de seed e comportamento não rodaram';
  else
    for v_chk in execute $q$
      with checks(grupo, objeto, esperado, atual) as (
        select 'seed', 'orgao_tipos: tipos/grupos/seg_defesa', '53/15/9',
               (select count(*) || '/' || count(distinct grupo_tipo) || '/' || count(*) filter (where seguranca_defesa)
                  from public.orgao_tipos)
        union all
        select 'seed', 'orgao_tipos: Segurança e Defesa', 'corpo_bombeiros_militar,forcas_armadas_aeronautica,forcas_armadas_exercito,forcas_armadas_marinha,ministerio_defesa,policia_civil,policia_federal,policia_militar,policia_rodoviaria_federal',
               (select string_agg(tipo_orgao, ',' order by tipo_orgao) from public.orgao_tipos where seguranca_defesa)
        union all
        select 'seed', 'orgao_tipo_regras: total/orgao/uasg', '116/108/8',
               (select count(*) || '/' || count(*) filter (where nivel = 'orgao') || '/' || count(*) filter (where nivel = 'uasg')
                  from public.orgao_tipo_regras)
        union all
        select 'seed', 'orgao_tipo_override: total', '5', (select count(*)::text from public.orgao_tipo_override)
        union all
        select 'seed', 'escopo_termos: adjacente/exclusao/nucleo/recreacao_pca', '7/49/160/16',
               (select count(*) filter (where nivel = 'adjacente') || '/' || count(*) filter (where nivel = 'exclusao') || '/'
                       || count(*) filter (where nivel = 'nucleo') || '/' || count(*) filter (where nivel = 'recreacao_pca')
                  from public.escopo_termos)
        union all
        select 'seed', 'md5 orgao_tipos', 'b9c23d4def774b5177ea4fc256a2137f',
               (select md5(string_agg(format('%s|%s|%s|%s|%s|%s', tipo_orgao, grupo_tipo, rotulo, grupo_rotulo, ordem_grupo, ordem),
                                      E'\n' order by tipo_orgao)) from public.orgao_tipos)
        union all
        select 'seed', 'md5 orgao_tipo_regras', '06862e5336e59fb83ea27769c97bd68a',
               (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', nivel, prioridade, tipo_orgao,
                                             nome_regex, nome_regex_exclui, codigos_orgao, codigos_orgao_vinculado,
                                             tipos_administracao, aceita_tipo_adm_nulo, naturezas, natureza_regex, esferas,
                                             grupos_orgao_pai, aceita_grupo_pai_nulo, ativo),
                                      E'\n' order by nivel, prioridade)) from public.orgao_tipo_regras)
        union all
        select 'seed', 'md5 orgao_tipo_override', '6e0783659891ffcce792a162bac7b76e',
               (select md5(string_agg(format('%s|%s|%s', nivel, chave, tipo_orgao), E'\n' order by nivel, chave))
                  from public.orgao_tipo_override)
        union all
        select 'seed', 'md5 escopo_termos', 'fe18977d4c81dd9a395d3310367146f8',
               (select md5(string_agg(format('%s|%s|%s|%s|%s|%s', prioridade, nivel, familia, padrao, janela_caracteres, ativo),
                                      E'\n' order by prioridade)) from public.escopo_termos)

        union all
        -- normalização
        select 'comportamento', 'fn_txt_ascii', 'Acao CA x', public.fn_txt_ascii('Ação ÇÃ´x')
        union all
        select 'comportamento', 'fn_norm_nome (prefixo sigla, acento)', 'UNIVERSIDADE FEDERAL FICTICIA',
               public.fn_norm_nome('UFXX - Universidade Federal Fictícia')
        union all
        select 'comportamento', 'fn_norm_item (HTML, espaços)', ' anilha olimpica s', public.fn_norm_item('<b>Anilha</b>   Olímpica´s')
        union all
        -- classificação de órgão (nomes sintéticos)
        select 'comportamento', 'fn_classifica_orgao(' || x.nome || ')', x.esperado,
               (public.fn_classifica_orgao(x.nome, null, x.esfera, null, null, null)).tipo_orgao
          from (values
            ('POLÍCIA MILITAR DO ESTADO FICTÍCIO', 'E', 'policia_militar'),
            ('POLÍCIA CIVIL DO ESTADO FICTÍCIO', 'E', 'policia_civil'),
            ('CORPO DE BOMBEIROS MILITAR DO ESTADO FICTÍCIO', 'E', 'corpo_bombeiros_militar'),
            ('PREFEITURA MUNICIPAL DE CIDADE FICTÍCIA', 'M', 'prefeitura'),
            ('CÂMARA MUNICIPAL DE CIDADE FICTÍCIA', 'M', 'camara_municipal'),
            ('UNIVERSIDADE FEDERAL FICTÍCIA', 'F', 'universidade_federal'),
            ('INSTITUTO FEDERAL DE EDUCAÇÃO, CIÊNCIA E TECNOLOGIA FICTÍCIO', 'F', 'instituto_federal_cefet'),
            ('TRIBUNAL DE JUSTIÇA DO ESTADO FICTÍCIO', 'E', 'tribunal_justica_estadual'),
            ('MINISTÉRIO PÚBLICO DO ESTADO FICTÍCIO', 'E', 'ministerio_publico'),
            ('SECRETARIA DE ESTADO DA EDUCAÇÃO FICTÍCIA', 'E', 'secretaria_educacao'),
            ('XYZ QWERTY', 'M', 'outros')) x(nome, esfera, esperado)
        union all
        select 'comportamento', 'fn_classifica_uasg(batalhão PM sob SSP)', 'policia_militar',
               (public.fn_classifica_uasg('BATALHAO DE POLICIA MILITAR FICTICIO', 'secretaria_seguranca_publica')).tipo_orgao
        union all
        select 'comportamento', 'fn_classifica_uasg(Forças Armadas herdam)', 'forcas_armadas_exercito',
               (public.fn_classifica_uasg('QUALQUER UNIDADE FICTICIA', 'forcas_armadas_exercito')).tipo_orgao
        union all
        -- match de item
        select 'comportamento', 'fn_escopo_item(' || x.d || ')', x.esperado,
               coalesce((select e.nivel || '/' || e.familia from public.fn_escopo_item(x.d) e where e.nivel is not null), 'sem match')
          from (values
            ('ANILHA DE FERRO 10 KG PARA MUSCULAÇÃO', 'nucleo/musculacao_academia'),
            ('ESTEIRA ERGOMÉTRICA ELÉTRICA', 'nucleo/musculacao_academia'),
            ('PISO EMBORRACHADO 50X50 CM ESPESSURA 20 MM', 'nucleo/piso_emborrachado'),
            ('BOLA DE FUTEBOL DE CAMPO OFICIAL', 'nucleo/material_esportivo'),
            ('GRAMA SINTÉTICA 12 MM', 'adjacente/superficie_esportiva'),
            ('<p>Halter  sextavado</p> 5kg', 'nucleo/musculacao_academia'),
            ('ACADEMIA DE GINÁSTICA', 'nucleo/musculacao_academia'),
            ('ACADEMIA AO AR LIVRE', 'sem match'),
            ('PISO EMBORRACHADO PARA ACADEMIA AO AR LIVRE', 'nucleo/piso_emborrachado'),
            ('RELÓGIO DESPERTADOR DIGITAL', 'sem match'),
            ('PAPEL A4 BRANCO', 'sem match'),
            ('', 'sem match')) x(d, esperado)
        union all
        select 'comportamento', 'fn_escopo_pca(vazio/playground/banco supino)', 'vazio/recreacao/escopo',
               public.fn_escopo_pca('') || '/' || public.fn_escopo_pca('PLAYGROUND INFANTIL') || '/' || public.fn_escopo_pca('BANCO SUPINO')
        union all
        select 'comportamento', 'fn_esfera_canon(E+DF / natureza municipal / privado / PNCP)', 'D/M/N/F',
               public.fn_esfera_canon(null, 'E', null, 'DF', 'secretaria_estadual') || '/' ||
               public.fn_esfera_canon('1031', null, null, 'SP', 'prefeitura') || '/' ||
               public.fn_esfera_canon(null, null, null, null, 'entidade_privada') || '/' ||
               public.fn_esfera_canon(null, null, 'F', null, 'outros')
        union all
        select 'comportamento', 'fn_poder_canon(câmara/TJ/prefeitura/sistema S/conselho)', 'L/J/E/N/E',
               public.fn_poder_canon('camara_municipal', null) || '/' || public.fn_poder_canon('tribunal_justica_estadual', null) || '/' ||
               public.fn_poder_canon('prefeitura', null) || '/' || public.fn_poder_canon('sistema_s', null) || '/' ||
               public.fn_poder_canon('conselho_profissional', null)
      )
      select * from checks order by grupo, objeto $q$
    loop
      n := n + 1;
      if v_chk.atual is distinct from v_chk.esperado then
        f := f + 1;
        raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
      end if;
    end loop;
  end if;

  -- Todas as regex dos dicionários compilam no motor ARE do Postgres (erro de regex = falha contada).
  if to_regclass('public.orgao_tipo_regras') is not null and to_regclass('public.escopo_termos') is not null then
    v_ruins := 0;
    for v_rx in
      select x from public.orgao_tipo_regras r, unnest(array[r.nome_regex, r.nome_regex_exclui, r.natureza_regex]) x
       where x is not null
      union all
      select padrao from public.escopo_termos
    loop
      begin
        perform '' ~ v_rx;
      exception when others then
        v_ruins := v_ruins + 1;
        raise notice 'FALHA [seed] regex inválida: %', v_rx;
      end;
    end loop;
    n := n + 1;
    if v_ruins > 0 then f := f + 1; end if;
  end if;

  -- Expressões geradas de uasgs (municipio_ibge e cnpj_cpf_orgao_vinculado_norm) sobre literais sintéticos
  for v_am in
    select * from (values
      ('municipio_ibge', 'codigo_municipio_ibge', 'integer', '3550308', '3550308'),
      ('municipio_ibge', 'codigo_municipio_ibge', 'integer', '99', null),
      ('municipio_ibge', 'codigo_municipio_ibge', 'integer', null, null),
      ('cnpj_cpf_orgao_vinculado_norm', 'cnpj_cpf_orgao_vinculado', 'text', '508903000188', '00508903000188'),
      ('cnpj_cpf_orgao_vinculado_norm', 'cnpj_cpf_orgao_vinculado', 'text', '12.345.678/0001-95', '12345678000195'),
      ('cnpj_cpf_orgao_vinculado_norm', 'cnpj_cpf_orgao_vinculado', 'text', '0', null),
      ('cnpj_cpf_orgao_vinculado_norm', 'cnpj_cpf_orgao_vinculado', 'text', '', null),
      ('cnpj_cpf_orgao_vinculado_norm', 'cnpj_cpf_orgao_vinculado', 'text', null, null)) s(coluna, base, tipo, entrada, esperado)
  loop
    n := n + 1;
    v_expr := null;
    select pg_get_expr(d.adbin, d.adrelid) into v_expr
      from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = to_regclass('public.uasgs') and a.attname = v_am.coluna and a.attgenerated = 's';
    if v_expr is null then
      v_out := 'coluna gerada ausente';
    else
      execute format('select (%s)::text from (select $1::%s as %I) s', v_expr, v_am.tipo, v_am.base)
         into v_out using v_am.entrada;
    end if;
    if v_expr is null or v_out is distinct from v_am.esperado then
      f := f + 1;
      raise notice 'FALHA [gerada] uasgs.%(%): esperado "%", atual "%"',
        v_am.coluna, coalesce(v_am.entrada, 'NULL'), coalesce(v_am.esperado, 'NULL'), coalesce(v_out, 'NULL');
    end if;
  end loop;

  raise notice 'orgaos_uasgs_filtros_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'orgaos_uasgs_filtros_check FALHOU: % de % checagens', f, n;
  end if;
end $$;

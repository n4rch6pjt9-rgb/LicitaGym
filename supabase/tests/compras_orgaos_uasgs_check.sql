-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260930130000_compras_orgaos_uasgs.
-- Só SELECT em catálogo, funções has_*_privilege e avaliação da expressão das colunas geradas *_norm sobre
-- literais sintéticos (nenhuma escrita, nenhuma tabela temporária, nenhum dado real).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/compras_orgaos_uasgs_check.sql
-- Resultado esperado: NOTICE "compras_orgaos_uasgs_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION (exit code <> 0
-- com ON_ERROR_STOP=1).
--
-- O que confere:
--   colunas/tipos: 24 colunas Compras em orgaos (cnpj_cpf_orgao_norm gerada), entidade_id e cnpj anuláveis,
--                  legadas esfera_id/poder_id mantidas; todas as colunas de uasgs com tipo e NOT NULL.
--   chaves:        uasgs PK (id identity always), UNIQUE codigo_uasg; orgaos PK id, UNIQUE codigo_orgao,
--                  UNIQUE entidade_id; nenhum índice único em CNPJ (orgaos_cnpj_idx ausente); 3 CHECKs de orgaos.
--   índices:       6 em orgaos e 6 em uasgs (nome e colunas).
--   FK:            uasgs.orgao_id -> orgaos(id) ON DELETE SET NULL; FKs antigas para orgaos intactas.
--   RLS:           ligado em orgaos e uasgs; nenhuma policy nas duas.
--   grants:        anon/authenticated/PUBLIC sem nenhum privilégio (tabela, coluna e sequence);
--                  service_role só SELECT/INSERT/UPDATE/DELETE nas tabelas (sem TRUNCATE/REFERENCES/TRIGGER/MAINTAIN),
--                  USAGE/SELECT na sequence.
--   CPF/CNPJ:      colunas cnpj_cpf_* são text puro (não geradas, sem default, sem domínio), nenhuma trigger
--                  ou rule nas tabelas; *_norm = lpad 14 dos dígitos, NULL para "", "0", só zeros e NULL.

do $$
declare
  v_chk    record;
  v_tab    record;
  n        int := 0;
  f        int := 0;
  v_expr   text;
  v_out    text;
  v_amostra record;
begin
  for v_chk in
    with
    esperadas(tabela, coluna, tipo, nao_nulo, gerada) as (values
      -- orgaos: colunas novas (tipo, NOT NULL, gerada)
      ('orgaos', 'codigo_orgao', 'integer', false, false),
      ('orgaos', 'nome_orgao', 'text', false, false),
      ('orgaos', 'nome_mnemonico_orgao', 'text', false, false),
      ('orgaos', 'cnpj_cpf_orgao', 'text', false, false),
      ('orgaos', 'codigo_orgao_vinculado', 'integer', false, false),
      ('orgaos', 'cnpj_cpf_orgao_vinculado', 'text', false, false),
      ('orgaos', 'nome_orgao_vinculado', 'text', false, false),
      ('orgaos', 'codigo_orgao_superior', 'integer', false, false),
      ('orgaos', 'cnpj_cpf_orgao_superior', 'text', false, false),
      ('orgaos', 'nome_orgao_superior', 'text', false, false),
      ('orgaos', 'codigo_tipo_administracao', 'integer', false, false),
      ('orgaos', 'nome_tipo_administracao', 'text', false, false),
      ('orgaos', 'poder', 'text', false, false),
      ('orgaos', 'esfera', 'text', false, false),
      ('orgaos', 'uso_sisg', 'boolean', false, false),
      ('orgaos', 'status_orgao', 'boolean', false, false),
      ('orgaos', 'data_hora_movimento', 'timestamp without time zone', false, false),
      ('orgaos', 'compras_raw', 'jsonb', false, false),
      ('orgaos', 'compras_payload_hash', 'text', false, false),
      ('orgaos', 'compras_primeira_vez_em', 'timestamp with time zone', false, false),
      ('orgaos', 'compras_last_seen_at', 'timestamp with time zone', false, false),
      ('orgaos', 'compras_removido_em', 'timestamp with time zone', false, false),
      ('orgaos', 'pncp_vinculo', 'text', false, false),
      ('orgaos', 'cnpj_cpf_orgao_norm', 'text', false, true),
      -- orgaos: colunas que existiam (relaxadas ou mantidas)
      ('orgaos', 'id', 'uuid', true, false),
      ('orgaos', 'entidade_id', 'uuid', false, false),
      ('orgaos', 'cnpj', 'text', false, false),
      ('orgaos', 'orgao_id_pncp', 'bigint', false, false),
      ('orgaos', 'razao_social', 'text', false, false),
      ('orgaos', 'esfera_id', 'integer', false, false),
      ('orgaos', 'poder_id', 'integer', false, false),
      ('orgaos', 'payload_hash', 'text', false, false),
      ('orgaos', 'ativo', 'boolean', true, false),
      -- uasgs
      ('uasgs', 'id', 'bigint', true, false),
      ('uasgs', 'codigo_uasg', 'text', true, false),
      ('uasgs', 'nome_uasg', 'text', false, false),
      ('uasgs', 'uso_sisg', 'boolean', false, false),
      ('uasgs', 'adesao_siasg', 'boolean', false, false),
      ('uasgs', 'sigla_uf', 'text', false, false),
      ('uasgs', 'codigo_municipio', 'integer', false, false),
      ('uasgs', 'codigo_municipio_ibge', 'integer', false, false),
      ('uasgs', 'nome_municipio_ibge', 'text', false, false),
      ('uasgs', 'codigo_unidade_polo', 'integer', false, false),
      ('uasgs', 'nome_unidade_polo', 'text', false, false),
      ('uasgs', 'codigo_unidade_espelho', 'integer', false, false),
      ('uasgs', 'nome_unidade_espelho', 'text', false, false),
      ('uasgs', 'uasg_cadastradora', 'boolean', false, false),
      ('uasgs', 'cnpj_cpf_uasg', 'text', false, false),
      ('uasgs', 'codigo_orgao', 'integer', false, false),
      ('uasgs', 'cnpj_cpf_orgao', 'text', false, false),
      ('uasgs', 'cnpj_cpf_orgao_vinculado', 'text', false, false),
      ('uasgs', 'cnpj_cpf_orgao_superior', 'text', false, false),
      ('uasgs', 'codigo_siorg', 'text', false, false),
      ('uasgs', 'status_uasg', 'boolean', false, false),
      ('uasgs', 'data_implantacao_sidec', 'timestamp with time zone', false, false),
      ('uasgs', 'data_hora_movimento', 'timestamp without time zone', false, false),
      ('uasgs', 'cnpj_cpf_orgao_norm', 'text', false, true),
      ('uasgs', 'orgao_id', 'uuid', false, false),
      ('uasgs', 'raw', 'jsonb', true, false),
      ('uasgs', 'payload_hash', 'text', true, false),
      ('uasgs', 'ativo', 'boolean', true, false),
      ('uasgs', 'primeira_vez_em', 'timestamp with time zone', true, false),
      ('uasgs', 'last_seen_at', 'timestamp with time zone', false, false),
      ('uasgs', 'removido_da_fonte_em', 'timestamp with time zone', false, false),
      ('uasgs', 'last_synced_at', 'timestamp with time zone', false, false),
      ('uasgs', 'created_at', 'timestamp with time zone', true, false),
      ('uasgs', 'updated_at', 'timestamp with time zone', true, false)),
    cols as (
      select e.*, a.attname is not null as existe,
             format_type(a.atttypid, a.atttypmod) as tipo_atual, a.attnotnull, a.attgenerated
        from esperadas e
        left join pg_attribute a
          on a.attrelid = to_regclass('public.' || e.tabela) and a.attname = e.coluna
         and a.attnum > 0 and not a.attisdropped),
    tabs(obj) as (values ('public.orgaos'), ('public.uasgs')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema: conferido à parte.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    papeis_fechados(papel) as (values ('anon'), ('authenticated'), ('public')),
    seq as (select pg_get_serial_sequence('public.uasgs', 'id') as obj
             where to_regclass('public.uasgs') is not null),
    idx_esperados(tabela, nome, sufixo) as (values
      ('orgaos', 'orgaos_cnpj_norm_idx',              'USING btree (regexp_replace(cnpj, ''[^0-9]''::text, ''''::text, ''g''::text))'),
      ('orgaos', 'orgaos_cnpj_cpf_orgao_norm_idx',    'USING btree (cnpj_cpf_orgao_norm)'),
      ('orgaos', 'orgaos_orgao_id_pncp_idx',          'USING btree (orgao_id_pncp)'),
      ('orgaos', 'orgaos_codigo_orgao_superior_idx',  'USING btree (codigo_orgao_superior)'),
      ('orgaos', 'orgaos_codigo_orgao_vinculado_idx', 'USING btree (codigo_orgao_vinculado)'),
      ('orgaos', 'orgaos_data_hora_movimento_idx',    'USING btree (data_hora_movimento)'),
      ('uasgs',  'uasgs_codigo_orgao_idx',            'USING btree (codigo_orgao)'),
      ('uasgs',  'uasgs_orgao_id_idx',                'USING btree (orgao_id)'),
      ('uasgs',  'uasgs_cnpj_cpf_orgao_norm_idx',     'USING btree (cnpj_cpf_orgao_norm)'),
      ('uasgs',  'uasgs_uf_municipio_idx',            'USING btree (sigla_uf, codigo_municipio_ibge)'),
      ('uasgs',  'uasgs_status_uasg_idx',             'USING btree (status_uasg)'),
      ('uasgs',  'uasgs_data_hora_movimento_idx',     'USING btree (data_hora_movimento)')),
    cons_esperadas(tabela, nome, tipo, def) as (values
      ('orgaos', 'orgaos_pkey',                'p', 'PRIMARY KEY (id)'),
      ('orgaos', 'orgaos_codigo_orgao_key',    'u', 'UNIQUE (codigo_orgao)'),
      ('orgaos', 'orgaos_entidade_id_key',     'u', 'UNIQUE (entidade_id)'),
      ('orgaos', 'orgaos_pncp_vinculo_check',  'c', null),
      ('orgaos', 'orgaos_compras_consistente', 'c', null),
      ('orgaos', 'orgaos_tem_identidade',      'c', null),
      ('uasgs',  'uasgs_pkey',                 'p', 'PRIMARY KEY (id)'),
      ('uasgs',  'uasgs_codigo_uasg_key',      'u', 'UNIQUE (codigo_uasg)'),
      ('uasgs',  'uasgs_orgao_id_fkey',        'f', 'FOREIGN KEY (orgao_id) REFERENCES orgaos(id) ON DELETE SET NULL')),
    checks(grupo, objeto, esperado, atual) as (
      -- colunas: existência, tipo, NOT NULL, gerada
      select 'coluna', c.tabela || '.' || c.coluna,
             c.tipo || case when c.nao_nulo then ' not null' else ' null' end
                    || case when c.gerada then ' gerada' else '' end,
             case when not c.existe then 'ausente'
                  else c.tipo_atual || case when c.attnotnull then ' not null' else ' null' end
                       || case when c.attgenerated = 's' then ' gerada' else '' end end
        from cols c
      union all
      -- identity always em uasgs.id
      select 'chave', 'uasgs.id identity', 'a',
             coalesce((select a.attidentity::text from pg_attribute a
                        where a.attrelid = to_regclass('public.uasgs') and a.attname = 'id'), 'ausente')
      union all
      -- constraints nomeadas
      select 'constraint', ce.tabela || '.' || ce.nome,
             ce.tipo || coalesce(' ' || ce.def, ''),
             coalesce((select co.contype::text
                              || case when ce.def is null then '' else ' ' || pg_get_constraintdef(co.oid) end
                         from pg_constraint co
                        where co.conrelid = to_regclass('public.' || ce.tabela) and co.conname = ce.nome), 'ausente')
        from cons_esperadas ce
      union all
      -- CHECK de pncp_vinculo aceita exatamente os 5 valores
      select 'constraint', 'orgaos.orgaos_pncp_vinculo_check valores',
             'cnpj_compartilhado,raiz_cnpj_candidato,sem_cnpj,sem_pncp,titular_cnpj',
             coalesce((select string_agg(m[1], ',' order by m[1])
                         from pg_constraint co,
                              regexp_matches(pg_get_constraintdef(co.oid), '''([a-z_]+)''', 'g') m
                        where co.conrelid = to_regclass('public.orgaos') and co.conname = 'orgaos_pncp_vinculo_check'), 'ausente')
      union all
      -- nenhum índice único em orgaos além da PK e das duas UNIQUE (codigo_orgao, entidade_id)
      select 'chave', 'orgaos: índices únicos', 'orgaos_codigo_orgao_key,orgaos_entidade_id_key,orgaos_pkey',
             coalesce((select string_agg(ic.relname, ',' order by ic.relname)
                         from pg_index i join pg_class ic on ic.oid = i.indexrelid
                        where i.indrelid = to_regclass('public.orgaos') and i.indisunique), '')
      union all
      select 'chave', 'public.orgaos_cnpj_idx', 'ausente',
             case when to_regclass('public.orgaos_cnpj_idx') is null then 'ausente' else 'presente' end
      union all
      -- índices esperados
      select 'indice', ie.tabela || '.' || ie.nome, ie.sufixo,
             coalesce((select substring(pi.indexdef from 'USING .*$') from pg_indexes pi
                        where pi.schemaname = 'public' and pi.tablename = ie.tabela and pi.indexname = ie.nome), 'ausente')
        from idx_esperados ie
      union all
      -- FKs antigas que apontam para orgaos continuam
      select 'fk', x.t || '.orgao_id -> orgaos(id)', 'presente',
             case when exists (select 1 from pg_constraint co
                                where co.contype = 'f' and co.conrelid = to_regclass(x.t)
                                  and co.confrelid = to_regclass('public.orgaos')) then 'presente' else 'ausente' end
        from (values ('public.unidades'), ('public.contratacoes_editais'), ('public.irp_intencoes')) x(t)
      union all
      -- RLS
      select 'rls', t.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.obj)), 'ausente')
        from tabs t
      union all
      -- nenhuma policy em orgaos/uasgs
      select 'policy', t.obj, '0',
             (select count(*)::text from pg_policies pp where pp.schemaname || '.' || pp.tablename = t.obj)
        from tabs t
      union all
      -- tabela: nenhum privilégio para anon/authenticated/PUBLIC
      select 'grant', t.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(t.obj), p.p)::text, 'ausente')
        from tabs t cross join privs p cross join papeis_fechados r
      union all
      -- coluna: nenhum privilégio de coluna para anon/authenticated/PUBLIC
      select 'grant', t.obj || ' ' || r.papel || ' qualquer coluna ' || p.p, 'false',
             coalesce(has_any_column_privilege(r.papel, to_regclass(t.obj), p.p)::text, 'ausente')
        from tabs t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(p)
        cross join papeis_fechados r
      union all
      -- service_role: só CRUD
      select 'grant', t.obj || ' service_role ' || p.p,
             (p.p in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))::text,
             coalesce(has_table_privilege('service_role', to_regclass(t.obj), p.p)::text, 'ausente')
        from tabs t cross join privs p
      union all
      -- visão independente pelo information_schema: nenhuma linha de grant para anon/authenticated/PUBLIC
      select 'grant', 'information_schema.role_table_grants orgaos/uasgs anon/authenticated/PUBLIC', '0',
             (select count(*)::text from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name in ('orgaos', 'uasgs')
                 and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
      union all
      -- sequence de identidade de uasgs
      select 'sequence', coalesce(s.obj, 'uasgs.id sequence') || ' ' || r.papel || ' ' || p.p,
             (r.papel = 'service_role' and p.p in ('USAGE', 'SELECT'))::text,
             coalesce(has_sequence_privilege(r.papel, s.obj, p.p)::text, 'ausente')
        from (select (select obj from seq) as obj) s
        cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p)
        cross join (values ('anon'), ('authenticated'), ('public'), ('service_role')) r(papel)
      union all
      -- CPF/CNPJ sem transformação: colunas cruas são text puro, sem default e sem geração
      select 'cpf_cnpj', x.t || '.' || x.c || ' cru', 'text sem default nem geração',
             coalesce((select case when a.atttypid = 'text'::regtype and not a.atthasdef and a.attgenerated::text = ''
                                   then 'text sem default nem geração'
                                   else format_type(a.atttypid, a.atttypmod) || ' def=' || a.atthasdef || ' gen=' || a.attgenerated::text end
                         from pg_attribute a
                        where a.attrelid = to_regclass('public.' || x.t) and a.attname = x.c and not a.attisdropped), 'ausente')
        from (values ('orgaos', 'cnpj_cpf_orgao'), ('orgaos', 'cnpj_cpf_orgao_vinculado'), ('orgaos', 'cnpj_cpf_orgao_superior'),
                     ('orgaos', 'cnpj'),
                     ('uasgs', 'cnpj_cpf_uasg'), ('uasgs', 'cnpj_cpf_orgao'), ('uasgs', 'cnpj_cpf_orgao_vinculado'),
                     ('uasgs', 'cnpj_cpf_orgao_superior')) x(t, c)
      union all
      -- nenhuma trigger de usuário nem rule que possa reescrever os valores
      select 'cpf_cnpj', t.obj || ' triggers/rules', '0',
             ((select count(*) from pg_trigger tg where tg.tgrelid = to_regclass(t.obj) and not tg.tgisinternal)
              + (select count(*) from pg_rewrite rw where rw.ev_class = to_regclass(t.obj)))::text
        from tabs t
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  -- CPF/CNPJ: a expressão gerada de *_norm, avaliada sobre literais sintéticos
  for v_tab in select * from (values ('orgaos'), ('uasgs')) x(t) loop
    select pg_get_expr(d.adbin, d.adrelid) into v_expr
      from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = to_regclass('public.' || v_tab.t) and a.attname = 'cnpj_cpf_orgao_norm' and a.attgenerated = 's';
    for v_amostra in
      select * from (values
        ('12345678000195',     '12345678000195'),   -- 14 dígitos: igual
        ('508903000188',       '00508903000188'),   -- sem zeros à esquerda: lpad 14
        ('12.345.678/0001-95', '12345678000195'),   -- máscara: só dígitos
        ('0',                  null),               -- "0": NULL
        ('',                   null),               -- vazio: NULL
        ('00000000000000',     null),               -- só zeros: NULL
        (null,                 null)) s(entrada, esperado)
    loop
      n := n + 1;
      if v_expr is null then
        v_out := 'coluna gerada ausente';
      else
        execute format('select (%s)::text from (select $1::text as cnpj_cpf_orgao) s', v_expr)
           into v_out using v_amostra.entrada;
      end if;
      if v_expr is null or v_out is distinct from v_amostra.esperado then
        f := f + 1;
        raise notice 'FALHA [cpf_cnpj] %.cnpj_cpf_orgao_norm(%): esperado "%", atual "%"',
          v_tab.t, coalesce(v_amostra.entrada, 'NULL'), coalesce(v_amostra.esperado, 'NULL'), coalesce(v_out, 'NULL');
      end if;
    end loop;
  end loop;

  raise notice 'compras_orgaos_uasgs_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'compras_orgaos_uasgs_check FALHOU: % de % checagens', f, n;
  end if;
end $$;

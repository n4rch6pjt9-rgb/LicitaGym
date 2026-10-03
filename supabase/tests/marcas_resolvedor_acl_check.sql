-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261003200000_marcas_resolvedor_fornecedor.
-- Só SELECT em catálogo, funções has_*_privilege e chamadas às funções IMMUTABLE/STABLE do resolvedor
-- (nenhuma escrita, nenhuma tabela temporária). Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/marcas_resolvedor_acl_check.sql
-- Também roda inteiro no SQL Editor do Supabase.
-- Resultado esperado: NOTICE "SUCESSO: marcas_resolvedor_acl_check: N checagens, 0 falhas".
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   objetos:  marca_aliases (+ sequence), 4 views e 2 funções existem; semente marcas-v1 presente.
--   grants:   anon, authenticated e PUBLIC sem nenhum privilégio na tabela, nas 4 views, na sequence e nas 2 funções
--             (relação, coluna, information_schema); service_role com SELECT/INSERT/UPDATE/DELETE na tabela,
--             SELECT nas views, USAGE na sequence e EXECUTE nas funções.
--   RLS:      ligado em marca_aliases; nenhuma policy.
--   views:    security_invoker=true.
--   funções:  normalização e resolução de casos conhecidos (CNPJ 11222333000181 é fictício).

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    tabelas(obj) as (values ('public.marca_aliases')),
    views(obj) as (values ('public.v_marca_ocorrencias'), ('public.v_fornecedor_marcas_ranking'),
                          ('public.v_fornecedor_marcas'), ('public.v_marca_aliases_pendentes')),
    objs(obj) as (select obj from tabelas union all select obj from views),
    seqs(obj) as (values ('public.marca_aliases_id_seq')),
    funcs(obj) as (values ('private.marca_normalizar(text)'), ('private.marca_resolver(text,text)')),
    fechados(papel) as (values ('anon'), ('authenticated'), ('public')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    casos(entrada, cnpj, esperado) as (values
      ('CLASSIC', '11222333000181', 'FLEX EQUIPMENT'),
      ('CLASSIC PLUS', '11222333000181', 'FLEX EQUIPMENT'),
      ('XI', '11222333000181', 'FLEX EQUIPMENT'),
      ('Flex Equipment', '11222333000181', 'FLEX EQUIPMENT'),
      ('EVO 3850 AC', '11222333000181', 'EVOLUTION'),
      ('NEW EDGE SHP +', '11222333000181', 'MOVEMENT'),
      ('R55V5', '11222333000181', 'SPEEDO'),
      ('INK', '11222333000181', 'INK FITNESS'),
      ('VAXX DELVA', '11222333000181', 'VAXX'),
      ('ANILHAS MINAS', '11222333000181', 'ANILHAS MINAS'),
      ('AGON', '11222333000181', 'AGON'),
      ('FUNDIBAN FUNDIBAN', '11222333000181', 'FUNDIBAN'),
      ('ANILHA EMBORRACHADA', '11222333000181', null),
      ('1130PC', '11222333000181', null),
      ('SIMILAR', '11222333000181', null),
      ('0', '11222333000181', null),
      ('-', '11222333000181', null),
      ('2 KG', '11222333000181', null),
      ('', '11222333000181', null),
      (null, '11222333000181', null),
      ('PRÓPRIA', '11222333000181', null),
      ('Marca Própria', '11222333000181', null),
      ('MARCA PROPIA', '11222333000181', null),
      ('ESTANTE ANILHAS', '11222333000181', null),
      ('ESQUI TRIPLO', '11222333000181', null),
      ('PRÓPRIA', '08973569000145', 'FLEX EQUIPMENT'),
      ('P ROPIO', '50937669000182', 'SIGMETAL')),
    checks(grupo, objeto, esperado, atual) as (
      select 'objeto', o.obj, 'existe', case when to_regclass(o.obj) is null then 'ausente' else 'existe' end
        from objs o
      union all
      select 'objeto', s.obj, 'existe', case when to_regclass(s.obj) is null then 'ausente' else 'existe' end
        from seqs s
      union all
      select 'objeto', fn.obj, 'existe', case when to_regprocedure(fn.obj) is null then 'ausente' else 'existe' end
        from funcs fn
      union all
      select 'semente', 'public.marca_aliases marcas-v1 > 100 linhas', 'true',
             ((select count(*) from public.marca_aliases a where a.seed_versao = 'marcas-v1') > 100)::text
      union all
      -- anon, authenticated e PUBLIC: nenhum privilégio de relação
      select 'grant', o.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(o.obj), p.p)::text, 'ausente')
        from objs o cross join privs p cross join fechados r
      union all
      -- ... nem de coluna
      select 'grant', o.obj || ' ' || r.papel || ' qualquer coluna ' || p.p, 'false',
             coalesce(has_any_column_privilege(r.papel, to_regclass(o.obj), p.p)::text, 'ausente')
        from objs o cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(p) cross join fechados r
      union all
      select 'grant', 'information_schema anon/authenticated/PUBLIC (tabela + coluna)', '0',
             ((select count(*) from information_schema.role_table_grants g
                where g.table_schema = 'public'
                  and g.table_name in ('marca_aliases', 'v_marca_ocorrencias', 'v_fornecedor_marcas_ranking',
                                       'v_fornecedor_marcas', 'v_marca_aliases_pendentes')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
              + (select count(*) from information_schema.column_privileges g
                where g.table_schema = 'public'
                  and g.table_name in ('marca_aliases', 'v_marca_ocorrencias', 'v_fornecedor_marcas_ranking',
                                       'v_fornecedor_marcas', 'v_marca_aliases_pendentes')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC')))::text
      union all
      -- sequence: nada para anon/authenticated/PUBLIC
      select 'grant', s.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_sequence_privilege(r.papel, to_regclass(s.obj), p.p)::text, 'ausente')
        from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p) cross join fechados r
      union all
      -- funções: nada para anon/authenticated/PUBLIC
      select 'grant', fn.obj || ' ' || r.papel || ' EXECUTE', 'false',
             coalesce(has_function_privilege(r.papel, to_regprocedure(fn.obj), 'EXECUTE')::text, 'ausente')
        from funcs fn cross join fechados r
      union all
      -- service_role
      select 'grant', t.obj || ' service_role ' || p.p, 'true',
             coalesce(has_table_privilege('service_role', to_regclass(t.obj), p.p)::text, 'ausente')
        from tabelas t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
      union all
      select 'grant', v.obj || ' service_role SELECT', 'true',
             coalesce(has_table_privilege('service_role', to_regclass(v.obj), 'SELECT')::text, 'ausente')
        from views v
      union all
      select 'grant', s.obj || ' service_role USAGE', 'true',
             coalesce(has_sequence_privilege('service_role', to_regclass(s.obj), 'USAGE')::text, 'ausente')
        from seqs s
      union all
      select 'grant', fn.obj || ' service_role EXECUTE', 'true',
             coalesce(has_function_privilege('service_role', to_regprocedure(fn.obj), 'EXECUTE')::text, 'ausente')
        from funcs fn
      union all
      select 'grant', 'schema private service_role USAGE', 'true',
             coalesce(has_schema_privilege('service_role', 'private', 'USAGE')::text, 'ausente')
      union all
      -- RLS ligado e nenhuma policy
      select 'rls', t.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.obj)), 'ausente')
        from tabelas t
      union all
      select 'policy', t.obj, '0',
             (select count(*)::text from pg_policies pp where pp.schemaname || '.' || pp.tablename = t.obj)
        from tabelas t
      union all
      select 'security_invoker', v.obj, 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass(v.obj)), 'ausente')
        from views v
      union all
      -- funções: normalização
      select 'normalizar', ''' Flex  Equipment Ltda ''', 'FLEX EQUIPMENT',
             coalesce(private.marca_normalizar(' Flex  Equipment Ltda '), 'NULL')
      union all
      select 'normalizar', '''Fundiban Fundiban''', 'FUNDIBAN',
             coalesce(private.marca_normalizar('Fundiban Fundiban'), 'NULL')
      union all
      select 'normalizar', '''Açúcar & Cia.''', 'ACUCAR & CIA', coalesce(private.marca_normalizar('Açúcar & Cia.'), 'NULL')
      union all
      select 'normalizar', ''' - ''', 'NULL', coalesce(private.marca_normalizar(' - '), 'NULL')
      union all
      -- funções: resolução (marca canônica ou NULL)
      select 'resolver', coalesce(c.entrada, '<null>') || ' / ' || c.cnpj, coalesce(c.esperado, 'NULL'),
             coalesce((select r.marca from private.marca_resolver(c.entrada, c.cnpj) r), 'NULL')
        from casos c
      union all
      select 'resolver', 'AGON metodo/curada', 'bruta/false',
             (select r.metodo || '/' || r.curada::text from private.marca_resolver('AGON', '11222333000181') r)
      union all
      select 'resolver', 'CLASSIC metodo/curada', 'alias_prefixo/true',
             (select r.metodo || '/' || r.curada::text from private.marca_resolver('CLASSIC', '11222333000181') r)
      union all
      select 'resolver', 'PRÓPRIA 08973569000145 metodo', 'alias_regex',
             (select r.metodo from private.marca_resolver('PRÓPRIA', '08973569000145') r)
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  if f > 0 then
    raise exception 'ACL CHECK FALHOU: marcas_resolvedor_acl_check: % de % checagens', f, n;
  end if;
  raise notice 'SUCESSO: marcas_resolvedor_acl_check: % checagens, 0 falhas', n;
end $$;

-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260930140000_entidades_unidades_acl.
-- Só SELECT em catálogo e funções has_*_privilege (nenhuma escrita, nenhuma tabela temporária, nenhum dado).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/entidades_unidades_acl_check.sql
-- Resultado esperado: NOTICE "entidades_unidades_acl_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION (exit code <> 0
-- com ON_ERROR_STOP=1).
--
-- O que confere:
--   RLS:        ligado em entidades e unidades; nenhuma policy nas duas.
--   grants:     anon/authenticated/PUBLIC sem nenhum privilégio (tabela e coluna; information_schema também);
--               service_role só SELECT/INSERT/UPDATE/DELETE (sem TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).
--   sequences:  qualquer sequence ligada às tabelas sem privilégio para anon/authenticated/PUBLIC.
--   dependente: v_licitacoes_filtro (security_invoker, lê unidades) continua legível por service_role e
--               fechada para anon/authenticated.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    tabs(obj) as (values ('public.entidades'), ('public.unidades')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema: conferido à parte.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    papeis_fechados(papel) as (values ('anon'), ('authenticated'), ('public')),
    seqs(tab, obj) as (
      select d.refobjid::regclass::text, d.objid::regclass::text
        from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
       where d.classid = 'pg_class'::regclass and d.deptype in ('a', 'i')
         and d.refobjid in (select to_regclass(obj) from tabs where to_regclass(obj) is not null)),
    checks(grupo, objeto, esperado, atual) as (
      select 'tabela', t.obj, 'existe',
             case when to_regclass(t.obj) is null then 'ausente' else 'existe' end
        from tabs t
      union all
      select 'rls', t.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.obj)), 'ausente')
        from tabs t
      union all
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
      -- visão independente pelo information_schema (tabela e coluna)
      select 'grant', 'information_schema.role_table_grants entidades/unidades anon/authenticated/PUBLIC', '0',
             (select count(*)::text from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name in ('entidades', 'unidades')
                 and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
      union all
      select 'grant', 'information_schema.column_privileges entidades/unidades anon/authenticated/PUBLIC', '0',
             (select count(*)::text from information_schema.column_privileges g
               where g.table_schema = 'public' and g.table_name in ('entidades', 'unidades')
                 and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
      union all
      -- sequences ligadas (hoje nenhuma): fechadas para anon/authenticated/PUBLIC
      select 'sequence', s.obj || ' ' || r.papel || ' ' || p.p, 'false',
             has_sequence_privilege(r.papel, s.obj, p.p)::text
        from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p) cross join papeis_fechados r
      union all
      -- dependente security_invoker: service_role continua lendo; anon/authenticated fechados
      select 'dependente', 'public.v_licitacoes_filtro ' || r.papel || ' SELECT',
             (r.papel = 'service_role')::text,
             coalesce(has_table_privilege(r.papel, to_regclass('public.v_licitacoes_filtro'), 'SELECT')::text, 'ausente')
        from (values ('anon'), ('authenticated'), ('service_role')) r(papel)
       where to_regclass('public.v_licitacoes_filtro') is not null
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  raise notice 'entidades_unidades_acl_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'entidades_unidades_acl_check FALHOU: % de % checagens', f, n;
  end if;
end $$;

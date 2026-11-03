-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260930190000_pca_views_security_invoker.
-- Só SELECT em catálogo e funções has_*_privilege (nenhuma escrita, nenhuma tabela temporária, nenhum dado).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pca_views_security_invoker_check.sql
-- Resultado esperado: NOTICE "pca_views_security_invoker_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   views:   as três existem e têm security_invoker=true.
--   grants:  anon/PUBLIC sem nenhum privilégio (relação e coluna; information_schema também);
--            authenticated e service_role só SELECT.
--   base:    RLS ligado em pca_alteracoes, pca_itens, pca_planos e contratacoes_editais; nenhuma policy
--            para anon/PUBLIC.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    views(obj) as (values ('public.pca_alteracoes_resumo'), ('public.pca_conversao_edital_item'),
                          ('public.pca_conversao_edital_taxa')),
    bases(obj) as (values ('public.pca_alteracoes'), ('public.pca_itens'), ('public.pca_planos'),
                          ('public.contratacoes_editais')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    checks(grupo, objeto, esperado, atual) as (
      select 'view', v.obj, 'existe', case when to_regclass(v.obj) is null then 'ausente' else 'existe' end
        from views v
      union all
      select 'security_invoker', v.obj, 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass(v.obj)), 'ausente')
        from views v
      union all
      -- anon e PUBLIC: nenhum privilégio na view
      select 'grant', v.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(v.obj), p.p)::text, 'ausente')
        from views v cross join privs p cross join (values ('anon'), ('public')) r(papel)
      union all
      select 'grant', v.obj || ' ' || r.papel || ' qualquer coluna ' || p.p, 'false',
             coalesce(has_any_column_privilege(r.papel, to_regclass(v.obj), p.p)::text, 'ausente')
        from views v cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(p)
        cross join (values ('anon'), ('public')) r(papel)
      union all
      -- authenticated e service_role: só SELECT
      select 'grant', v.obj || ' ' || r.papel || ' ' || p.p, (p.p = 'SELECT')::text,
             coalesce(has_table_privilege(r.papel, to_regclass(v.obj), p.p)::text, 'ausente')
        from views v cross join privs p cross join (values ('authenticated'), ('service_role')) r(papel)
      union all
      select 'grant', 'information_schema.role_table_grants views pca anon/PUBLIC', '0',
             (select count(*)::text from information_schema.role_table_grants g
               where g.table_schema = 'public'
                 and g.table_name in ('pca_alteracoes_resumo', 'pca_conversao_edital_item', 'pca_conversao_edital_taxa')
                 and g.grantee in ('anon', 'PUBLIC'))
      union all
      select 'grant', 'information_schema.column_privileges views pca anon/PUBLIC', '0',
             (select count(*)::text from information_schema.column_privileges g
               where g.table_schema = 'public'
                 and g.table_name in ('pca_alteracoes_resumo', 'pca_conversao_edital_item', 'pca_conversao_edital_taxa')
                 and g.grantee in ('anon', 'PUBLIC'))
      union all
      -- tabelas base: RLS ligado e nenhuma policy para anon/PUBLIC
      select 'base rls', b.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(b.obj)), 'ausente')
        from bases b
      union all
      select 'base policy anon/public', b.obj, '0',
             (select count(*)::text from pg_policies pp
               where pp.schemaname || '.' || pp.tablename = b.obj
                 and (pp.roles && array['anon', 'public']::name[]))
        from bases b
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  raise notice 'pca_views_security_invoker_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'pca_views_security_invoker_check FALHOU: % de % checagens', f, n;
  end if;
end $$;

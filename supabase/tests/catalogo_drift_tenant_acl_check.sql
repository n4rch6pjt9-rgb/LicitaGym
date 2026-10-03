-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261002220000_versionar_drift_catalogo_tenant.
-- Só SELECT em catálogo e funções has_*_privilege (nenhuma escrita, nenhuma tabela temporária, nenhum dado).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/catalogo_drift_tenant_acl_check.sql
-- Também roda inteiro no SQL Editor do Supabase.
-- Resultado esperado: NOTICE "SUCESSO: catalogo_drift_tenant_acl_check: N checagens, 0 falhas".
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   objetos:  tenants, catalogo_precos, catalogo_de_para e v_catalogo_viabilidade existem; colunas do drift em
--             catalogo_produtos (tenant_id, atributos, fonte_documento, ativo) e índice uq_catprod_tenant_codigo.
--   grants:   anon, authenticated e PUBLIC sem nenhum privilégio nas 3 tabelas, na view e nas 3 sequences
--             (relação, coluna e information_schema); service_role com SELECT/INSERT/UPDATE/DELETE nas tabelas,
--             SELECT na view e USAGE nas sequences.
--   RLS:      ligado nas 3 tabelas; nenhuma policy nelas (acesso só por service_role, que ignora RLS).
--   view:     security_invoker=true.
-- catalogo_produtos (grants e policy catprod_select) continua coberto por sistema_s_catalogos_acl_check.sql.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    tabelas(obj) as (values ('public.tenants'), ('public.catalogo_precos'), ('public.catalogo_de_para')),
    objs(obj) as (select obj from tabelas union all values ('public.v_catalogo_viabilidade')),
    seqs(obj) as (values ('public.tenants_id_seq'), ('public.catalogo_precos_id_seq'),
                         ('public.catalogo_de_para_id_seq')),
    fechados(papel) as (values ('anon'), ('authenticated'), ('public')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    checks(grupo, objeto, esperado, atual) as (
      select 'objeto', o.obj, 'existe', case when to_regclass(o.obj) is null then 'ausente' else 'existe' end
        from objs o
      union all
      select 'objeto', s.obj, 'existe', case when to_regclass(s.obj) is null then 'ausente' else 'existe' end
        from seqs s
      union all
      select 'coluna', 'public.catalogo_produtos.' || c.col, 'existe',
             case when exists (select 1 from pg_attribute a
                                where a.attrelid = to_regclass('public.catalogo_produtos')
                                  and a.attname = c.col and a.attnum > 0 and not a.attisdropped)
                  then 'existe' else 'ausente' end
        from (values ('tenant_id'), ('atributos'), ('fonte_documento'), ('ativo')) c(col)
      union all
      select 'indice', 'public.uq_catprod_tenant_codigo', 'existe',
             case when to_regclass('public.uq_catprod_tenant_codigo') is null then 'ausente' else 'existe' end
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
                  and g.table_name in ('tenants', 'catalogo_precos', 'catalogo_de_para', 'v_catalogo_viabilidade')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
              + (select count(*) from information_schema.column_privileges g
                where g.table_schema = 'public'
                  and g.table_name in ('tenants', 'catalogo_precos', 'catalogo_de_para', 'v_catalogo_viabilidade')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC')))::text
      union all
      -- sequences: nada para anon/authenticated/PUBLIC
      select 'grant', s.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_sequence_privilege(r.papel, to_regclass(s.obj), p.p)::text, 'ausente')
        from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p) cross join fechados r
      union all
      -- service_role: leitura e escrita nas tabelas, leitura na view, uso das sequences
      select 'grant', t.obj || ' service_role ' || p.p, 'true',
             coalesce(has_table_privilege('service_role', to_regclass(t.obj), p.p)::text, 'ausente')
        from tabelas t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
      union all
      select 'grant', 'public.v_catalogo_viabilidade service_role SELECT', 'true',
             coalesce(has_table_privilege('service_role', to_regclass('public.v_catalogo_viabilidade'), 'SELECT')::text,
                      'ausente')
      union all
      select 'grant', s.obj || ' service_role USAGE', 'true',
             coalesce(has_sequence_privilege('service_role', to_regclass(s.obj), 'USAGE')::text, 'ausente')
        from seqs s
      union all
      -- RLS ligado e nenhuma policy nas 3 tabelas
      select 'rls', t.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.obj)), 'ausente')
        from tabelas t
      union all
      select 'policy', t.obj, '0',
             (select count(*)::text from pg_policies pp where pp.schemaname || '.' || pp.tablename = t.obj)
        from tabelas t
      union all
      select 'security_invoker', 'public.v_catalogo_viabilidade', 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass('public.v_catalogo_viabilidade')), 'ausente')
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
    raise exception 'ACL CHECK FALHOU: catalogo_drift_tenant_acl_check: % de % checagens', f, n;
  end if;
  raise notice 'SUCESSO: catalogo_drift_tenant_acl_check: % checagens, 0 falhas', n;
end $$;

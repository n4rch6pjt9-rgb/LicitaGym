-- Checagem da migration 20261008180000_portal_consulta.
-- anon e authenticated não leem. service_role tem DML. RLS ligado.

do $$
declare
  v_chk record;
  n int := 0;
  f int := 0;
begin
  for v_chk in
    with checks(grupo, objeto, esperado, atual) as (
      select 'rls', 'public.portal_consulta', 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass('public.portal_consulta')), 'ausente')
      union all
      select 'grant', r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass('public.portal_consulta'), p.p)::text, 'ausente')
        from (values ('anon'), ('authenticated'), ('public')) r(papel)
        cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(p)
      union all
      select 'grant', 'service_role ' || p.p, 'true',
             coalesce(has_table_privilege('service_role', to_regclass('public.portal_consulta'), p.p)::text, 'ausente')
        from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
    )
    select * from checks
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'ACL CHECK FALHOU: % % esperado=% atual=%', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  if f > 0 then
    raise exception 'ACL CHECK FALHOU: portal_consulta (% de % verificações)', f, n;
  end if;
  raise notice 'SUCESSO: portal_consulta (% verificações)', n;
end
$$;

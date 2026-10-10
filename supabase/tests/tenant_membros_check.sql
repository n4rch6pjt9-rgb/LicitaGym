-- Checagem da migration 20261007223000_tenant_membros.
-- anon não lê. authenticated tem DML, sem TRUNCATE. Dados bancários existem e têm RLS.
-- licitagym_role não aparece na policy.

do $$
declare
  v_chk record;
  n int := 0;
  f int := 0;
begin
  for v_chk in
    with
    privs(p) as (
      select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) v(p)
      union all
      select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000
    ),
    dml(p) as (
      select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(p)
    ),
    checks(grupo, objeto, esperado, atual) as (
      select 'rls', t.rel, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.rel)), 'ausente')
        from (values ('public.tenant_membros'), ('public.tenant_dados_restritos')) t(rel)
      union all
      select 'grant', r.papel || ' ' || t.rel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(t.rel), p.p)::text, 'ausente')
        from privs p
        cross join (values ('anon'), ('public')) r(papel)
        cross join (values ('public.tenant_membros'), ('public.tenant_dados_restritos')) t(rel)
      union all
      select 'grant', 'authenticated ' || t.rel || ' ' || p.p, 'true',
             coalesce(has_table_privilege('authenticated', to_regclass(t.rel), p.p)::text, 'ausente')
        from dml p
        cross join (values ('public.tenant_membros'), ('public.tenant_dados_restritos')) t(rel)
      union all
      select 'grant', 'authenticated ' || t.rel || ' ' || p.p, 'false',
             coalesce(has_table_privilege('authenticated', to_regclass(t.rel), p.p)::text, 'ausente')
        from (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(p)
        cross join (values ('public.tenant_membros'), ('public.tenant_dados_restritos')) t(rel)
      union all
      select 'policy', pol.polname, 'existe',
             case when exists (
               select 1 from pg_policy p
                where p.polrelid = to_regclass(pol.rel) and p.polname = pol.polname
             ) then 'existe' else 'ausente' end
        from (values
          ('public.tenant_membros', 'tenant_membros_select'),
          ('public.tenant_membros', 'tenant_membros_escrever'),
          ('public.tenant_dados_restritos', 'tenant_dados_restritos_admin')
        ) pol(rel, polname)
      union all
      select 'execute', 'anon tenant_papel', 'false',
             coalesce(has_function_privilege('anon', 'public.tenant_papel(bigint)', 'EXECUTE')::text, 'ausente')
      union all
      select 'execute', 'authenticated tenant_papel', 'true',
             coalesce(has_function_privilege('authenticated', 'public.tenant_papel(bigint)', 'EXECUTE')::text, 'ausente')
      union all
      select 'execute', 'anon licitagym_desenvolvedor', 'false',
             coalesce(has_function_privilege('anon', 'public.licitagym_desenvolvedor()', 'EXECUTE')::text, 'ausente')
      union all
      select 'execute', 'authenticated licitagym_desenvolvedor', 'true',
             coalesce(has_function_privilege('authenticated', 'public.licitagym_desenvolvedor()', 'EXECUTE')::text, 'ausente')
      union all
      select 'policy', pol.polname, 'existe',
             case when exists (
               select 1 from pg_policy p
                where p.polrelid = to_regclass(pol.rel) and p.polname = pol.polname
             ) then 'existe' else 'ausente' end
        from (values
          ('public.tenant_membros', 'tenant_membros_desenvolvedor'),
          ('public.tenant_dados_restritos', 'tenant_dados_restritos_desenvolvedor'),
          ('public.tenants', 'tenants_desenvolvedor')
        ) pol(rel, polname)
    )
    select * from checks
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA % % esperado=% atual=%', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;
  if exists (
    select 1 from pg_policy p
     where p.polrelid in (
       'public.tenant_membros'::regclass,
       'public.tenant_dados_restritos'::regclass,
       'public.tenants'::regclass
     )
       and (
         pg_get_expr(p.polqual, p.polrelid) like '%user_metadata%'
         or pg_get_expr(p.polwithcheck, p.polrelid) like '%user_metadata%'
       )
  ) then
    f := f + 1;
    raise notice 'FALHA policy usa user_metadata';
  end if;
  -- 20261010140000 (#263): vínculo só vale com a empresa ativa; a função continua security definer com search_path fixo.
  n := n + 2;
  -- Lê public.tenants e exige t.ativo e m.ativo verdadeiros (sem "= false"). Teste por comportamento não dá: o stub de
  -- supabase/tests/pre.sql faz auth.uid() devolver sempre null.
  if coalesce((
    select p.prosrc ~* '\mpublic\.tenants\M'
       and p.prosrc ~* '\mt\.ativo\M(?!\s*(=|is)\s*(false|not))'
       and p.prosrc ~* '\mm\.ativo\M(?!\s*(=|is)\s*(false|not))'
      from pg_proc p where p.oid = to_regprocedure('public.tenant_papel(bigint)')
  ), false) is not true then
    f := f + 1;
    raise notice 'FALHA tenant_papel não exige tenants.ativo';
  end if;
  if coalesce((
    select p.prosecdef and coalesce(array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%', false)
      from pg_proc p where p.oid = to_regprocedure('public.tenant_papel(bigint)')
  ), false) is not true then
    f := f + 1;
    raise notice 'FALHA tenant_papel sem security definer ou search_path fixo';
  end if;
  if f > 0 then
    raise exception 'ACL CHECK FALHOU: tenant_membros % checagens, % falhas', n, f;
  end if;
  raise notice 'SUCESSO: tenant_membros % checagens, 0 falhas', n;
end
$$;

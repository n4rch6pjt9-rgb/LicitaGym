-- Checagem da migration 20261010100100_agente_execucoes.
-- RLS ligada, nenhuma policy, anon e authenticated sem privilégio. Falha com EXCEPTION.

do $$
declare
  r text;
  p text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agente_execucoes'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em public.agente_execucoes';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.agente_execucoes'::regclass) then
    raise exception 'CHECK FALHOU: policy em public.agente_execucoes';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.agente_execucoes'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em public.agente_execucoes', r, p;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.agente_execucoes'::regclass, 'SELECT')
     or not has_table_privilege('service_role', 'public.agente_execucoes'::regclass, 'INSERT')
     or not has_table_privilege('service_role', 'public.agente_execucoes'::regclass, 'UPDATE') then
    raise exception 'CHECK FALHOU: service_role sem select/insert/update em public.agente_execucoes';
  end if;
  raise notice 'SUCESSO: agente_execucoes ACL';
end $$;

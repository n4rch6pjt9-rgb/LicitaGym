-- Checagem da migration 20261007133000_saude_rpc_public.
-- Invólucro public, security definer, EXECUTE só service_role.

do $$
declare
  v_fn regprocedure := to_regprocedure('public.saude_operacional_resumo()');
begin
  if v_fn is null then
    raise exception 'CHECK FALHOU: public.saude_operacional_resumo() não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE')
     or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'CHECK FALHOU: anon ou authenticated executa public.saude_operacional_resumo()';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa public.saude_operacional_resumo()';
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = v_fn
       and prosecdef
       and 'search_path=pg_catalog, private, pg_temp' = any (proconfig)
  ) then
    raise exception 'CHECK FALHOU: invólucro precisa ser security definer com search_path fixo';
  end if;
  raise notice 'SUCESSO: saude rpc public';
end $$;

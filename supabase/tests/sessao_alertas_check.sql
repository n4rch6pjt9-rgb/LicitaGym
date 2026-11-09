-- Spec 0039, etapa 1b (CA-7f): public.sessao_alertas e private.sessao_alertas_destinos(bigint).
--   1. tabela existe, RLS ligada, sem policy; anon/authenticated sem nenhum privilégio; service_role lê e escreve
--   2. único por (tenant_id, chave_mensagem); tipo só convocacao_anexos | etapa_fechada
--   3. sessao_alertas_destinos: security invoker, search_path fixo, EXECUTE só service_role
-- Só leitura. Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_fn regprocedure := to_regprocedure('private.sessao_alertas_destinos(bigint)');
  v_priv text;
begin
  if to_regclass('public.sessao_alertas') is null then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: public.sessao_alertas não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.sessao_alertas'::regclass) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: RLS desligado';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessao_alertas') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: há policy (leitura só por Edge Function)';
  end if;
  foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('anon', 'public.sessao_alertas', v_priv)
       or has_table_privilege('authenticated', 'public.sessao_alertas', v_priv) then
      raise exception 'SESSAO_ALERTAS CHECK FALHOU: anon/authenticated tem % em sessao_alertas', v_priv;
    end if;
  end loop;
  foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
    if not has_table_privilege('service_role', 'public.sessao_alertas', v_priv) then
      raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role sem % em sessao_alertas', v_priv;
    end if;
  end loop;

  if not exists (
    select 1 from pg_index i
     where i.indrelid = 'public.sessao_alertas'::regclass and i.indisunique
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum) = array['tenant_id', 'chave_mensagem']
  ) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: falta único (tenant_id, chave_mensagem)';
  end if;
  begin
    insert into public.sessao_alertas (tenant_id, licitacao_id, chave_mensagem, tipo, mensagem_em)
    values (-1, -1, gen_random_uuid(), 'outro_tipo', now());
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: aceitou tipo fora da lista';
  exception
    when check_violation or foreign_key_violation then null;
  end;

  if v_fn is null then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: private.sessao_alertas_destinos(bigint) não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: anon/authenticated executa sessao_alertas_destinos';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: service_role não executa sessao_alertas_destinos';
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn and not prosecdef
                  and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    raise exception 'SESSAO_ALERTAS CHECK FALHOU: sessao_alertas_destinos precisa ser security invoker com search_path fixo';
  end if;

  raise notice 'SUCESSO: sessao_alertas e sessao_alertas_destinos conferidos';
end $$;

-- Checagem da migration 20261020150000_fila_preparacao_solicitar (spec 0032, fase 1, CA-1).
--   ACL; "Analisar" enfileira um pedido para licitação fora do pipeline, sem duplicar o aberto; depois de failed,
--   enfileira de novo; recusa empresa inativa e licitação inexistente. Tudo desfeito ao final.

do $$
declare
  r     text;
  v_t   bigint;
  v_l1  bigint;
  v_st  text;
  v_ok  boolean;
  v_id  uuid;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.fila_preparacao_solicitar(bigint,bigint)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa fila_preparacao_solicitar', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.fila_preparacao_solicitar(bigint,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa fila_preparacao_solicitar';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-solicitar-1', 'Check solicitar 1') returning id into v_t;
    insert into public.licitacoes_externas (fonte) values ('sestsenat') returning id into v_l1;

    -- fora do pipeline: enfileira com fonte e origem; de novo, com o pedido aberto, não duplica
    v_st := public.fila_preparacao_solicitar(v_t, v_l1);
    if v_st is distinct from 'enfileirado' then raise exception 'CHECK FALHOU: primeiro pedido devolveu %', v_st; end if;
    if (select payload ->> 'fonte' || '/' || (payload ->> 'origem') from private.job_queue
         where job_type = 'preparar_triagem' and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text)
       is distinct from 'sestsenat/analisar' then
      raise exception 'CHECK FALHOU: pedido sem fonte ou origem';
    end if;
    if (select status from public.pipeline_preparacao_estado(v_t, array[v_l1])) is distinct from 'pending' then
      raise exception 'CHECK FALHOU: estado não ficou pending';
    end if;
    v_st := public.fila_preparacao_solicitar(v_t, v_l1);
    if v_st is distinct from 'ja_na_fila' then raise exception 'CHECK FALHOU: segundo pedido devolveu %', v_st; end if;
    if (select count(*) from private.job_queue where job_type = 'preparar_triagem'
         and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text) <> 1 then
      raise exception 'CHECK FALHOU: pedido aberto duplicado';
    end if;

    -- em processamento também não duplica
    update private.job_queue set status = 'processing', attempts = 1
     where job_type = 'preparar_triagem' and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text
    returning id into v_id;
    if public.fila_preparacao_solicitar(v_t, v_l1) is distinct from 'ja_na_fila' then
      raise exception 'CHECK FALHOU: duplicou pedido em processamento';
    end if;

    -- falhou: pedir de novo cria pedido novo, e o estado volta a pending
    update private.job_queue set status = 'failed', last_error = 'download: HTTP 504' where id = v_id;
    if public.fila_preparacao_solicitar(v_t, v_l1) is distinct from 'enfileirado' then
      raise exception 'CHECK FALHOU: não reenfileirou depois de failed';
    end if;
    if (select count(*) from private.job_queue where job_type = 'preparar_triagem'
         and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text) <> 2 then
      raise exception 'CHECK FALHOU: esperado o pedido failed e o novo';
    end if;

    -- recusas
    v_ok := false;
    begin perform public.fila_preparacao_solicitar(v_t, -1); exception when sqlstate 'P0002' then v_ok := true; end;
    if not v_ok then raise exception 'CHECK FALHOU: aceitou licitação inexistente'; end if;
    update public.tenants set ativo = false where id = v_t;
    v_ok := false;
    begin perform public.fila_preparacao_solicitar(v_t, v_l1); exception when sqlstate '42501' then v_ok := true; end;
    if not v_ok then raise exception 'CHECK FALHOU: aceitou empresa inativa'; end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'fila_preparacao_solicitar_check: OK';
end;
$$;

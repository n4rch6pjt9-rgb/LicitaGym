-- Checagem da migration 20261011160000_fila_preparacao_triagem (spec 0018, PR 4a; CA-17).
--   ACL; entrar em Triagem enfileira um pedido por (empresa, licitação), sem duplicar; reivindicar/concluir;
--   reagendar com erro; estado para a tela. Tudo desfeito ao final.

do $$
declare
  r      text;
  f      text;
  v_t    bigint;
  v_t2   bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000000f2';
  v_nova bigint; v_tri bigint; v_ana bigint; v_tri2 bigint; v_nova2 bigint;
  v_l1   bigint;
  v_l2   bigint;
  v_l3   bigint;
  v_job  record;
  v_st   text;
  v_ok   boolean;
  v_n    integer := 0;
begin
  foreach f in array array[
    'public.fila_preparacao_reivindicar(integer)',
    'public.fila_preparacao_concluir(uuid,text,text,integer)',
    'public.pipeline_preparacao_estado(bigint,bigint[])',
    'public.pipeline_oportunidades_enfileirar_triagem()'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % executa %', r, f;
      end if;
    end loop;
  end loop;
  foreach f in array array['public.fila_preparacao_reivindicar(integer)', 'public.fila_preparacao_concluir(uuid,text,text,integer)',
                           'public.pipeline_preparacao_estado(bigint,bigint[])'] loop
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', f;
    end if;
  end loop;
  -- a fila guarda tenant_id e o schema private está exposto no PostgREST: só service_role lê/escreve
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'private.job_queue', 'SELECT') or has_table_privilege(r, 'private.job_queue', 'INSERT')
       or has_table_privilege(r, 'private.job_queue', 'UPDATE') then
      raise exception 'CHECK FALHOU: % acessa private.job_queue', r;
    end if;
  end loop;

  begin
    insert into public.tenants (slug, nome) values ('check-fila-1', 'Check fila 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-fila-2', 'Check fila 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';
    select id into v_tri  from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_ana  from public.pipeline_etapas where tenant_id = v_t and nome = 'Em análise';
    select id into v_tri2 from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Triagem';
    select id into v_nova2 from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Nova';
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;
    insert into public.licitacoes_externas (fonte) values ('sestsenat') returning id into v_l2;

    -- Nova não enfileira; Triagem enfileira um pedido; ir e voltar com pedido aberto não duplica
    perform public.pipeline_mover(v_t, array[v_l1], v_nova, null, v_u);
    if exists (select 1 from private.job_queue where job_type = 'preparar_triagem' and payload ->> 'licitacao_id' = v_l1::text) then
      raise exception 'CHECK FALHOU: entrar em Nova enfileirou';
    end if;
    perform public.pipeline_mover(v_t, array[v_l1, v_l2], v_tri, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_ana, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    if (select count(*) from private.job_queue where job_type = 'preparar_triagem'
         and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text) <> 1 then
      raise exception 'CHECK FALHOU: CA-17 Triagem → Em análise → Triagem duplicou o pedido aberto';
    end if;
    if (select payload ->> 'fonte' from private.job_queue where job_type = 'preparar_triagem'
         and payload ->> 'licitacao_id' = v_l2::text) is distinct from 'sestsenat' then
      raise exception 'CHECK FALHOU: pedido sem a fonte (o consumidor pula o PNCP fora do PNCP)';
    end if;
    -- outra empresa com a mesma licitação tem o próprio pedido
    perform public.pipeline_mover(v_t2, array[v_l1], v_tri2, null, v_u);
    if (select count(*) from private.job_queue where job_type = 'preparar_triagem' and payload ->> 'licitacao_id' = v_l1::text) <> 2 then
      raise exception 'CHECK FALHOU: pedido da empresa 2 não foi criado';
    end if;

    -- estado: pendente
    if (select status from public.pipeline_preparacao_estado(v_t, array[v_l1])) is distinct from 'pending'
       or exists (select 1 from public.pipeline_preparacao_estado(v_t, array[v_l1]) where licitacao_id <> v_l1) then
      raise exception 'CHECK FALHOU: estado da preparação';
    end if;

    -- reivindicar pega os pedidos e marca processing; pegar de novo não devolve os mesmos
    for v_job in select * from public.fila_preparacao_reivindicar(10) loop
      v_n := v_n + 1;
      if v_job.tentativa <> 1 then raise exception 'CHECK FALHOU: tentativa %', v_job.tentativa; end if;
      if not ((v_job.tenant_id = v_t and v_job.licitacao_id in (v_l1, v_l2)) or (v_job.tenant_id = v_t2 and v_job.licitacao_id = v_l1))
         or (v_job.licitacao_id = v_l2 and v_job.fonte is distinct from 'sestsenat') then
        raise exception 'CHECK FALHOU: reivindicar devolveu pedido inesperado (%, %, %)', v_job.tenant_id, v_job.licitacao_id, v_job.fonte;
      end if;
    end loop;
    if v_n <> 3 then
      raise exception 'CHECK FALHOU: reivindicar devolveu % pedido(s), esperado 3', v_n;
    end if;
    if exists (select 1 from public.fila_preparacao_reivindicar(10)) then
      raise exception 'CHECK FALHOU: reivindicar devolveu pedido já em processamento';
    end if;
    -- com pedido em processamento, voltar a Triagem não duplica
    perform public.pipeline_mover(v_t, array[v_l1], v_ana, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    if (select count(*) from private.job_queue where job_type = 'preparar_triagem'
         and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text) <> 1 then
      raise exception 'CHECK FALHOU: pedido em processamento foi duplicado';
    end if;

    -- concluir: resultado grava no payload; erro reagenda
    select id into v_job from private.job_queue where job_type = 'preparar_triagem'
       and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text;
    v_ok := false;
    begin perform public.fila_preparacao_concluir(v_job.id, 'ok', null, 2); exception when sqlstate 'P0002' then v_ok := true; end;
    if not v_ok then raise exception 'CHECK FALHOU: concluiu com tentativa de outro job'; end if;
    v_st := public.fila_preparacao_concluir(v_job.id, 'ok', null, 1);
    if v_st is distinct from 'completed' or (select payload ->> 'resultado' from private.job_queue where id = v_job.id) is distinct from 'ok' then
      raise exception 'CHECK FALHOU: concluir ok';
    end if;
    select id into v_job from private.job_queue where job_type = 'preparar_triagem'
       and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l2::text;
    v_st := public.fila_preparacao_concluir(v_job.id, null, 'PNCP 504');
    if v_st is distinct from 'pending' or (select scheduled_for from private.job_queue where id = v_job.id) <= now()
       or (select last_error from private.job_queue where id = v_job.id) is distinct from 'PNCP 504' then
      raise exception 'CHECK FALHOU: erro não reagendou';
    end if;
    -- concluído: entrar de novo em Triagem cria pedido novo
    perform public.pipeline_mover(v_t, array[v_l1], v_ana, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    if (select status from public.pipeline_preparacao_estado(v_t, array[v_l1])) is distinct from 'pending' then
      raise exception 'CHECK FALHOU: nova entrada em Triagem após concluir não criou pedido';
    end if;

    -- recusas
    v_ok := false;
    begin perform public.fila_preparacao_concluir(v_job.id, 'qualquer'); exception when sqlstate '22023' then v_ok := true; end;
    if not v_ok then raise exception 'CHECK FALHOU: aceitou resultado inválido'; end if;
    v_ok := false;
    begin perform public.fila_preparacao_concluir(v_job.id, 'ok'); exception when sqlstate 'P0002' then v_ok := true; end;
    if not v_ok then raise exception 'CHECK FALHOU: concluiu pedido que não está em processamento'; end if;

    -- concluir com resultado limpa o erro da tentativa anterior (card preparado não mostra erro antigo)
    update private.job_queue set scheduled_for = now() - interval '1 second' where id = v_job.id;
    perform public.fila_preparacao_reivindicar(50);
    perform public.fila_preparacao_concluir(v_job.id, 'sem_documento');
    if (select last_error from private.job_queue where id = v_job.id) is not null
       or (select erro from public.pipeline_preparacao_estado(v_t, array[v_l2])) is not null then
      raise exception 'CHECK FALHOU: pedido concluído manteve o erro antigo';
    end if;

    -- pedido preso em processing (job que morreu) com tentativas esgotadas vira failed, não volta para sempre
    update private.job_queue set status = 'processing', attempts = max_attempts, updated_at = now() - interval '2 hours'
     where job_type = 'preparar_triagem' and payload ->> 'tenant_id' = v_t::text and payload ->> 'licitacao_id' = v_l1::text
       and status in ('pending', 'processing');
    perform public.fila_preparacao_reivindicar(50);
    -- (consulta a tabela: na transação do check os created_at empatam)
    if not exists (select 1 from private.job_queue where job_type = 'preparar_triagem' and payload ->> 'tenant_id' = v_t::text
                     and payload ->> 'licitacao_id' = v_l1::text and status = 'failed' and last_error like 'interrompido%') then
      raise exception 'CHECK FALHOU: pedido preso com tentativas esgotadas não virou failed';
    end if;

    -- CA-20: excluir etapa movendo os cards para Triagem enfileira
    perform public.pipeline_mover(v_t2, array[v_l2], v_nova2, null, v_u);
    perform public.pipeline_etapa_excluir(v_t2, v_nova2, v_tri2, v_u);
    if (select status from public.pipeline_preparacao_estado(v_t2, array[v_l2])) is distinct from 'pending' then
      raise exception 'CHECK FALHOU: CA-20 card movido por exclusão de etapa não entrou na fila';
    end if;

    -- empresa inativa não ganha pedido
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_l3;
    update public.tenants set ativo = false where id = v_t2;
    perform public.pipeline_mover(v_t2, array[v_l3], v_tri2, null, v_u);
    if exists (select 1 from private.job_queue where job_type = 'preparar_triagem'
                and payload ->> 'tenant_id' = v_t2::text and payload ->> 'licitacao_id' = v_l3::text) then
      raise exception 'CHECK FALHOU: empresa inativa ganhou pedido novo';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: fila_preparacao_triagem ok (desfeito)';
end
$$;

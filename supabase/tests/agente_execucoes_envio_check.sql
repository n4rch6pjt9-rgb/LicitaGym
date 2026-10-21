-- Checagem da migration 20261021130200_agente_execucoes_envio (spec 0035: K-3, K-4, K-15, R-7 a R-9; CA-6, CA-7,
-- CA-9, CA-24, CA-29, CA-30).
--   ACL; envio liga a tarefa aberta do mesmo agente na etapa atual; segundo envio dá LG003; outra empresa não acha a
--   execução; aprovar conclui a tarefa; rejeitar reabre; reenvio de rejeitada guarda a revisão anterior; tirar do
--   pipeline anula tarefa_id. Tudo o que grava é desfeito ao final.

do $$
declare
  r      text;
  v_t    bigint;
  v_t2   bigint;
  v_nova bigint;
  v_l    bigint;
  v_e    bigint;
  v_ej   bigint;
  v_tar  bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000035b1';
  v_ok   boolean;
  v_x    public.agente_execucoes%rowtype;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.agente_execucao_enviar(bigint,bigint,uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa agente_execucao_enviar', r;
    end if;
    if has_table_privilege(r, 'public.agente_execucoes', 'SELECT') then
      raise exception 'CHECK FALHOU: % lê agente_execucoes', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.agente_execucao_enviar(bigint,bigint,uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa agente_execucao_enviar';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-envio-1', 'Check envio 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-envio-2', 'Check envio 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l;
    perform public.pipeline_mover(v_t, array[v_l], v_nova, null, v_u);
    select id into v_tar from public.tarefas_equipe
     where tenant_id = v_t and licitacao_id = v_l and responsavel_agente = 'edital';

    insert into public.agente_execucoes (tenant_id, licitacao_id, agente, situacao, contexto_hash, regra_versao, solicitado_por)
    values (v_t, v_l, 'edital', 'ok', repeat('a', 64), 'teste', v_u) returning id into v_e;
    insert into public.agente_execucoes (tenant_id, licitacao_id, agente, situacao, contexto_hash, regra_versao, solicitado_por)
    values (v_t, v_l, 'juridico', 'ok', repeat('b', 64), 'teste', v_u) returning id into v_ej;

    -- CA-6: colunas novas nulas por padrão
    if exists (select 1 from public.agente_execucoes where id = v_e
                and (enviada_em is not null or tarefa_id is not null or revisoes_anteriores <> '[]'::jsonb)) then
      raise exception 'CHECK FALHOU: execução nova já nasce enviada';
    end if;

    -- CA-9: outra empresa não acha a execução
    v_ok := false;
    begin
      perform public.agente_execucao_enviar(v_t2, v_e, v_u);
    exception when sqlstate 'P0002' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: outra empresa enviou a execução';
    end if;

    -- CA-7 / R-8: envio liga a tarefa do mesmo agente na etapa atual
    select * into v_x from public.agente_execucao_enviar(v_t, v_e, v_u);
    if v_x.enviada_em is null or v_x.enviada_por <> v_u or v_x.tarefa_id is distinct from v_tar then
      raise exception 'CHECK FALHOU: envio não gravou ou ligou a tarefa errada (%, esperado %)', v_x.tarefa_id, v_tar;
    end if;
    -- CA-29: segundo envio dá LG003
    v_ok := false;
    begin
      perform public.agente_execucao_enviar(v_t, v_e, v_u);
    exception when sqlstate 'LG003' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: segundo envio aceito';
    end if;

    -- CA-24: aprovar conclui a tarefa
    update public.agente_execucoes set revisao = 'aprovada', revisado_por = v_u, revisado_em = now() where id = v_e;
    if (select status from public.tarefas_equipe where id = v_tar) <> 'concluida' then
      raise exception 'CHECK FALHOU: aprovar não concluiu a tarefa';
    end if;
    -- aprovada não pode ser reenviada
    v_ok := false;
    begin
      perform public.agente_execucao_enviar(v_t, v_e, v_u);
    exception when sqlstate 'LG003' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: aprovada foi reenviada';
    end if;

    -- CA-30: rejeitada reabre a tarefa e pode ser reenviada, guardando a revisão anterior
    select * into v_x from public.agente_execucao_enviar(v_t, v_ej, v_u);
    update public.agente_execucoes set revisao = 'rejeitada', revisao_nota = 'faltou o TR', revisado_por = v_u,
           revisado_em = now() where id = v_ej;
    update public.tarefas_equipe set status = 'concluida', concluida_em = now() where id = v_x.tarefa_id;
    update public.agente_execucoes set revisao = 'aguardando', revisao_nota = null, revisado_por = null, revisado_em = null
     where id = v_ej;
    update public.agente_execucoes set revisao = 'rejeitada', revisao_nota = 'faltou o TR', revisado_por = v_u,
           revisado_em = now() where id = v_ej;
    if (select status from public.tarefas_equipe where id = v_x.tarefa_id) <> 'aberta' then
      raise exception 'CHECK FALHOU: rejeitar não reabriu a tarefa';
    end if;
    select * into v_x from public.agente_execucao_enviar(v_t, v_ej, v_u);
    if v_x.revisao <> 'aguardando' or jsonb_array_length(v_x.revisoes_anteriores) <> 1
       or v_x.revisoes_anteriores -> 0 ->> 'nota' <> 'faltou o TR' or v_x.revisado_por is not null then
      raise exception 'CHECK FALHOU: reenvio de rejeitada (%)', v_x.revisoes_anteriores;
    end if;

    -- aprovada antes da spec 0035 (nunca enviada): o envio guarda a aprovação em revisoes_anteriores
    insert into public.agente_execucoes (tenant_id, licitacao_id, agente, situacao, contexto_hash, regra_versao, solicitado_por,
                                         revisao, revisado_por, revisado_em)
    values (v_t, v_l, 'preco', 'ok', repeat('c', 64), 'teste', v_u, 'aprovada', v_u, now()) returning id into v_e;
    select * into v_x from public.agente_execucao_enviar(v_t, v_e, v_u);
    if v_x.revisao <> 'aguardando' or v_x.revisoes_anteriores -> 0 ->> 'decisao' <> 'aprovada' then
      raise exception 'CHECK FALHOU: envio de aprovada antiga perdeu a aprovação (%)', v_x.revisoes_anteriores;
    end if;

    -- R-7: tirar do pipeline apaga a tarefa e anula tarefa_id (a execução fica)
    perform public.pipeline_mover(v_t, array[v_l], null, null, v_u);
    if exists (select 1 from public.agente_execucoes where tenant_id = v_t and tarefa_id is not null)
       or (select count(*) from public.agente_execucoes where tenant_id = v_t) <> 3 then
      raise exception 'CHECK FALHOU: tarefa_id não foi anulado ao tirar do pipeline';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: agente_execucoes_envio ok (desfeito)';
end
$$;

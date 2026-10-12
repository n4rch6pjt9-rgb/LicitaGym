-- Checagem de 20261011235000_pipeline_remover_apaga_tarefas.
-- Remover do Kanban apaga as tarefas daquela empresa. Mudar de etapa não apaga. Outra empresa não é afetada.
-- O que o teste grava é desfeito.

do $$
declare
  v_t1  bigint;
  v_t2  bigint;
  v_u   uuid := '00000000-0000-0000-0000-0000000000f7';
  v_tri bigint;
  v_doc bigint;
  v_l1  bigint;
  v_n   integer;
begin
  begin
    insert into public.tenants (slug, nome) values ('check-remover-tarefas-1', 'Check remover 1') returning id into v_t1;
    insert into public.tenants (slug, nome) values ('check-remover-tarefas-2', 'Check remover 2') returning id into v_t2;
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t1 and nome = 'Triagem';
    select id into v_doc from public.pipeline_etapas where tenant_id = v_t1 and nome = 'Documentação';
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;

    perform public.pipeline_mover(v_t1, array[v_l1], v_tri, null, v_u);
    select count(*) into v_n from public.tarefas_equipe where tenant_id = v_t1 and licitacao_id = v_l1;
    if v_n < 1 then
      raise exception 'CHECK FALHOU: Triagem não criou tarefa';
    end if;

    -- mudar de etapa conserva as tarefas
    perform public.pipeline_mover(v_t1, array[v_l1], v_doc, null, v_u);
    if (select count(*) from public.tarefas_equipe where tenant_id = v_t1 and licitacao_id = v_l1) <> v_n then
      raise exception 'CHECK FALHOU: mudar de etapa apagou tarefa';
    end if;

    -- a outra empresa, com a mesma licitação, não perde as suas quando a primeira sai
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Triagem';
    perform public.pipeline_mover(v_t2, array[v_l1], v_tri, null, v_u);
    select count(*) into v_n from public.tarefas_equipe where tenant_id = v_t2 and licitacao_id = v_l1;
    if v_n < 1 then
      raise exception 'CHECK FALHOU: empresa 2 sem tarefa';
    end if;

    perform public.pipeline_mover(v_t1, array[v_l1], null, null, v_u);
    if exists (select 1 from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_l1) then
      raise exception 'CHECK FALHOU: card da empresa 1 continua no Kanban';
    end if;
    if exists (select 1 from public.tarefas_equipe where tenant_id = v_t1 and licitacao_id = v_l1) then
      raise exception 'CHECK FALHOU: tarefa da empresa 1 sobreviveu à saída do Kanban';
    end if;
    if (select count(*) from public.tarefas_equipe where tenant_id = v_t2 and licitacao_id = v_l1) <> v_n then
      raise exception 'CHECK FALHOU: a saída da empresa 1 apagou tarefa da empresa 2';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: remover do Kanban apaga as tarefas da empresa (desfeito)';
end
$$;

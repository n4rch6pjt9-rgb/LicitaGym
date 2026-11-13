-- Checagem da migration 20261011170000_pipeline_tarefas_abertas (spec 0018, PR 5a).
--   ACL; conta só aberta/em_andamento, só da empresa pedida, só das licitações pedidas. Tudo desfeito ao final.

do $$
declare
  r     text;
  v_t   bigint;
  v_t2  bigint;
  v_u   uuid := '00000000-0000-0000-0000-0000000000f3';
  v_tri bigint;
  v_l1  bigint;
  v_l2  bigint;
  v_n   integer;
  v_tot integer;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.pipeline_tarefas_abertas(bigint,bigint[])'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa pipeline_tarefas_abertas', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.pipeline_tarefas_abertas(bigint,bigint[])'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa pipeline_tarefas_abertas';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-abertas-1', 'Check abertas 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-abertas-2', 'Check abertas 2') returning id into v_t2;
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;
    insert into public.licitacoes_externas (fonte) values ('sestsenat') returning id into v_l2;

    -- entrar em Triagem cria as tarefas da empresa do modelo padrão
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    select count(*) into v_tot from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1;
    if v_tot < 2 then
      raise exception 'CHECK FALHOU: esperava ao menos 2 tarefas em Triagem, há %', v_tot;
    end if;

    select abertas into v_n from public.pipeline_tarefas_abertas(v_t, array[v_l1, v_l2]) where licitacao_id = v_l1;
    if v_n is distinct from v_tot then
      raise exception 'CHECK FALHOU: abertas % <> total %', v_n, v_tot;
    end if;

    -- concluída não conta; em_andamento conta
    update public.tarefas_equipe set status = 'concluida', concluida_em = now()
     where id = (select min(id) from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1);
    update public.tarefas_equipe set status = 'em_andamento'
     where id = (select max(id) from public.tarefas_equipe where tenant_id = v_t and licitacao_id = v_l1);
    select abertas into v_n from public.pipeline_tarefas_abertas(v_t, array[v_l1]);
    if v_n is distinct from v_tot - 1 then
      raise exception 'CHECK FALHOU: concluída contou (abertas %, esperado %)', v_n, v_tot - 1;
    end if;

    -- licitação sem tarefa não aparece
    if exists (select 1 from public.pipeline_tarefas_abertas(v_t, array[v_l2])) then
      raise exception 'CHECK FALHOU: licitação sem tarefa apareceu';
    end if;
    -- empresa 2 com a mesma licitação: cada uma conta só as suas (sem soma entre empresas)
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Triagem';
    perform public.pipeline_mover(v_t2, array[v_l1], v_tri, null, v_u);
    select abertas into v_n from public.pipeline_tarefas_abertas(v_t2, array[v_l1]);
    if v_n is distinct from (select count(*)::integer from public.tarefas_equipe where tenant_id = v_t2 and licitacao_id = v_l1) then
      raise exception 'CHECK FALHOU: contagem da empresa 2 (%) errada', v_n;
    end if;
    select abertas into v_n from public.pipeline_tarefas_abertas(v_t, array[v_l1]);
    if v_n is distinct from v_tot - 1 then
      raise exception 'CHECK FALHOU: contagem da empresa 1 mudou com as tarefas da empresa 2 (%)', v_n;
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_tarefas_abertas ok (desfeito)';
end
$$;

-- Checagem da migration 20261011180000_pipeline_tarefas_pendencia_reativacao (revisão do PR #329, spec 0018).
--   pendência limpa com bloqueio de regulamento e fora do pipeline; reativar empresa não recria etapa excluída e
--   semeia o modelo nas etapas existentes. Tudo desfeito ao final.

do $$
declare
  v_t    bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000000f4';
  v_tri  bigint;
  v_ana  bigint;
  v_l1   bigint;
  v_l2   bigint;
  v_r    record;
begin
  if has_function_privilege('authenticated', 'public.pipeline_tarefas_reaplicar(bigint,bigint,uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: authenticated executa pipeline_tarefas_reaplicar';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-pend-1', 'Check pendência 1') returning id into v_t;
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_ana from public.pipeline_etapas where tenant_id = v_t and nome = 'Em análise';
    insert into public.licitacoes_externas (fonte, regulamento) values ('sestsenat', 'OUTRO') returning id into v_l1;
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_l2;

    -- regulamento sem catálogo é estado final: reaplicar termina com bloqueio e limpa a pendência antiga
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    insert into private.pipeline_tarefas_pendencias (tenant_id, licitacao_id, motivo, erro)
    values (v_t, v_l1, 'reaplicar_falhou', 'teste');
    select * into v_r from public.pipeline_tarefas_reaplicar(v_t, v_l1, null);
    if v_r.bloqueio is distinct from 'regulamento_sem_catalogo' then
      raise exception 'CHECK FALHOU: bloqueio esperado regulamento_sem_catalogo, veio %', v_r.bloqueio;
    end if;
    if exists (select 1 from private.pipeline_tarefas_pendencias where tenant_id = v_t and licitacao_id = v_l1) then
      raise exception 'CHECK FALHOU: pendência ficou depois de reaplicar com bloqueio (alerta falso permanente)';
    end if;

    -- fora do pipeline: a pendência deixa de valer
    insert into private.pipeline_tarefas_pendencias (tenant_id, licitacao_id, motivo) values (v_t, v_l2, 'reaplicar_falhou');
    select * into v_r from public.pipeline_tarefas_reaplicar(v_t, v_l2, null);
    if v_r.bloqueio <> 'fora_do_pipeline'
       or exists (select 1 from private.pipeline_tarefas_pendencias where tenant_id = v_t and licitacao_id = v_l2) then
      raise exception 'CHECK FALHOU: pendência de licitação fora do pipeline não foi limpa';
    end if;

    -- reativar a empresa não recria etapa excluída, mas semeia o modelo que falta nas etapas existentes
    perform public.pipeline_mover(v_t, array[v_l1], v_ana, null, v_u);
    perform public.pipeline_etapa_excluir(v_t, v_tri, null, v_u);
    delete from public.pipeline_etapa_tarefas where tenant_id = v_t and etapa_id = v_ana;
    update public.tenants set ativo = false where id = v_t;
    update public.tenants set ativo = true where id = v_t;
    if exists (select 1 from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem') then
      raise exception 'CHECK FALHOU: reativar recriou a etapa Triagem excluída pelo admin';
    end if;
    if not exists (select 1 from public.pipeline_etapa_tarefas where tenant_id = v_t and etapa_id = v_ana) then
      raise exception 'CHECK FALHOU: reativar não semeou o modelo de Em análise';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_tarefas_pendencia_reativacao ok (desfeito)';
end
$$;

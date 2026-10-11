-- Checagem da migration 20261011140100_pipeline_etapa_tarefas_ajustes (revisão do PR #327) e das lacunas apontadas no
-- check de 20261011120000: prazo da tarefa da empresa ao voltar à etapa, filha desligada, criar fora do pipeline,
-- pendência observável, empresa reativada, CA-13 pelo gatilho, CA-21 com OUTRO, CA-22 pelo caminho real (amparo_legal),
-- etapa excluída ignorada e eventos do certame não reliberados. Tudo desfeito ao final.

do $$
declare
  r       text;
  v_t     bigint;
  v_u     uuid := '00000000-0000-0000-0000-0000000000f1';
  v_tri   bigint; v_doc bigint; v_qua bigint; v_agu bigint;
  v_l1    bigint;   -- LEI_14133
  v_l2    bigint;   -- regulamento nulo -> chega por amparo_legal
  v_l3    bigint;   -- OUTRO
  v_fora  bigint;   -- fora do pipeline
  v_res   record;
  v_ok    boolean;
  v_prazo timestamptz;
begin
  if not (select relrowsecurity from pg_class where oid = 'private.pipeline_tarefas_pendencias'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em private.pipeline_tarefas_pendencias';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'private.pipeline_tarefas_pendencias'::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: % lê private.pipeline_tarefas_pendencias', r;
    end if;
    if has_function_privilege(r, 'public.tenants_reativada_semear()'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa tenants_reativada_semear', r;
    end if;
  end loop;
  if to_regprocedure('public.pipeline_etapa_tarefas_criar(bigint,bigint,bigint,uuid)') is not null then
    raise exception 'CHECK FALHOU: assinatura antiga de pipeline_etapa_tarefas_criar continua existindo';
  end if;

  begin
    insert into auth.users (id, email) values (v_u, 'check-ajustes@example.invalid') on conflict (id) do nothing;
    insert into public.tenants (slug, nome) values ('check-ajustes-1', 'Check ajustes 1') returning id into v_t;
    select id into v_tri from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_doc from public.pipeline_etapas where tenant_id = v_t and nome = 'Documentação';
    select id into v_qua from public.pipeline_etapas where tenant_id = v_t and nome = 'Qualificação';
    select id into v_agu from public.pipeline_etapas where tenant_id = v_t and nome = 'Aguardando resultado';
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;
    insert into public.licitacoes_externas (fonte, codigo_externo) values ('pncp', 'check-ajustes-l2') returning id into v_l2;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'OUTRO') returning id into v_l3;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_fora;

    -- CA-13 pelo gatilho: tarefa inativa no catálogo não entra no modelo (23514)
    update public.tarefas_catalogo set ativo = false where codigo = '14133-F01-T06';
    v_ok := false;
    begin
      insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, tarefa_codigo)
      values (v_t, v_tri, 'catalogo', '14133-F01-T06');
    exception when check_violation then v_ok := true;
    end;
    update public.tarefas_catalogo set ativo = true where codigo = '14133-F01-T06';
    if not v_ok then raise exception 'CHECK FALHOU: CA-13 modelo aceitou tarefa inativa no catálogo'; end if;

    -- 3) criar fora do pipeline: nada
    select * into v_res from public.pipeline_etapa_tarefas_criar(v_t, v_fora, v_doc, v_u);
    if v_res.bloqueio is distinct from 'fora_do_pipeline' or exists (select 1 from public.tarefas_equipe where licitacao_id = v_fora) then
      raise exception 'CHECK FALHOU: criar fora do pipeline gravou (%)', v_res;
    end if;

    -- 2) filha desligada no modelo não nasce pela mãe (F04-T02 desligada, F04-T01 ligada)
    update public.pipeline_etapa_tarefas set ativo = false where etapa_id = v_doc and tarefa_codigo = '14133-F04-T02';
    perform public.pipeline_mover(v_t, array[v_l1], v_doc, null, v_u);
    if exists (select 1 from public.tarefas_equipe where licitacao_id = v_l1 and tarefa_codigo = '14133-F04-T02')
       or not exists (select 1 from public.tarefas_equipe where licitacao_id = v_l1 and tarefa_codigo = '14133-F04-T01') then
      raise exception 'CHECK FALHOU: filha desligada nasceu pela mãe (ou a mãe não nasceu)';
    end if;

    -- 1) prazo da tarefa da empresa: nasce contado da entrada (agora), nunca no passado
    update public.pipeline_etapa_tarefas set prazo_horas = 48 where tenant_id = v_t and chave = 'triagem-aderencia';
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    select prazo_em into v_prazo from public.tarefas_equipe where licitacao_id = v_l1 and origem_modelo_chave = 'triagem-aderencia';
    if v_prazo is null or v_prazo < now() + interval '47 hours' then
      raise exception 'CHECK FALHOU: prazo da tarefa da empresa não contou da entrada (%)', v_prazo;
    end if;

    -- CA-21 com OUTRO: só tarefas da empresa, e nem reaplicar cria as da lei
    perform public.pipeline_mover(v_t, array[v_l3], v_doc, null, v_u);
    select * into v_res from public.pipeline_tarefas_reaplicar(v_t, v_l3, v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo'
       or exists (select 1 from public.tarefas_equipe where licitacao_id = v_l3 and origem = 'catalogo') then
      raise exception 'CHECK FALHOU: CA-21 OUTRO criou tarefa da lei (%)', v_res;
    end if;

    -- CA-22 pelo caminho real: amparo_legal (gatilho BEFORE) -> regulamento -> gatilho AFTER reaplica.
    -- v_l2 passou por Qualificação e está em Documentação; Qualificação é excluída antes (etapa excluída é ignorada);
    -- um evento do certame já liberado não é reliberado.
    perform public.pipeline_mover(v_t, array[v_l2], v_qua, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l2], v_doc, null, v_u);
    perform public.pipeline_etapa_excluir(v_t, v_qua, v_tri, v_u);
    insert into private.pipeline_tarefas_pendencias (tenant_id, licitacao_id, motivo) values (v_t, v_l2, 'teste');
    insert into public.licitacoes_externas (fonte, codigo_externo, amparo_legal)
      values ('pncp', 'check-ajustes-l2', '{"codigo": 1, "nome": "Lei 14.133/2021, Art. 28, I"}')
      on conflict (fonte, codigo_externo) do update set amparo_legal = excluded.amparo_legal;
    if (select regulamento from public.licitacoes_externas where id = v_l2) is distinct from 'LEI_14133' then
      raise exception 'CHECK FALHOU: amparo_legal não derivou o regulamento';
    end if;
    if (select count(*) from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l2 and origem = 'catalogo' and origem_etapa_nome = 'Documentação') <> 5 then
      raise exception 'CHECK FALHOU: CA-22 pelo amparo_legal não criou as tarefas da lei de Documentação (F04-T02 desligada: 5)';
    end if;
    if exists (select 1 from public.tarefas_equipe where licitacao_id = v_l2 and origem_etapa_nome = 'Qualificação')
       or exists (select 1 from public.tarefas_equipe where licitacao_id = v_l2 and liberada_por_evento is not null) then
      raise exception 'CHECK FALHOU: CA-22 reaplicou etapa excluída ou reliberou evento do certame';
    end if;
    if exists (select 1 from private.pipeline_tarefas_pendencias where tenant_id = v_t and licitacao_id = v_l2) then
      raise exception 'CHECK FALHOU: reaplicar com sucesso não limpou a pendência';
    end if;

    -- 5) empresa reativada recebe o modelo padrão
    delete from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'interessante-decidir';
    update public.tenants set ativo = false where id = v_t;
    update public.tenants set ativo = true where id = v_t;
    if not exists (select 1 from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'interessante-decidir') then
      raise exception 'CHECK FALHOU: empresa reativada não recebeu o modelo padrão';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_etapa_tarefas ajustes ok (desfeitos)';
end
$$;

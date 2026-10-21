-- Checagem da migration 20261021130400_agente_consultas (spec 0035: K-0, K-1, R-1 a R-3; CA-0, CA-0b, CA-0c, CA-1,
-- CA-26).
--   ACL; busca só traz o pipeline da empresa numa etapa com tarefa ativa do agente; outra empresa não vê; a tarefa do
--   agente noutra etapa amplia a busca; busca por texto; limite máximo 50; documentos com páginas distintas (null sem
--   chunks); fora do pipeline dá P0002. Tudo o que grava é desfeito ao final.

do $$
declare
  r       text;
  v_t     bigint;
  v_t2    bigint;
  v_nova  bigint;
  v_qual  bigint;
  v_l1    bigint;
  v_l2    bigint;
  v_l3    bigint;
  v_d1    bigint;
  v_d2    bigint;
  v_u     uuid := '00000000-0000-0000-0000-0000000035c1';
  v_ok    boolean;
  v_ids   bigint[];
  v_total bigint;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.agente_oportunidades_buscar(bigint,text,text,integer,integer)'::regprocedure, 'EXECUTE')
       or has_function_privilege(r, 'public.agente_documentos_listar(bigint,bigint)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa as consultas do agente', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.agente_oportunidades_buscar(bigint,text,text,integer,integer)'::regprocedure, 'EXECUTE')
     or not has_function_privilege('service_role', 'public.agente_documentos_listar(bigint,bigint)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa as consultas do agente';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-consulta-1', 'Check consulta 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-consulta-2', 'Check consulta 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';
    select id into v_qual from public.pipeline_etapas where tenant_id = v_t and nome = 'Qualificação';
    if v_qual is null then
      select id into v_qual from public.pipeline_etapas where tenant_id = v_t and id <> v_nova and desfecho is null
       order by ordem limit 1;
    end if;
    insert into public.licitacoes_externas (fonte, objeto, orgao_nome, municipio, data_fim)
    values ('pncp', 'Aquisição de equipamento de musculação', 'Prefeitura de Horizontina', 'Horizontina', now() + interval '5 days')
    returning id into v_l1;
    insert into public.licitacoes_externas (fonte, objeto, orgao_nome, data_fim)
    values ('pncp', 'Aquisição de esteiras', 'Prefeitura de Outra', now() + interval '2 days') returning id into v_l2;
    insert into public.licitacoes_externas (fonte, objeto) values ('pncp', 'Fora do pipeline') returning id into v_l3;
    perform public.pipeline_mover(v_t, array[v_l1], v_nova, null, v_u);
    perform public.pipeline_mover(v_t, array[v_l2], v_qual, null, v_u);
    -- a outra empresa tem a v_l2 em Nova: não pode aparecer para a primeira por esse caminho
    perform public.pipeline_mover(v_t2, array[v_l2], (select id from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Nova'), null, v_u);

    -- CA-0: só a de Nova volta; fora do pipeline nunca
    select array_agg(b.licitacao_id order by b.licitacao_id) into v_ids
      from public.agente_oportunidades_buscar(v_t, 'edital', null, 20, 0) b;
    if v_ids is distinct from array[v_l1] then
      raise exception 'CHECK FALHOU: busca do edital trouxe % (esperado só %)', v_ids, v_l1;
    end if;
    -- CA-0c: outra empresa só vê o seu pipeline
    select array_agg(b.licitacao_id) into v_ids from public.agente_oportunidades_buscar(v_t2, 'edital', null, 20, 0) b;
    if v_ids is distinct from array[v_l2] then
      raise exception 'CHECK FALHOU: outra empresa viu % (esperado só %)', v_ids, v_l2;
    end if;
    -- CA-0b: tarefa do agente também na outra etapa amplia a busca, ordenada por prazo
    perform public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_qual, '[{"agente":"edital"}]'::jsonb, v_u);
    select array_agg(b.licitacao_id order by b.data_fim), max(b.total) into v_ids, v_total
      from public.agente_oportunidades_buscar(v_t, 'edital', null, 20, 0) b;
    if v_ids is distinct from array[v_l2, v_l1] or v_total <> 2 then
      raise exception 'CHECK FALHOU: busca com a tarefa em duas etapas trouxe % (total %)', v_ids, v_total;
    end if;
    -- o jurídico não foi posto em Qualificação
    if (select count(*) from public.agente_oportunidades_buscar(v_t, 'juridico', null, 20, 0)) <> 1 then
      raise exception 'CHECK FALHOU: busca do jurídico deveria trazer só a de Nova';
    end if;
    -- busca por texto e limite
    select array_agg(b.licitacao_id) into v_ids from public.agente_oportunidades_buscar(v_t, 'edital', 'horizontina', 20, 0) b;
    if v_ids is distinct from array[v_l1] then
      raise exception 'CHECK FALHOU: busca "horizontina" trouxe %', v_ids;
    end if;
    if (select count(*) from public.agente_oportunidades_buscar(v_t, 'edital', null, 1, 0)) <> 1
       or (select count(*) from public.agente_oportunidades_buscar(v_t, 'edital', null, 1, 1)) <> 1 then
      raise exception 'CHECK FALHOU: paginação da busca';
    end if;

    -- CA-1: documentos com páginas distintas; null sem chunks
    insert into public.licitacao_documentos (licitacao_id, secao, nome_original, arquivo_origem, status_processamento, storage_uri)
    values (v_l1, 'processo', 'Edital.pdf', 'edital.pdf', 'indexado', 'gs://segredo/edital.pdf') returning id into v_d1;
    insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, status_processamento, erro)
    values (v_l1, 'processo', 'tr.pdf', 'erro', '422 Client Error: for url: gs://segredo/tr.pdf') returning id into v_d2;
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao)
    values (v_l1, v_d1, 1, 1, 'a', 'processo'), (v_l1, v_d1, 2, 1, 'b', 'processo'), (v_l1, v_d1, 3, 2, 'c', 'processo');
    if (select paginas from public.agente_documentos_listar(v_t, v_l1) where id = v_d1) <> 2
       or (select paginas from public.agente_documentos_listar(v_t, v_l1) where id = v_d2) is not null
       or (select nome from public.agente_documentos_listar(v_t, v_l1) where id = v_d2) <> 'tr.pdf' then
      raise exception 'CHECK FALHOU: documentos_listar (páginas ou nome)';
    end if;
    -- CA-26: fora do pipeline, P0002
    v_ok := false;
    begin
      perform public.agente_documentos_listar(v_t, v_l3);
    exception when sqlstate 'P0002' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: documentos de licitação fora do pipeline';
    end if;
    v_ok := false;
    begin
      perform public.agente_documentos_listar(v_t2, v_l1);
    exception when sqlstate 'P0002' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: outra empresa listou os documentos';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: agente_consultas ok (desfeito)';
end
$$;

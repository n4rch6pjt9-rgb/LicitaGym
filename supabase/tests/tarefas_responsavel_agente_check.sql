-- Checagem das migrations 20261021130100_tarefas_responsavel_agente e 20261021130300_tarefas_agente_semente
-- (spec 0035: K-11 a K-14, R-12 a R-16; CA-20, CA-21, CA-23, CA-33).
--   ACL; semente das 2 tarefas de agente na Nova; tarefa de agente nasce com qualquer regulamento e responsável agente;
--   salvar antigo não desliga agente; salvar agentes (um por etapa, mesmo agente em duas etapas, inativo recusado);
--   responsável usuário só membro ativo e queda para papel admin. Tudo o que grava é desfeito ao final.

do $$
declare
  r       text;
  v_t     bigint;
  v_t2    bigint;
  v_nova  bigint;
  v_tri   bigint;
  v_tri2  bigint;
  v_l1    bigint;
  v_l2    bigint;
  v_l3    bigint;
  v_u     uuid := '00000000-0000-0000-0000-0000000035a1';
  v_m     uuid := '00000000-0000-0000-0000-0000000035a2';
  v_fora  uuid := '00000000-0000-0000-0000-0000000035a3';
  v_ok    boolean;
  v_n     integer;
  v_chave text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.pipeline_etapa_tarefas_agentes_salvar(bigint,bigint,jsonb,uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa pipeline_etapa_tarefas_agentes_salvar', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.pipeline_etapa_tarefas_agentes_salvar(bigint,bigint,jsonb,uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa pipeline_etapa_tarefas_agentes_salvar';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-0035-1', 'Check 0035 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-0035-2', 'Check 0035 2') returning id into v_t2;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t and nome = 'Nova';
    select id into v_tri  from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_tri2 from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Triagem';
    insert into auth.users (id, email) values (v_m, 'check-0035-membro@example.invalid') on conflict (id) do nothing;
    insert into public.tenant_membros (tenant_id, user_id, papel) values (v_t, v_m, 'operacao');
    insert into public.tenant_membros (tenant_id, user_id, papel) values (v_t2, v_fora, 'admin');

    -- CA-21: empresa nova recebe as 2 tarefas de agente na Nova; semear de novo não duplica
    if (select count(*) from public.pipeline_etapa_tarefas
         where etapa_id = v_nova and origem = 'agente' and ativo and responsavel_tipo = 'agente'
           and chave in ('agente-edital', 'agente-juridico') and responsavel_agente in ('edital', 'juridico')) <> 2 then
      raise exception 'CHECK FALHOU: semente das tarefas de agente na Nova';
    end if;
    perform public.pipeline_semear_tarefas(v_t);
    if (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_nova and origem = 'agente') <> 2 then
      raise exception 'CHECK FALHOU: semear de novo duplicou tarefa de agente';
    end if;

    -- CA-20: modelo de agente sem agente é recusado
    v_ok := false;
    begin
      insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, chave, titulo, responsavel_tipo)
      values (v_t, v_tri, 'agente', 'agt-semagente', 'Sem agente', 'agente');
    exception when check_violation then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: modelo de agente sem responsavel_agente aceito';
    end if;
    -- instância com tipo agente e sem agente é recusada
    v_ok := false;
    begin
      insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l3;
      insert into public.tarefas_equipe (tenant_id, licitacao_id, origem, titulo, prazo_situacao, responsavel_tipo)
      values (v_t, v_l3, 'empresa', 'x', 'sem_prazo', 'agente');
    exception when check_violation then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: tarefa com responsável agente sem agente aceita';
    end if;

    -- CA-23: card entra na Nova (regulamento nulo) e nascem as 2 tarefas de agente
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', null) returning id into v_l1;
    perform public.pipeline_mover(v_t, array[v_l1], v_nova, null, v_u);
    if (select count(*) from public.tarefas_equipe
         where tenant_id = v_t and licitacao_id = v_l1 and origem = 'empresa' and responsavel_tipo = 'agente'
           and responsavel_papel = 'admin' and status = 'aberta' and origem_etapa_id = v_nova
           and responsavel_agente in ('edital', 'juridico')) <> 2 then
      raise exception 'CHECK FALHOU: tarefas de agente não nasceram na entrada da Nova';
    end if;

    -- CA-33 / R-16: salvar a lista antiga (vazia) da Nova não desliga as tarefas de agente
    perform public.pipeline_etapa_tarefas_salvar(v_t, v_nova, '[]'::jsonb, v_u);
    if (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_nova and origem = 'agente' and ativo) <> 2 then
      raise exception 'CHECK FALHOU: salvar antigo desligou tarefa de agente';
    end if;
    -- salvar antigo recusa origem agente
    v_ok := false;
    begin
      perform public.pipeline_etapa_tarefas_salvar(v_t, v_nova,
        jsonb_build_array(jsonb_build_object('origem', 'agente', 'agente', 'edital')), v_u);
    exception when sqlstate '22023' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: salvar antigo aceitou origem agente';
    end if;

    -- R-12: o mesmo agente em outra etapa (chave agt-), título padrão = nome do agente
    v_n := public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_tri, jsonb_build_array(jsonb_build_object('agente', 'edital')), v_u);
    select chave into v_chave from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'agente' and ativo;
    if v_n <> 1 or v_chave !~ '^agt-[0-9a-f]{8}$'
       or (select titulo from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'agente') <> 'Agente de Edital' then
      raise exception 'CHECK FALHOU: agentes_salvar na Triagem (%, %)', v_n, v_chave;
    end if;
    -- salvar de novo mantém a chave; tirar da lista desliga sem apagar
    perform public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_tri,
      jsonb_build_array(jsonb_build_object('agente', 'edital', 'titulo', 'Ler o edital com o agente', 'prazo_horas', 24)), v_u);
    if (select chave from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'agente') <> v_chave then
      raise exception 'CHECK FALHOU: agentes_salvar trocou a chave';
    end if;
    perform public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_tri, '[]'::jsonb, v_u);
    if exists (select 1 from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'agente' and ativo)
       or not exists (select 1 from public.pipeline_etapa_tarefas where etapa_id = v_tri and origem = 'agente') then
      raise exception 'CHECK FALHOU: agentes_salvar não desligou (ou apagou)';
    end if;
    -- recusas: agente inativo, inexistente, repetido, etapa de outra empresa
    foreach r in array array['[{"agente":"preco"}]', '[{"agente":"xyz"}]', '[{"agente":"edital"},{"agente":"edital"}]'] loop
      v_ok := false;
      begin
        perform public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_tri, r::jsonb, v_u);
      exception when sqlstate '22023' then v_ok := true;
      end;
      if not v_ok then
        raise exception 'CHECK FALHOU: agentes_salvar aceitou %', r;
      end if;
    end loop;
    v_ok := false;
    begin
      perform public.pipeline_etapa_tarefas_agentes_salvar(v_t, v_tri2, '[]'::jsonb, v_u);
    exception when sqlstate 'P0002' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: agentes_salvar aceitou etapa de outra empresa';
    end if;

    -- R-14: responsável usuário só membro ativo desta empresa
    v_ok := false;
    begin
      perform public.pipeline_etapa_tarefas_salvar(v_t, v_tri, jsonb_build_array(jsonb_build_object(
        'origem', 'empresa', 'titulo', 'Tarefa de outra empresa',
        'responsavel', jsonb_build_object('tipo', 'usuario', 'user_id', v_fora))), v_u);
    exception when sqlstate '22023' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: responsável de outra empresa aceito';
    end if;
    perform public.pipeline_etapa_tarefas_salvar(v_t, v_tri, jsonb_build_array(
      jsonb_build_object('origem', 'empresa', 'titulo', 'Conferir catálogo',
                         'responsavel', jsonb_build_object('tipo', 'usuario', 'user_id', v_m)),
      jsonb_build_object('origem', 'empresa', 'titulo', 'Fila da operação',
                         'responsavel', jsonb_build_object('tipo', 'papel', 'papel', 'operacao'))), v_u);
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l2;
    perform public.pipeline_mover(v_t, array[v_l2], v_tri, null, v_u);
    if not exists (select 1 from public.tarefas_equipe where licitacao_id = v_l2 and titulo = 'Conferir catálogo'
                    and responsavel_tipo = 'usuario' and responsavel_user_id = v_m)
       or not exists (select 1 from public.tarefas_equipe where licitacao_id = v_l2 and titulo = 'Fila da operação'
                    and responsavel_tipo = 'papel' and responsavel_papel = 'operacao') then
      raise exception 'CHECK FALHOU: responsável do modelo não foi copiado';
    end if;
    -- front anterior (sem a chave 'responsavel'): o responsável gravado fica
    select chave into v_chave from public.pipeline_etapa_tarefas where etapa_id = v_tri and titulo = 'Conferir catálogo';
    perform public.pipeline_etapa_tarefas_salvar(v_t, v_tri, (
      select jsonb_agg(jsonb_build_object('origem', 'empresa', 'chave', m.chave, 'titulo', m.titulo) order by m.ordem)
        from public.pipeline_etapa_tarefas m where m.etapa_id = v_tri and m.origem = 'empresa' and m.ativo), v_u);
    if not exists (select 1 from public.pipeline_etapa_tarefas where chave = v_chave and tenant_id = v_t
                    and responsavel_tipo = 'usuario' and responsavel_user_id = v_m) then
      raise exception 'CHECK FALHOU: salvar sem responsavel apagou o responsável gravado';
    end if;
    -- membro desativado: a próxima tarefa nasce em papel admin
    update public.tenant_membros set ativo = false where tenant_id = v_t and user_id = v_m;
    perform public.pipeline_mover(v_t, array[v_l1], v_tri, null, v_u);
    if not exists (select 1 from public.tarefas_equipe where licitacao_id = v_l1 and titulo = 'Conferir catálogo'
                    and responsavel_tipo = 'papel' and responsavel_papel = 'admin' and responsavel_user_id is null) then
      raise exception 'CHECK FALHOU: membro inativo não caiu em papel admin';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: tarefas_responsavel_agente ok (desfeito)';
end
$$;

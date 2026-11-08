-- Checagem da migration 20261109010000_nexor_tenant_novo (spec 0042). Tudo desfeito ao final.
--   ACL da tabela e das funções novas; CA-1 14 etapas NX; CA-2 tarefas padrão por etapa; CA-3 tenant existente não
--   muda; CA-4 prazo e responsável do modelo NX; CA-5 modelo 14.133 segue a regra de antes; regulamento sem catálogo
--   cria só NX.

do $$
declare
  r      text;
  n      integer;
  v_t    bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000004a1';
  v_a01  bigint; v_a02 bigint; v_s08 bigint;
  v_l1   bigint;  -- LEI_14133
  v_l2   bigint;  -- RCA (Sistema S)
  v_res  record;
  v_te   record;
  v_ant  integer;
begin
  -- ACL ---------------------------------------------------------------------------------------------------------------
  if not (select relrowsecurity from pg_class where oid = 'public.nexor_etapa_tarefas_padrao'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em nexor_etapa_tarefas_padrao';
  end if;
  foreach r in array array['anon', 'authenticated', 'public'] loop
    if has_table_privilege(r, 'public.nexor_etapa_tarefas_padrao', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') then
      raise exception 'CHECK FALHOU: % tem privilégio em nexor_etapa_tarefas_padrao', r;
    end if;
    if has_function_privilege(r, 'public.pipeline_semear_etapas_nx(bigint)', 'EXECUTE')
       or has_function_privilege(r, 'public.pipeline_semear_tarefas_nx(bigint)', 'EXECUTE')
       or has_function_privilege(r, 'public.tarefa_responsavel_do_modelo(text)', 'EXECUTE')
       or has_function_privilege(r, 'public.pipeline_etapa_tarefas_criar(bigint,bigint,bigint,uuid,timestamptz)', 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa função da semente NX', r;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.nexor_etapa_tarefas_padrao', 'INSERT,UPDATE,DELETE,TRUNCATE,MAINTAIN') then
    raise exception 'CHECK FALHOU: service_role escreve em nexor_etapa_tarefas_padrao';
  end if;

  -- Tabela gerada: 34 linhas (23 NX + 11 modelos 14.133 dos 10 apelidos), NX-T34 fora ----------------------------------
  select count(*) into n from public.nexor_etapa_tarefas_padrao;
  if n <> 34 then raise exception 'CHECK FALHOU: esperadas 34 tarefas padrão NX, achei %', n; end if;
  if exists (select 1 from public.nexor_etapa_tarefas_padrao where apelido = 'NX-T34') then
    raise exception 'CHECK FALHOU: NX-T34 reservada na tabela padrão';
  end if;

  -- Responsável do modelo ---------------------------------------------------------------------------------------------
  select * into v_res from public.tarefa_responsavel_do_modelo('papel:operacao');
  if (v_res.responsavel_tipo, v_res.responsavel_papel, v_res.responsavel_agente) is distinct from ('papel', 'operacao', null::text) then
    raise exception 'CHECK FALHOU: papel:operacao virou %', v_res;
  end if;
  select * into v_res from public.tarefa_responsavel_do_modelo('agente:juridico + agente:edital');
  if (v_res.responsavel_tipo, v_res.responsavel_agente) is distinct from ('agente', 'juridico') then
    raise exception 'CHECK FALHOU: agente:juridico + agente:edital virou %', v_res;
  end if;
  select * into v_res from public.tarefa_responsavel_do_modelo(null);
  if (v_res.responsavel_tipo, v_res.responsavel_papel, v_res.responsavel_agente) is distinct from ('papel', 'admin', null::text) then
    raise exception 'CHECK FALHOU: modelo sem responsável virou %', v_res;
  end if;

  -- CA-3: tenants que já existiam não ganham etapa NX -----------------------------------------------------------------
  select count(*) into v_ant from public.pipeline_etapas;
  if exists (select 1 from public.pipeline_etapas where fase_codigo is not null) then
    raise exception 'CHECK FALHOU: etapa já existente ganhou fase_codigo (a migration não pode mexer em tenant antigo)';
  end if;

  begin
    insert into auth.users (id, email) values (v_u, 'check-nexor-tenant@example.invalid') on conflict (id) do nothing;
    insert into public.tenants (slug, nome) values ('check-nexor-tenant', 'Check Nexor tenant') returning id into v_t;

    -- CA-1 ------------------------------------------------------------------------------------------------------------
    select count(*) into n from public.pipeline_etapas where tenant_id = v_t;
    if n <> 14 then raise exception 'CHECK FALHOU: tenant novo com % etapas (esperadas 14)', n; end if;
    if (select string_agg(fase_codigo, ',' order by ordem) from public.pipeline_etapas where tenant_id = v_t)
       <> 'A01,A02,A03,A04,P05,P06,P07,S08,S09,S10,S11,R12,R13,R14' then
      raise exception 'CHECK FALHOU: ordem das etapas NX errada';
    end if;
    if (select string_agg(nome || ':' || coalesce(desfecho, '-') || ':' || exige_motivo, ',' order by ordem)
          from public.pipeline_etapas where tenant_id = v_t and fase_codigo in ('R12', 'R13', 'R14'))
       <> 'Ata e execução:vencida:false,Perdida:perdida:false,Descartada:descartada:true' then
      raise exception 'CHECK FALHOU: desfecho ou motivo das etapas finais NX';
    end if;
    if exists (select 1 from public.pipeline_etapas where tenant_id = v_t and fase <> case left(fase_codigo, 1)
                 when 'A' then 'prospeccao' when 'P' then 'proposta' when 'S' then 'disputa' else 'conclusao' end) then
      raise exception 'CHECK FALHOU: fase do Kanban não bate com o grupo NX';
    end if;

    -- CA-2 ------------------------------------------------------------------------------------------------------------
    select id into v_a01 from public.pipeline_etapas where tenant_id = v_t and fase_codigo = 'A01';
    select id into v_a02 from public.pipeline_etapas where tenant_id = v_t and fase_codigo = 'A02';
    select id into v_s08 from public.pipeline_etapas where tenant_id = v_t and fase_codigo = 'S08';
    if (select string_agg(tarefa_codigo, ',' order by ordem) from public.pipeline_etapa_tarefas where etapa_id = v_a01)
       <> 'NX.GEN.A01.DAT.001-2,14133-F01-T01,NX.GEN.A01.DAT.003-8,NX.GEN.A01.DAT.027-4' then
      raise exception 'CHECK FALHOU: tarefas de A01 (NX-T01, T02, T03, T27)';
    end if;
    if not exists (select 1 from public.pipeline_etapa_tarefas t join public.pipeline_etapas e on e.id = t.etapa_id
                    where e.tenant_id = v_t and e.fase_codigo = 'S10' and t.tarefa_codigo = '14133-F04-T01') then
      raise exception 'CHECK FALHOU: NX-T16 (14133-F04-T01) fora de S10';
    end if;
    if exists (select 1 from public.pipeline_etapa_tarefas where etapa_id = v_s08) then
      raise exception 'CHECK FALHOU: S08 Proposta cadastrada com tarefa padrão';
    end if;
    select count(*) into n from public.pipeline_etapa_tarefas where tenant_id = v_t;
    if n <> 34 then raise exception 'CHECK FALHOU: tenant novo com % tarefas padrão (esperadas 34)', n; end if;

    -- CA-4 e CA-5: entrar em A02 com licitação 14.133 ------------------------------------------------------------------
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'LEI_14133') returning id into v_l1;
    insert into public.licitacoes_externas (fonte, regulamento) values ('pncp', 'RCA') returning id into v_l2;
    insert into public.pipeline_oportunidades (tenant_id, licitacao_id, etapa_id, adicionada_por, atualizada_por)
    values (v_t, v_l1, v_a02, v_u, v_u), (v_t, v_l2, v_a02, v_u, v_u);

    -- o gatilho pipeline_oportunidades_tarefas_trg cria as tarefas no insert (entrada = agora)
    if (select string_agg(tarefa_codigo, ',' order by tarefa_codigo) from public.tarefas_equipe where licitacao_id = v_l1)
       is distinct from '14133-F01-T04,NX.GEN.A02.PAR.004-2' then
      raise exception 'CHECK FALHOU: A02 com 14.133 não criou NX-T04 e NX-T05';
    end if;
    select * into v_te from public.tarefas_equipe where licitacao_id = v_l1 and tarefa_codigo = 'NX.GEN.A02.PAR.004-2';
    if v_te.prazo_situacao is distinct from 'calculado'
       or v_te.prazo_em not between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
       or v_te.responsavel_papel is distinct from 'operacao' or v_te.responsavel_tipo is distinct from 'papel' then
      raise exception 'CHECK FALHOU: NX-T04 sem prazo de 24h ou sem papel operacao (%, %, %)',
        v_te.prazo_situacao, v_te.prazo_em, v_te.responsavel_papel;
    end if;
    select * into v_te from public.tarefas_equipe where licitacao_id = v_l1 and tarefa_codigo = '14133-F01-T04';
    if v_te.prazo_em is not null or v_te.responsavel_papel is distinct from 'admin' or v_te.responsavel_tipo is distinct from 'papel'
       or v_te.prazo_situacao is distinct from public.tarefas_prazo_situacao(
            (select prazo_unidade from public.tarefas_catalogo where codigo = '14133-F01-T04')) then
      raise exception 'CHECK FALHOU: modelo 14.133 (NX-T05) mudou de regra';
    end if;

    -- Regulamento sem catálogo da lei (Sistema S): nasce só a NX e o aviso continua, porque a etapa tem 14.133 --------
    select * into v_res from public.pipeline_etapa_tarefas_criar(v_t, v_l2, v_a02, v_u);
    if v_res.bloqueio is distinct from 'regulamento_sem_catalogo'
       or (select string_agg(tarefa_codigo, ',') from public.tarefas_equipe where licitacao_id = v_l2) is distinct from 'NX.GEN.A02.PAR.004-2' then
      raise exception 'CHECK FALHOU: Sistema S em A02 (%)', v_res;
    end if;

    -- Agente como responsável: NX-T01 (agente:juridico) em A01 ---------------------------------------------------------
    update public.pipeline_oportunidades set etapa_id = v_a01, atualizada_por = v_u
     where tenant_id = v_t and licitacao_id = v_l1;
    select * into v_te from public.tarefas_equipe where licitacao_id = v_l1 and tarefa_codigo = 'NX.GEN.A01.DAT.001-2';
    if v_te.responsavel_tipo is distinct from 'agente' or v_te.responsavel_agente is distinct from 'juridico' then
      raise exception 'CHECK FALHOU: NX-T01 não nasceu com o agente jurídico (%, %)', v_te.responsavel_tipo, v_te.responsavel_agente;
    end if;

    -- Reativar a empresa NX não traz tarefas da Konnen para "Triagem"/"Perdida" (nomes iguais nas duas sementes) ------
    update public.tenants set ativo = false where id = v_t;
    update public.tenants set ativo = true where id = v_t;
    select count(*) into n from public.pipeline_etapa_tarefas where tenant_id = v_t;
    if n <> 34 then raise exception 'CHECK FALHOU: reativar a empresa NX mudou as tarefas padrão (% em vez de 34)', n; end if;
    if exists (select 1 from public.pipeline_etapa_tarefas where tenant_id = v_t and origem <> 'catalogo') then
      raise exception 'CHECK FALHOU: reativar a empresa NX semeou tarefa da empresa do modelo antigo';
    end if;

    raise exception 'ROLLBACK_CHECK';
  exception when raise_exception then
    if sqlerrm <> 'ROLLBACK_CHECK' then raise; end if;
  end;

  if (select count(*) from public.pipeline_etapas) <> v_ant then
    raise exception 'CHECK FALHOU: o check deixou etapas para trás';
  end if;
  raise notice 'SUCESSO: nexor_tenant_novo (ACL, 14 etapas NX, 34 tarefas padrão, prazo e responsável do modelo NX)';
end $$;

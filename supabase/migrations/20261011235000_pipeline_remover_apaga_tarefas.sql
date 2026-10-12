-- LicitaGym: sair do Kanban leva as tarefas da empresa junto.
-- Decisão do Marcelo em 11/10/2026, revendo a decisão 2 da spec 0018 só neste caso:
-- mudar de etapa (inclusive Descartada) não fecha tarefa; remover do pipeline apaga as
-- tarefas daquela empresa naquela licitação. O histórico de etapas continua.
--
-- O que muda:
--   public.pipeline_mover   com p_etapa nulo, apaga public.tarefas_equipe do par (empresa, licitação)
--                           antes de tirar o card
--   limpeza                 tarefas que já ficaram sem card (a oportunidade 133, por exemplo) saem agora
-- Quem escreve: service_role, pela api-pipeline. Volta: as tarefas da lei nascem de novo se o card
-- voltar a uma etapa que as cria; tarefa da empresa, prazo e responsável apagados não voltam.
-- Verificar: supabase/tests/pipeline_remover_apaga_tarefas_check.sql

begin;

set local lock_timeout = '5s';

create or replace function public.pipeline_mover(
  p_tenant     bigint,
  p_licitacoes bigint[],
  p_etapa      bigint,
  p_motivo     text,
  p_user       uuid,
  p_so_novos   boolean default false
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_etapa   public.pipeline_etapas%rowtype;
  v_motivo  text := nullif(btrim(coalesce(p_motivo, '')), '');
  v_n       integer := 0;
  r         record;
begin
  if p_user is null then
    raise exception 'pipeline_mover: usuário obrigatório' using errcode = '22023';
  end if;
  if p_licitacoes is null or cardinality(p_licitacoes) = 0 then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));

  if p_etapa is not null then
    select * into v_etapa from public.pipeline_etapas where id = p_etapa and tenant_id = p_tenant;
    if not found then
      raise exception 'pipeline_mover: etapa não encontrada' using errcode = 'P0002';
    end if;
    if v_etapa.exige_motivo and v_motivo is null then
      raise exception 'pipeline_mover: a etapa "%" exige motivo', v_etapa.nome using errcode = '22023';
    end if;
  end if;

  for r in
    select l.id as licitacao_id, po.etapa_id as etapa_atual, ea.nome as nome_atual
      from (select distinct id from unnest(p_licitacoes) as u (id)) u
      join public.licitacoes_externas l on l.id = u.id
      left join public.pipeline_oportunidades po on po.tenant_id = p_tenant and po.licitacao_id = l.id
      left join public.pipeline_etapas ea on ea.id = po.etapa_id
     order by l.id
  loop
    continue when p_so_novos and r.etapa_atual is not null;
    if p_etapa is null then
      continue when r.etapa_atual is null;
      delete from public.tarefas_equipe
       where tenant_id = p_tenant and licitacao_id = r.licitacao_id;
      delete from public.pipeline_oportunidades where tenant_id = p_tenant and licitacao_id = r.licitacao_id;
    else
      continue when r.etapa_atual is not distinct from p_etapa;
      insert into public.pipeline_oportunidades as po
             (tenant_id, licitacao_id, etapa_id, motivo, adicionada_por, atualizada_por)
      values (p_tenant, r.licitacao_id, p_etapa, case when v_etapa.exige_motivo then v_motivo end, p_user, p_user)
      on conflict on constraint pipeline_oportunidades_pkey do update
         set etapa_id = excluded.etapa_id, motivo = excluded.motivo,
             atualizada_por = excluded.atualizada_por, atualizada_em = now();
    end if;
    insert into public.pipeline_historico (tenant_id, licitacao_id, etapa_de, etapa_para, nome_de, nome_para, motivo, user_id)
    values (p_tenant, r.licitacao_id, r.etapa_atual, p_etapa, r.nome_atual, v_etapa.nome, v_motivo, p_user);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke execute on function public.pipeline_mover(bigint, bigint[], bigint, text, uuid, boolean) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_mover(bigint, bigint[], bigint, text, uuid, boolean) to service_role;

-- Tarefas que já ficaram sem card. Outra empresa que ainda tem a mesma licitação no Kanban não perde as dela.
delete from public.tarefas_equipe t
 where not exists (
   select 1 from public.pipeline_oportunidades po
    where po.tenant_id = t.tenant_id and po.licitacao_id = t.licitacao_id
 );

commit;

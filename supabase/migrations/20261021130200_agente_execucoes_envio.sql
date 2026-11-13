-- LicitaGym: envio da análise para a oportunidade e ligação com a tarefa do agente (spec 0035, K-3, K-15, R-7 a R-9).
--
-- Por quê: a análise roda na rota do agente e só aparece na aba da oportunidade depois de "Enviar para a
-- oportunidade". A execução enviada fica ligada à tarefa aberta do agente; aprovar conclui a tarefa, rejeitar a
-- devolve para aberta. Rejeitada pode ser enviada de novo (a revisão anterior fica em revisoes_anteriores).
--
-- O que muda:
--   public.agente_execucoes              enviada_em, enviada_por, tarefa_id (FK com tenant_id para tarefas_equipe,
--                                        set null: tirar a oportunidade do pipeline apaga a tarefa), revisoes_anteriores.
--   public.agente_tarefa_aberta(...)     tarefa aberta do agente na etapa atual (ou null).
--   public.agente_execucao_enviar(...)   envio atômico: trava a linha, recusa reenvio (LG003) salvo de rejeitada ou de
--                                        aprovada com tarefa nova do agente, e liga a tarefa aberta do mesmo agente na
--                                        etapa atual (ou nenhuma).
--   gatilho agente_execucoes_tarefa_trg  aprovada → tarefa concluida; rejeitada → tarefa aberta.
-- Quem chama: só service_role (api-agentes). Aditiva e idempotente. O merge na main aplica em produção.
-- Verificação: supabase/tests/agente_execucoes_envio_check.sql.

begin;

set local lock_timeout = '5s';

alter table public.agente_execucoes
  add column if not exists enviada_em          timestamptz,
  add column if not exists enviada_por         uuid,
  add column if not exists tarefa_id           bigint,
  add column if not exists revisoes_anteriores jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agente_execucoes_envio_chk') then
    alter table public.agente_execucoes add constraint agente_execucoes_envio_chk check (
      (enviada_em is null) = (enviada_por is null)
      and (tarefa_id is null or enviada_em is not null)
      and jsonb_typeof(revisoes_anteriores) = 'array'
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agente_execucoes_tarefa_fkey') then
    alter table public.agente_execucoes add constraint agente_execucoes_tarefa_fkey
      foreign key (tenant_id, tarefa_id) references public.tarefas_equipe (tenant_id, id)
      on delete set null (tarefa_id);
  end if;
end $$;

create index if not exists agente_execucoes_tarefa_idx on public.agente_execucoes (tenant_id, tarefa_id)
  where tarefa_id is not null;
create index if not exists agente_execucoes_enviada_idx
  on public.agente_execucoes (tenant_id, licitacao_id, agente, enviada_em desc) where enviada_em is not null;

comment on column public.agente_execucoes.enviada_em is
  'Quando a análise foi enviada para a aba da oportunidade (spec 0035). Nula: só aparece na rota do agente.';
comment on column public.agente_execucoes.tarefa_id is
  'Tarefa do agente ligada no envio (aberta, mesmo agente, etapa atual). Nula: não havia tarefa ou foi apagada.';
comment on column public.agente_execucoes.revisoes_anteriores is
  'Revisões anteriores a um envio (rejeitada reenviada, ou aprovada antes da spec 0035): [{decisao, nota, por, em, enviada_em}]. Só cresce.';

-- Tarefa aberta do agente na etapa atual -----------------------------------------------------------------------
create or replace function public.agente_tarefa_aberta(
  p_tenant    bigint,
  p_licitacao bigint,
  p_agente    text
)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select te.id
    from public.tarefas_equipe te
    join public.pipeline_oportunidades po
      on po.tenant_id = te.tenant_id and po.licitacao_id = te.licitacao_id and po.etapa_id = te.origem_etapa_id
   where te.tenant_id = p_tenant and te.licitacao_id = p_licitacao
     and te.responsavel_tipo = 'agente' and te.responsavel_agente = p_agente
     and te.status in ('aberta', 'em_andamento')
   order by te.criada_em desc, te.id desc
   limit 1;
$$;
comment on function public.agente_tarefa_aberta(bigint, bigint, text) is
  'Tarefa aberta (ou em andamento) do agente na etapa atual da licitação no pipeline da empresa; null sem tarefa. '
  'Usada no envio e para dizer à rota que uma análise aprovada pode ir de novo para uma tarefa nova. Só service_role.';

-- Envio atômico ---------------------------------------------------------------------------------------------------
create or replace function public.agente_execucao_enviar(
  p_tenant   bigint,
  p_execucao bigint,
  p_user     uuid
)
returns setof public.agente_execucoes
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_exec   public.agente_execucoes%rowtype;
  v_tarefa bigint;
begin
  if p_user is null then
    raise exception 'Usuário obrigatório.' using errcode = '22023';
  end if;
  select * into v_exec from public.agente_execucoes e
   where e.tenant_id = p_tenant and e.id = p_execucao
   for update;
  if not found then
    raise exception 'Execução não encontrada.' using errcode = 'P0002';
  end if;
  v_tarefa := public.agente_tarefa_aberta(p_tenant, v_exec.licitacao_id, v_exec.agente);

  -- Já enviada só volta quando foi rejeitada, ou quando foi aprovada e há uma tarefa nova do agente (outra etapa com o
  -- mesmo agente, ou a oportunidade saiu e voltou ao pipeline): a mesma análise, sem mudança de entrada, abre o novo
  -- ciclo de revisão dessa tarefa (achado do Codex no #416).
  if v_exec.enviada_em is not null
     and v_exec.revisao <> 'rejeitada'
     and not (v_exec.revisao = 'aprovada' and v_tarefa is not null and v_tarefa is distinct from v_exec.tarefa_id) then
    raise exception 'Esta análise já foi enviada.' using errcode = 'LG003';
  end if;

  return query
  update public.agente_execucoes e
     -- qualquer revisão anterior fica registrada: a rejeitada que volta e a aprovada da spec 0032 que nunca foi enviada
     set revisoes_anteriores = case when e.revisao <> 'aguardando'
                                    then e.revisoes_anteriores || jsonb_build_array(jsonb_build_object(
                                           'decisao', e.revisao, 'nota', e.revisao_nota, 'por', e.revisado_por,
                                           'em', e.revisado_em, 'enviada_em', e.enviada_em))
                                    else e.revisoes_anteriores end,
         revisao      = 'aguardando',
         revisao_nota = null,
         revisado_por = null,
         revisado_em  = null,
         enviada_em   = now(),
         enviada_por  = p_user,
         tarefa_id    = v_tarefa
   where e.tenant_id = p_tenant and e.id = p_execucao
  returning e.*;
end;
$$;
comment on function public.agente_execucao_enviar(bigint, bigint, uuid) is
  'Envia a análise para a aba da oportunidade (spec 0035, K-4/R-8/R-9). LG003: já enviada (salvo rejeitada, ou aprovada '
  'com tarefa nova do agente; as duas voltam a aguardando e guardam a revisão anterior). Liga a tarefa aberta do mesmo '
  'agente na etapa atual. Só service_role; '
  'a api-agentes confere antes que a execução está atual.';

-- Revisão move a tarefa ligada --------------------------------------------------------------------------------------
create or replace function public.agente_execucoes_tarefa()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.tarefa_id is null or new.revisao is not distinct from old.revisao then
    return null;
  end if;
  if new.revisao = 'aprovada' then
    update public.tarefas_equipe te
       set status = 'concluida', concluida_em = now(), atualizada_por = new.revisado_por, atualizada_em = now()
     where te.tenant_id = new.tenant_id and te.id = new.tarefa_id and te.status <> 'concluida';
  elsif new.revisao = 'rejeitada' then
    update public.tarefas_equipe te
       set status = 'aberta', concluida_em = null, atualizada_por = new.revisado_por, atualizada_em = now()
     where te.tenant_id = new.tenant_id and te.id = new.tarefa_id and te.status <> 'aberta';
  end if;
  return null;
end;
$$;
create or replace trigger agente_execucoes_tarefa_trg
  after update of revisao on public.agente_execucoes
  for each row execute function public.agente_execucoes_tarefa();

revoke all on function public.agente_tarefa_aberta(bigint, bigint, text) from PUBLIC, anon, authenticated;
grant execute on function public.agente_tarefa_aberta(bigint, bigint, text) to service_role;
revoke all on function public.agente_execucao_enviar(bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.agente_execucoes_tarefa() from PUBLIC, anon, authenticated, service_role;
grant execute on function public.agente_execucao_enviar(bigint, bigint, uuid) to service_role;

commit;

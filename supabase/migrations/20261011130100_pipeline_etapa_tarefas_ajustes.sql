-- LicitaGym: ajustes do modelo de tarefas por etapa (revisor-migration do PR #327, já em produção como 20261011120000).
--
-- O que corrige:
--   1) prazo da tarefa da empresa: conta da entrada na etapa. O gatilho de entrada roda ANTES de pipeline_mover gravar
--      o histórico, então ler pipeline_historico ali pegava a visita anterior (prazo no passado). Agora quem chama
--      informa o início do prazo: o gatilho passa now(); pipeline_tarefas_reaplicar passa a entrada registrada.
--   2) tarefa filha (parent_codigo) desligada no modelo da etapa não nasce pela mãe.
--   3) pipeline_etapa_tarefas_criar só cria para licitação no pipeline da empresa ('fora_do_pipeline').
--   4) falha ao reaplicar no gatilho de regulamento fica registrada em private.pipeline_tarefas_pendencias (além do
--      WARNING), visível para a api-pipeline e para a fila (spec 0018, "nunca some em silêncio"); reaplicar com
--      sucesso limpa a pendência.
--   5) empresa reativada recebe as etapas e o modelo padrão (a semente só rodava para tenants ativos e novos).
-- Gatilhos com create or replace trigger (PG14+): reaplicar não pede ACCESS EXCLUSIVE na tabela.
-- Quem chama: só service_role. Verificar: supabase/tests/pipeline_etapa_tarefas_ajustes_check.sql. Idempotente.

begin;

set local lock_timeout = '5s';

-- 4) Pendências observáveis ------------------------------------------------------------------------------------
create table if not exists private.pipeline_tarefas_pendencias (
  tenant_id    bigint not null references public.tenants (id) on delete cascade,
  licitacao_id bigint not null references public.licitacoes_externas (id) on delete cascade,
  motivo       text   not null,
  erro         text,
  em           timestamptz not null default now(),
  primary key (tenant_id, licitacao_id)
);
comment on table private.pipeline_tarefas_pendencias is
  'Tarefas da lei que não puderam ser criadas quando o regulamento chegou (gatilho licext_regulamento_reaplicar_trg). '
  'pipeline_tarefas_reaplicar com sucesso apaga a linha. Spec 0018: falha nunca some em silêncio.';
alter table private.pipeline_tarefas_pendencias enable row level security;
revoke all on table private.pipeline_tarefas_pendencias from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table private.pipeline_tarefas_pendencias to service_role;

-- 1, 2, 3) criar com início do prazo, filha desligada e gate de pipeline --------------------------------------
-- Troca de assinatura (novo p_prazo_desde): a de 4 argumentos sai e quem chama (gatilho e reaplicar) é recriado aqui.
drop function if exists public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid);

create or replace function public.pipeline_etapa_tarefas_criar(
  p_tenant      bigint,
  p_licitacao   bigint,
  p_etapa       bigint,
  p_user        uuid default null,
  p_prazo_desde timestamptz default null
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_etapa_nome  text;
  v_regulamento text;
  v_contexto    jsonb;
  v_bloqueio    text;
  v_total       integer := 0;
  v_cat         integer := 0;
  v_emp         integer := 0;
  v_desde       timestamptz := coalesce(p_prazo_desde, now());
begin
  select e.nome into v_etapa_nome from public.pipeline_etapas e where e.id = p_etapa and e.tenant_id = p_tenant;
  if v_etapa_nome is null then
    return query select 0, 0, 'etapa_inexistente'::text;
    return;
  end if;
  if not exists (select 1 from public.pipeline_oportunidades po
                  where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao) then
    return query select 0, 0, 'fora_do_pipeline'::text;
    return;
  end if;

  select l.regulamento into v_regulamento from public.licitacoes_externas l where l.id = p_licitacao;
  if v_regulamento is null then
    v_bloqueio := 'regulamento_nao_informado';
  elsif v_regulamento not in ('LEI_14133', 'LEI_14981') then
    v_bloqueio := 'regulamento_sem_catalogo';
  end if;

  if v_bloqueio is null then
    v_contexto := public.tarefas_contexto_certame(p_licitacao);
    with modelo as (
      select m.id as modelo_id, m.tarefa_codigo, m.ativo
        from public.pipeline_etapa_tarefas m
       where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo'
    ),
    alvo as (
      select distinct on (c.codigo) c.codigo, c.prazo_unidade, c.condicao,
             coalesce(mo.modelo_id, mp.modelo_id) as modelo_id
        from public.tarefas_catalogo c
        left join modelo mo on mo.tarefa_codigo = c.codigo and mo.ativo
        left join modelo mp on mp.tarefa_codigo = c.parent_codigo and mp.ativo
       where c.ativo
         and (mo.tarefa_codigo is not null or mp.tarefa_codigo is not null)
         -- filha desligada no modelo desta etapa não nasce pela mãe
         and not exists (select 1 from modelo off where off.tarefa_codigo = c.codigo and not off.ativo)
       order by c.codigo
    ),
    avaliado as (
      select a.*, public.catalogo_condicao_avaliar(a.condicao, v_contexto) as aplicavel from alvo a
    ),
    gravadas as (
      insert into public.tarefas_equipe as te (
        tenant_id, licitacao_id, origem, tarefa_codigo, condicao_verificada, contexto, prazo_situacao,
        responsavel_papel, criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome
      )
      select p_tenant, p_licitacao, 'catalogo', v.codigo, v.aplicavel, v_contexto,
             public.tarefas_prazo_situacao(v.prazo_unidade), 'admin', p_user, p_user,
             p_etapa, v.modelo_id, v_etapa_nome
        from avaliado v
       where v.aplicavel is distinct from false
      on conflict (tenant_id, licitacao_id, tarefa_codigo) where origem = 'catalogo' do update
         set origem_etapa_id     = coalesce(te.origem_etapa_id, excluded.origem_etapa_id),
             origem_modelo_id    = coalesce(te.origem_modelo_id, excluded.origem_modelo_id),
             origem_etapa_nome   = coalesce(te.origem_etapa_nome, excluded.origem_etapa_nome),
             condicao_verificada = coalesce(te.condicao_verificada, excluded.condicao_verificada),
             contexto            = case when te.condicao_verificada is null and excluded.condicao_verificada
                                        then excluded.contexto else te.contexto end,
             atualizada_por      = coalesce(excluded.atualizada_por, te.atualizada_por),
             atualizada_em       = now()
       where te.origem_etapa_nome is null
          or (te.condicao_verificada is null and excluded.condicao_verificada)
      returning (xmax = 0) as nova
    )
    select count(*) filter (where nova) into v_cat from gravadas;
    select count(*) into v_total
      from public.tarefas_catalogo c
     where c.ativo
       and public.catalogo_condicao_avaliar(c.condicao, v_contexto) is distinct from false
       and exists (select 1 from public.pipeline_etapa_tarefas m
                    where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
                      and m.tarefa_codigo in (c.codigo, c.parent_codigo))
       and not exists (select 1 from public.pipeline_etapa_tarefas m
                        where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo'
                          and not m.ativo and m.tarefa_codigo = c.codigo);
  end if;

  -- Tarefas da empresa: sempre (qualquer regulamento), uma por chave. Prazo conta de v_desde (entrada na etapa).
  with gravadas as (
    insert into public.tarefas_equipe (
      tenant_id, licitacao_id, origem, titulo, descricao, condicao_verificada, prazo_situacao, prazo_em,
      responsavel_papel, criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome,
      origem_modelo_chave
    )
    select p_tenant, p_licitacao, 'empresa', m.titulo, m.descricao, true,
           case when m.prazo_horas is null then 'sem_prazo' else 'calculado' end,
           case when m.prazo_horas is null then null else v_desde + make_interval(hours => m.prazo_horas) end,
           'admin', p_user, p_user, p_etapa, m.id, v_etapa_nome, m.chave
      from public.pipeline_etapa_tarefas m
     where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'empresa' and m.ativo
    on conflict (tenant_id, licitacao_id, origem_modelo_chave) where origem = 'empresa' do nothing
    returning 1
  )
  select count(*) into v_emp from gravadas;
  v_total := v_total + (select count(*) from public.pipeline_etapa_tarefas m
                         where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'empresa' and m.ativo);

  return query select v_cat + v_emp, v_total - (v_cat + v_emp), v_bloqueio;
end;
$$;
comment on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) is
  'Cria as tarefas do modelo da etapa para a licitação (spec 0018, seção 3). Idempotente. p_prazo_desde = entrada '
  'na etapa (prazo da tarefa da empresa); nulo = now(). bloqueio: regulamento_nao_informado / regulamento_sem_catalogo '
  '(só as da empresa nascem), etapa_inexistente, fora_do_pipeline.';

-- Reaplicar: passa a entrada registrada de cada etapa; sucesso limpa a pendência.
create or replace function public.pipeline_tarefas_reaplicar(
  p_tenant    bigint,
  p_licitacao bigint,
  p_user      uuid default null
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_entrada  timestamptz;
  v_criadas  integer := 0;
  v_exist    integer := 0;
  v_bloqueio text;
  r          record;
  x          record;
begin
  if not exists (select 1 from public.pipeline_oportunidades po
                  where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao) then
    return query select 0, 0, 'fora_do_pipeline'::text;
    return;
  end if;

  select max(h.em) into v_entrada
    from public.pipeline_historico h
   where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao and h.etapa_de is null and h.etapa_para is not null;

  for r in
    select e.id,
           (select max(h.em) from public.pipeline_historico h
             where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao and h.etapa_para = e.id) as entrada
      from public.pipeline_etapas e
     where e.tenant_id = p_tenant
       and (e.id in (select po.etapa_id from public.pipeline_oportunidades po
                      where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao)
            or e.id in (select h.etapa_para from public.pipeline_historico h
                         where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao
                           and h.etapa_para is not null and h.em >= coalesce(v_entrada, '-infinity'::timestamptz)))
     order by e.ordem, e.id
  loop
    select * into x from public.pipeline_etapa_tarefas_criar(p_tenant, p_licitacao, r.id, p_user, r.entrada);
    v_criadas := v_criadas + x.criadas;
    v_exist := v_exist + x.existentes;
    v_bloqueio := coalesce(v_bloqueio, x.bloqueio);
  end loop;

  if v_bloqueio is null then
    delete from private.pipeline_tarefas_pendencias pp
     where pp.tenant_id = p_tenant and pp.licitacao_id = p_licitacao;
  end if;
  return query select v_criadas, v_exist, v_bloqueio;
end;
$$;

-- Gatilho de entrada na etapa: prazo conta de agora (o histórico desta entrada ainda não foi gravado).
create or replace function public.pipeline_oportunidades_tarefas()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then
    return null;
  end if;
  perform public.pipeline_etapa_tarefas_criar(new.tenant_id, new.licitacao_id, new.etapa_id, new.atualizada_por, now());
  return null;
end;
$$;

-- Gatilho de regulamento: falha vira pendência registrada (e WARNING), sem derrubar a coleta.
create or replace function public.licitacoes_externas_regulamento_reaplicar()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in select po.tenant_id
             from public.pipeline_oportunidades po
             join public.tenants t on t.id = po.tenant_id and t.ativo
            where po.licitacao_id = new.id loop
    begin
      perform public.pipeline_tarefas_reaplicar(r.tenant_id, new.id, null);
    exception when others then
      raise warning 'pipeline_tarefas_reaplicar(tenant %, licitação %) falhou: % (%)', r.tenant_id, new.id, sqlerrm, sqlstate;
      insert into private.pipeline_tarefas_pendencias (tenant_id, licitacao_id, motivo, erro)
      values (r.tenant_id, new.id, 'reaplicar_falhou', left(sqlerrm, 500))
      on conflict (tenant_id, licitacao_id) do update set motivo = excluded.motivo, erro = excluded.erro, em = now();
    end;
  end loop;
  return null;
end;
$$;

-- 5) Empresa reativada recebe etapas e modelo padrão (sem desfazer edição: on conflict do nothing nas duas sementes).
create or replace function public.tenants_reativada_semear()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.pipeline_semear_etapas(new.id);
  perform public.pipeline_semear_tarefas(new.id);
  return null;
end;
$$;
create or replace trigger tenants_reativada_semear_trg
  after update of ativo on public.tenants
  for each row when (old.ativo is distinct from true and new.ativo)
  execute function public.tenants_reativada_semear();

-- ACL -----------------------------------------------------------------------------------------------------------
revoke all on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_oportunidades_tarefas() from PUBLIC, anon, authenticated;
revoke all on function public.licitacoes_externas_regulamento_reaplicar() from PUBLIC, anon, authenticated;
revoke all on function public.tenants_reativada_semear() from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid, timestamptz) to service_role;
grant execute on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) to service_role;

commit;

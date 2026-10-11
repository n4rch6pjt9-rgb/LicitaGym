-- LicitaGym: correções da revisão do PR #329 (spec 0018; migration 20261011140100, já em produção).
--
-- O que muda:
--   pipeline_tarefas_reaplicar            limpa a pendência sempre que termina sem exceção, inclusive com bloqueio de
--                                         regulamento (sem catálogo é estado final) e fora do pipeline. Antes ela só
--                                         saía com bloqueio nulo: alerta falso permanente no card.
--   licitacoes_externas_regulamento_...   o insert da pendência fica protegido: se falhar, só WARNING (não derruba a
--                                         coleta, como na 20261011120000).
--   tenants_reativada_semear              empresa reativada recebe o modelo de tarefas nas etapas que existem; as 13
--                                         etapas padrão só se ela não tiver nenhuma (inativa quando a 20261006020000
--                                         semeou as outras). Antes semeava sempre, recriando etapa que o admin
--                                         excluiu ou renomeou. Empresa nova continua semeada no insert. Cards que
--                                         estão em Triagem ganham pedido de preparação (o gatilho só age ao mover).
--   índice private.pipeline_tarefas_pendencias (licitacao_id) para a FK on delete cascade.
-- Verificar: supabase/tests/pipeline_tarefas_pendencia_reativacao_check.sql. Idempotente.

begin;

set local lock_timeout = '5s';

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
    -- fora do pipeline não há tarefa a criar: a pendência antiga deixa de valer
    delete from private.pipeline_tarefas_pendencias pp
     where pp.tenant_id = p_tenant and pp.licitacao_id = p_licitacao;
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

  -- terminou sem exceção: a falha registrada deixou de valer. Bloqueio (regulamento ausente ou sem catálogo) não é
  -- falha: o card mostra o motivo pelo licitacao.regulamento, não pela pendência.
  delete from private.pipeline_tarefas_pendencias pp
   where pp.tenant_id = p_tenant and pp.licitacao_id = p_licitacao;
  return query select v_criadas, v_exist, v_bloqueio;
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
      begin
        insert into private.pipeline_tarefas_pendencias (tenant_id, licitacao_id, motivo, erro)
        values (r.tenant_id, new.id, 'reaplicar_falhou', left(sqlerrm, 500))
        on conflict (tenant_id, licitacao_id) do update set motivo = excluded.motivo, erro = excluded.erro, em = now();
      exception when others then
        -- nem a pendência gravou: só o WARNING, sem derrubar a coleta
        raise warning 'pendência de tarefas não registrada (tenant %, licitação %): %', r.tenant_id, new.id, sqlerrm;
      end;
    end;
  end loop;
  return null;
end;
$$;

create or replace function public.tenants_reativada_semear()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- empresa sem nenhuma etapa (inativa quando a 20261006020000 semeou as existentes): recebe as 13 padrão.
  -- Com etapas, elas são do admin: não recria excluída nem renomeada.
  if not exists (select 1 from public.pipeline_etapas e where e.tenant_id = new.id) then
    perform public.pipeline_semear_etapas(new.id);
  end if;
  -- modelo de tarefas nas etapas que existem (on conflict do nothing)
  perform public.pipeline_semear_tarefas(new.id);
  -- cards que ficaram em Triagem enquanto a empresa estava inativa ganham pedido de preparação (mesma regra do
  -- backfill da 20261011160000; um pedido aberto por empresa e licitação)
  insert into private.job_queue (job_type, payload)
  select 'preparar_triagem', jsonb_build_object('tenant_id', po.tenant_id::text, 'licitacao_id', po.licitacao_id::text,
                                                'fonte', l.fonte)
    from public.pipeline_oportunidades po
    join public.pipeline_etapas e on e.id = po.etapa_id and e.tenant_id = po.tenant_id and lower(btrim(e.nome)) = 'triagem'
    left join public.licitacoes_externas l on l.id = po.licitacao_id
   where po.tenant_id = new.id
  on conflict ((payload ->> 'tenant_id'), (payload ->> 'licitacao_id'))
    where job_type = 'preparar_triagem' and status in ('pending', 'processing')
  do nothing;
  return null;
end;
$$;
comment on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) is
  'Cria as tarefas que faltam da etapa atual e das visitadas desde a última entrada (spec 0018). Terminar sem exceção '
  'limpa a pendência, inclusive com bloqueio de regulamento (estado final) e fora do pipeline.';
comment on function public.tenants_reativada_semear() is
  'Empresa reativada: etapas padrão só se não tiver nenhuma; modelo de tarefas nas existentes (spec 0018). Não recria etapa excluída.';
comment on function public.licitacoes_externas_regulamento_reaplicar() is
  'Regulamento chegou (null → valor): reaplica as tarefas em cada empresa ativa; falha vira pendência e WARNING.';

create index if not exists pipeline_tarefas_pendencias_licitacao_idx
  on private.pipeline_tarefas_pendencias (licitacao_id);

revoke all on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.licitacoes_externas_regulamento_reaplicar() from PUBLIC, anon, authenticated;
revoke all on function public.tenants_reativada_semear() from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) to service_role;

commit;

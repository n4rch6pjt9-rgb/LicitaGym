-- LicitaGym: fila de preparação ao entrar em Triagem (spec 0018, PR 4a; CA-17). Decisões do Marcelo em 11/10/2026:
-- a fila prepara (detalhe PNCP com amparo_legal, download, indexação, reaplicar tarefas); os agentes rodam sob demanda
-- quando alguém abre a análise; o consumidor (PR 4b) roda no Cloud Run Job do coletor a cada 15 min.
--
-- O que muda:
--   private.job_queue (já existia, sem uso)  índice único parcial: no máximo um pedido aberto por (empresa, licitação)
--   gatilho em pipeline_oportunidades        ao entrar na etapa "Triagem" enfileira 'preparar_triagem'
--   public.fila_preparacao_reivindicar()     o consumidor pega N pedidos (FOR UPDATE SKIP LOCKED); pedido preso em
--                                            'processing' há mais de 1 h volta para a fila
--   public.fila_preparacao_concluir()        grava o desfecho no payload (resultado) ou reagenda com espera crescente
--   public.pipeline_preparacao_estado()      último pedido por licitação, para a api-pipeline mostrar "em preparação"
-- Funções em public (o coletor fala com o PostgREST no schema public); só service_role executa.
-- Verificar: supabase/tests/fila_preparacao_triagem_check.sql. Idempotente.

begin;

set local lock_timeout = '5s';

create unique index if not exists job_queue_preparar_triagem_aberto_uq
  on private.job_queue ((payload ->> 'tenant_id'), (payload ->> 'licitacao_id'))
  where job_type = 'preparar_triagem' and status in ('pending', 'processing');

-- Enfileirar ao entrar em Triagem (nome da etapa padrão; renomeada, deixa de enfileirar: o nome é o contrato).
create or replace function public.pipeline_oportunidades_enfileirar_triagem()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then
    return null;
  end if;
  if exists (select 1 from public.pipeline_etapas e
              where e.id = new.etapa_id and e.tenant_id = new.tenant_id and lower(e.nome) = 'triagem') then
    insert into private.job_queue (job_type, payload)
    values ('preparar_triagem', jsonb_build_object(
      'tenant_id', new.tenant_id::text,
      'licitacao_id', new.licitacao_id::text,
      'fonte', (select l.fonte from public.licitacoes_externas l where l.id = new.licitacao_id)))
    on conflict ((payload ->> 'tenant_id'), (payload ->> 'licitacao_id'))
      where job_type = 'preparar_triagem' and status in ('pending', 'processing')
    do nothing;
  end if;
  return null;
end;
$$;
create or replace trigger pipeline_oportunidades_enfileirar_triagem_trg
  after insert or update of etapa_id on public.pipeline_oportunidades
  for each row execute function public.pipeline_oportunidades_enfileirar_triagem();

-- Consumidor: pega até p_limite pedidos prontos. Pedido em 'processing' há mais de 1 h (job que morreu) volta.
create or replace function public.fila_preparacao_reivindicar(p_limite integer default 5)
returns table (id uuid, tenant_id bigint, licitacao_id bigint, fonte text, tentativa integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update private.job_queue q
     set status = 'pending', updated_at = now(), last_error = coalesce(q.last_error, 'preso em processing; devolvido')
   where q.job_type = 'preparar_triagem' and q.status = 'processing' and q.updated_at < now() - interval '1 hour';

  return query
  with alvo as (
    select q.id
      from private.job_queue q
     where q.job_type = 'preparar_triagem' and q.status = 'pending' and q.scheduled_for <= now()
     order by q.scheduled_for, q.created_at
     limit greatest(1, least(coalesce(p_limite, 5), 50))
       for update skip locked
  )
  update private.job_queue q
     set status = 'processing', attempts = q.attempts + 1, updated_at = now()
    from alvo
   where q.id = alvo.id
  returning q.id, (q.payload ->> 'tenant_id')::bigint, (q.payload ->> 'licitacao_id')::bigint,
            q.payload ->> 'fonte', q.attempts;
end;
$$;

-- Desfecho: resultado (ok | sem_documento | regulamento_nao_informado_pela_fonte) conclui; erro reagenda com espera
-- crescente (5, 10, 20, 40 min...) até max_attempts, depois 'failed'. Nunca apaga o pedido.
create or replace function public.fila_preparacao_concluir(
  p_id        uuid,
  p_resultado text,
  p_erro      text default null
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_status text;
begin
  if p_resultado is not null and p_resultado not in ('ok', 'sem_documento', 'regulamento_nao_informado_pela_fonte') then
    raise exception 'Resultado % inválido.', p_resultado using errcode = '22023';
  end if;
  if p_resultado is null and nullif(btrim(p_erro), '') is null then
    raise exception 'Informe o resultado ou o erro.' using errcode = '22023';
  end if;

  update private.job_queue q
     set status = case when p_resultado is not null then 'completed'
                       when q.attempts >= q.max_attempts then 'failed'
                       else 'pending' end,
         payload = case when p_resultado is not null
                        then q.payload || jsonb_build_object('resultado', p_resultado, 'concluido_em', now())
                        else q.payload end,
         last_error = case when p_resultado is null then left(p_erro, 1000) else q.last_error end,
         scheduled_for = case when p_resultado is null and q.attempts < q.max_attempts
                              then now() + make_interval(mins => 5 * power(2, greatest(q.attempts - 1, 0))::integer)
                              else q.scheduled_for end,
         updated_at = now()
   where q.id = p_id and q.job_type = 'preparar_triagem' and q.status = 'processing'
  returning q.status into v_status;
  if v_status is null then
    raise exception 'Pedido % não está em processamento.', p_id using errcode = 'P0002';
  end if;
  return v_status;
end;
$$;

-- Estado da preparação por licitação (último pedido da empresa), para a tela mostrar "análise em preparação".
create or replace function public.pipeline_preparacao_estado(p_tenant bigint, p_licitacoes bigint[])
returns table (licitacao_id bigint, status text, resultado text, erro text, atualizado_em timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct on ((q.payload ->> 'licitacao_id')::bigint)
         (q.payload ->> 'licitacao_id')::bigint, q.status, q.payload ->> 'resultado', q.last_error, q.updated_at
    from private.job_queue q
   where q.job_type = 'preparar_triagem'
     and q.payload ->> 'tenant_id' = p_tenant::text
     and (q.payload ->> 'licitacao_id')::bigint = any (p_licitacoes)
   order by (q.payload ->> 'licitacao_id')::bigint, q.created_at desc, (q.status in ('pending', 'processing')) desc
$$;

revoke all on function public.pipeline_oportunidades_enfileirar_triagem() from PUBLIC, anon, authenticated;
revoke all on function public.fila_preparacao_reivindicar(integer) from PUBLIC, anon, authenticated;
revoke all on function public.fila_preparacao_concluir(uuid, text, text) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_preparacao_estado(bigint, bigint[]) from PUBLIC, anon, authenticated;
grant execute on function public.fila_preparacao_reivindicar(integer) to service_role;
grant execute on function public.fila_preparacao_concluir(uuid, text, text) to service_role;
grant execute on function public.pipeline_preparacao_estado(bigint, bigint[]) to service_role;

commit;

-- LicitaGym, spec 0064: coleta do Sistema S por portal e em camadas (descoberta -> fila -> carga).
--
-- Contexto (medido em 13/11/2026): o coletor Paradigma hidrata de novo, a cada execução, tudo o que lista (fieb: 334
-- de 367 processos, 55 min) e não tem checkpoint: o job cortado pelo limite recomeça do zero. O sesc_senac_rs nunca
-- concluiu no runner de 70 min. A coleta passa a ter duas etapas: a descoberta lista o mural e enfileira só o que é
-- novo ou mudou (hash da linha da listagem); a carga hidrata a fila em fatias com orçamento de tempo.
--
-- O que muda:
--   K-1 private.coleta_externa_fila: um processo por (fonte, nCdOrigem, módulo), com a linha da listagem como veio
--       do portal, hash, status (pendente, processando, feito, erro), tentativas e erro. RLS ligada, sem policy, sem
--       grant a ninguém: só as RPCs abaixo leem e escrevem (e a saúde, security definer).
--   K-2 public.coleta_externa_fila_enfileirar(fonte, itens) -> {novos, reabertos, inalterados}: novo entra
--       pendente; existente volta a pendente (tentativas zeradas) se o hash mudou ou se a licitação está em
--       leads/monitorar e não é processada há mais de 24 h. Item em processamento não é tocado (a próxima
--       descoberta vê o hash diferente). Sem hash no item, vale o md5 da listagem.
--   K-3 public.coleta_externa_fila_reservar(fonte, limite): devolve 'processando' há mais de 2 h à fila e reserva
--       até `limite` (máx. 500) pendentes com for update skip locked, menos tentativas e mais antigos primeiro.
--       public.coleta_externa_fila_marcar(id, ok, erro): ok = feito; erro = tentativas + 1 e volta a pendente
--       enquanto tinha menos de 5 falhas (senão fica 'erro'); ok nulo = devolve à fila sem contar tentativa (carga
--       que parou no orçamento). Id inexistente = 22023.
--   K-7 coleta_externa_run.modo aceita 'descoberta' e 'carga'.
--   K-9 verificação coleta_externa_fila_pendente_horas (atenção 26 h, crítico 48 h; decisão do Marcelo de
--       13/11/2026): horas do pendente mais antigo entre fontes ativas do coletor Paradigma.
--   private.saude_operacional_resumo() é recriada a partir da definição da spec 0063
--   (20261113160000_coleta_externa_run_orfaos.sql), acrescentando só o bloco da fila.
--
-- Escreve: private.coleta_externa_fila (só pelas RPCs), private.saude_limiares (1 linha nova, sem sobrescrever
-- limiar editado), CHECK de private.coleta_externa_run.modo. Lê: public.licitacoes_externas (prioridade, para a
-- revisita), saúde operacional (só service_role, api-saude).
-- Quem chama: coletor Paradigma (`python3 -m coletor.paradigma --etapa ...`) com a service role key.
-- Verificação: supabase/tests/coleta_externa_fila_check.sql, coleta_externa_run_rpc_check.sql (CA-8) e
-- saude_coleta_externa_fila_check.sql.
--
-- Idempotente: create table/index if not exists, create or replace, drop/add da CHECK de modo (lista ampliada,
-- linhas atuais continuam válidas), insert ... on conflict do nothing.
--
-- ROLLBACK (não executado):
--   reaplicar private.saude_operacional_resumo de 20261113160000;
--   delete from private.saude_limiares where verificacao = 'coleta_externa_fila_pendente_horas';
--   drop function if exists public.coleta_externa_fila_enfileirar(text, jsonb),
--     public.coleta_externa_fila_reservar(text, integer), public.coleta_externa_fila_marcar(bigint, boolean, text);
--   drop table if exists private.coleta_externa_fila;
--   CHECK de modo de volta a ('leads','monitorar','historico','dry_run') depois de apagar as execuções
--   descoberta/carga.

begin;

set local lock_timeout = '10s';

-- K-1 ------------------------------------------------------------------------------------------------------------
create table if not exists private.coleta_externa_fila (
  id             bigint generated always as identity primary key,
  fonte          text not null references public.fontes_externas (slug),
  n_cd_origem    bigint not null check (n_cd_origem > 0),
  modulo         integer not null,
  listagem       jsonb not null default '{}'::jsonb,   -- linha da listagem como veio do portal
  hash_listagem  text not null,
  status         text not null default 'pendente' check (status in ('pendente', 'processando', 'feito', 'erro')),
  tentativas     integer not null default 0 check (tentativas >= 0),
  erro           text,
  descoberto_em  timestamptz not null default now(),
  pendente_desde timestamptz default now(),            -- desde quando o trabalho espera (saúde, K-9)
  atualizado_em  timestamptz not null default now(),
  processado_em  timestamptz,
  constraint coleta_externa_fila_processo_uq unique (fonte, n_cd_origem, modulo)
);

comment on table private.coleta_externa_fila is
  'Spec 0064: fila de processos do Paradigma a hidratar (descoberta -> carga). Só pelas RPCs coleta_externa_fila_*.';

-- Reserva e saúde: pendentes por fonte, do mais antigo; volta dos processando abandonados.
create index if not exists coleta_externa_fila_pendente_idx
  on private.coleta_externa_fila (fonte, pendente_desde) where status = 'pendente';
create index if not exists coleta_externa_fila_processando_idx
  on private.coleta_externa_fila (fonte, atualizado_em) where status = 'processando';

alter table private.coleta_externa_fila enable row level security;
revoke all on table private.coleta_externa_fila from public, anon, authenticated, service_role;

-- K-2 ------------------------------------------------------------------------------------------------------------
create or replace function public.coleta_externa_fila_enfileirar(p_fonte text, p_itens jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v jsonb;
begin
  if p_fonte is null then
    raise exception 'coleta_externa_fila_enfileirar: fonte é obrigatória' using errcode = '22004';
  end if;
  if p_itens is not null and jsonb_typeof(p_itens) <> 'array' then
    raise exception 'coleta_externa_fila_enfileirar: itens deve ser uma lista' using errcode = '22023';
  end if;

  with entrada as (
    select distinct on (x."nCdOrigem", coalesce(x.modulo, 59))
           x."nCdOrigem" as n_cd_origem, coalesce(x.modulo, 59) as modulo,
           coalesce(x.listagem, '{}'::jsonb) as listagem,
           coalesce(nullif(x.hash, ''), md5(coalesce(x.listagem, '{}'::jsonb)::text)) as hash
      from jsonb_to_recordset(coalesce(p_itens, '[]'::jsonb))
           as x("nCdOrigem" bigint, modulo integer, listagem jsonb, hash text)
     where x."nCdOrigem" > 0
  ), vivas as (
    -- licitações da fonte ainda acompanhadas (revisita diária, decisão de 13/11/2026)
    -- o detalhe gravado em raw traz o nCdOrigem; id_externo (nCdProcesso) só quando ele falta
    select le.modulo,
           case when le.raw ->> 'nCdOrigem' ~ '^[0-9]{1,18}$' then (le.raw ->> 'nCdOrigem')::bigint
                else le.id_externo::bigint end as n_cd_origem
      from public.licitacoes_externas le
     where le.fonte = p_fonte and le.prioridade in ('leads', 'monitorar')
  ), classif as (
    select e.*, f.id,
           case
             when f.id is null then 'novo'
             when f.status = 'processando' then 'inalterado'
             when f.hash_listagem is distinct from e.hash then 'reaberto'
             when f.status in ('feito', 'erro')
                  and coalesce(f.processado_em, f.atualizado_em) < now() - interval '24 hours'
                  and exists (select 1 from vivas v where v.modulo = e.modulo and v.n_cd_origem = e.n_cd_origem)
               then 'reaberto'
             else 'inalterado'
           end as acao
      from entrada e
      left join private.coleta_externa_fila f
        on f.fonte = p_fonte and f.n_cd_origem = e.n_cd_origem and f.modulo = e.modulo
  ), ins as (
    insert into private.coleta_externa_fila (fonte, n_cd_origem, modulo, listagem, hash_listagem)
    select p_fonte, c.n_cd_origem, c.modulo, c.listagem, c.hash from classif c where c.acao = 'novo'
    on conflict (fonte, n_cd_origem, modulo) do nothing
    returning 1
  ), upd as (
    update private.coleta_externa_fila f
       set listagem = c.listagem, hash_listagem = c.hash, status = 'pendente', tentativas = 0, erro = null,
           pendente_desde = case when f.status = 'pendente' then f.pendente_desde else now() end,
           atualizado_em = now()
      from classif c
     where c.acao = 'reaberto' and f.id = c.id and f.status <> 'processando'
    returning 1
  )
  select jsonb_build_object('novos', (select count(*) from ins),
                            'reabertos', (select count(*) from upd),
                            'inalterados', (select count(*) from classif c where c.acao = 'inalterado'))
    into v;
  return v;
end
$fn$;

-- K-3 ------------------------------------------------------------------------------------------------------------
create or replace function public.coleta_externa_fila_reservar(p_fonte text, p_limite integer default 20)
returns table (id bigint, n_cd_origem bigint, modulo integer, listagem jsonb)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
#variable_conflict use_column
begin
  if p_fonte is null then
    raise exception 'coleta_externa_fila_reservar: fonte é obrigatória' using errcode = '22004';
  end if;
  -- worker que morreu (job cancelado sem devolver): volta à fila depois de 2 h
  update private.coleta_externa_fila f
     set status = 'pendente', atualizado_em = now()
   where f.fonte = p_fonte and f.status = 'processando' and f.atualizado_em < now() - interval '2 hours';

  return query
    with alvo as (
      select f.id
        from private.coleta_externa_fila f
       where f.fonte = p_fonte and f.status = 'pendente'
       -- menos falhas primeiro: item que acabou de falhar não volta à frente na mesma execução da carga
       order by f.tentativas, f.pendente_desde nulls first, f.id
       limit least(greatest(coalesce(p_limite, 20), 1), 500)
         for update skip locked
    )
    update private.coleta_externa_fila f
       set status = 'processando', atualizado_em = now()
      from alvo
     where f.id = alvo.id
    returning f.id, f.n_cd_origem, f.modulo, f.listagem;
end
$fn$;

create or replace function public.coleta_externa_fila_marcar(p_id bigint, p_ok boolean, p_erro text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  update private.coleta_externa_fila f
     set status = case when p_ok then 'feito'
                       when p_ok is null then 'pendente'
                       when f.tentativas < 5 then 'pendente'
                       else 'erro' end,
         tentativas = case when p_ok is false then f.tentativas + 1 else f.tentativas end,
         erro = case when p_ok then null when p_ok is null then f.erro else left(p_erro, 1000) end,
         processado_em = case when p_ok then now() else f.processado_em end,
         atualizado_em = now()
   where f.id = p_id;
  if not found then
    raise exception 'coleta_externa_fila_marcar: item % inexistente', p_id using errcode = '22023';
  end if;
  return true;
end
$fn$;

comment on function public.coleta_externa_fila_enfileirar(text, jsonb) is
  'Spec 0064 K-2. Enfileira processos da listagem do Paradigma: novos, reabertos (hash mudou ou revisita de '
  'leads/monitorar após 24 h) e inalterados. Só service_role.';
comment on function public.coleta_externa_fila_reservar(text, integer) is
  'Spec 0064 K-3. Reserva pendentes da fonte (for update skip locked); processando há mais de 2 h volta à fila. '
  'Só service_role.';
comment on function public.coleta_externa_fila_marcar(bigint, boolean, text) is
  'Spec 0064 K-3. ok = feito; erro = tentativa + 1 (volta a pendente enquanto tinha menos de 5 falhas); ok nulo = '
  'devolve à fila sem contar tentativa. Só service_role.';

revoke all on function public.coleta_externa_fila_enfileirar(text, jsonb) from public, anon, authenticated;
revoke all on function public.coleta_externa_fila_reservar(text, integer) from public, anon, authenticated;
revoke all on function public.coleta_externa_fila_marcar(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.coleta_externa_fila_enfileirar(text, jsonb) to service_role;
grant execute on function public.coleta_externa_fila_reservar(text, integer) to service_role;
grant execute on function public.coleta_externa_fila_marcar(bigint, boolean, text) to service_role;

-- K-7 ------------------------------------------------------------------------------------------------------------
alter table private.coleta_externa_run drop constraint if exists coleta_externa_run_modo_check;
alter table private.coleta_externa_run add constraint coleta_externa_run_modo_check
  check (modo in ('leads', 'monitorar', 'historico', 'dry_run', 'descoberta', 'carga'));

-- K-9: limiares (o da 0063 se repete: a definição mais recente da saúde traz os limiares que mede) ---------------
insert into private.saude_limiares (verificacao, descricao, unidade, atencao, critico, sem_dado) values
  ('coleta_externa_executando_horas', 'Horas da execução do Sistema S em andamento mais antiga', 'horas', 2, 7, 'atencao'),
  ('coleta_externa_fila_pendente_horas', 'Horas do processo pendente mais antigo na fila do Sistema S', 'horas', 26, 48, 'atencao')
on conflict (verificacao) do nothing;

create or replace function private.saude_operacional_resumo()
returns table (verificacao text, status text, valor numeric, unidade text, atencao numeric, critico numeric,
               mensagem text, detalhe jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
#variable_conflict use_column
declare
  m jsonb := '[]'::jsonb;   -- [{verificacao, valor, detalhe}]
  v numeric;
  d jsonb;
  n_com bigint;
  n_total bigint;
  total_estimado boolean;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select count(*), coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'em', r.start_time,
                                          'erro', left(r.return_message, 200)) order by r.start_time desc), '[]'::jsonb)
        from cron.job_run_details r join cron.job j on j.jobid = r.jobid
       where j.jobname like 'licitagym-%' and r.status = 'failed' and r.start_time > now() - interval '24 hours'$q$
      into v, d;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_falhas_24h', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('private.cron_edge_chamadas') is not null then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'http', c.status_code,
                                        'timeout', c.timed_out, 'erro', left(coalesce(c.erro, c.resposta), 200),
                                        'em', c.chamado_em) order by c.chamado_em desc), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.chamado_em > now() - interval '24 hours'
       and (c.status_code >= 400 or c.timed_out or c.erro is not null);
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_http_erros_24h', 'valor', v, 'detalhe', d));

    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'em', c.chamado_em)), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.respondido_em is null and c.chamado_em < now() - interval '30 minutes'
       and c.chamado_em > now() - interval '7 days';
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_sem_resposta', 'valor', v, 'detalhe', d));
  end if;

  select round(max(extract(epoch from now() - coalesce(r.last_heartbeat_at, r.iniciada_em)) / 60)),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                            'heartbeat', coalesce(r.last_heartbeat_at, r.iniciada_em))), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'executando';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_heartbeat_parado', 'valor', coalesce(v, 0), 'detalhe', d));

  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                                      'erro', left(r.erro_principal, 200), 'em', r.iniciada_em)), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'falhou' and r.iniciada_em > now() - interval '24 hours';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_falhas_24h', 'valor', v, 'detalhe', d));

  select max(t.dias), jsonb_object_agg(t.resource_type, t.dias)
    into v, d
    from (select x.resource_type,
                 round((extract(epoch from now() - max(r.finalizada_em)) / 86400)::numeric, 1) as dias
            from (values ('pca'), ('orgaos'), ('compras_catmat')) x(resource_type)
            left join private.pncp_sync_run r
              on r.resource_type = x.resource_type and r.status in ('concluida', 'concluida_com_erros')
           group by x.resource_type) t;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_dias_sem_sucesso', 'valor', v, 'detalhe', d));

  if to_regclass('private.coleta_externa_run') is not null then
    -- Spec 0063, K-7: cobra toda fonte ativa do coletor Paradigma (fontes_externas.ativo, plataforma paradigma, modo
    -- de coleta diferente de 'bloqueado'). Valor = dias da pior fonte; fonte ativa sem nenhuma conclusão deixa o valor
    -- sem dado (crítico pelo limiar) e aparece com data nula no detalhe. Nenhuma fonte ativa = sem dado.
    select case when count(*) = 0 or bool_or(t.ultima is null) then null
                else round((extract(epoch from now() - min(t.ultima)) / 86400)::numeric, 1) end,
           coalesce(jsonb_object_agg(t.slug, t.ultima), '{}'::jsonb)
      into v, d
      from (select f.slug, max(r.finished_at) as ultima
              from public.fontes_externas f
              left join private.coleta_externa_run r
                on r.fonte = f.slug and r.status in ('concluida', 'concluida_com_erros')
             where f.ativo and f.plataforma = 'paradigma' and f.modo_coleta <> 'bloqueado'
             group by f.slug) t;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_dias_sem_sucesso', 'valor', v, 'detalhe', d));

    -- Spec 0063, K-3: horas da execução em andamento mais antiga (0 sem nenhuma); detalhe = início por fonte. Pega
    -- execução presa que o fechamento de órfãs (6 h, de hora em hora) ainda não fechou ou não consegue fechar.
    select coalesce(round((extract(epoch from now() - min(t.desde)) / 3600)::numeric, 1), 0),
           coalesce(jsonb_object_agg(t.fonte, t.desde), '{}'::jsonb)
      into v, d
      from (select fonte, min(started_at) as desde
              from private.coleta_externa_run where status = 'executando'
             group by fonte) t;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_executando_horas', 'valor', v, 'detalhe', d));

    if to_regclass('private.coleta_externa_fila') is not null then
      -- Spec 0064, K-9: horas do pendente mais antigo da fila (0 com a fila vazia) entre as fontes ativas do coletor
      -- Paradigma (mesmo recorte da coleta_externa_dias_sem_sucesso); detalhe = pendentes e o mais antigo por fonte.
      select coalesce(round((extract(epoch from now() - min(t.desde)) / 3600)::numeric, 1), 0),
             coalesce(jsonb_object_agg(t.fonte, jsonb_build_object('pendentes', t.n, 'desde', t.desde)), '{}'::jsonb)
        into v, d
        from (select q.fonte, count(*) as n, min(coalesce(q.pendente_desde, q.atualizado_em)) as desde
                from private.coleta_externa_fila q
                join public.fontes_externas f on f.slug = q.fonte
               where q.status = 'pendente'
                 and f.ativo and f.plataforma = 'paradigma' and f.modo_coleta <> 'bloqueado'
               group by q.fonte) t;
      m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_fila_pendente_horas', 'valor', v, 'detalhe', d));
    end if;
  end if;

  if to_regclass('public.precos_praticados_itens') is not null then
    -- Pesquisa de Preço (spec 0009): dias desde a última gravação de preço. last_synced_at só muda quando o upsert
    -- do coletor grava; uma coleta que falha inteira não move a data. Nenhum preço = sem dado (crítico).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object(
             'ultima_coleta', max(p.last_synced_at),
             'linhas', count(*),
             'sem_descricao_detalhada', count(*) filter (where nullif(btrim(p.descricao_detalhada_item), '') is null),
             'detalhe_sincronizado', count(*) filter (where p.detalhe_sincronizado_em is not null))
      into v, d
      from public.precos_praticados_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'precos_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.pca_pgc_itens') is not null then
    -- PGC (spec 0057): dias desde a última gravação do coletor compras_pgc. O upsert regrava last_synced_at de toda
    -- linha lida; uma coleta que falha inteira não move a data. Nenhuma linha = sem dado (atenção, pelo limiar).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object('ultima_coleta', max(p.last_synced_at), 'linhas', count(*))
      into v, d
      from public.pca_pgc_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pgc_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  select round((extract(epoch from now() - max(l.created_at)) / 3600)::numeric, 1),
         coalesce((select jsonb_object_agg(f.fonte, f.ultima)
                     from (select fonte, max(created_at) as ultima from public.licitacoes_externas group by fonte) f), '{}'::jsonb)
    into v, d
    from public.licitacoes_externas l;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'licitacoes_horas_sem_novas', 'valor', v, 'detalhe', d));

  -- Itens sem taxonomia: conta exato só os itens COM taxonomia (poucos), pelo índice de expressão
  -- licitacao_itens_no_taxonomia_efetiva_idx (o predicado repete a expressão do índice). O total vem da estimativa
  -- do planner (pg_class.reltuples, mantida por autovacuum/analyze) e o detalhe diz isso em total_estimado.
  -- Tabela nunca analisada (reltuples < 0): conta exato, porque aí ela ainda é pequena.
  select count(*) into n_com
    from public.licitacao_itens i
   where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is not null;
  select c.reltuples::bigint into n_total from pg_class c where c.oid = 'public.licitacao_itens'::regclass;
  total_estimado := coalesce(n_total, -1) >= 0;
  if not total_estimado then
    select count(*) into n_total from public.licitacao_itens;
  end if;
  n_total := greatest(n_total, n_com);
  v := round(100.0 * (n_total - n_com) / nullif(n_total, 0), 1);
  d := jsonb_build_object('itens', n_total, 'sem_taxonomia', n_total - n_com, 'com_taxonomia', n_com,
                          'total_estimado', total_estimado);
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'itens_sem_taxonomia_pct', 'valor', v, 'detalhe', d));

  return query
    with medidas as (
      select e ->> 'verificacao' as verificacao, (e ->> 'valor')::numeric as valor, e -> 'detalhe' as detalhe
        from jsonb_array_elements(m) e
    ), avaliadas as (
      select x.verificacao,
             case when x.valor is null then l.sem_dado
                  when l.critico is not null and x.valor >= l.critico then 'critico'
                  when x.valor >= l.atencao then 'atencao'
                  else 'ok' end as status,
             x.valor, l.unidade, l.atencao, l.critico, l.descricao, x.detalhe
        from medidas x join private.saude_limiares l on l.verificacao = x.verificacao
       where l.ativo
    )
    select a.verificacao, a.status, a.valor, a.unidade, a.atencao, a.critico,
           a.descricao || ': ' || coalesce(a.valor::text || ' ' || a.unidade, 'sem dado') ||
             ' (atenção ≥ ' || a.atencao || coalesce(', crítico ≥ ' || a.critico, '') || ')',
           a.detalhe
      from avaliadas a
     order by case a.status when 'critico' then 0 when 'atencao' then 1 else 2 end, a.verificacao;
end

$fn$;

comment on function private.saude_operacional_resumo() is
  'Verificações de saúde da ingestão (cron, sync PNCP, coleta externa e fila do Sistema S, coleta de preços, PGC, '
  'volume, taxonomia) com '
  'status por limiar de private.saude_limiares. Só leitura. EXECUTE só service_role (api-saude).';

revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function private.saude_operacional_resumo() to service_role;

commit;

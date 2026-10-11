-- LicitaGym: tarefas da equipe, instância por certame em cima do catálogo 14.133 (#252, spec 0019).
--
-- Por quê: o catálogo (20260927100000 + seed 20260927100100) diz o que a lei permite ou exige do fornecedor em cada
-- fase e evento, mas não havia onde gravar "a empresa X tem esta tarefa na licitação Y", com responsável, prazo e
-- status. A spec 0018 (tarefas padrão por etapa) depende desta tabela.
--
-- O que muda:
--   public.tarefas_equipe            tabela nova (uma linha = uma tarefa de uma empresa numa licitação)
--   public.tarefas_contexto_certame  contexto do certame só com dado oficial (v1: srp do PNCP, raw->>'srp')
--   public.tarefas_equipe_liberar    cria as tarefas que uma fase ou um evento liberam (idempotente)
--
-- Regras (spec 0019, decisões do Marcelo em 10/10/2026):
--   * Só licitação no pipeline da empresa recebe tarefa (bloqueio 'fora_do_pipeline').
--   * Gate de regulamento: só LEI_14133 e LEI_14981. Nulo -> 'regulamento_nao_informado' (em 10/10, todas as linhas:
--     nada nasce até o backfill pelo amparoLegal do PNCP); outro -> 'regulamento_sem_catalogo'. LEI_14981 ainda não
--     passa no licext_regulamento_chk (20260925120000): o ramo vale quando o PR do backfill ampliar o check.
--   * srp vem só do PNCP (raw->>'srp'). licitacoes_externas.objeto_registro_preco NÃO serve: é regex sobre o texto
--     do objeto, not null default false (20261004140000), e transformaria ausência em "não se aplica".
--   * Condição do catálogo: chave ausente no contexto -> tarefa criada com condicao_verificada nulo ("condição não
--     verificada"); condição falsa -> tarefa não nasce. false nunca é gravado.
--   * Prazo: nenhuma data inventada. dias_uteis/meses/anos -> 'nao_calculado'; demais unidades viram a situação do
--     catálogo. prazo_em só existe com 'manual' (a equipe informou; prazo_informado_por/em) ou 'calculado'
--     (reservado para a spec 0018: prazo da tarefa da empresa contado da entrada na etapa).
--   * Liberar de novo (ou por fase depois do evento) não duplica: guarda a segunda origem e, se a condição antes não
--     verificada agora se confirma, grava true. Sair do pipeline não apaga a tarefa (decisão 2 da spec 0018).
--   * Responsável: nasce para o papel admin, sem pessoa (decisão 3 da spec 0018).
--   * O catálogo não muda: responsável, prazo e status ficam na instância.
--
-- Quem lê/escreve: só service_role (Edge Function api-tarefas, que confere usuário, empresa e papel).
-- Verificar: supabase/tests/tarefas_equipe_check.sql.
-- Idempotente.

begin;

-- ---------------------------------------------------------------- tabela
create table if not exists public.tarefas_equipe (
  id                   bigint generated always as identity primary key,
  tenant_id            bigint not null references public.tenants (id) on delete cascade,
  licitacao_id         bigint not null references public.licitacoes_externas (id) on delete cascade,
  origem               text   not null default 'catalogo',
  tarefa_codigo        text   references public.tarefas_catalogo (codigo),
  titulo               text,
  descricao            text,
  liberada_por_fase    text   references public.processo_fases (codigo),
  liberada_por_evento  text   references public.processo_eventos (codigo),
  condicao_verificada  boolean,
  contexto             jsonb  not null default '{}'::jsonb,
  prazo_situacao       text   not null,
  prazo_em             timestamptz,
  prazo_informado_por  uuid,
  prazo_informado_em   timestamptz,
  status               text   not null default 'aberta',
  responsavel_papel    text   not null default 'admin',
  responsavel_user_id  uuid   references auth.users (id) on delete set null,
  criada_por           uuid,
  criada_em            timestamptz not null default now(),
  atualizada_por       uuid,
  atualizada_em        timestamptz not null default now(),
  concluida_em         timestamptz
);

comment on table public.tarefas_equipe is
  'Tarefas da equipe do fornecedor por licitação (#252). origem catalogo: código do catálogo 14.133; origem empresa: '
  'tarefa escrita pela empresa (spec 0018). Só service_role; o cliente chega pela api-tarefas.';
comment on column public.tarefas_equipe.condicao_verificada is
  'Resultado de catalogo_condicao_avaliar na liberação: true, ou nulo = condição não verificada (falta dado no '
  'contexto). false nunca é gravado: a tarefa não nasce.';
comment on column public.tarefas_equipe.prazo_situacao is
  'nao_calculado (dias úteis sem calendário, ou sem data do evento), definido_no_edital, sem_prazo_legal, imediato, '
  'manual (prazo_em informado pela equipe), calculado (reservado à spec 0018).';
comment on column public.tarefas_equipe.responsavel_papel is
  'Papel do responsável: admin na criação (fila dos admins); ao atribuir, o papel do membro em tenant_membros.';
comment on column public.tarefas_equipe.tarefa_codigo is
  'Código do catálogo. O catálogo desativa por ativo=false e nunca apaga: a FK sem on delete preserva a instância.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_origem_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_origem_chk check (
      (origem = 'catalogo' and tarefa_codigo is not null
        and (liberada_por_fase is not null or liberada_por_evento is not null))
      or (origem = 'empresa' and tarefa_codigo is null and nullif(btrim(titulo), '') is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_condicao_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_condicao_chk
      check (condicao_verificada is distinct from false);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_prazo_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_prazo_chk check (
      prazo_situacao in ('nao_calculado', 'definido_no_edital', 'sem_prazo_legal', 'imediato', 'manual', 'calculado')
      and ((prazo_situacao in ('manual', 'calculado')) = (prazo_em is not null))
      and (prazo_situacao <> 'manual' or (prazo_informado_por is not null and prazo_informado_em is not null))
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_status_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_status_chk
      check (status in ('aberta', 'em_andamento', 'concluida', 'cancelada'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_papel_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_papel_chk
      check (responsavel_papel in ('admin', 'operacao'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_concluida_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_concluida_chk
      check ((status = 'concluida') = (concluida_em is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_contexto_chk') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_contexto_chk
      check (jsonb_typeof(contexto) = 'object');
  end if;
end $$;

-- Uma instância por código do catálogo na licitação da empresa (liberar de novo, ou por fase e por evento, não duplica).
create unique index if not exists tarefas_equipe_catalogo_uq
  on public.tarefas_equipe (tenant_id, licitacao_id, tarefa_codigo) where origem = 'catalogo';
-- Listagens da api-tarefas: por licitação, e a fila/tarefas de uma pessoa.
create index if not exists tarefas_equipe_tenant_licitacao_idx on public.tarefas_equipe (tenant_id, licitacao_id);
create index if not exists tarefas_equipe_responsavel_idx
  on public.tarefas_equipe (tenant_id, responsavel_user_id, status);

alter table public.tarefas_equipe enable row level security;
revoke all on table public.tarefas_equipe from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table public.tarefas_equipe to service_role;

-- ---------------------------------------------------------------- contexto do certame
-- Só dado oficial. Chave sem dado fica ausente (vira "condição não verificada"), nunca presumida.
create or replace function public.tarefas_contexto_certame(p_licitacao_id bigint)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(
           (select case
                     when lower(l.raw ->> 'srp') in ('true', 't', '1', 'sim')         then jsonb_build_object('srp', true)
                     when lower(l.raw ->> 'srp') in ('false', 'f', '0', 'nao', 'não') then jsonb_build_object('srp', false)
                     else '{}'::jsonb
                   end
              from public.licitacoes_externas l
             where l.id = p_licitacao_id),
           '{}'::jsonb);
$$;
comment on function public.tarefas_contexto_certame(bigint) is
  'Contexto do certame para avaliar a condição do catálogo, só com dado oficial. v1: srp do PNCP (raw->>''srp''); '
  'sem o campo, a chave fica ausente (condição não verificada). Nunca objeto_registro_preco (regex no texto).';

-- Situação do prazo na criação (nenhuma data calculada no v1).
create or replace function public.tarefas_prazo_situacao(p_unidade public.prazo_unidade)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select case p_unidade
           when 'definido_no_edital' then 'definido_no_edital'
           when 'sem_prazo_legal'    then 'sem_prazo_legal'
           when 'imediato'           then 'imediato'
           else 'nao_calculado'
         end;
$$;

-- ---------------------------------------------------------------- liberar
-- security invoker, como pipeline_mover: só a service_role executa, e ela já lê o catálogo e grava a instância.
create or replace function public.tarefas_equipe_liberar(
  p_tenant_id    bigint,
  p_licitacao_id bigint,
  p_fase         text,
  p_evento       text,
  p_user_id      uuid
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_regulamento text;
  v_contexto    jsonb;
  v_total       integer;
  v_criadas     integer;
begin
  if (p_fase is null) = (p_evento is null) then
    raise exception 'Informe exatamente um entre fase e evento.' using errcode = '22023';
  end if;
  if p_user_id is null then
    raise exception 'Usuário obrigatório.' using errcode = '22023';
  end if;
  if p_fase is not null and not exists (select 1 from public.processo_fases f where f.codigo = p_fase) then
    raise exception 'Fase % não existe no catálogo.', p_fase using errcode = '22023';
  end if;
  if p_evento is not null and not exists (select 1 from public.processo_eventos e where e.codigo = p_evento) then
    raise exception 'Evento % não existe no catálogo.', p_evento using errcode = '22023';
  end if;

  if not exists (select 1 from public.pipeline_oportunidades o
                  where o.tenant_id = p_tenant_id and o.licitacao_id = p_licitacao_id) then
    return query select 0, 0, 'fora_do_pipeline'::text;
    return;
  end if;

  select l.regulamento into v_regulamento from public.licitacoes_externas l where l.id = p_licitacao_id;
  if v_regulamento is null then
    return query select 0, 0, 'regulamento_nao_informado'::text;
    return;
  end if;
  if v_regulamento not in ('LEI_14133', 'LEI_14981') then
    return query select 0, 0, 'regulamento_sem_catalogo'::text;
    return;
  end if;

  v_contexto := public.tarefas_contexto_certame(p_licitacao_id);

  select count(*) into v_total
    from (select f.codigo from public.catalogo_tarefas_da_fase(p_fase, v_contexto) f where p_fase is not null
          union all
          select e.codigo from public.catalogo_tarefas_do_evento(p_evento, v_contexto) e where p_evento is not null) x;

  with gravadas as (
    insert into public.tarefas_equipe as te (
      tenant_id, licitacao_id, origem, tarefa_codigo, liberada_por_fase, liberada_por_evento,
      condicao_verificada, contexto, prazo_situacao, responsavel_papel, criada_por, atualizada_por
    )
    select p_tenant_id, p_licitacao_id, 'catalogo', t.codigo, p_fase, p_evento,
           t.aplicavel, v_contexto, public.tarefas_prazo_situacao(t.prazo_unidade), 'admin', p_user_id, p_user_id
      from (select f.codigo, f.aplicavel, f.prazo_unidade
              from public.catalogo_tarefas_da_fase(p_fase, v_contexto) f where p_fase is not null
            union all
            select e.codigo, e.aplicavel, e.prazo_unidade
              from public.catalogo_tarefas_do_evento(p_evento, v_contexto) e where p_evento is not null) t
    on conflict (tenant_id, licitacao_id, tarefa_codigo) where origem = 'catalogo' do update
       set liberada_por_fase   = coalesce(te.liberada_por_fase, excluded.liberada_por_fase),
           liberada_por_evento = coalesce(te.liberada_por_evento, excluded.liberada_por_evento),
           condicao_verificada = coalesce(te.condicao_verificada, excluded.condicao_verificada),
           contexto            = case when te.condicao_verificada is null and excluded.condicao_verificada
                                      then excluded.contexto else te.contexto end
     where (te.liberada_por_fase is null and excluded.liberada_por_fase is not null)
        or (te.liberada_por_evento is null and excluded.liberada_por_evento is not null)
        or (te.condicao_verificada is null and excluded.condicao_verificada)
    returning (xmax = 0) as nova
  )
  select count(*) filter (where nova) into v_criadas from gravadas;

  return query select v_criadas, v_total - v_criadas, null::text;
end;
$$;
comment on function public.tarefas_equipe_liberar(bigint, bigint, text, text, uuid) is
  'Cria as tarefas do catálogo que uma fase ou um evento liberam para a licitação da empresa (idempotente). '
  'bloqueio: fora_do_pipeline, regulamento_nao_informado, regulamento_sem_catalogo (nada gravado).';

revoke all on function public.tarefas_contexto_certame(bigint) from PUBLIC, anon, authenticated;
revoke all on function public.tarefas_prazo_situacao(public.prazo_unidade) from PUBLIC, anon, authenticated;
revoke all on function public.tarefas_equipe_liberar(bigint, bigint, text, text, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.tarefas_contexto_certame(bigint) to service_role;
grant execute on function public.tarefas_prazo_situacao(public.prazo_unidade) to service_role;
grant execute on function public.tarefas_equipe_liberar(bigint, bigint, text, text, uuid) to service_role;

commit;

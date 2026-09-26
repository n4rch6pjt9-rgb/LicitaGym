-- LicitaGym: catálogo determinístico de tarefas do FORNECEDOR por fase do processo licitatório.
--
-- Objetivo: a rota "Tarefas da equipe" só oferece o que a lei permite ou exige naquele momento.
-- Cada tarefa tem código estável, fase, evento que abre a janela, prazo legal, condição de
-- aplicabilidade e base legal (artigo + texto). Nada é inferido em tempo de execução.
--
-- Modelo:
--   norma_dispositivos            texto dos artigos citados (fonte + flag de conferência oficial)
--   processo_fases                fases (Lei 14.133, art. 17) + fases do contrato + trilhas transversais
--   processo_eventos              gatilhos que abrem/fecham janelas (ex.: ATA_HABILITACAO)
--   processo_fase_transicoes      máquina de estados entre fases (com condição, ex.: inversão de fases)
--   tarefas_catalogo              árvore de tarefas (parent_codigo) com prazo e condição
--   tarefas_catalogo_base_legal   N:N tarefa -> dispositivo
--   tarefas_catalogo_dependencias pré-requisitos e bloqueios entre tarefas
--
-- Condição de aplicabilidade (jsonb): objeto { chave: valor | [valores] }.
--   Valor escalar  -> contexto->>chave deve ser igual.
--   Array          -> contexto->>chave deve estar na lista.
--   Chave ausente no contexto -> resultado NULL ("condição não verificada"), nunca false.
--   Golden rule: ausência nunca vira "não se aplica".
--
-- Escopo v1: Lei 14.133/2021, perspectiva do licitante/contratado, do edital ao fim do contrato.
-- Fora do v1: LC 123/2006 (só referenciada), decretos/IN, regulamentos do Sistema S,
-- calendário de feriados para contagem de dias úteis.
--
-- RLS: catálogo é dado de referência. SELECT authenticated; escrita só admin
-- (app_metadata.licitagym_role = 'admin') ou service_role. Precedente: 20260926110000.
-- Idempotente.

-- ---------------------------------------------------------------- domínios
do $$ begin
  create type public.prazo_unidade as enum
    ('dias_uteis', 'dias_corridos', 'meses', 'anos', 'imediato', 'definido_no_edital', 'sem_prazo_legal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.prazo_sentido as enum ('antes_de', 'apos', 'ate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.tarefa_natureza as enum
    ('obrigacao', 'faculdade', 'direito', 'acompanhamento', 'preparacao');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- dispositivos legais
create table if not exists public.norma_dispositivos (
  id                 bigint generated always as identity primary key,
  norma              text    not null,                 -- 'LEI_14133_2021'
  artigo             integer not null,
  texto              text    not null,                 -- texto literal do artigo (recorte)
  recorte            text,                             -- ex.: 'caput e §§ 1º a 3º' quando parcial
  fonte_url          text    not null,
  conferido_oficial  boolean not null default false,   -- true só após conferência com o Planalto
  observacao         text,
  atualizado_em      timestamptz not null default now(),
  unique (norma, artigo)
);
comment on table public.norma_dispositivos is
  'Texto dos artigos citados pelo catálogo de tarefas. conferido_oficial=false até conferência com o Planalto.';

-- ---------------------------------------------------------------- fases
create table if not exists public.processo_fases (
  codigo        text primary key,                      -- 'F05'
  norma         text    not null,
  ordem         integer,                               -- null = trilha transversal
  nome          text    not null,
  macro         text    not null check (macro in ('certame', 'contrato', 'transversal')),
  descricao     text    not null,
  artigos       integer[] not null default '{}'
);
comment on table public.processo_fases is
  'Fases do processo (Lei 14.133 art. 17 + contrato). ordem null = trilha transversal (sanções, ata SRP).';

-- ---------------------------------------------------------------- eventos (gatilhos)
create table if not exists public.processo_eventos (
  codigo        text primary key,                      -- 'ATA_HABILITACAO'
  fase_codigo   text references public.processo_fases (codigo),
  nome          text not null,
  descricao     text not null,
  origem        text not null check (origem in ('orgao', 'licitante', 'calendario', 'plataforma')),
  fonte_dado    text                                   -- onde o LicitaGym detecta (PNCP, portal, manual)
);
comment on table public.processo_eventos is
  'Gatilhos que abrem ou fecham janelas de tarefas. fonte_dado diz como o evento é detectado.';

-- ---------------------------------------------------------------- transições
create table if not exists public.processo_fase_transicoes (
  id             bigint generated always as identity primary key,
  norma          text not null,
  fase_origem    text not null references public.processo_fases (codigo),
  fase_destino   text not null references public.processo_fases (codigo),
  evento_codigo  text not null references public.processo_eventos (codigo),
  condicao       jsonb not null default '{}'::jsonb,
  artigo_base    text not null,
  unique (norma, fase_origem, fase_destino, evento_codigo)
);
comment on table public.processo_fase_transicoes is
  'Máquina de estados entre fases. condicao usa a mesma regra de tarefas_catalogo.condicao.';

-- ---------------------------------------------------------------- tarefas
create table if not exists public.tarefas_catalogo (
  codigo              text primary key,                -- '14133-F05-T02'
  norma               text not null,
  fase_codigo         text not null references public.processo_fases (codigo),
  parent_codigo       text references public.tarefas_catalogo (codigo),
  ordem               integer not null,
  titulo              text not null,
  descricao           text not null,
  natureza            public.tarefa_natureza not null,
  ator                text not null check (ator in ('licitante', 'contratado', 'licitante_ou_contratado')),
  evento_abertura     text references public.processo_eventos (codigo),   -- janela abre
  prazo_quantidade    integer check (prazo_quantidade is null or prazo_quantidade > 0),
  prazo_unidade       public.prazo_unidade not null,
  prazo_sentido       public.prazo_sentido,
  prazo_evento        text references public.processo_eventos (codigo),   -- referência do prazo
  prazo_observacao    text,
  condicao            jsonb not null default '{}'::jsonb,
  consequencia_omissao text,                           -- preclusão, decadência, sanção...
  efeito_suspensivo   boolean not null default false,
  saida_esperada      text,                            -- artefato: petição, documento, registro
  versao              integer not null default 1,
  ativo               boolean not null default true,
  atualizado_em       timestamptz not null default now(),
  constraint prazo_coerente check (
    (prazo_unidade in ('imediato', 'definido_no_edital', 'sem_prazo_legal') and prazo_quantidade is null)
    or (prazo_unidade in ('dias_uteis', 'dias_corridos', 'meses', 'anos')
        and prazo_quantidade is not null and prazo_sentido is not null and prazo_evento is not null)
  ),
  constraint condicao_objeto check (jsonb_typeof(condicao) = 'object')
);
create index if not exists idx_tarefas_catalogo_fase   on public.tarefas_catalogo (fase_codigo, ordem);
create index if not exists idx_tarefas_catalogo_parent on public.tarefas_catalogo (parent_codigo);
create index if not exists idx_tarefas_catalogo_evento on public.tarefas_catalogo (evento_abertura);
comment on table public.tarefas_catalogo is
  'Árvore de tarefas do fornecedor por fase, com prazo legal e condição de aplicabilidade. Fonte de verdade: data/catalogo_tarefas_14133.yaml.';

create table if not exists public.tarefas_catalogo_base_legal (
  tarefa_codigo  text not null references public.tarefas_catalogo (codigo) on delete cascade,
  norma          text not null,
  artigo         integer not null,
  dispositivo    text not null default 'caput',        -- 'art. 165, § 1º, I'
  papel          text not null default 'fundamento' check (papel in ('fundamento', 'prazo', 'consequencia', 'referencia')),
  primary key (tarefa_codigo, norma, artigo, dispositivo),
  foreign key (norma, artigo) references public.norma_dispositivos (norma, artigo)
);

create table if not exists public.tarefas_catalogo_dependencias (
  tarefa_codigo     text not null references public.tarefas_catalogo (codigo) on delete cascade,
  depende_de_codigo text not null references public.tarefas_catalogo (codigo) on delete cascade,
  tipo              text not null check (tipo in ('requer', 'alternativa_a')),
  observacao        text,
  primary key (tarefa_codigo, depende_de_codigo),
  check (tarefa_codigo <> depende_de_codigo)
);
comment on column public.tarefas_catalogo_dependencias.tipo is
  'requer: só libera depois da outra concluída. alternativa_a: caminhos excludentes (escolher um).';

-- ---------------------------------------------------------------- funções determinísticas
-- Avalia condição contra o contexto do certame. true | false | null (não verificada).
create or replace function public.catalogo_condicao_avaliar(p_condicao jsonb, p_contexto jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  resultado boolean := true;
begin
  if p_condicao is null or p_condicao = '{}'::jsonb then
    return true;
  end if;
  for k, v in select key, value from jsonb_each(p_condicao) loop
    if p_contexto is null or not (p_contexto ? k) or jsonb_typeof(p_contexto -> k) = 'null' then
      resultado := null;                       -- falta dado: não verificado
      continue;
    end if;
    if jsonb_typeof(v) = 'array' then
      if not (v @> jsonb_build_array(p_contexto -> k)) then
        return false;
      end if;
    elsif (p_contexto -> k) <> v then
      return false;
    end if;
  end loop;
  return resultado;
end;
$$;
comment on function public.catalogo_condicao_avaliar(jsonb, jsonb) is
  'false se alguma chave presente diverge; null se falta chave no contexto; true se todas batem.';

-- Tarefas de uma fase, com aplicabilidade avaliada. Não descarta as "não verificadas".
create or replace function public.catalogo_tarefas_da_fase(p_fase text, p_contexto jsonb default '{}'::jsonb)
returns table (
  codigo text, parent_codigo text, ordem integer, titulo text, natureza public.tarefa_natureza,
  evento_abertura text, prazo_quantidade integer, prazo_unidade public.prazo_unidade,
  prazo_sentido public.prazo_sentido, prazo_evento text, aplicavel boolean,
  base_legal text
)
language sql
stable
set search_path = ''
as $$
  select t.codigo, t.parent_codigo, t.ordem, t.titulo, t.natureza,
         t.evento_abertura, t.prazo_quantidade, t.prazo_unidade, t.prazo_sentido, t.prazo_evento,
         public.catalogo_condicao_avaliar(t.condicao, p_contexto) as aplicavel,
         (select string_agg('art. ' || b.artigo || ' (' || b.dispositivo || ')', '; ' order by b.artigo, b.dispositivo)
            from public.tarefas_catalogo_base_legal b where b.tarefa_codigo = t.codigo) as base_legal
    from public.tarefas_catalogo t
   where t.fase_codigo = p_fase
     and t.ativo
     and public.catalogo_condicao_avaliar(t.condicao, p_contexto) is distinct from false
   order by t.ordem;
$$;

-- Tarefas que um evento libera (ex.: 'ATA_HABILITACAO' -> intenção + razões + vista).
create or replace function public.catalogo_tarefas_do_evento(p_evento text, p_contexto jsonb default '{}'::jsonb)
returns table (codigo text, fase_codigo text, titulo text, prazo_quantidade integer,
               prazo_unidade public.prazo_unidade, prazo_sentido public.prazo_sentido,
               prazo_evento text, aplicavel boolean)
language sql
stable
set search_path = ''
as $$
  select t.codigo, t.fase_codigo, t.titulo, t.prazo_quantidade, t.prazo_unidade, t.prazo_sentido,
         t.prazo_evento, public.catalogo_condicao_avaliar(t.condicao, p_contexto)
    from public.tarefas_catalogo t
   where t.evento_abertura = p_evento
     and t.ativo
     and public.catalogo_condicao_avaliar(t.condicao, p_contexto) is distinct from false
   order by t.fase_codigo, t.ordem;
$$;

-- ---------------------------------------------------------------- RLS + ACL
alter table public.norma_dispositivos            enable row level security;
alter table public.processo_fases                enable row level security;
alter table public.processo_eventos              enable row level security;
alter table public.processo_fase_transicoes      enable row level security;
alter table public.tarefas_catalogo              enable row level security;
alter table public.tarefas_catalogo_base_legal   enable row level security;
alter table public.tarefas_catalogo_dependencias enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['norma_dispositivos', 'processo_fases', 'processo_eventos',
                           'processo_fase_transicoes', 'tarefas_catalogo',
                           'tarefas_catalogo_base_legal', 'tarefas_catalogo_dependencias'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select_auth', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   t || '_select_auth', t);
    execute format('drop policy if exists %I on public.%I', t || '_write_admin', t);
    execute format($p$create policy %I on public.%I for all to authenticated
                     using ((auth.jwt() -> 'app_metadata' ->> 'licitagym_role') = 'admin')
                     with check ((auth.jwt() -> 'app_metadata' ->> 'licitagym_role') = 'admin')$p$,
                   t || '_write_admin', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

revoke all on function public.catalogo_condicao_avaliar(jsonb, jsonb) from public, anon;
revoke all on function public.catalogo_tarefas_da_fase(text, jsonb) from public, anon;
revoke all on function public.catalogo_tarefas_do_evento(text, jsonb) from public, anon;
grant execute on function public.catalogo_condicao_avaliar(jsonb, jsonb) to authenticated, service_role;
grant execute on function public.catalogo_tarefas_da_fase(text, jsonb) to authenticated, service_role;
grant execute on function public.catalogo_tarefas_do_evento(text, jsonb) to authenticated, service_role;

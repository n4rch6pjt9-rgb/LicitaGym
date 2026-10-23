-- LicitaGym: catálogo de agentes (spec 0035, K-10 e R-17).
--
-- Por quê: a tarefa do pipeline passa a ter responsável do tipo agente (Agente de Edital, Agente Jurídico). O
-- catálogo diz o nome que a tela mostra e a API de execução (Edge Function, ação e agente), para servir a agentes
-- futuros em outras etapas sem mudar a tela.
--
-- Regra (R-4): o catálogo é só para mostrar. A api-agentes executa só os agentes da lista fixa do código; um código
-- novo aqui sem implementação aparece como "sem execução" e não roda. O catálogo muda só por migration.
--
-- O que cria: public.agentes_catalogo (semente: edital e juridico ativos; preco inativo nesta spec).
-- Quem lê: só service_role (api-pipeline e api-agentes). RLS ligada e sem policy: anon e authenticated não leem.
-- Aditiva e idempotente. O merge na main aplica em produção.
-- Verificação: supabase/tests/agentes_catalogo_check.sql.

begin;

set local lock_timeout = '5s';

create table if not exists public.agentes_catalogo (
  codigo     text primary key,
  nome       text not null,
  api        text not null,
  acao_api   text not null,
  agente_api text not null,
  descricao  text,
  ativo      boolean not null default true,
  ordem      integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agentes_catalogo_codigo_chk check (codigo ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint agentes_catalogo_nome_chk check (nullif(btrim(nome), '') is not null and char_length(nome) <= 80),
  constraint agentes_catalogo_api_chk check (api ~ '^[a-z][a-z0-9-]{1,62}$' and acao_api ~ '^[a-z][a-z0-9_]{1,62}$'
                                             and agente_api ~ '^[a-z][a-z0-9_]{1,30}$')
);

comment on table public.agentes_catalogo is
  'Agentes que podem ser responsáveis por tarefa do pipeline (spec 0035). api/acao_api/agente_api só para mostrar: '
  'a execução segue a lista fixa da api-agentes. Muda só por migration. Só service_role.';
comment on column public.agentes_catalogo.api is 'Edge Function que executa o agente (ex.: api-agentes).';
comment on column public.agentes_catalogo.acao_api is 'Ação da Edge Function (ex.: analise_executar).';
comment on column public.agentes_catalogo.agente_api is 'Valor em agentes[] da ação (ex.: edital).';

insert into public.agentes_catalogo (codigo, nome, api, acao_api, agente_api, descricao, ativo, ordem)
values
  ('edital', 'Agente de Edital', 'api-agentes', 'analise_executar', 'edital',
   'Lê o edital e o termo de referência e aponta exigências e riscos, com trecho e página.', true, 10),
  ('juridico', 'Agente Jurídico', 'api-agentes', 'analise_executar', 'juridico',
   'Liga cada alerta do edital e do preço ao artigo da Lei 14.133 e sugere a peça.', true, 20),
  ('preco', 'Agente de Preço', 'api-agentes', 'analise_executar', 'preco',
   'Confere o estimado contra o preço homologado do item.', false, 30)
on conflict (codigo) do nothing;

alter table public.agentes_catalogo enable row level security;
revoke all on table public.agentes_catalogo from PUBLIC, anon, authenticated, service_role;
grant select on table public.agentes_catalogo to service_role;

commit;

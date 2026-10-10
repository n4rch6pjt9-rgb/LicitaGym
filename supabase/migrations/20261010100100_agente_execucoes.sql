-- Execuções dos agentes de edital, preço e jurídico (plano 1, 06/10/2026).
--
-- O que cria: public.agente_execucoes. Uma linha por (tenant, licitação, agente, impressão do contexto).
-- Execução gravada não é alterada por execução nova: só a revisão (aprovada/rejeitada) muda a linha.
-- Quem lê e escreve: só service_role (Edge Function api-agentes). O JWT identifica o usuário; o banco não é aberto
-- ao authenticated. Sem policy: com RLS ligada, anon e authenticated não leem.
--
-- Timestamp 20261010100100 (resgate; era 20261006220000): 20261010100000 é o histórico de PCA por órgão e ano.
-- Aditiva. O merge na main aplica em produção (integração Supabase).
-- Verificação: supabase/tests/agente_execucoes_check.sql.

begin;

set local lock_timeout = '10s';

create table if not exists public.agente_execucoes (
  id bigint generated always as identity primary key,
  tenant_id bigint not null references public.tenants(id),
  licitacao_id bigint not null references public.licitacoes_externas(id) on delete cascade,
  agente text not null check (agente in ('edital','preco','juridico')),
  situacao text not null check (situacao in ('ok','sem_documento','sem_referencia','sem_proposta')),
  contexto_hash text not null check (contexto_hash ~ '^[0-9a-f]{64}$'),
  regra_versao text not null,
  modelo text,
  entrada jsonb not null default '{}'::jsonb check (jsonb_typeof(entrada) = 'object'),
  achados jsonb not null default '[]'::jsonb check (jsonb_typeof(achados) = 'array'),
  revisao text not null default 'aguardando' check (revisao in ('aguardando','aprovada','rejeitada')),
  revisao_nota text,
  revisado_por uuid,
  revisado_em timestamptz,
  solicitado_por uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, licitacao_id, agente, contexto_hash),
  check (revisao <> 'rejeitada' or length(btrim(coalesce(revisao_nota, ''))) > 0),
  check ((revisao = 'aguardando') = (revisado_por is null))
);

create index if not exists agente_execucoes_licitacao_idx
  on public.agente_execucoes (tenant_id, licitacao_id, agente, created_at desc);

alter table public.agente_execucoes enable row level security;

revoke all on table public.agente_execucoes from public, anon, authenticated;
grant select, insert, update on table public.agente_execucoes to service_role;

comment on table public.agente_execucoes is
  'Execuções dos agentes de edital, preço e jurídico. Uma linha por (cliente, licitação, agente, contexto). Leitura e escrita só service_role (Edge Function api-agentes).';

commit;

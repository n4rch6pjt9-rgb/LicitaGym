-- LicitaGym: persistência das decisões de recomendação de lance v4 (spec 0039).
--
-- O que cria: public.recomendacao_decisoes.
-- Registra cada decisão determinística emitida por recomendarV4 (_shared/agentes/recomendacao.ts)
-- com os 4 scores (aderência, risco, viabilidade e concorrência), score final, motivos, alertas e detalhes.
--
-- Segurança & ACL:
-- - RLS habilitado e sem policy direta para anon ou authenticated.
-- - Acesso exclusivo via service_role (Edge Functions autenticadas).
-- - Idempotente.

begin;

set local lock_timeout = '10s';

create table if not exists public.recomendacao_decisoes (
  id                 bigint generated always as identity primary key,
  tenant_id          bigint not null references public.tenants(id) on delete cascade,
  licitacao_id       bigint not null references public.licitacoes_externas(id) on delete cascade,
  numero_item        integer not null check (numero_item > 0),
  produto_id         bigint references public.catalogo_produtos(id) on delete set null,
  decisao            text not null check (decisao in ('disputar', 'aguardar_aprovacao', 'nao_disputar')),
  score_aderencia    numeric(5,3) not null check (score_aderencia >= 0 and score_aderencia <= 1),
  score_risco        numeric(5,3) not null check (score_risco >= 0 and score_risco <= 1),
  score_viabilidade  numeric(5,3) not null check (score_viabilidade >= 0 and score_viabilidade <= 1),
  score_concorrencia numeric(5,3) not null check (score_concorrencia >= 0 and score_concorrencia <= 1),
  score_final        numeric(5,3) not null check (score_final >= 0 and score_final <= 1),
  motivos            jsonb not null default '[]'::jsonb check (jsonb_typeof(motivos) = 'array'),
  alertas            jsonb not null default '[]'::jsonb check (jsonb_typeof(alertas) = 'array'),
  detalhes           jsonb not null default '{}'::jsonb check (jsonb_typeof(detalhes) = 'object'),
  regra_versao       text not null,
  solicitado_por     uuid not null,
  created_at         timestamptz not null default now()
);

create index if not exists recomendacao_decisoes_tenant_licitacao_idx
  on public.recomendacao_decisoes (tenant_id, licitacao_id, numero_item, created_at desc);

alter table public.recomendacao_decisoes enable row level security;

drop policy if exists recomendacao_decisoes_tenant_isolation on public.recomendacao_decisoes;

revoke all on table public.recomendacao_decisoes from public, anon, authenticated;
grant select, insert on table public.recomendacao_decisoes to service_role;

revoke all on sequence public.recomendacao_decisoes_id_seq from public, anon, authenticated;
grant usage, select on sequence public.recomendacao_decisoes_id_seq to service_role;

comment on table public.recomendacao_decisoes is
  'Decisões determinísticas de recomendação de lance v4 (spec 0039) com os 4 scores, motivos, alertas e detalhes. Leitura e escrita só service_role.';

commit;

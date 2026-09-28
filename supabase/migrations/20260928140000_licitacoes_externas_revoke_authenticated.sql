-- LicitaGym: D1.2 — Revogação de acesso direto de `authenticated` a `licitacoes_externas`
--
-- Contexto:
-- A leitura de licitações externas passa a ser realizada exclusivamente através da Edge Function
-- `api-dashboard-oportunidades`, que executa no servidor com service_role e projeta estritamente
-- as colunas públicas permitidas (PUBLIC_LICITACAO_COLUMNS), impedindo que qualquer usuário
-- autenticado leia colunas internas/técnicas (como `raw`, `notas`, `esclarecimentos`, etc.)
-- diretamente via PostgREST REST API.
--
-- Esta migration:
-- 1. Remove a policy de SELECT para authenticated em licitacoes_externas (licitacoes_externas_select).
-- 2. Revoga todos os privilégios na tabela public.licitacoes_externas de authenticated, anon e PUBLIC.
-- 3. Garante que RLS permaneça habilitado na tabela.
-- 4. O acesso continua liberado via service_role (usado pela Edge Function e pelo coletor backend).
--
-- Idempotente.

drop policy if exists licitacoes_externas_select on public.licitacoes_externas;
drop policy if exists licitacoes_externas_select_anon on public.licitacoes_externas;

revoke all on table public.licitacoes_externas from authenticated, anon, PUBLIC;

alter table public.licitacoes_externas enable row level security;

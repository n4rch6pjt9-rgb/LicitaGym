-- LicitaGym: Revogação explícita de anon em licitacoes_externas (RLS e ACL)
--
-- Contexto:
-- A migration 20260926110000 revogou anon de `licitacoes_externas` de propósito
-- (SELECT permitido apenas para `authenticated`).
-- Esta migration garante de forma aditiva e idempotente que nenhuma policy ou GRANT
-- de SELECT para `anon` ou `PUBLIC` persista em `licitacoes_externas`, protegendo a tabela
-- inteira de leitura direta não autenticada via PostgREST REST API.
--
-- RLS check:
-- A migration 20260923100000_licitacoes_externas.sql já executa:
--   alter table public.licitacoes_externas enable row level security;
--   create policy licitacoes_externas_select on public.licitacoes_externas for select to authenticated using (true);
-- e a migration 20260926110000_pncp_rls_policies.sql concedeu:
--   grant select on table public.licitacoes_externas to authenticated;
-- Portanto, RLS já está habilitado e possui policy de SELECT para authenticated ativa.
--
-- O dashboard consome os dados de forma controlada através da Edge Function
-- `api-dashboard-oportunidades`, que realiza as leituras no backend com projeção
-- explícita de colunas públicas seguras, sem expor a chave de service_role ao cliente.
--
-- Idempotente.

drop policy if exists licitacoes_externas_select_anon on public.licitacoes_externas;
REVOKE ALL ON TABLE public.licitacoes_externas FROM PUBLIC, anon;


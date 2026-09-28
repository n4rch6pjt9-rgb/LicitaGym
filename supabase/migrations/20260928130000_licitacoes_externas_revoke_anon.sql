-- LicitaGym: Revogação explícita de anon em licitacoes_externas (RLS e ACL)
--
-- Contexto:
-- A migration 20260926110000 revogou anon de `licitacoes_externas` de propósito
-- (SELECT permitido apenas para `authenticated`).
-- Esta migration garante de forma aditiva e idempotente que nenhuma policy ou GRANT
-- de SELECT para `anon` persista em `licitacoes_externas`, protegendo a tabela inteira
-- de leitura direta não autenticada via PostgREST REST API.
--
-- O dashboard consome os dados de forma controlada através da Edge Function
-- `api-dashboard-oportunidades`, que realiza as leituras no backend com projeção
-- explícita de colunas públicas seguras, sem expor a chave de service_role ao cliente.
--
-- Idempotente.

drop policy if exists licitacoes_externas_select_anon on public.licitacoes_externas;
revoke all on table public.licitacoes_externas from anon;

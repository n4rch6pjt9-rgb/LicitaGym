-- LicitaGym: RLS aditivo para leitura de licitações externas via chave anon / dashboard
--
-- Contexto:
-- As migrations anteriores (20260923100000 e 20260926110000) concederam SELECT para `authenticated`
-- mas revogaram acesso de `anon`.
-- O dashboard do LicitaGym no navegador acessa via Edge Function / client com chave pública `anon`.
-- Para permitir que usuários anônimos (ou com a chave anon) leiam oportunidades públicas de licitações,
-- esta migration garante a policy e o GRANT de SELECT em `licitacoes_externas` para `anon`.
-- Escrita continua exclusiva do coletor (service_role).
--
-- Idempotente. Não destrutivo.

grant select on table public.licitacoes_externas to anon;

drop policy if exists licitacoes_externas_select_anon on public.licitacoes_externas;
create policy licitacoes_externas_select_anon on public.licitacoes_externas
  for select to anon using (true);

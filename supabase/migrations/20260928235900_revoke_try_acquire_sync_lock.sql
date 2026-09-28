-- 20260928235900_revoke_try_acquire_sync_lock.sql
-- FASE 2 (PR A): Remocao de private.try_acquire_sync_lock (substituida por private.acquire_sync_lock).
--
-- Contexto de Seguranca:
-- A funcao private.try_acquire_sync_lock foi criada em 202609180001_pncp_foundation.sql
-- com SECURITY DEFINER e sem REVOKE FROM PUBLIC. Com a exposicao do schema 'private'
-- no PostgREST (db_schemas), roles anon e authenticated herdavam permissao de execucao.
--
-- Verificacao no repositorio:
-- NENHUM componente (Edge Functions, Deno _shared, scripts PowerShell, coletores Python)
-- utiliza private.try_acquire_sync_lock. Todas as funcoes de sync usam lock logico
-- em TypeScript ou a nova RPC private.acquire_sync_lock (20260929000001).
--
-- Idempotencia:
-- Pode ser aplicada mesmo que a revogacao/remocao ja tenha sido feita manualmente.

-- 1. Revoga execucao explicitamente caso a funcao ainda exista
REVOKE EXECUTE ON FUNCTION private.try_acquire_sync_lock(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- 2. Remove a funcao obsoleta/insegura
DROP FUNCTION IF EXISTS private.try_acquire_sync_lock(text, text, jsonb);

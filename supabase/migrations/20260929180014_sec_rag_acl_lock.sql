-- LicitaGym: segurança do RAG contra envenenamento (prompt injection indireta) — ACL
--
-- Contexto (inspeção de 29/09/2026, docs: claude/seguranca-prompt-injection-v1.md, seções 4.1, 4.2 e 4.5):
--   * legislacao e legislacao_embeddings: policies de INSERT/UPDATE para qualquer usuário autenticado e
--     GRANT de ALL (inclusive TRUNCATE, que ignora RLS) para anon e authenticated. Qualquer conta logada
--     podia reescrever a "lei" servida pelo RAG, e qualquer pessoa com a chave anon podia apagar a base.
--   * consultas_log: SELECT de todos os logs para qualquer autenticado, sem dono; anon/authenticated com ALL.
--   * match_licitacao_chunks e match_legislacao_embeddings: EXECUTE para PUBLIC/anon (drift: a
--     20260926110000_pncp_rls_policies já revogava match_licitacao_chunks, mas o ACL voltou).
--
-- Modelo após esta migration:
--   legislacao, legislacao_embeddings -> anon/authenticated só SELECT (policy de leitura pública mantida);
--                                        escrita só service_role (sync e agente jurídico usam service_role)
--   consultas_log                     -> authenticated só SELECT das próprias linhas; escrita só service_role
--   match_licitacao_chunks            -> só service_role
--   match_legislacao_embeddings       -> authenticated + service_role; search_path fixo
--   match_catalogo_chunks             -> search_path fixo (ACL já correto desde 20260929130000)
--
-- Consumidores conferidos em 29/09/2026: nenhum uso de consultas_log nem de rpc match_* no Dashboard,
-- no coletor ou nas Edge Functions; o agente jurídico (docs/agente-juridico-ml) usa chave service_role.
-- consultas_log tem 0 linhas (NOT NULL em user_id é seguro).
-- Verificação: supabase/tests/sec_rag_prompt_injection_acl_check.sql.

-- 1) Base normativa do RAG ---------------------------------------------------------------------------
drop policy if exists "Permitir inserção autenticada de embeddings"   on public.legislacao_embeddings;
drop policy if exists "Permitir atualização autenticada de embeddings" on public.legislacao_embeddings;
drop policy if exists "Permitir inserção autenticada"                  on public.legislacao;
drop policy if exists "Permitir atualização autenticada"               on public.legislacao;

revoke all on table public.legislacao, public.legislacao_embeddings from public, anon, authenticated;
grant select on table public.legislacao, public.legislacao_embeddings to anon, authenticated;
grant all on table public.legislacao, public.legislacao_embeddings to service_role;

revoke all on sequence public.legislacao_id_seq, public.legislacao_embeddings_id_seq from public, anon, authenticated;
grant all on sequence public.legislacao_id_seq, public.legislacao_embeddings_id_seq to service_role;

-- 2) consultas_log: log por dono + trace do RAG -------------------------------------------------------
alter table public.consultas_log
  add column if not exists user_id uuid not null references auth.users(id) on delete cascade,
  add column if not exists trace_id uuid not null default gen_random_uuid(),
  add column if not exists guardrail_entrada jsonb,   -- {veredito, modelo, score, motivo}
  add column if not exists chunks_recuperados jsonb,  -- [{base, chunk_id, similaridade, nivel_confianca}]
  add column if not exists tools_chamadas jsonb,      -- [{tool, args, autorizado, motivo_bloqueio}]
  add column if not exists guardrail_saida jsonb,     -- {veredito, links_bloqueados, fora_escopo}
  add column if not exists resposta_final text,
  add column if not exists modelo text;

comment on column public.consultas_log.user_id is
  'Dono da pergunta. Preenchido pela Edge Function (service_role) a partir do JWT validado; não usar default auth.uid().';

create index if not exists consultas_log_user_id_created_at_idx on public.consultas_log (user_id, created_at desc);

drop policy if exists "Permitir leitura autenticada de consultas_log" on public.consultas_log;
drop policy if exists "Permitir inserção autenticada de consultas_log" on public.consultas_log;
drop policy if exists consultas_log_select_own on public.consultas_log;
create policy consultas_log_select_own on public.consultas_log
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on table public.consultas_log from public, anon, authenticated;
grant select on table public.consultas_log to authenticated;
grant all on table public.consultas_log to service_role;
revoke all on sequence public.consultas_log_id_seq from public, anon, authenticated;
grant all on sequence public.consultas_log_id_seq to service_role;

-- 3) Funções de recuperação --------------------------------------------------------------------------
revoke all on function public.match_licitacao_chunks(vector, integer, text, text) from public, anon, authenticated;
grant execute on function public.match_licitacao_chunks(vector, integer, text, text) to service_role;

revoke all on function public.match_legislacao_embeddings(vector, double precision, integer) from public, anon;
grant execute on function public.match_legislacao_embeddings(vector, double precision, integer) to authenticated, service_role;
alter function public.match_legislacao_embeddings(vector, double precision, integer) set search_path = public;

alter function public.match_catalogo_chunks(vector, integer, text, text) set search_path = public;

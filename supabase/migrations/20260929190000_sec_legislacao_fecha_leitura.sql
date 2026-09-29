-- LicitaGym: fecha a leitura de legislacao e legislacao_embeddings para anon/authenticated
--
-- Contexto:
-- A 20260929180014_sec_rag_acl_lock (PR #89) trancou a escrita e manteve a leitura pública que vinha do
-- supabase_schema.sql original ("Permitir leitura pública ..." using (true) para public), sem avaliar se era
-- necessária. Não é: nenhum código do Dashboard, das Edge Functions ou do Kuib-Harness lê essas tabelas; as Edge
-- Functions de legislação usam legislacao_documentos/legislacao_versoes com service_role. O único consumidor é o
-- agente jurídico (docs/agente-juridico-ml), que roda no servidor com a chave de serviço. A abertura expunha
-- download em massa dos vetores (anon) e busca vetorial por qualquer usuário logado (match_legislacao_embeddings).
--
-- Decisão (29/09/2026): só service_role. Se o app for mostrar legislação, reabre-se depois só public.legislacao, com
-- policy própria.
--
-- A baseline 20260929180000 recria as policies de leitura num banco novo; esta migration vem depois e as remove,
-- então o replay continua reproduzível.
--
-- Verificação: supabase/tests/sec_rag_prompt_injection_acl_check.sql (bloco 1 e 4).
-- Idempotente.

begin;

drop policy if exists "Permitir leitura pública de legislação" on public.legislacao;
drop policy if exists "Permitir leitura pública de embeddings" on public.legislacao_embeddings;

revoke all on table public.legislacao, public.legislacao_embeddings from public, anon, authenticated;
grant all on table public.legislacao, public.legislacao_embeddings to service_role;

revoke all on function public.match_legislacao_embeddings(vector, double precision, integer) from public, anon, authenticated;
grant execute on function public.match_legislacao_embeddings(vector, double precision, integer) to service_role;

comment on table public.legislacao is
  'Base normativa do RAG jurídico. Leitura e escrita só service_role (agente jurídico no servidor). Ver 20260929190000.';
comment on table public.legislacao_embeddings is
  'Embeddings da base normativa. Leitura e escrita só service_role; busca via match_legislacao_embeddings (só service_role).';

commit;

-- LicitaGym: ACL explícita nos objetos do coletor Sistema S e dos catálogos de fabricantes
--
-- Contexto:
-- As migrations 20260925120000_sistema_s_coleta_externa, 20260926120000_fornecedores_e_lances e
-- 20260926160000_catalogos_fabricantes (aplicadas pelo SQL Editor e versionadas no #72) criaram
-- tabelas, views, sequences e uma função sem GRANT/REVOKE completos. Em produção elas herdaram os
-- privilégios padrão do schema public: anon e authenticated com ALL (inclusive TRUNCATE, que ignora
-- RLS) em fornecedores, catalogo_* e v_fornecedor_participacoes; authenticated com
-- INSERT/UPDATE/DELETE/TRUNCATE em v_oportunidades_externas; sequences e match_catalogo_chunks
-- abertas a anon. Mesmo padrão que a 20260926110000_pncp_rls_policies corrigiu nas tabelas do PNCP.
--
-- Modelo após esta migration:
--   anon / PUBLIC  -> nenhum privilégio
--   authenticated  -> SELECT (RLS/policies existentes continuam valendo)
--                     + INSERT em licitacao_escopo_decisao (policy licdec_insert_own)
--                     + EXECUTE em match_catalogo_chunks (security invoker: lê catalogo_chunks via RLS)
--   service_role   -> ALL (coletor do Sistema S e Edge Functions)
--
-- Consumidores conferidos em 29/09/2026: só o coletor (service_role). Nenhum uso no frontend nem nas
-- Edge Functions. Verificação: supabase/tests/sistema_s_catalogos_acl_check.sql.
--
-- Idempotente. Não altera dados nem policies.

begin;

-- 1) Tabelas e views --------------------------------------------------------------------------------
revoke all on table
  public.fornecedores,
  public.catalogo_documentos, public.catalogo_produtos, public.catalogo_chunks,
  public.fontes_externas, public.licitacao_escopo_decisao,
  public.v_fornecedor_participacoes, public.v_oportunidades_externas
from anon, authenticated, PUBLIC;

grant select on table
  public.fornecedores,
  public.catalogo_documentos, public.catalogo_produtos, public.catalogo_chunks,
  public.fontes_externas, public.licitacao_escopo_decisao,
  public.v_fornecedor_participacoes, public.v_oportunidades_externas
to authenticated;

grant insert on table public.licitacao_escopo_decisao to authenticated;

grant all on table
  public.fornecedores,
  public.catalogo_documentos, public.catalogo_produtos, public.catalogo_chunks,
  public.fontes_externas, public.licitacao_escopo_decisao,
  public.v_fornecedor_participacoes, public.v_oportunidades_externas
to service_role;

-- 2) Sequences ------------------------------------------------------------------------------------
revoke all on sequence
  public.catalogo_documentos_id_seq, public.catalogo_produtos_id_seq, public.catalogo_chunks_id_seq,
  public.licitacao_escopo_decisao_id_seq
from anon, authenticated, PUBLIC;

-- INSERT de authenticated em licitacao_escopo_decisao (coluna identity) mantém USAGE por segurança.
grant usage on sequence public.licitacao_escopo_decisao_id_seq to authenticated;

grant all on sequence
  public.catalogo_documentos_id_seq, public.catalogo_produtos_id_seq, public.catalogo_chunks_id_seq,
  public.licitacao_escopo_decisao_id_seq
to service_role;

-- 3) Função de busca semântica nos catálogos -----------------------------------------------------
revoke execute on function public.match_catalogo_chunks(vector, int, text, text) from PUBLIC, anon;
grant execute on function public.match_catalogo_chunks(vector, int, text, text) to authenticated, service_role;

commit;

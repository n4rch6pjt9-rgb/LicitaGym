-- LicitaGym: move a extensão vector (pgvector 0.8.2) de public para extensions (advisor 0014).
-- *** ADIADO — NÃO É MIGRATION. Script manual, só com o ok do Marcelo, numa janela calma. ***
-- Rollback: alter extension vector set schema public;  (ver vector_para_extensions_rollback.sql)
--
-- Pré-condições (o script confere e aborta se faltar):
--   1. Migration 20261004120000_advisors_warn_security aplicada: match_* com search_path = public, extensions.
--      Sem isso, <=> deixa de resolver dentro de match_legislacao_embeddings, match_licitacao_chunks,
--      match_licitacao_chunks_v2 e match_catalogo_chunks (todas tinham search_path = public) e a busca RAG cai.
--   2. Nenhuma outra função/view de public/private usando <=>, <->, <#> ou funções do pgvector sem
--      extensions no search_path (em 03/10/2026: só as 4 match_*; nenhuma view, nenhum job pg_cron).
--   3. O dono da extensão é supabase_admin (postgres não é superuser). O ALTER só funciona se o supautils do
--      projeto permitir (supabase/supautils#88, resolvido no PR #94). Se der "must be owner of extension vector",
--      pare: não há atalho seguro (DROP EXTENSION apagaria as colunas embedding). Abra chamado no suporte
--      Supabase ou aceite o WARN.
--   4. Teste antes num branch/local (supabase db reset) com o mesmo fluxo.
--
-- O que NÃO quebra: colunas vector(768) (legislacao_embeddings, licitacao_chunks, catalogo_chunks,
-- private.backup_licitacao_chunks_sest_20261001), índices HNSW (idx_legislacao_embedding_hnsw,
-- idx_licchunk_hnsw, idx_catchunk_vec) e as assinaturas das funções: tudo referencia o OID, que não muda.
-- PostgREST (Edge Functions, coletor Python via service_role) usa db-extra-search-path "public, extensions",
-- então gravar embedding como texto '[...]' continua funcionando. Sessões psql/SQL editor como postgres já têm
-- extensions no search_path. anon/authenticated/service_role não têm search_path próprio (usam o do PostgREST).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare
  v_ns  text := (select extnamespace::regnamespace::text from pg_extension where extname = 'vector');
  v_bad text;
begin
  if v_ns is null then raise exception 'vector não instalada'; end if;
  if v_ns = 'extensions' then raise notice 'vector já está em extensions: nada a fazer.'; return; end if;
  if to_regnamespace('extensions') is null then raise exception 'schema extensions não existe'; end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
     and (p.prosrc ~ '<=>|<->|<#>' or p.prosrc ~* '(cosine_distance|l2_distance|inner_product|vector_dims|vector_norm|l2_normalize|::\s*vector)')
     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%' and c ~ '(^|[=, ])extensions($|,)');
  if v_bad is not null then
    raise exception 'funções com search_path fixo sem extensions (ajuste antes): %', v_bad;
  end if;
end
$pre$;

alter extension vector set schema extensions;

do $chk$
begin
  if (select extnamespace::regnamespace::text from pg_extension where extname = 'vector') <> 'extensions' then
    raise exception 'CHECK FALHOU: vector não está em extensions';
  end if;
  -- Os índices HNSW continuam válidos (mesmo opclass, outro schema).
  if exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid join pg_am am on am.oid = c.relam
              where am.amname in ('hnsw', 'ivfflat') and not (i.indisvalid and i.indisready)) then
    raise exception 'CHECK FALHOU: índice vetorial inválido';
  end if;
  raise notice 'vector_para_extensions: ok';
end
$chk$;

commit;

-- Depois (fora da transação), smoke test como service_role via PostgREST: chamar rpc match_licitacao_chunks_v2
-- com um vetor de 768 zeros+1 e conferir que não dá "operator does not exist: vector <=> vector".

-- LicitaGym: licitacao_chunks.embedding_model (C2)
--
-- Por quê: vetores de modelos de embedding diferentes não são comparáveis (docs/arquitetura/
-- licitagym_conectividade_infra_ia.md, seção 3). Sem o nome do modelo no banco, um reindex parcial com outro
-- modelo mistura espaços na mesma tabela sem ninguém perceber. O indexador (services/coletor-externo/coletor/
-- indexador.py) passa a gravar ia.EMBED_MODEL em cada chunk; o default cobre qualquer outro INSERT.
--
-- Esta migration:
--   1) adiciona public.licitacao_chunks.embedding_model text (sem default nesse passo, para o default não
--      rotular linhas sem vetor);
--   2) preenche 'text-multilingual-embedding-002' só onde embedding is not null and embedding_model is null.
--      Em 02/10/2026 20:26 BRT: 403 linhas (todas com embedding; 14 documentos; criadas em 23/09/2026
--      23:35-23:51 BRT). O modelo dessas linhas é inferido (padrão de coletor/ia.py desde o primeiro commit do
--      coletor, 25/09); o banco não registrava o modelo;
--   3) default 'text-multilingual-embedding-002' para linhas novas.
--
-- Fora de escopo (de propósito):
--   * índice: um único valor em ~400 linhas, nenhum filtro usa a coluna ainda; criar quando
--     match_licitacao_chunks_v2 filtrar por modelo;
--   * NOT NULL / CHECK de modelo único: depois de confirmar o modelo das linhas antigas (ou reindexar);
--   * legislacao_embeddings: os vetores de lá são de outro modelo (agente jurídico local); rotular com o
--     default daqui seria errado. Entra junto com o reindex da legislação;
--   * match_licitacao_chunks*: assinatura inalterada (mudar exige DROP/CREATE, grants e o ACL check).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; o UPDATE só toca embedding_model is null; SET DEFAULT repete igual.
-- O UPDATE não dispara licitacao_chunks_scan (trigger é "update of texto, metadados, secao").
-- Lock: ADD COLUMN sem default e SET DEFAULT pegam ACCESS EXCLUSIVE por instantes (só catálogo);
-- o UPDATE pega ROW EXCLUSIVE. lock_timeout evita ficar na fila atrás de um lock longo.
--
-- Desfazer: alter table public.licitacao_chunks drop column if exists embedding_model;
-- (antes, voltar o indexador: ele passa a mandar a coluna no upsert e o PostgREST recusa coluna inexistente).

begin;

set local lock_timeout = '10s';

alter table public.licitacao_chunks
  add column if not exists embedding_model text;

update public.licitacao_chunks
   set embedding_model = 'text-multilingual-embedding-002'
 where embedding is not null
   and embedding_model is null;

alter table public.licitacao_chunks
  alter column embedding_model set default 'text-multilingual-embedding-002';

comment on column public.licitacao_chunks.embedding_model is
  'Modelo que gerou embedding (ex.: text-multilingual-embedding-002, 768d). A pergunta precisa usar o mesmo modelo. '
  'Linhas anteriores a 20261002200000 foram rotuladas por inferência (padrão de coletor/ia.py).';

commit;

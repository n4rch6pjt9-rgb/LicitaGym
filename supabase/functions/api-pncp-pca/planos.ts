// Colunas de public.pca_planos devolvidas pela listagem GET api-pncp-pca (sem visao). Lista explícita: as de controle
// do sync (descoberta_ausente, reprocessar, spec 0012) não saem na resposta. São as colunas da tabela até a spec 0012
// (migration 202609180004_pca.sql), as mesmas que o select("*") devolvia.
export const COLUNAS_LISTA_PLANOS = [
  "id",
  "id_pca_pncp",
  "ano_exercicio",
  "orgao_cnpj",
  "unidade_codigo",
  "numero_plano",
  "titulo",
  "descricao",
  "status",
  "data_aprovacao",
  "data_publicacao",
  "data_atualizacao_origem",
  "url_origem",
  "payload_hash",
  "last_synced_at",
  "last_seen_sync_id",
  "ativo",
  "created_at",
  "updated_at",
].join(", ");

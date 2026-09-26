-- pgvector para licitacao_chunks.embedding (20260923100000).
-- Em produção a extensão já existe no schema public (habilitada fora do histórico, v0.8.2);
-- esta migration espelha esse estado para que um banco limpo aplique o histórico inteiro.
-- Idempotente: no-op onde a extensão já existe.
create extension if not exists vector with schema public;

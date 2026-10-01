SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '15s'; CREATE INDEX IF NOT EXISTS pca_alteracoes_plano_id_id_idx ON public.pca_alteracoes (pca_plano_id, id);

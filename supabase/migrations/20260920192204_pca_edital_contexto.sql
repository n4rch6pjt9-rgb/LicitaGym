-- Recuperado de supabase_migrations.schema_migrations em 2026-09-28 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.

ALTER TABLE public.contratacoes_editais ADD COLUMN IF NOT EXISTS pca_link_evidencia text;

COMMENT ON COLUMN public.contratacoes_editais.pca_link_evidencia IS 'Como pca_plano_id foi preenchido. NULL = sem vinculo auditavel. Nunca inventar % sem FK/evidencia.';

CREATE INDEX IF NOT EXISTS contratacoes_editais_pca_plano_idx ON public.contratacoes_editais (pca_plano_id) WHERE pca_plano_id IS NOT NULL;

UPDATE public.pca_alteracoes a SET pca_plano_id = p.id FROM public.pca_planos p WHERE a.pca_plano_id IS NULL AND (p.id_pca_pncp = NULLIF(btrim(a.dados_novos->>'id_pca_pncp'), '') OR p.id_pca_pncp = NULLIF(btrim(a.dados_novos->>'titulo'), '') OR (a.payload_hash_novo IS NOT NULL AND p.payload_hash = a.payload_hash_novo AND a.dados_novos ? 'id_pca_pncp'));

COMMENT ON TABLE public.pca_alteracoes IS 'Historico sync PCA. Orfas restantes = legado irrecuperavel. Sync atual grava pca_plano_id; pca_item_id em alteracoes de item.';

CREATE OR REPLACE VIEW public.pca_alteracoes_resumo AS SELECT a.pca_plano_id, a.pca_item_id, count(*) AS total_alteracoes, count(*) FILTER (WHERE a.tipo_operacao = 'insert') AS n_insert, count(*) FILTER (WHERE a.tipo_operacao = 'update') AS n_update, count(*) FILTER (WHERE a.tipo_operacao = 'inativacao') AS n_inativacao, count(*) FILTER (WHERE a.tipo_operacao = 'reativacao') AS n_reativacao, bool_or(a.tipo_operacao = 'update' AND a.dados_anteriores IS NOT NULL AND a.dados_novos IS NOT NULL AND (COALESCE(a.dados_anteriores->>'data_prevista_contratacao', '') IS DISTINCT FROM COALESCE(a.dados_novos->>'data_prevista_contratacao', ''))) AS mudou_data_prevista, bool_or(a.tipo_operacao = 'update' AND a.dados_anteriores IS NOT NULL AND a.dados_novos IS NOT NULL AND (COALESCE(a.dados_anteriores->>'valor_total_estimado', '') IS DISTINCT FROM COALESCE(a.dados_novos->>'valor_total_estimado', '') OR COALESCE(a.dados_anteriores->>'valor_unitario_estimado', '') IS DISTINCT FROM COALESCE(a.dados_novos->>'valor_unitario_estimado', ''))) AS mudou_valor, min(a.created_at) AS primeira_alteracao_em, max(a.created_at) AS ultima_alteracao_em FROM public.pca_alteracoes a WHERE a.pca_plano_id IS NOT NULL GROUP BY a.pca_plano_id, a.pca_item_id;

GRANT SELECT ON public.pca_alteracoes_resumo TO authenticated;
GRANT SELECT ON public.pca_alteracoes_resumo TO service_role;

CREATE OR REPLACE VIEW public.pca_conversao_edital_item AS WITH cohort AS (SELECT i.id AS pca_item_id, i.pca_plano_id, i.numero_item, i.codigo_item_origem, i.data_prevista_contratacao, i.classe_material_servico, p.orgao_cnpj, p.ano_exercicio, p.id_pca_pncp FROM public.pca_itens i INNER JOIN public.pca_planos p ON p.id = i.pca_plano_id WHERE i.ativo = true AND p.ativo = true AND i.classe_material_servico IN ('7830', '7220')), edital_link AS (SELECT e.id AS edital_id, e.pca_plano_id, e.pca_link_evidencia, e.data_publicacao, e.numero_controle_pncp, e.orgao_cnpj, e.ano FROM public.contratacoes_editais e WHERE e.ativo = true AND e.pca_plano_id IS NOT NULL AND e.pca_link_evidencia IS NOT NULL) SELECT c.pca_item_id, c.pca_plano_id, c.id_pca_pncp, c.orgao_cnpj, c.ano_exercicio, c.classe_material_servico, c.codigo_item_origem, c.data_prevista_contratacao, el.edital_id, el.numero_controle_pncp, el.data_publicacao AS edital_data_publicacao, el.pca_link_evidencia, CASE WHEN el.edital_id IS NULL THEN false ELSE true END AS convertido_com_evidencia, CASE WHEN el.data_publicacao IS NOT NULL AND c.data_prevista_contratacao IS NOT NULL THEN (el.data_publicacao::date - c.data_prevista_contratacao) ELSE NULL END AS lag_prevista_vs_pub_dias, (SELECT count(*)::int FROM public.pca_alteracoes a WHERE a.pca_item_id = c.pca_item_id AND a.tipo_operacao = 'update' AND (el.data_publicacao IS NULL OR a.created_at <= el.data_publicacao)) AS n_updates_antes_pub FROM cohort c LEFT JOIN edital_link el ON el.pca_plano_id = c.pca_plano_id;

GRANT SELECT ON public.pca_conversao_edital_item TO authenticated;
GRANT SELECT ON public.pca_conversao_edital_item TO service_role;

CREATE OR REPLACE VIEW public.pca_conversao_edital_taxa AS SELECT ano_exercicio, classe_material_servico, count(*) AS denominador_itens, count(*) FILTER (WHERE convertido_com_evidencia) AS numerador_com_evidencia, CASE WHEN count(*) = 0 THEN NULL ELSE round(100.0 * count(*) FILTER (WHERE convertido_com_evidencia) / count(*), 2) END AS taxa_pct_historica, avg(lag_prevista_vs_pub_dias) FILTER (WHERE convertido_com_evidencia) AS lag_medio_dias, 'frequencia_historica_fk_evidencia_nao_ml'::text AS disclaimer FROM public.pca_conversao_edital_item GROUP BY ano_exercicio, classe_material_servico;

GRANT SELECT ON public.pca_conversao_edital_taxa TO authenticated;
GRANT SELECT ON public.pca_conversao_edital_taxa TO service_role;

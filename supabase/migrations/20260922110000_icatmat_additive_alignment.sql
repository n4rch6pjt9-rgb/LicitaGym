-- Migration: Additive Alignment for icatmat_* (E5-E7)
-- LOTE 5 — CATMAT: CATMAT-P0-003, CATMAT-P0-004, CATMAT-P1-001
--
-- Estado real (2026-09-25): icatmat_natureza_despesa, icatmat_unidade_fornecimento e
-- icatmat_caracteristica_material não existem em produção; são criadas por
-- 202609211004..006 (staging). A troca de UNIQUE do E7 abaixo não afeta dados de produção.
-- Idempotente: pode ser reaplicada.

-- 1. E7: icatmat_caracteristica_material
-- codigoValorCaracteristica pode ser NULL na fonte oficial (schemas-consultas.md §1.7).
-- Sem DEFAULT: NULL é preservado, nunca convertido em sentinel.
ALTER TABLE icatmat_caracteristica_material
  ADD COLUMN IF NOT EXISTS codigo_valor_caracteristica VARCHAR(100),
  ADD COLUMN IF NOT EXISTS nome_valor_caracteristica VARCHAR(500);

-- Chave natural do contrato: (codigoItem, codigoCaracteristica, codigoValorCaracteristica).
-- A UNIQUE antiga (grupo, classe, item, caracteristica) colapsava multivalores do mesmo item.
-- NULLS NOT DISTINCT: dois NULL no valor da mesma característica do mesmo item são a mesma linha,
-- o que torna o ON CONFLICT idempotente sem sentinel.
-- Rollback: recriar unique_caracteristica só é possível se não houver multivalores gravados.
ALTER TABLE icatmat_caracteristica_material
  DROP CONSTRAINT IF EXISTS unique_caracteristica;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_caracteristica_valor'
      AND conrelid = 'public.icatmat_caracteristica_material'::regclass
  ) THEN
    ALTER TABLE icatmat_caracteristica_material
      ADD CONSTRAINT unique_caracteristica_valor
      UNIQUE NULLS NOT DISTINCT (codigo_item, codigo_caracteristica, codigo_valor_caracteristica);
  END IF;
END $$;

-- 2. E5: icatmat_natureza_despesa
-- Coluna escrita por enrich_e5 (DmMaterialNaturezaDespesaDTO).
ALTER TABLE icatmat_natureza_despesa
  ADD COLUMN IF NOT EXISTS descricao_natureza VARCHAR(500);

CREATE INDEX IF NOT EXISTS idx_icatmat_natureza_pdm_despesa
  ON icatmat_natureza_despesa (codigo_pdm, codigo_natureza);

-- 3. E6: icatmat_unidade_fornecimento
-- Colunas escritas por enrich_e6 (DmMaterialUnidadeFornecimentoDTO).
ALTER TABLE icatmat_unidade_fornecimento
  ADD COLUMN IF NOT EXISTS sigla_unidade VARCHAR(20),
  ADD COLUMN IF NOT EXISTS descricao_unidade VARCHAR(500);

CREATE INDEX IF NOT EXISTS idx_icatmat_unidade_pdm_sigla
  ON icatmat_unidade_fornecimento (codigo_pdm, sigla_unidade, codigo_unidade);

-- 4. ACL do staging icatmat_*: só service_role (upsert_icatmat_consolidado). RLS ligado e sem
-- policies; anon/authenticated sem acesso. Projetos novos não concedem DML por padrão.
REVOKE ALL ON TABLE
  icatmat_grupo_material, icatmat_classe_material, icatmat_pdm_material, icatmat_item_material,
  icatmat_natureza_despesa, icatmat_unidade_fornecimento, icatmat_caracteristica_material
FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  icatmat_grupo_material, icatmat_classe_material, icatmat_pdm_material, icatmat_item_material,
  icatmat_natureza_despesa, icatmat_unidade_fornecimento, icatmat_caracteristica_material
TO service_role;

-- Snapshot pré-reprojeção P0 (classificacao_catalogo_id).
-- Justificativa: tabela private permite rollback SQL atômico, sem CSV no git,
-- e sem dependência de home do Cloud Shell. Só service_role escreve/lê.

CREATE TABLE IF NOT EXISTS private.pca_itens_snapshot_p0 (
  snapshot_id text NOT NULL,
  pca_item_id uuid NOT NULL,
  classificacao_catalogo_id text,
  payload_hash text NOT NULL,
  updated_at timestamptz NOT NULL,
  snapshotted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, pca_item_id)
);

CREATE INDEX IF NOT EXISTS pca_itens_snapshot_p0_snapshot_idx
  ON private.pca_itens_snapshot_p0 (snapshot_id);

COMMENT ON TABLE private.pca_itens_snapshot_p0 IS
  'Snapshot P0 reprojeção classificacao_catalogo_id — rollback sem pca_alteracoes';

REVOKE ALL ON TABLE private.pca_itens_snapshot_p0 FROM PUBLIC;
GRANT ALL ON TABLE private.pca_itens_snapshot_p0 TO postgres, service_role;

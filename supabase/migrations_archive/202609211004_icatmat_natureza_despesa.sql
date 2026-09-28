-- Endpoint 5: consultarMaterialNaturezaDespesa
-- Naturezas de Despesa (relaciona items a códigos contábeis de despesa)
-- 1:N relationship com items
-- FK: referencia E4 (icatmat_item_material)

CREATE TABLE icatmat_natureza_despesa (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  codigo_pdm INTEGER NOT NULL,
  codigo_item INTEGER NOT NULL,
  codigo_natureza INTEGER NOT NULL,
  descricao_natureza VARCHAR(500),
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_natureza_item
    FOREIGN KEY (codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    REFERENCES icatmat_item_material(codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    ON DELETE CASCADE,
  CONSTRAINT unique_natureza UNIQUE(codigo_grupo, codigo_classe, codigo_item, codigo_natureza),
  CONSTRAINT icatmat_natureza_despesa_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_natureza_sync ON icatmat_natureza_despesa(sync_timestamp);

ALTER TABLE icatmat_natureza_despesa ENABLE ROW LEVEL SECURITY;

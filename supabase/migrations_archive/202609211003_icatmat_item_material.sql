-- Endpoint 4: consultarItemMaterial
-- Items de Material (CATMAT Nível 4)
-- Item = SKU/variação de um PDM com características específicas
-- FK: referencia E3 (icatmat_pdm_material)

CREATE TABLE icatmat_item_material (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  codigo_pdm INTEGER NOT NULL,
  codigo_item INTEGER NOT NULL,
  descricao_item VARCHAR(1000),
  tipo_item VARCHAR(100),
  status_item BOOLEAN NOT NULL DEFAULT TRUE,
  valor_unitario NUMERIC(15, 4),
  unidade_padrao VARCHAR(50),
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_item_pdm
    FOREIGN KEY (codigo_grupo, codigo_classe, codigo_pdm)
    REFERENCES icatmat_pdm_material(codigo_grupo, codigo_classe, codigo_pdm)
    ON DELETE CASCADE,
  CONSTRAINT unique_item UNIQUE(codigo_grupo, codigo_classe, codigo_pdm, codigo_item),
  CONSTRAINT icatmat_item_material_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_item_sync ON icatmat_item_material(sync_timestamp);

ALTER TABLE icatmat_item_material ENABLE ROW LEVEL SECURITY;

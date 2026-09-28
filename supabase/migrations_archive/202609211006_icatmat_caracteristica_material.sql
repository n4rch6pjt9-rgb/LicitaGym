-- Endpoint 7: consultarMaterialCaracteristicas
-- Características de Items (relaciona items a specs/atributos técnicos)
-- 1:N relationship com items
-- FK: referencia E4 (icatmat_item_material)

CREATE TABLE icatmat_caracteristica_material (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  codigo_pdm INTEGER NOT NULL,
  codigo_item INTEGER NOT NULL,
  codigo_caracteristica INTEGER NOT NULL,
  nome_caracteristica VARCHAR(300),
  descricao_caracteristica VARCHAR(1000),
  tipo_caracteristica VARCHAR(100),
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_caracteristica_item
    FOREIGN KEY (codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    REFERENCES icatmat_item_material(codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    ON DELETE CASCADE,
  CONSTRAINT unique_caracteristica UNIQUE(codigo_grupo, codigo_classe, codigo_item, codigo_caracteristica),
  CONSTRAINT icatmat_caracteristica_material_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_caracteristica_sync ON icatmat_caracteristica_material(sync_timestamp);

ALTER TABLE icatmat_caracteristica_material ENABLE ROW LEVEL SECURITY;

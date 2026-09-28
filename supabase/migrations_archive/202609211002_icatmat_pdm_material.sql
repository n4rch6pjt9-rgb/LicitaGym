-- Endpoint 3: consultarPdmMaterial
-- Produtos Descritivos Básicos (CATMAT Nível 3)
-- PDM = unidade de descrição/negociação no CATMAT
-- FK: referencia E2 (icatmat_classe_material)

CREATE TABLE icatmat_pdm_material (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  codigo_pdm INTEGER NOT NULL,
  nome_pdm VARCHAR(500) NOT NULL,
  status_pdm BOOLEAN NOT NULL DEFAULT TRUE,
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_pdm_classe
    FOREIGN KEY (codigo_grupo, codigo_classe)
    REFERENCES icatmat_classe_material(codigo_grupo, codigo_classe)
    ON DELETE CASCADE,
  CONSTRAINT unique_pdm UNIQUE(codigo_grupo, codigo_classe, codigo_pdm),
  CONSTRAINT icatmat_pdm_material_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_pdm_sync ON icatmat_pdm_material(sync_timestamp);

ALTER TABLE icatmat_pdm_material ENABLE ROW LEVEL SECURITY;

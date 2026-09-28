-- Endpoint 2: consultarClasseMaterial
-- Classes de Material (CATMAT Nível 2)
-- Golden rule: apenas classe 7220 (G72) e 7830 (G78)
-- FK: referencia E1 (icatmat_grupo_material)

CREATE TABLE icatmat_classe_material (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  nome_classe VARCHAR(255) NOT NULL,
  status_classe BOOLEAN NOT NULL DEFAULT TRUE,
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_classe_grupo
    FOREIGN KEY (codigo_grupo)
    REFERENCES icatmat_grupo_material(codigo_grupo)
    ON DELETE CASCADE,
  CONSTRAINT unique_classe UNIQUE(codigo_grupo, codigo_classe),
  CONSTRAINT icatmat_classe_material_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_classe_sync ON icatmat_classe_material(sync_timestamp);

ALTER TABLE icatmat_classe_material ENABLE ROW LEVEL SECURITY;

-- Endpoint 6: consultarMaterialUnidadeFornecimento
-- Unidades de Fornecimento (relaciona items a unidades de compra/venda)
-- 1:N relationship com items (MAIOR tabela: ~76k registros esperados)
-- FK: referencia E4 (icatmat_item_material)

CREATE TABLE icatmat_unidade_fornecimento (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo_grupo INTEGER NOT NULL,
  codigo_classe INTEGER NOT NULL,
  codigo_pdm INTEGER NOT NULL,
  codigo_item INTEGER NOT NULL,
  codigo_unidade INTEGER NOT NULL,
  descricao_unidade VARCHAR(200),
  sigla_unidade VARCHAR(10),
  data_hora_atualizacao TIMESTAMP WITH TIME ZONE NOT NULL,
  payload_hash TEXT NOT NULL,
  sync_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT check_grupos CHECK (codigo_grupo IN (72, 78)),
  CONSTRAINT check_classes CHECK (
    (codigo_grupo = 72 AND codigo_classe = 7220) OR
    (codigo_grupo = 78 AND codigo_classe = 7830)
  ),
  CONSTRAINT fk_unidade_item
    FOREIGN KEY (codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    REFERENCES icatmat_item_material(codigo_grupo, codigo_classe, codigo_pdm, codigo_item)
    ON DELETE CASCADE,
  CONSTRAINT unique_unidade UNIQUE(codigo_grupo, codigo_classe, codigo_item, codigo_unidade),
  CONSTRAINT icatmat_unidade_fornecimento_payload_hash_key UNIQUE(payload_hash)
);

CREATE INDEX idx_icatmat_unidade_sync ON icatmat_unidade_fornecimento(sync_timestamp);

ALTER TABLE icatmat_unidade_fornecimento ENABLE ROW LEVEL SECURITY;

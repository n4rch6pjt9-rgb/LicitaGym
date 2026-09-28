-- Fase 3: PNCP Contratações — Preços Praticados
-- Tabela central: histórico de preços por item + fornecedor (PNCP)

CREATE TABLE IF NOT EXISTS public.precos_praticados_itens (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- FK ao catálogo E4
  codigo_item_catalogo INT NOT NULL,

  -- Fornecedor (PNCP)
  ni_fornecedor TEXT NOT NULL,
  nome_fornecedor TEXT,

  -- Preço + quantidade contratada
  preco_unitario DECIMAL(12,2) NOT NULL,
  quantidade_contratada DECIMAL(10,2),

  -- Contextualização
  numero_licitacao TEXT,
  modalidade_licitacao TEXT,
  data_publicacao DATE,
  data_homologacao DATE,

  -- Rastreabilidade
  payload_hash TEXT NOT NULL UNIQUE,
  sync_timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  data_hora_atualizacao TIMESTAMP,

  CONSTRAINT fk_item_catalogo FOREIGN KEY (codigo_item_catalogo)
    REFERENCES public.icatmat_item_material(id) ON DELETE CASCADE,

  CHECK (preco_unitario > 0),
  CHECK (quantidade_contratada > 0)
);

CREATE INDEX idx_precos_item ON public.precos_praticados_itens(codigo_item_catalogo);
CREATE INDEX idx_precos_fornecedor ON public.precos_praticados_itens(ni_fornecedor);
CREATE INDEX idx_precos_data ON public.precos_praticados_itens(data_publicacao DESC);

ALTER TABLE public.precos_praticados_itens ENABLE ROW LEVEL SECURITY;

-- Política: leitura pública (dados de compras públicas)
CREATE POLICY "allow_select_precos_praticados" ON public.precos_praticados_itens
  FOR SELECT USING (true);

-- Política: insert apenas admin/sync
CREATE POLICY "allow_insert_precos_praticados" ON public.precos_praticados_itens
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

COMMENT ON TABLE public.precos_praticados_itens IS 'Fase 3: Preços praticados em contratações PNCP — histórico de valores reais pagos por item fitness';
COMMENT ON COLUMN public.precos_praticados_itens.payload_hash IS 'MD5(serialized_row) para dedup de syncs';
COMMENT ON COLUMN public.precos_praticados_itens.codigo_item_catalogo IS 'FK ao item E4 (icatmat_item_material.codigo_item)';

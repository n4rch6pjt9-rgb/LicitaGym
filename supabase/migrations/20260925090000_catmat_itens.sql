-- catmat_itens: dependência de catmat_itens_taxonomia (20260925100000).
-- Em produção a tabela foi criada fora do histórico por supabase/sql/catmat_item_completo.sql
-- (seção 1). Esta migration espelha só o DDL verificado em produção (2026-09-25); o bootstrap
-- de dados daquele script não entra aqui. Idempotente: no-op onde a tabela já existe.

CREATE TABLE IF NOT EXISTS public.catmat_itens (
  codigo_item               bigint PRIMARY KEY,
  codigo_grupo              bigint,
  nome_grupo                text,
  codigo_classe             bigint,
  nome_classe               text,
  codigo_pdm                text,
  nome_pdm                  text,
  descricao_item            text,
  status_item               boolean NOT NULL DEFAULT true,
  item_sustentavel          boolean,
  codigo_ncm                text,
  descricao_ncm             text,
  aplica_margem_preferencia boolean,
  data_hora_atualizacao     timestamptz,
  origem                    text NOT NULL DEFAULT 'api'
                            CHECK (origem IN ('api', 'bootstrap_catalogo',
                                              'bootstrap_caracteristica', 'bootstrap_preco')),
  payload_hash              text,
  last_synced_at            timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catmat_itens_pdm_idx ON public.catmat_itens (codigo_pdm);

ALTER TABLE public.catmat_itens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catmat_itens_select ON public.catmat_itens;
CREATE POLICY catmat_itens_select ON public.catmat_itens
  FOR SELECT TO authenticated USING (true);

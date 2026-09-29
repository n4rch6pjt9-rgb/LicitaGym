-- =============================================================================
-- MIGRATION: 20260929120000_acompanhamento_tarefas.sql
-- STATUS: PROPOSTA DE DESIGN — NÃO APLICADA NO BANCO DE DADOS
--
-- Modelagem para acompanhamento de eventos do histórico PNCP e automação
-- de tarefas do fornecedor (Lei 14.133/2021).
--
-- Tabelas propostas:
--   1. public.acompanhamento_eventos: ingestão idempotente do histórico PNCP
--   2. public.tarefa_tipos: regras canônicas de mapeamento (categoria, tipo) -> tarefa
--   3. public.tarefas: instâncias operacionais de tarefas para a equipe
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabela: public.acompanhamento_eventos
-- Armazena cada entrada do histórico oficial do PNCP para uma compra.
-- Chave única de idempotência composta:
--   (compra_orgao_cnpj, compra_ano, compra_sequencial,
--    log_data_inclusao, categoria, tipo,
--    coalesce(item_numero, -1),
--    coalesce(documento_sequencial, -1),
--    coalesce(item_resultado_sequencial, -1))
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.acompanhamento_eventos (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  licitacao_id                BIGINT REFERENCES public.licitacoes_externas(id) ON DELETE SET NULL,
  compra_orgao_cnpj           TEXT NOT NULL,
  compra_ano                  INTEGER NOT NULL,
  compra_sequencial           INTEGER NOT NULL,
  numero_controle_pncp        TEXT,
  log_data_inclusao           TIMESTAMPTZ NOT NULL,
  categoria                   TEXT NOT NULL,
  categoria_codigo            INTEGER,
  tipo                        TEXT NOT NULL,
  tipo_codigo                 INTEGER,
  item_numero                 INTEGER NOT NULL DEFAULT -1,
  documento_tipo              TEXT,
  documento_sequencial        INTEGER NOT NULL DEFAULT -1,
  documento_titulo            TEXT,
  item_resultado_numero       INTEGER,
  item_resultado_sequencial   INTEGER NOT NULL DEFAULT -1,
  usuario_nome                TEXT,
  justificativa               TEXT,
  raw                         JSONB,
  processado                  BOOLEAN NOT NULL DEFAULT FALSE,
  processado_em               TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_acompanhamento_eventos_idempotencia UNIQUE (
    compra_orgao_cnpj,
    compra_ano,
    compra_sequencial,
    log_data_inclusao,
    categoria,
    tipo,
    item_numero,
    documento_sequencial,
    item_resultado_sequencial
  )
);

CREATE INDEX IF NOT EXISTS idx_acomp_eventos_compra ON public.acompanhamento_eventos (
  compra_orgao_cnpj,
  compra_ano,
  compra_sequencial
);

CREATE INDEX IF NOT EXISTS idx_acomp_eventos_pendentes ON public.acompanhamento_eventos (processado)
  WHERE NOT processado;

COMMENT ON TABLE public.acompanhamento_eventos IS
  'Eventos ingeridos do histórico oficial do PNCP por compra, com chave única de idempotência.';

-- -----------------------------------------------------------------------------
-- 2. Tabela: public.tarefa_tipos
-- Tabela canônica de regras para mapeamento determinístico de eventos em tarefas.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tarefa_tipos (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo                 TEXT NOT NULL UNIQUE,
  categoria_evento       TEXT NOT NULL,
  tipo_evento            TEXT NOT NULL,
  titulo_template        TEXT NOT NULL,
  descricao_template     TEXT,
  prioridade             TEXT NOT NULL CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente')),
  prazo_padrao_dias      INTEGER NOT NULL DEFAULT 2,
  prazo_tipo             TEXT NOT NULL DEFAULT 'dias_uteis' CHECK (prazo_tipo IN ('dias_uteis', 'dias_corridos', 'horas')),
  agrupamento            TEXT NOT NULL DEFAULT 'compra_dia' CHECK (agrupamento IN ('compra_dia', 'item', 'individual')),
  ativo                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_tarefa_tipos_regra UNIQUE (categoria_evento, tipo_evento)
);

COMMENT ON TABLE public.tarefa_tipos IS
  'Regras canônicas determinísticas: mapeia (categoria, tipo) do PNCP em tarefas com SLA e agrupamento.';

-- Seed canônico de regras de tarefas
INSERT INTO public.tarefa_tipos (
  codigo, categoria_evento, tipo_evento, titulo_template, prioridade, prazo_padrao_dias, agrupamento
) VALUES
  (
    'DOC_INCLUIDO',
    'Documento de Contratação',
    'Inclusão',
    'Ler novo documento: {documento_titulo}',
    'alta',
    1,
    'individual'
  ),
  (
    'ITEM_RETIFICADO',
    'Item de Contratação',
    'Retificação',
    'Revisar itens alterados no certame ({quantidade_itens} itens)',
    'urgente',
    1,
    'compra_dia'
  ),
  (
    'RESULTADO_INCLUIDO',
    'Resultado de Contratação',
    'Inclusão',
    'Conferir vencedor/preço homologado do item {item_numero}',
    'alta',
    2,
    'item'
  ),
  (
    'ATA_PUBLICADA',
    'Ata de Registro de Preço',
    'Inclusão',
    'Avaliar adesão à ata de registro de preços',
    'media',
    3,
    'compra_dia'
  ),
  (
    'CONTRATACAO_RETIFICADA',
    'Contratação',
    'Retificação',
    'Revisar/encerrar lead — certame alterado',
    'urgente',
    1,
    'compra_dia'
  ),
  (
    'CONTRATACAO_REVOGADA',
    'Contratação',
    'Revogação',
    'Revisar/encerrar lead — certame revogado',
    'alta',
    1,
    'compra_dia'
  ),
  (
    'CONTRATACAO_ANULADA',
    'Contratação',
    'Anulação',
    'Revisar/encerrar lead — certame anulado',
    'alta',
    1,
    'compra_dia'
  )
ON CONFLICT (categoria_evento, tipo_evento) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Tabela: public.tarefas
-- Instâncias operacionais de tarefas atribuídas a usuários autenticados da equipe.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tarefas (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tarefa_tipo_id         BIGINT NOT NULL REFERENCES public.tarefa_tipos(id) ON DELETE RESTRICT,
  licitacao_id           BIGINT REFERENCES public.licitacoes_externas(id) ON DELETE CASCADE,
  compra_orgao_cnpj      TEXT NOT NULL,
  compra_ano             INTEGER NOT NULL,
  compra_sequencial      INTEGER NOT NULL,
  numero_controle_pncp   TEXT,
  titulo                 TEXT NOT NULL,
  descricao              TEXT,
  status                 TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'em_andamento', 'concluida', 'cancelada')),
  prioridade             TEXT NOT NULL CHECK (prioridade IN ('baixa', 'media', 'alta', 'urgente')),
  responsavel_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  prazo_limite           TIMESTAMPTZ,
  data_referencia        DATE NOT NULL DEFAULT CURRENT_DATE,
  chave_agrupamento      TEXT NOT NULL,
  eventos_origem_ids     BIGINT[] NOT NULL DEFAULT '{}',
  quantidade_eventos     INTEGER NOT NULL DEFAULT 1,
  metadados              JSONB DEFAULT '{}'::jsonb,
  concluida_em           TIMESTAMPTZ,
  concluida_por_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_tarefas_agrupamento_aberta UNIQUE (chave_agrupamento, status)
);

CREATE INDEX IF NOT EXISTS idx_tarefas_status_responsavel ON public.tarefas (status, responsavel_id);
CREATE INDEX IF NOT EXISTS idx_tarefas_prazo ON public.tarefas (prazo_limite) WHERE status IN ('aberta', 'em_andamento');
CREATE INDEX IF NOT EXISTS idx_tarefas_licitacao ON public.tarefas (licitacao_id);

COMMENT ON TABLE public.tarefas IS
  'Instâncias de tarefas da equipe geradas por automação de eventos ou manualmente.';

-- -----------------------------------------------------------------------------
-- 4. Políticas de Segurança (RLS e Permissões)
-- Apenas usuários autenticados (authenticated) podem ler/escrever tarefas e eventos.
-- REVOKE ALL explícito para role 'anon' em tabelas e sequências.
-- -----------------------------------------------------------------------------

ALTER TABLE public.acompanhamento_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tarefa_tipos           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tarefas                ENABLE ROW LEVEL SECURITY;

-- Políticas de SELECT para authenticated
DROP POLICY IF EXISTS acomp_eventos_select_auth ON public.acompanhamento_eventos;
CREATE POLICY acomp_eventos_select_auth ON public.acompanhamento_eventos
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tarefa_tipos_select_auth ON public.tarefa_tipos;
CREATE POLICY tarefa_tipos_select_auth ON public.tarefa_tipos
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS tarefas_select_auth ON public.tarefas;
CREATE POLICY tarefas_select_auth ON public.tarefas
  FOR SELECT TO authenticated USING (true);

-- Políticas de DML em tarefas para authenticated (atualização de status e responsável)
DROP POLICY IF EXISTS tarefas_update_auth ON public.tarefas;
CREATE POLICY tarefas_update_auth ON public.tarefas
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS tarefas_insert_auth ON public.tarefas;
CREATE POLICY tarefas_insert_auth ON public.tarefas
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Revogação total de privilégios para a role anon
REVOKE ALL ON TABLE public.acompanhamento_eventos FROM anon;
REVOKE ALL ON TABLE public.tarefa_tipos           FROM anon;
REVOKE ALL ON TABLE public.tarefas                FROM anon;

REVOKE ALL ON SEQUENCE public.acompanhamento_eventos_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.tarefa_tipos_id_seq           FROM anon;
REVOKE ALL ON SEQUENCE public.tarefas_id_seq                FROM anon;

-- Concessão para service_role (usado pelos workers e background jobs)
GRANT ALL ON TABLE public.acompanhamento_eventos TO service_role;
GRANT ALL ON TABLE public.tarefa_tipos           TO service_role;
GRANT ALL ON TABLE public.tarefas                TO service_role;

GRANT ALL ON SEQUENCE public.acompanhamento_eventos_id_seq TO service_role;
GRANT ALL ON SEQUENCE public.tarefa_tipos_id_seq           TO service_role;
GRANT ALL ON SEQUENCE public.tarefas_id_seq                TO service_role;

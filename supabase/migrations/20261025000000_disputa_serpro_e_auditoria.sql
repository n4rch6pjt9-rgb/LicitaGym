-- Migration: 20261025000000_disputa_serpro_e_auditoria.sql
-- Descrição: Criação das tabelas da Spec 0039 (Módulos 5, 6 e 10 do ESCOPO)
--           1. disputa_mensagens: chat e diligências oficiais lidos do Integra Compras (Serpro)
--           2. disputa_sessoes_ativas: controle de polling de sessões em andamento
--           3. disputa_lances_auditoria: trilha forense e conformidade com a IN SEGES 73/2022 e TCU

-- 1. Mensagens oficiais da sessão (Módulo 6 - Chat do Compras.gov.br via Serpro)
CREATE TABLE IF NOT EXISTS public.disputa_mensagens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    licitacao_id BIGINT NOT NULL REFERENCES public.licitacoes_externas(id) ON DELETE CASCADE,
    chave_compra VARCHAR(64) NOT NULL,
    item_numero INT,
    categoria VARCHAR(32) NOT NULL, -- 'chat' | 'diligencia' | 'aviso' | 'sistema'
    remetente VARCHAR(64) NOT NULL,
    mensagem TEXT NOT NULL,
    data_hora_oficial TIMESTAMPTZ NOT NULL,
    lida_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_disputa_mensagem_evento UNIQUE(tenant_id, chave_compra, data_hora_oficial, mensagem)
);

CREATE INDEX IF NOT EXISTS idx_disputa_mensagens_busca 
    ON public.disputa_mensagens(tenant_id, licitacao_id, data_hora_oficial DESC);

-- 2. Sessões em monitoramento ativo de polling (Módulos 5 e 6)
CREATE TABLE IF NOT EXISTS public.disputa_sessoes_ativas (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    licitacao_id BIGINT NOT NULL REFERENCES public.licitacoes_externas(id) ON DELETE CASCADE,
    chave_compra VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'agendada', -- 'agendada' | 'em_disputa' | 'encerrada' | 'suspensa'
    ultima_consulta_serpro TIMESTAMPTZ,
    ultimo_evento_data_hora TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_disputa_sessao_tenant_licitacao UNIQUE(tenant_id, licitacao_id)
);

CREATE INDEX IF NOT EXISTS idx_disputa_sessoes_status 
    ON public.disputa_sessoes_ativas(status) WHERE status = 'em_disputa';

-- 3. Trilha de auditoria e conformidade de lances (Módulo 10 - Robô supervisionado no operador)
CREATE TABLE IF NOT EXISTS public.disputa_lances_auditoria (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    licitacao_id BIGINT NOT NULL REFERENCES public.licitacoes_externas(id) ON DELETE CASCADE,
    item_numero INT NOT NULL,
    valor_lance_centavos BIGINT NOT NULL,
    piso_referencia_centavos BIGINT NOT NULL,
    melhor_lance_adversario_centavos BIGINT,
    modo_disputa VARCHAR(32) NOT NULL, -- 'aberto' | 'aberto_fechado'
    regra_aplicada VARCHAR(64) NOT NULL, -- 'cobranca_minima' | 'intermediario' | 'desempate_me_epp' | 'manual'
    origem VARCHAR(32) NOT NULL, -- 'extensao_operador' | 'nativo_governo' | 'manual_operador'
    resultado VARCHAR(32) NOT NULL, -- 'sucesso' | 'recusado_intervalo' | 'bloqueado_piso'
    detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
    enviado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputa_lances_auditoria_busca 
    ON public.disputa_lances_auditoria(tenant_id, licitacao_id, enviado_em DESC);

-- Habilitação obrigatória de RLS (Spec 0039 / K-1 / CA-1: RLS ligada sem policy direta para authenticated;
-- leitura e escrita ocorrem exclusivamente via Edge Function api-disputa com service_role).
ALTER TABLE public.disputa_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputa_sessoes_ativas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disputa_lances_auditoria ENABLE ROW LEVEL SECURITY;

-- Remove quaisquer policies residuais caso existam
DROP POLICY IF EXISTS disputa_mensagens_tenant_isolation ON public.disputa_mensagens;
DROP POLICY IF EXISTS disputa_sessoes_ativas_tenant_isolation ON public.disputa_sessoes_ativas;
DROP POLICY IF EXISTS disputa_lances_auditoria_tenant_isolation ON public.disputa_lances_auditoria;

-- Revoga todo acesso de público, anon e authenticated para blindar auditoria e mensagens oficiais contra adulteração
REVOKE ALL ON TABLE public.disputa_mensagens, public.disputa_sessoes_ativas, public.disputa_lances_auditoria
    FROM PUBLIC, anon, authenticated;

-- Concede privilégios estritamente a service_role (Edge Functions autenticadas)
GRANT ALL ON TABLE public.disputa_mensagens, public.disputa_sessoes_ativas, public.disputa_lances_auditoria
    TO service_role;


-- 20260929000001_pncp_sync_request_telemetry.sql
-- FASE 2 (PR A): Telemetria, heartbeat, suporte a status 'retomada', índice único de lock
-- e RPC atômica de aquisição com retomada e preservação de fatias em stale.
-- Alinhado com a especificação em .audit/20-rate-limit-map-and-design.md.

-- 1. Colunas de telemetria em private.pncp_sync_request
ALTER TABLE private.pncp_sync_request
  ADD COLUMN IF NOT EXISTS host text,
  ADD COLUMN IF NOT EXISTS retry_after_seconds int;

-- 2. Colunas de heartbeat e rastreabilidade de retomada em private.pncp_sync_run
ALTER TABLE private.pncp_sync_run
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS retomada_por_id uuid REFERENCES private.pncp_sync_run(id) ON DELETE SET NULL;

-- 3. Inclusão do status 'retomada' no CHECK de status
ALTER TABLE private.pncp_sync_run
  DROP CONSTRAINT IF EXISTS pncp_sync_run_status_check;

ALTER TABLE private.pncp_sync_run
  ADD CONSTRAINT pncp_sync_run_status_check
  CHECK (status IN (
    'pendente',
    'executando',
    'concluida',
    'concluida_com_erros',
    'falhou',
    'cancelada',
    'incompleta',
    'retomada'
  ));

COMMENT ON CONSTRAINT pncp_sync_run_status_check ON private.pncp_sync_run IS
  'Status unificado: inclui incompleta (continuação pendente) e retomada (assumida por novo run).';

-- 4. Substituição do índice não-único por índice único parcial para garantir atomicidade física
-- Nota: o zumbi 'orgaos-sync:7830' é chave única isolada; este índice cria sem erros desde que não
-- haja duas linhas com a mesma chave em 'executando'.
DROP INDEX IF EXISTS private.pncp_sync_run_lock_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS pncp_sync_run_lock_key_executando_uidx
  ON private.pncp_sync_run (lock_key)
  WHERE status = 'executando';

-- 5. RPC Atômica: private.acquire_sync_lock
-- Substitui a versão antiga de 202609180001_pncp_foundation.sql.
-- Implementa:
--  - Advisory xact lock por chave para evitar race conditions no SELECT prévio;
--  - Heartbeat evaluation em vez de iniciada_em fixo para detecção de stale;
--  - Preservação de fatias: stale com fatias vira 'incompleta'; sem fatias vira 'falhou';
--  - Regra de chave :manual:: execuções manuais nunca retomam e viram 'falhou' em stale;
--  - Herança atômica da continuation na criação do novo run e marcação da anterior como 'retomada';
--  - Tratamento de unique_violation capturado como already_running (defesa em profundidade).
CREATE OR REPLACE FUNCTION private.acquire_sync_lock(
  p_lock_key text,
  p_resource_type text,
  p_parametros jsonb DEFAULT '{}'::jsonb,
  p_stale_interval interval DEFAULT interval '3 minutes',
  p_max_ttl interval DEFAULT interval '7 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_running_rec record;
  v_prior_incompleta record;
  v_new_run_id uuid;
  v_continuation jsonb := NULL;
  v_prior_id uuid := NULL;
  v_initial_parametros jsonb;
  v_has_pending boolean;
  v_is_manual boolean;
BEGIN
  -- 0. Serialização estrita por chave: impede race condition em invocações concorrentes
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_lock_key));

  -- Classifica se é chave ou disparo manual (ex.: contratacoes-editais:manual:20260801:20260810)
  v_is_manual := (
    p_lock_key LIKE '%:manual:%' 
    OR (p_parametros ? 'data_inicial' AND p_parametros ? 'data_final')
  );

  -- 1. Verifica se já existe execução com lock ativo
  SELECT id, iniciada_em, last_heartbeat_at, parametros INTO v_running_rec
  FROM private.pncp_sync_run
  WHERE lock_key = p_lock_key AND status = 'executando'
  FOR UPDATE;

  IF FOUND THEN
    -- Avalia se o lock está vivo pelo último heartbeat
    IF (v_now - COALESCE(v_running_rec.last_heartbeat_at, v_running_rec.iniciada_em)) <= p_stale_interval THEN
      RETURN jsonb_build_object(
        'already_running', true,
        'run_id', v_running_rec.id
      );
    END IF;

    -- STALE DETECTADO: Processo anterior morreu ou travou sem heartbeat há mais de 3 min.
    -- Se for execução manual, vai sempre para 'falhou' (não gera incompleta retomável).
    IF v_is_manual THEN
      UPDATE private.pncp_sync_run
      SET status = 'falhou',
          erro_principal = 'lock expirado (stale / execucao manual)',
          finalizada_em = v_now
      WHERE id = v_running_rec.id;
    ELSE
      -- Execuções automáticas: se havia continuation com fatias pendentes, preserva como 'incompleta'
      v_has_pending := (
        v_running_rec.parametros->'continuation'->'pending' IS NOT NULL
        AND jsonb_typeof(v_running_rec.parametros->'continuation'->'pending') = 'array'
        AND jsonb_array_length(v_running_rec.parametros->'continuation'->'pending') > 0
      );

      IF v_has_pending THEN
        UPDATE private.pncp_sync_run
        SET status = 'incompleta',
            erro_principal = 'lock expirado (stale) - fatias pendentes preservadas para retomada',
            finalizada_em = v_now
        WHERE id = v_running_rec.id;
      ELSE
        UPDATE private.pncp_sync_run
        SET status = 'falhou',
            erro_principal = 'lock expirado (stale / worker morto sem fatias)',
            finalizada_em = v_now
        WHERE id = v_running_rec.id;
      END IF;
    END IF;
  END IF;

  -- 2. Busca execução 'incompleta' anterior para o mesmo lock_key (se NÃO for manual)
  -- Nota: não retoma o registro que acabou de ser detectado como stale nesta mesma transação
  IF NOT v_is_manual THEN
    SELECT id, parametros, iniciada_em INTO v_prior_incompleta
    FROM private.pncp_sync_run
    WHERE lock_key = p_lock_key 
      AND status = 'incompleta'
      AND (v_running_rec.id IS NULL OR id <> v_running_rec.id)
    ORDER BY iniciada_em DESC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      -- Se tiver mais de 7 dias (TTL), descarta por obsolescência
      IF (v_now - v_prior_incompleta.iniciada_em) > p_max_ttl THEN
        UPDATE private.pncp_sync_run
        SET status = 'falhou',
            erro_principal = 'fatias descartadas por obsolescencia (> 7 dias)',
            finalizada_em = v_now
        WHERE id = v_prior_incompleta.id;
      ELSE
        -- Herda a continuação para a nova execução
        v_continuation := v_prior_incompleta.parametros->'continuation';
        v_prior_id := v_prior_incompleta.id;
      END IF;
    END IF;
  END IF;

  -- 3. Prepara parâmetros iniciais gravando continuation herdada logo na largada
  v_initial_parametros := p_parametros;
  IF v_continuation IS NOT NULL THEN
    v_initial_parametros := v_initial_parametros || jsonb_build_object('continuation', v_continuation);
  END IF;

  -- 4. Cria a nova execução com status 'executando'
  INSERT INTO private.pncp_sync_run (
    resource_type,
    lock_key,
    parametros,
    status,
    iniciada_em,
    last_heartbeat_at
  )
  VALUES (
    p_resource_type,
    p_lock_key,
    v_initial_parametros,
    'executando',
    v_now,
    v_now
  )
  ON CONFLICT (lock_key) WHERE status = 'executando' DO NOTHING
  RETURNING id INTO v_new_run_id;

  -- Se não inseriu por conflito com índice único parcial
  IF v_new_run_id IS NULL THEN
    SELECT id INTO v_new_run_id
    FROM private.pncp_sync_run
    WHERE lock_key = p_lock_key AND status = 'executando'
    LIMIT 1;

    RETURN jsonb_build_object(
      'already_running', true,
      'run_id', v_new_run_id
    );
  END IF;

  -- 5. ATÔMICO NA MESMA TRANSAÇÃO: marca a execução anterior como 'retomada'
  IF v_prior_id IS NOT NULL THEN
    UPDATE private.pncp_sync_run
    SET status = 'retomada',
        retomada_por_id = v_new_run_id,
        finalizada_em = v_now
    WHERE id = v_prior_id;
  END IF;

  RETURN jsonb_build_object(
    'already_running', false,
    'run_id', v_new_run_id,
    'continuation', v_continuation,
    'retomada_de_id', v_prior_id
  );
END;
$$;

-- Permissões estritas no schema private
REVOKE EXECUTE ON FUNCTION private.acquire_sync_lock(text, text, jsonb, interval, interval) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.acquire_sync_lock(text, text, jsonb, interval, interval) TO service_role;

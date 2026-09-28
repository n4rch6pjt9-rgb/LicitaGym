-- 20260929000000_http_host_lease.sql
-- FASE 2 (PR A): Tabela de coordenação de taxa por host e RPCs atômicas de rate limiting.
-- Alinhado com a especificação em .audit/20-rate-limit-map-and-design.md.
--
-- Concorrência 1 serializada: o próximo momento permitido (next_allowed_at) é avançado
-- atomicamente pela RPC acquire_http_slot, dispensando contadores voláteis de holders
-- e garantindo imunidade a vazamento em crashes ou timeouts de workers (546).

CREATE TABLE IF NOT EXISTS private.http_host_lease (
  host text PRIMARY KEY,
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz NOT NULL DEFAULT now(),
  min_interval_ms int NOT NULL DEFAULT 1000,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS ativado: proibido acesso anônimo/autenticado (schema private está exposto no PostgREST)
ALTER TABLE private.http_host_lease ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.http_host_lease FROM public, anon, authenticated;
GRANT ALL ON TABLE private.http_host_lease TO service_role;

-- Seed inicial idempotente dos hosts oficiais governamentais
INSERT INTO private.http_host_lease (host, min_interval_ms)
VALUES 
  ('pncp.gov.br', 1000),
  ('dadosabertos.compras.gov.br', 1000)
ON CONFLICT (host) DO NOTHING;

-- -----------------------------------------------------------------------------
-- RPC: private.acquire_http_slot
-- -----------------------------------------------------------------------------
-- Reserva atômica de slot de rede por host.
-- Usa EXTRACT(EPOCH FROM ...) * 1000 para cálculo de wait_ms e SET search_path = ''.
CREATE OR REPLACE FUNCTION private.acquire_http_slot(
  p_host text,
  p_max_wait_ms int DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec record;
  v_now timestamptz := clock_timestamp();
  v_wait_ms int;
  v_target_time timestamptz;
BEGIN
  -- Garante que a linha do host exista sem risco de unique_violation concorrente
  INSERT INTO private.http_host_lease (host, min_interval_ms)
  VALUES (p_host, 1000)
  ON CONFLICT (host) DO NOTHING;

  -- Bloqueia exclusivamente a linha do host durante a transação rápida
  SELECT * INTO v_rec
  FROM private.http_host_lease
  WHERE host = p_host
  FOR UPDATE;

  -- 1. Verifica Cooldown Ativo (429 global do host)
  IF v_rec.cooldown_until > v_now THEN
    v_wait_ms := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_rec.cooldown_until - v_now)) * 1000)::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- 2. Concorrência 1: calcula próximo instante liberado e reserva atômica
  v_target_time := GREATEST(v_now, v_rec.next_allowed_at);
  v_wait_ms := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_target_time - v_now)) * 1000)::int);

  -- Se o tempo de espera na fila exceder o teto aceitável pelo processo
  IF v_wait_ms > p_max_wait_ms THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'queue_full',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- Reserva atômica: avança next_allowed_at para o próximo processo
  UPDATE private.http_host_lease
  SET next_allowed_at = v_target_time + (v_rec.min_interval_ms || ' milliseconds')::interval,
      updated_at = v_now
  WHERE host = p_host;

  RETURN jsonb_build_object(
    'allowed', true,
    'wait_ms', v_wait_ms
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION private.acquire_http_slot(text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.acquire_http_slot(text, int) TO service_role;

-- -----------------------------------------------------------------------------
-- RPC: private.report_http_rate_limit
-- -----------------------------------------------------------------------------
-- Notifica ocorrência de HTTP 429 para acionar cooldown global em todas as instâncias.
CREATE OR REPLACE FUNCTION private.report_http_rate_limit(
  p_host text,
  p_cooldown_seconds int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secs int;
  v_new_target timestamptz;
BEGIN
  -- Valida p_cooldown_seconds > 0 com teto razoável de segurança (3600s = 1 hora)
  v_secs := GREATEST(1, LEAST(COALESCE(p_cooldown_seconds, 1), 3600));
  v_new_target := clock_timestamp() + (v_secs || ' seconds')::interval;

  -- Garante que o host exista
  INSERT INTO private.http_host_lease (host, min_interval_ms)
  VALUES (p_host, 1000)
  ON CONFLICT (host) DO NOTHING;

  -- Atualiza sem encurtar cooldown já ativo maior
  UPDATE private.http_host_lease
  SET cooldown_until = GREATEST(cooldown_until, v_new_target),
      next_allowed_at = GREATEST(next_allowed_at, v_new_target),
      updated_at = clock_timestamp()
  WHERE host = p_host;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.report_http_rate_limit(text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.report_http_rate_limit(text, int) TO service_role;

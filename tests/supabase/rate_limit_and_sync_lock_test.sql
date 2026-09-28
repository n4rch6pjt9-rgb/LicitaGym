-- tests/supabase/rate_limit_and_sync_lock_test.sql
-- Bateria de testes automatizados SQL para Fase 2 (PR A):
-- Validação estrita dos 7 cenários obrigatórios do .audit/20 e instruções do Marcelo:
--
-- 1. Duas chamadas simultâneas de acquire_sync_lock com a mesma chave: uma recebe already_running.
-- 2. 'incompleta' retomada vira 'retomada' com retomada_por_id e não é encontrada de novo na chamada seguinte.
-- 3. Stale com fatias vira 'incompleta'; sem fatias vira 'falhou'; stale ':manual:' com fatias vira 'falhou'.
-- 4. 'incompleta' com mais de 7 dias vira 'falhou' por obsolescência.
-- 5. Chave ':manual:' não retoma nada.
-- 6. wait_ms do acquire_http_slot para espera acima de 60 s (verifica uso de EPOCH e cálculo correto).
-- 7. anon e authenticated não conseguem executar as RPCs nem ler http_host_lease (RLS e ACL).

\set ON_ERROR_STOP on

SELECT '=== INICIANDO TESTES SQL: RATE LIMIT & SYNC LOCK ===' AS status;

-- -----------------------------------------------------------------------------
-- TESTE 1: Duas chamadas simultâneas de acquire_sync_lock com a mesma chave
-- Uma recebe already_running=false e a segunda recebe already_running=true.
-- (Ver também teste de dois processos concorrentes em tests/supabase/test_parallel_concurrency.sh).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_res1 jsonb;
  v_res2 jsonb;
BEGIN
  -- Limpeza prévia
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-concurrent-key';

  -- Chamada 1: Adquire o lock
  v_res1 := private.acquire_sync_lock('test-concurrent-key', 'teste', '{}'::jsonb);

  IF (v_res1->>'already_running')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'TESTE 1 FALHOU: Chamada 1 deveria ter adquirido o lock, mas obteve %', v_res1;
  END IF;

  -- Chamada 2: Tenta adquirir o mesmo lock com o job 1 ainda ativo ('executando'):
  v_res2 := private.acquire_sync_lock('test-concurrent-key', 'teste', '{}'::jsonb);

  IF (v_res2->>'already_running')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TESTE 1 FALHOU: Chamada 2 deveria ter recebido already_running=true, mas recebeu %', v_res2;
  END IF;

  IF (v_res2->>'run_id')::uuid <> (v_res1->>'run_id')::uuid THEN
    RAISE EXCEPTION 'TESTE 1 FALHOU: run_id retornado na colisão deveria ser o id da chamada 1';
  END IF;

  RAISE NOTICE '✓ TESTE 1 PASSOU: Concorrência bloqueada com already_running=true';
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 2: 'incompleta' retomada vira 'retomada' com retomada_por_id e não é reencontrada
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_run_a_id uuid;
  v_fatias jsonb := '[{"dataInicial":"20260901","dataFinal":"20260902","nextPage":5}]'::jsonb;
  v_res_b jsonb;
  v_res_c jsonb;
  v_run_b_id uuid;
  v_run_a_status text;
  v_run_a_retomada_por uuid;
BEGIN
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-retomada-key';

  -- 1. Cria Run A com status incompleta e fatias pendentes
  INSERT INTO private.pncp_sync_run (
    resource_type,
    lock_key,
    parametros,
    status,
    iniciada_em,
    last_heartbeat_at
  )
  VALUES (
    'teste_editais',
    'test-retomada-key',
    jsonb_build_object('continuation', jsonb_build_object('pending', v_fatias, 'chain_id', 'chain-123')),
    'incompleta',
    now() - interval '1 hour',
    now() - interval '1 hour'
  )
  RETURNING id INTO v_run_a_id;

  -- 2. Run B adquire o lock: deve herdar as fatias e marcar Run A como 'retomada'
  v_res_b := private.acquire_sync_lock('test-retomada-key', 'teste_editais', '{}'::jsonb);
  v_run_b_id := (v_res_b->>'run_id')::uuid;

  IF (v_res_b->>'already_running')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: Run B deveria ter iniciado, obteve already_running=true';
  END IF;

  IF (v_res_b->'continuation'->'pending') <> v_fatias THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: Run B não herdou as fatias pendentes de Run A. Obteve: %', v_res_b->'continuation';
  END IF;

  -- Verifica estado de Run A no banco: deve estar 'retomada' com retomada_por_id = Run B
  SELECT status, retomada_por_id INTO v_run_a_status, v_run_a_retomada_por
  FROM private.pncp_sync_run
  WHERE id = v_run_a_id;

  IF v_run_a_status <> 'retomada' OR v_run_a_retomada_por <> v_run_b_id THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: Run A deveria ter status=retomada e retomada_por_id=%, mas tem status=% e id=%',
      v_run_b_id, v_run_a_status, v_run_a_retomada_por;
  END IF;

  -- Finaliza Run B com sucesso para liberar o lock
  UPDATE private.pncp_sync_run SET status = 'concluida' WHERE id = v_run_b_id;

  -- 3. Run C adquire o lock: NÃO deve encontrar Run A (que agora é 'retomada')
  v_res_c := private.acquire_sync_lock('test-retomada-key', 'teste_editais', '{}'::jsonb);

  IF (v_res_c->>'continuation') IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE 2 FALHOU: Run C não deveria herdar continuation de Run A (que já foi retomada). Obteve: %', v_res_c;
  END IF;

  RAISE NOTICE '✓ TESTE 2 PASSOU: Transição atômica incompleta -> retomada com retomada_por_id validada';
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 3: Stale com fatias vira 'incompleta'; sem fatias vira 'falhou'; stale ':manual:' vira 'falhou'
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_stale_fatias_id uuid;
  v_stale_sem_fatias_id uuid;
  v_stale_manual_id uuid;
  v_res jsonb;
  v_status text;
  v_erro text;
BEGIN
  -- Caso 3.1: Stale regular com fatias pendentes -> deve virar 'incompleta'
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-stale-fatias';
  INSERT INTO private.pncp_sync_run (
    resource_type, lock_key, parametros, status, iniciada_em, last_heartbeat_at
  ) VALUES (
    'teste', 'test-stale-fatias',
    '{"continuation":{"pending":[{"pagina":2}]}}'::jsonb,
    'executando', now() - interval '10 minutes', now() - interval '5 minutes'
  ) RETURNING id INTO v_stale_fatias_id;

  v_res := private.acquire_sync_lock('test-stale-fatias', 'teste', '{}'::jsonb);
  SELECT status INTO v_status FROM private.pncp_sync_run WHERE id = v_stale_fatias_id;
  IF v_status <> 'incompleta' THEN
    RAISE EXCEPTION 'TESTE 3.1 FALHOU: Stale com fatias deveria virar incompleta, virou %', v_status;
  END IF;

  -- Caso 3.2: Stale regular sem fatias -> deve virar 'falhou'
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-stale-sem-fatias';
  INSERT INTO private.pncp_sync_run (
    resource_type, lock_key, parametros, status, iniciada_em, last_heartbeat_at
  ) VALUES (
    'teste', 'test-stale-sem-fatias', '{}'::jsonb,
    'executando', now() - interval '10 minutes', now() - interval '5 minutes'
  ) RETURNING id INTO v_stale_sem_fatias_id;

  v_res := private.acquire_sync_lock('test-stale-sem-fatias', 'teste', '{}'::jsonb);
  SELECT status INTO v_status FROM private.pncp_sync_run WHERE id = v_stale_sem_fatias_id;
  IF v_status <> 'falhou' THEN
    RAISE EXCEPTION 'TESTE 3.2 FALHOU: Stale sem fatias deveria virar falhou, virou %', v_status;
  END IF;

  -- Caso 3.3: Stale de chave ':manual:' com fatias -> deve virar 'falhou' (não gera incompleta)
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'contratacoes-editais:manual:20260901:20260905';
  INSERT INTO private.pncp_sync_run (
    resource_type, lock_key, parametros, status, iniciada_em, last_heartbeat_at
  ) VALUES (
    'teste', 'contratacoes-editais:manual:20260901:20260905',
    '{"continuation":{"pending":[{"pagina":2}]}}'::jsonb,
    'executando', now() - interval '10 minutes', now() - interval '5 minutes'
  ) RETURNING id INTO v_stale_manual_id;

  v_res := private.acquire_sync_lock('contratacoes-editais:manual:20260901:20260905', 'teste', '{}'::jsonb);
  SELECT status, erro_principal INTO v_status, v_erro FROM private.pncp_sync_run WHERE id = v_stale_manual_id;
  IF v_status <> 'falhou' THEN
    RAISE EXCEPTION 'TESTE 3.3 FALHOU: Stale manual deveria virar falhou mesmo com fatias, virou %', v_status;
  END IF;

  RAISE NOTICE '✓ TESTE 3 PASSOU: Regras de lock stale com/sem fatias e regra :manual: validadas';
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 4: 'incompleta' com mais de 7 dias vira 'falhou' por obsolescência
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_old_incompleta_id uuid;
  v_res jsonb;
  v_status text;
  v_erro text;
BEGIN
  DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-obsolescencia-key';

  INSERT INTO private.pncp_sync_run (
    resource_type, lock_key, parametros, status, iniciada_em, last_heartbeat_at
  ) VALUES (
    'teste', 'test-obsolescencia-key',
    '{"continuation":{"pending":[{"pagina":10}]}}'::jsonb,
    'incompleta', now() - interval '8 days', now() - interval '8 days'
  ) RETURNING id INTO v_old_incompleta_id;

  v_res := private.acquire_sync_lock('test-obsolescencia-key', 'teste', '{}'::jsonb);

  -- A nova execução NÃO deve herdar as fatias obsoletas
  IF (v_res->>'continuation') IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE 4 FALHOU: Nova execução herdou fatias com mais de 7 dias: %', v_res;
  END IF;

  -- A execução antiga deve ter sido descartada e marcada como 'falhou'
  SELECT status, erro_principal INTO v_status, v_erro FROM private.pncp_sync_run WHERE id = v_old_incompleta_id;
  IF v_status <> 'falhou' OR v_erro NOT LIKE '%obsolescencia%' THEN
    RAISE EXCEPTION 'TESTE 4 FALHOU: Execução antiga deveria ter sido marcada como falhou por obsolescência, status=%, erro=%', v_status, v_erro;
  END IF;

  RAISE NOTICE '✓ TESTE 4 PASSOU: TTL de 7 dias descartou fatias obsoletas para falhou';
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 5: Chave ':manual:' não retoma nada
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_manual_key text := 'contratacoes-editais:manual:20260910:20260915';
  v_res jsonb;
BEGIN
  DELETE FROM private.pncp_sync_run WHERE lock_key = v_manual_key;

  -- Insere uma execução 'incompleta' na chave manual (ex.: teste de borda)
  INSERT INTO private.pncp_sync_run (
    resource_type, lock_key, parametros, status, iniciada_em
  ) VALUES (
    'teste', v_manual_key,
    '{"continuation":{"pending":[{"pagina":3}]}}'::jsonb,
    'incompleta', now() - interval '1 hour'
  );

  -- Novo disparo na chave manual: não deve retomar nada
  v_res := private.acquire_sync_lock(v_manual_key, 'teste', '{"data_inicial":"20260910","data_final":"20260915"}'::jsonb);

  IF (v_res->>'continuation') IS NOT NULL THEN
    RAISE EXCEPTION 'TESTE 5 FALHOU: Disparo manual herdou continuation indevidamente: %', v_res;
  END IF;

  RAISE NOTICE '✓ TESTE 5 PASSOU: Chave :manual: isolada e sem herança de continuation';
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 6: wait_ms do acquire_http_slot para espera acima de 60 s (EPOCH)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_res jsonb;
  v_wait_ms int;
  v_host text := 'pncp.gov.br';
BEGIN
  -- Simula um cooldown longo (ex.: 120 segundos) no host lease
  PERFORM private.report_http_rate_limit(v_host, 120);

  -- Tenta adquirir slot permitindo espera de até 150 s (150000 ms)
  v_res := private.acquire_http_slot(v_host, 150000);

  IF (v_res->>'allowed')::boolean IS NOT FALSE OR v_res->>'reason' <> 'cooldown' THEN
    RAISE EXCEPTION 'TESTE 6 FALHOU: Host em cooldown deveria retornar allowed=false reason=cooldown, obteve %', v_res;
  END IF;

  v_wait_ms := (v_res->>'wait_ms')::int;
  -- Com EXTRACT(EPOCH), 120s deve dar ~120.000 ms (entre 110.000 e 120.000).
  -- Se usasse o antigo EXTRACT(MILLISECONDS), daria 0 ou < 1000!
  IF v_wait_ms < 100000 THEN
    RAISE EXCEPTION 'TESTE 6 FALHOU: wait_ms retornou % ms para cooldown de 120s! Bug do EXTRACT(MILLISECONDS) presente!', v_wait_ms;
  END IF;

  -- Reseta o cooldown para liberar o host nos testes seguintes
  UPDATE private.http_host_lease SET cooldown_until = now() - interval '1 second', next_allowed_at = now() - interval '1 second' WHERE host = v_host;

  RAISE NOTICE '✓ TESTE 6 PASSOU: Cálculo de wait_ms com EPOCH * 1000 validado para esperas longas (% ms)', v_wait_ms;
END $$;

-- -----------------------------------------------------------------------------
-- TESTE 7: anon e authenticated não conseguem executar as RPCs nem ler http_host_lease
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_err text;
BEGIN
  -- 7.1 Testa role anon lendo tabela http_host_lease
  BEGIN
    SET ROLE anon;
    PERFORM * FROM private.http_host_lease;
    RAISE EXCEPTION 'TESTE 7.1 FALHOU: Role anon conseguiu ler private.http_host_lease!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Esperado
      RESET ROLE;
  END;

  -- 7.2 Testa role authenticated lendo tabela http_host_lease
  BEGIN
    SET ROLE authenticated;
    PERFORM * FROM private.http_host_lease;
    RAISE EXCEPTION 'TESTE 7.2 FALHOU: Role authenticated conseguiu ler private.http_host_lease!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Esperado
      RESET ROLE;
  END;

  -- 7.3 Testa role anon executando private.acquire_http_slot
  BEGIN
    SET ROLE anon;
    PERFORM private.acquire_http_slot('pncp.gov.br', 1000);
    RAISE EXCEPTION 'TESTE 7.3 FALHOU: Role anon conseguiu executar private.acquire_http_slot!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Esperado
      RESET ROLE;
  END;

  -- 7.4 Testa role authenticated executando private.acquire_sync_lock
  BEGIN
    SET ROLE authenticated;
    PERFORM private.acquire_sync_lock('test-acl-key', 'teste', '{}'::jsonb);
    RAISE EXCEPTION 'TESTE 7.4 FALHOU: Role authenticated conseguiu executar private.acquire_sync_lock!';
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Esperado
      RESET ROLE;
  END;

  -- 7.5 Confirma que service_role consegue executar e ler normalmente
  BEGIN
    SET ROLE service_role;
    PERFORM * FROM private.http_host_lease LIMIT 1;
    PERFORM private.acquire_http_slot('pncp.gov.br', 1000);
    RESET ROLE;
  EXCEPTION
    WHEN OTHERS THEN
      RESET ROLE;
      RAISE EXCEPTION 'TESTE 7.5 FALHOU: Role service_role deveria ter acesso total, mas falhou: %', SQLERRM;
  END;

  RAISE NOTICE '✓ TESTE 7 PASSOU: ACL e isolamento de roles validados com sucesso (anon/authenticated bloqueados)';
END $$;

SELECT '=== TODOS OS 7 TESTES SQL PASSARAM COM SUCESSO! ===' AS resultado;

#!/usr/bin/env bash
set -e

echo "=== Testando chamadas concorrentes paralelas reais via dois processos psql ==="

# Limpa chave de teste concorrente
sudo -u postgres psql -d postgres -q -c "DELETE FROM private.pncp_sync_run WHERE lock_key = 'test-real-parallel';"

# Dispara processo A em background com transação aberta e lock adquirido
sudo -u postgres psql -d postgres -q << 'EOF' &
BEGIN;
SELECT private.acquire_sync_lock('test-real-parallel', 'teste', '{}'::jsonb);
SELECT pg_sleep(2);
COMMIT;
EOF
PID_A=$!

# Pequena pausa para garantir que o processo A adquiriu o lock e iniciou o sleep
sleep 0.2

# Dispara processo B tentando a mesma chave enquanto A está no sleep
RESULT_B=$(sudo -u postgres psql -d postgres -t -A -c "SELECT private.acquire_sync_lock('test-real-parallel', 'teste', '{}'::jsonb);")

# Espera processo A terminar
wait $PID_A

echo "Resultado Processo B: $RESULT_B"

# Valida se Processo B retornou already_running=true
if [[ "$RESULT_B" =~ \"already_running\":\ true ]]; then
  echo "✓ Teste de concorrência paralela real com dois processos psql PASSOU com sucesso!"
else
  echo "✗ FALHOU: Processo B não recebeu already_running=true!"
  exit 1
fi

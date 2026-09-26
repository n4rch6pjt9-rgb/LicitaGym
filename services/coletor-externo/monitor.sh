#!/usr/bin/env bash
# Monitor do coletor: mostra se o processo está vivo, há quanto tempo o log não muda e o fim do log.
# Uso: bash monitor.sh [arquivo_de_log]   (padrão: processo_edital.log)
LOG="${1:-processo_edital.log}"
while true; do
  clear
  echo "=== MONITOR $(date '+%H:%M:%S') | log: $LOG ==="
  PID=$(pgrep -f "coletor\." | head -1)
  if [ -n "$PID" ]; then
    echo "Processo: RODANDO (pid $PID) | CPU $(ps -o %cpu= -p "$PID")% | tempo $(ps -o etime= -p "$PID")"
    echo "Conexões abertas com o PNCP: $(ss -tnp 2>/dev/null | grep -c "pid=$PID")"
  else
    echo "Processo: PARADO (terminou ou caiu — veja o fim do log)"
  fi
  if [ -f "$LOG" ]; then
    PARADO=$(( $(date +%s) - $(stat -c %Y "$LOG") ))
    if   [ -z "$PID" ] && tail -n 3 "$LOG" | grep -q "RESUMO"; then
      SIT="CONCLUÍDO ($(tail -n 3 "$LOG" | grep -o 'RESUMO[^:]*' | tail -1))"
      if tail -n 3 "$LOG" | grep -q "'falha': [1-9]"; then SIT="$SIT — COM FALHAS, veja os WARNING"; fi
    elif [ -z "$PID" ]; then SIT="PARADO sem RESUMO — o processo caiu antes de terminar"
    elif [ "$PARADO" -lt 60 ];  then SIT="OK, ativo"
    elif [ "$PARADO" -lt 300 ]; then SIT="LENTO (PNCP demorando)"
    else                             SIT="PROVÁVEL TRAVA — nada novo há mais de 5 min"
    fi
    echo "Última linha do log há ${PARADO}s -> $SIT"
    echo "Progresso: $(grep -o '\[[0-9]*/[0-9]*\]' "$LOG" | tail -1)"
    echo "---------------------------------------------"
    tail -n 12 "$LOG"
  else
    echo "Log $LOG ainda não existe."
  fi
  sleep 5
done

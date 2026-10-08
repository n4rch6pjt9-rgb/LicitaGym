#!/usr/bin/env bash
# deno check dos entrypoints das Edge Functions (supabase/functions/<funcao>/index.ts).
# Sem argumentos: todas as funções. Com argumentos: só as funções nomeadas (ex.: api-catmat sync-pncp-pca).
# Funções em .github/ci/deno-check-pendentes.txt podem falhar (aviso); se passarem, falha até saírem da lista.
# Uso: scripts/ci/deno-check-funcoes.sh [funcao ...]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PENDENTES=" $(sed -e 's/#.*//' .github/ci/deno-check-pendentes.txt | awk 'NF{print $1}' | tr '\n' ' ') "
if [ "$#" -gt 0 ]; then FUNCOES=("$@"); else
  FUNCOES=(); for f in supabase/functions/*/index.ts; do FUNCOES+=("$(basename "$(dirname "$f")")"); done
fi

falhas=0; avisos=0
for fn in "${FUNCOES[@]}"; do
  arq="supabase/functions/$fn/index.ts"
  [ -f "$arq" ] || continue
  pend=0; case "$PENDENTES" in *" $fn "*) pend=1;; esac
  if saida=$(deno check "$arq" 2>&1); then
    if [ "$pend" -eq 1 ]; then
      echo "FALHA    $fn: passou, mas está em .github/ci/deno-check-pendentes.txt (tire da lista)"; falhas=$((falhas + 1))
    else
      echo "ok       $fn"
    fi
  elif [ "$pend" -eq 1 ]; then
    echo "PENDENTE $fn: $(grep -m1 -oE 'TS[0-9]+.*' <<<"$saida" | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-120)"; avisos=$((avisos + 1))
  else
    echo "FALHA    $fn"; sed 's/\x1b\[[0-9;]*m//g' <<<"$saida" | grep -E 'TS[0-9]+|at file' | head -6; falhas=$((falhas + 1))
  fi
done
echo "---"
echo "${#FUNCOES[@]} função(ões); $falhas falha(s); $avisos pendente(s) conhecida(s)."
[ "$falhas" -eq 0 ]

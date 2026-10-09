#!/usr/bin/env bash
# deno check dos entrypoints das Edge Functions (supabase/functions/<funcao>/index.ts).
# Sem argumentos: todas as funções. Com argumentos: só as funções nomeadas (ex.: api-catmat sync-pncp-pca).
# Funções em .github/ci/deno-check-pendentes.txt podem falhar (aviso); se passarem, falha até saírem da lista.
# Uso: scripts/ci/deno-check-funcoes.sh [funcao ...]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Lista: "<funcao> | <trecho do erro esperado> | <motivo>" (comentários com #).
declare -A PEND
while IFS='|' read -r nome trecho _; do
  nome="$(echo "$nome" | xargs)"; case "$nome" in ''|\#*) continue;; esac
  PEND["$nome"]="$(echo "$trecho" | sed 's/^ *//; s/ *$//')"
done < .github/ci/deno-check-pendentes.txt
if [ "$#" -gt 0 ]; then FUNCOES=("$@"); else
  FUNCOES=(); for f in supabase/functions/*/index.ts; do FUNCOES+=("$(basename "$(dirname "$f")")"); done
fi

falhas=0; avisos=0
for fn in "${FUNCOES[@]}"; do
  arq="supabase/functions/$fn/index.ts"
  if [ ! -f "$arq" ]; then echo "FALHA    $fn: $arq não existe"; falhas=$((falhas + 1)); continue; fi
  pend=0; [ -n "${PEND[$fn]+x}" ] && pend=1
  if saida=$(deno check "$arq" 2>&1); then
    if [ "$pend" -eq 1 ]; then
      echo "FALHA    $fn: passou, mas está em .github/ci/deno-check-pendentes.txt (tire da lista)"; falhas=$((falhas + 1))
    else
      echo "ok       $fn"
    fi
  elif [ "$pend" -eq 1 ] && sed 's/\x1b\[[0-9;]*m//g' <<<"$saida" | grep -qF -- "${PEND[$fn]}"; then
    echo "PENDENTE $fn: ${PEND[$fn]}"; avisos=$((avisos + 1))
  else
    echo "FALHA    $fn"; sed 's/\x1b\[[0-9;]*m//g' <<<"$saida" | grep -E 'TS[0-9]+|at file' | head -6; falhas=$((falhas + 1))
  fi
done
echo "---"
echo "${#FUNCOES[@]} função(ões); $falhas falha(s); $avisos pendente(s) conhecida(s)."
[ "$falhas" -eq 0 ]

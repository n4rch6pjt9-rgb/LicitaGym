#!/usr/bin/env bash
# Clona o LicitaGym público no SHA (head do PR) e roda o pytest do coletor.
# Não grava no GCS nem no Supabase. Passos de rede: timeout de 20s.
# Saída padrão: uma linha "<passo> OK" ou "<passo> FALHA". Exit 1 se algo falhar.
set -u

SHA="${1:-}"
URL="https://github.com/n4rch6pjt9-rgb/LicitaGym.git"

falha() {
  echo "$1 FALHA"
  if [[ -n "${LOG:-}" && -s "$LOG" ]]; then
    cat "$LOG" >&2
  fi
  exit 1
}

if [[ ! "$SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  falha argumento
fi
echo "argumento OK"

DEST="$(mktemp -d)"
LOG="$(mktemp)"
cleanup() { rm -rf "$DEST" "$LOG"; }
trap cleanup EXIT
export GIT_TERMINAL_PROMPT=0

if timeout 20 git clone --filter=blob:none --no-checkout "$URL" "$DEST" >"$LOG" 2>&1; then
  echo "clonar OK"
else
  falha clonar
fi

if timeout 20 git -C "$DEST" fetch --depth 1 origin "$SHA" >"$LOG" 2>&1; then
  echo "buscar-commit OK"
else
  falha buscar-commit
fi

if git -C "$DEST" checkout --detach FETCH_HEAD >"$LOG" 2>&1 \
   && [[ "$(git -C "$DEST" rev-parse HEAD)" == "$SHA" ]]; then
  echo "checkout OK"
else
  falha checkout
fi

if timeout 20 python3 -m pip install -q \
    -r "$DEST/services/coletor-externo/requirements.txt" \
    -r "$DEST/services/coletor-externo/requirements-dev.txt" >"$LOG" 2>&1; then
  echo "dependencias OK"
else
  falha dependencias
fi

if (cd "$DEST/services/coletor-externo" && python3 -m pytest -q --tb=line) >"$LOG" 2>&1; then
  echo "pytest OK"
else
  falha pytest
fi

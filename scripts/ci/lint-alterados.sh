#!/usr/bin/env bash
# Lint só dos arquivos informados (os alterados no PR ou os do commit), para não travar no legado.
#   .ts/.tsx em supabase/functions e tests/supabase -> deno lint (sem as regras ruidosas do legado, abaixo)
#   .py (fora de Kuib-Harness)                       -> ruff check (regras em ruff.toml)
# Uso: scripts/ci/lint-alterados.sh <arquivo> [...]     |  git diff --name-only ... | scripts/ci/lint-alterados.sh -
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Regras do deno lint desligadas por enquanto (contagem em 08/10/2026 nas funções + testes):
# require-await 66, no-explicit-any 35, no-unversioned-import 26, ban-unused-ignore 11.
DENO_EXCLUIR="require-await,no-explicit-any,no-unversioned-import,ban-unused-ignore"

if [ "${1:-}" = "-" ]; then mapfile -t ARQS; else ARQS=("$@"); fi
TS=(); PY=()
for a in "${ARQS[@]}"; do
  [ -f "$a" ] || continue                      # apagado no diff
  case "$a" in
    supabase/functions/*/_shared_prod/*) ;;   # cópia antiga, a eliminar
    supabase/functions/*.ts|supabase/functions/*.tsx|tests/supabase/*.ts) TS+=("$a") ;;
    Kuib-Harness/*) ;;
    *.py) PY+=("$a") ;;
  esac
done

# Sem a ferramenta: falha (CI), ou só avisa com PULAR_SEM_FERRAMENTA=1 (pre-commit na máquina de quem não tem).
tem() { command -v "$1" >/dev/null 2>&1 && return 0
  if [ "${PULAR_SEM_FERRAMENTA:-0}" = 1 ]; then echo "aviso: $1 não instalado, lint pulado"; return 1; fi
  echo "erro: $1 não instalado"; rc=1; return 1; }
rc=0
if [ "${#TS[@]}" -gt 0 ] && tem deno; then
  echo "deno lint (${#TS[@]} arquivo(s))"
  deno lint --rules-exclude="$DENO_EXCLUIR" -- "${TS[@]}" || rc=1
fi
if [ "${#PY[@]}" -gt 0 ] && tem ruff; then
  echo "ruff check (${#PY[@]} arquivo(s))"
  ruff check --force-exclude -- "${PY[@]}" || rc=1
fi
[ "${#TS[@]}" -eq 0 ] && [ "${#PY[@]}" -eq 0 ] && echo "nenhum .ts/.py para lint"
exit "$rc"

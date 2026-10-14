#!/usr/bin/env bash
# Guarda as migrations NOVAS do PR (git diff contra a base). Só lê git e arquivos: sem banco, Docker ou rede.
#  1. FALHA: arquivo novo em supabase/migrations/ com nome fora de <AAAAMMDDHHMMSS>_<assunto>.sql (minúsculas, _).
#     Arquivos já existentes não são olhados: os de 12 dígitos antigos continuam válidos.
#  2. ALERTA (não falha): conteúdo que costuma ser de teste/stub e não de migration. Pode ser legítimo; revisar.
# Uso: scripts/ci/guard-migrations.sh [base_git]   (padrão: origin/main)
# Sai com 0 se só houver alerta; 1 se houver nome inválido; 2 se a base não existir.
set -uo pipefail

BASE="${1:-origin/main}"
RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ"

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "guard-migrations: base '$BASE' não encontrada (rode git fetch ou informe outra base)."; exit 2
fi
if ! NOVAS=$(git diff --name-only --diff-filter=A "$BASE"...HEAD -- 'supabase/migrations/*'); then
  echo "guard-migrations: git diff contra '$BASE' falhou."; exit 2
fi
[ -z "$NOVAS" ] && { echo "guard-migrations: nenhuma migration nova vs $BASE."; exit 0; }

REGEX='^supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql$'
falhas=0
# Padrões de conteúdo típicos de stub ou check (não de migration). Case-insensitive, extended regex.
PADROES=(
  'create[[:space:]]+schema[[:space:]]+(auth|storage)([[:space:];]|$)'
  'create[[:space:]]+role[[:space:]]+(anon|authenticated|service_role|authenticator)([[:space:];]|$)'
  'create[[:space:]]+(or[[:space:]]+replace[[:space:]]+)?function[[:space:]]+(auth|storage)\.'
  'set[[:space:]]+(local[[:space:]]+)?role[[:space:]]'
  'request\.jwt\.claim'
  'set_config[[:space:]]*\([[:space:]]*.request\.'
  'raise[[:space:]]+exception'
)

while IFS= read -r arq; do
  [ -z "$arq" ] && continue
  if [[ ! "$arq" =~ $REGEX ]]; then
    echo "FALHA  nome fora do padrão <AAAAMMDDHHMMSS>_<assunto>.sql: $arq"
    falhas=$((falhas + 1))
    continue
  fi
  [ -f "$arq" ] || continue
  for p in "${PADROES[@]}"; do
    if grep -q -i -E -- "$p" "$arq"; then
      echo "ALERTA $arq: padrão de teste/stub '$p' (revisar; pode ser legítimo)"
    fi
  done
done <<< "$NOVAS"

if [ "$falhas" -gt 0 ]; then echo "guard-migrations: $falhas nome(s) inválido(s)."; exit 1; fi
echo "guard-migrations: nomes OK ($(wc -w <<<"$NOVAS") migration(s) nova(s))."
exit 0

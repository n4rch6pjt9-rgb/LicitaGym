#!/usr/bin/env bash
# Guarda as migrations NOVAS do PR (git diff contra a base). Só lê git e arquivos: sem banco, Docker ou rede.
#  1. FALHA: arquivo novo ou renomeado em supabase/migrations/ com nome fora de <AAAAMMDDHHMMSS>_<assunto>.sql
#     (minúsculas, _).
#     Arquivos já existentes não são olhados: os de 12 dígitos antigos continuam válidos.
#  2. FALHA: versão (prefixo numérico) da migration nova repetida em outro arquivo de supabase/migrations/.
#     A integração Supabase grava a versão em schema_migrations com chave única: a segunda é recusada no merge
#     (caso #469 x #470, versão 20261108130000).
#  3. FALHA: versão da migration nova menor ou igual à maior versão já na base. A integração não aplica migration
#     inserida antes da última aplicada. Versões antigas de 12 dígitos (AAAAMMDDHHMM) valem como ...00.
#     Rode de novo depois de atualizar a base: dois PRs abertos ao mesmo tempo só colidem depois do primeiro merge.
#  4. ALERTA (não falha): conteúdo que costuma ser de teste/stub e não de migration. Pode ser legítimo; revisar.
# Uso: scripts/ci/guard-migrations.sh [base_git]   (padrão: origin/main)
# Sai com 0 se só houver alerta; 1 se houver nome, versão repetida ou fora de ordem; 2 se a base não existir.
set -uo pipefail

BASE="${1:-origin/main}"
RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ"

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "guard-migrations: base '$BASE' não encontrada (rode git fetch ou informe outra base)."; exit 2
fi
# A (adicionada) e R (renomeada): com --name-only o rename sai só pelo caminho de destino, que é o que se valida.
if ! NOVAS=$(git diff --name-only --diff-filter=AR "$BASE"...HEAD -- 'supabase/migrations/*'); then
  echo "guard-migrations: git diff contra '$BASE' falhou."; exit 2
fi
[ -z "$NOVAS" ] && { echo "guard-migrations: nenhuma migration nova vs $BASE."; exit 0; }

REGEX='^supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql$'
falhas=0

# Versão de um caminho: dígitos antes do primeiro "_", com 12 dígitos completados para 14.
versao() {
  local v="${1##*/}"; v="${v%%_*}"
  [[ "$v" =~ ^[0-9]+$ ]] || return 1
  [ "${#v}" -eq 12 ] && v="${v}00"
  printf '%s\n' "$v"
}
# Versões dos arquivos de migration na base (árvore git) e no HEAD (disco).
versoes_base() {
  git ls-tree --name-only "$BASE" supabase/migrations/ | while IFS= read -r f; do
    [[ "${f##*/}" =~ ^[0-9]+_.*\.sql$ ]] && versao "$f"
  done
}
versoes_head() {
  for f in supabase/migrations/*.sql; do
    [[ "${f##*/}" =~ ^[0-9]+_.*\.sql$ ]] && versao "$f"
  done
}
MAX_BASE=$(versoes_base | sort | tail -n 1)
VERSOES_HEAD=$(versoes_head)
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
  v=$(versao "$arq")
  repetidas=$(grep -c -x -- "$v" <<<"$VERSOES_HEAD")
  if [ "$repetidas" -gt 1 ]; then
    echo "FALHA  versão $v repetida em supabase/migrations/ ($repetidas arquivos): $arq"
    falhas=$((falhas + 1))
  fi
  if [ -n "$MAX_BASE" ] && [[ ! "$v" > "$MAX_BASE" ]]; then
    echo "FALHA  versão $v não é maior que a última da base ($MAX_BASE): $arq (renomeie para depois dela)"
    falhas=$((falhas + 1))
  fi
  for p in "${PADROES[@]}"; do
    if grep -q -i -E -- "$p" "$arq"; then
      echo "ALERTA $arq: padrão de teste/stub '$p' (revisar; pode ser legítimo)"
    fi
  done
done <<< "$NOVAS"

if [ "$falhas" -gt 0 ]; then echo "guard-migrations: $falhas falha(s) de nome, versão repetida ou ordem."; exit 1; fi
echo "guard-migrations: nomes, versões e ordem OK ($(wc -w <<<"$NOVAS") migration(s) nova(s))."
exit 0

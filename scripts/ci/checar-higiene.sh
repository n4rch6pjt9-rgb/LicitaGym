#!/usr/bin/env bash
# Higiene do repositório: barra o que fez o repo crescer desordenado (nov/2026).
#   1. marcador de conflito de merge (<<<<<<< / >>>>>>>, e ======= fora de markdown/texto) em arquivo alterado
#   2. segredo no conteúdo: JWT (eyJ...), token sbp_, chave privada PEM, JSON de conta de serviço
#   3. arquivo NOVO de tipo proibido (sem diferenciar maiúsculas): log, HAR, zip/tar/gz/7z/rar, chave (pem, key,
#      p12, pfx), sqlite3, *_resultado.json, .env e variantes (exceto .env.example), CSV fora de tests/**/fixtures/
#   4. arquivo ou pasta NOVA na raiz fora de scripts/ci/raiz-permitida.txt
# Entrada: saída NUL-separada de --name-status -z (STATUS\0caminho\0, e R/C com dois caminhos).
#   pre-commit: git diff --cached --name-status -z --diff-filter=ACMR | HIGIENE_STAGED=1 scripts/ci/checar-higiene.sh -
#   CI:         git diff --name-status -z --diff-filter=ACMR BASE HEAD | scripts/ci/checar-higiene.sh -
#   CI, cada commit do PR (só o tipo do arquivo, pega o que foi adicionado e apagado depois):
#               git log --format= --name-status -z --diff-filter=AR BASE..HEAD | HIGIENE_SO_TIPO=1 scripts/ci/checar-higiene.sh -
# Conteúdo: HIGIENE_STAGED=1 lê o índice; senão lê a revisão HIGIENE_REV (padrão HEAD), nunca o disco.
# Raiz nova legítima: acrescente o nome em scripts/ci/raiz-permitida.txt no mesmo PR.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

[ "${1:-}" = "-" ] || { echo "uso: ... | $0 -" >&2; exit 2; }
REV="${HIGIENE_REV:-HEAD}"
SO_TIPO="${HIGIENE_SO_TIPO:-0}"

conteudo() {
  if [ "${HIGIENE_STAGED:-0}" = 1 ]; then git show ":$1" 2>/dev/null; else git show "$REV:$1" 2>/dev/null; fi
}
lista_raiz() { { conteudo scripts/ci/raiz-permitida.txt || cat scripts/ci/raiz-permitida.txt; } | sed 's/\r$//' | sed '/^$/d'; }
mapfile -t RAIZ < <(lista_raiz)

rc=0
declare -A VISTO=()
erro() { [ -n "${VISTO[$1]:-}" ] && return; VISTO[$1]=1; echo "higiene: $1"; rc=1; }

RE_SEGREDO='eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|sbp_[0-9a-f]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|"type": *"service_account"'

while IFS= read -r -d '' status; do
  [ -n "$status" ] || continue
  IFS= read -r -d '' caminho || break
  # Renomeação/cópia: STATUS\0antigo\0novo. Vale o novo, tratado como arquivo novo.
  case "$status" in R*|C*) IFS= read -r -d '' caminho || break; status=A ;; esac
  status="${status:0:1}"
  nome="${caminho##*/}"; nome_min="${nome,,}"

  if [ "$SO_TIPO" != 1 ] && [ "$status" != D ]; then
    # 1. Conflito de merge (grep -I ignora binário; o conteúdo vai direto no pipe para não perder o NUL).
    padrao='^(<<<<<<< |>>>>>>> )'
    case "$nome_min" in *.md|*.mdx|*.mdc|*.markdown|*.rst|*.txt|*.adoc) ;; *) padrao='^(<<<<<<< |>>>>>>> |=======\r?$)' ;; esac
    linha=$(conteudo "$caminho" | grep -IEn -m1 "$padrao")
    [ -n "$linha" ] && erro "marcador de conflito em $caminho:${linha%%:*}"
    # 2. Segredo no conteúdo.
    linha=$(conteudo "$caminho" | grep -IEn -m1 "$RE_SEGREDO")
    [ -n "$linha" ] && erro "possível segredo em $caminho:${linha%%:*} (token, JWT ou chave privada; troque o segredo se já foi enviado)"
  fi

  [ "$status" = A ] || continue

  # 3. Tipos proibidos em arquivo novo.
  case "$nome_min" in
    .env.example) ;;
    *.log|*.har|*.har.*|*.zip|*.tgz|*.tar|*.tar.*|*.gz|*.7z|*.rar|*.pem|*.key|*.p12|*.pfx|*.sqlite3|*_resultado.json|.env|.env.*|*.env|.envrc)
      erro "arquivo proibido no repositório: $caminho (log, HAR, compactado, chave, banco local, dump de coleta ou .env)" ;;
    *.csv)
      case "$caminho" in tests/fixtures/*|tests/*/fixtures/*|services/*/tests/fixtures/*|services/*/tests/*/fixtures/*) ;;
        *) erro "CSV fora de tests/**/fixtures/: $caminho (dado de coleta não se versiona)" ;; esac ;;
  esac

  # 4. Raiz: só nomes da lista.
  [ "$SO_TIPO" = 1 ] && continue
  topo="${caminho%%/*}"
  permitido=0
  for r in "${RAIZ[@]}"; do [ "$r" = "$topo" ] && { permitido=1; break; }; done
  [ "$permitido" = 1 ] || erro "novo item na raiz: $topo (mova para scripts/, docs/ etc. ou inclua em scripts/ci/raiz-permitida.txt)"
done

[ "$rc" -eq 0 ] && echo "higiene: ok"
exit "$rc"

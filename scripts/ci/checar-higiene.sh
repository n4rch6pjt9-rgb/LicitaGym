#!/usr/bin/env bash
# Higiene do repositório: barra o que fez o repo crescer desordenado (nov/2026).
#   1. marcador de conflito de merge (<<<<<<< / >>>>>>>, e ======= fora de .md) em arquivo alterado
#   2. arquivo NOVO proibido: *.log, *.har, *.zip, *.tgz, *.tar, *_resultado.json, .env (exceto .env.example),
#      *.csv fora de tests/**/fixtures/
#   3. arquivo ou pasta NOVA na raiz fora de scripts/ci/raiz-permitida.txt
# Uso: git -c core.quotePath=false diff --name-status --diff-filter=ACMR BASE HEAD | scripts/ci/checar-higiene.sh -
#      git -c core.quotePath=false diff --cached --name-status --diff-filter=ACMR | HIGIENE_STAGED=1 scripts/ci/checar-higiene.sh -
# Entrada: linhas "STATUS<TAB>caminho" (formato --name-status). HIGIENE_STAGED=1 lê o conteúdo do índice.
# Raiz nova legítima: acrescente o nome em scripts/ci/raiz-permitida.txt no mesmo PR.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

[ "${1:-}" = "-" ] || { echo "uso: ... | $0 -" >&2; exit 2; }
mapfile -t RAIZ < <(sed 's/\r$//' scripts/ci/raiz-permitida.txt | sed '/^$/d')
rc=0
erro() { echo "higiene: $1"; rc=1; }

conteudo() {
  if [ "${HIGIENE_STAGED:-0}" = 1 ]; then git show ":$1" 2>/dev/null; else cat -- "$1" 2>/dev/null; fi
}

while IFS=$'\t' read -r status caminho resto; do
  caminho="${caminho%$'\r'}"; resto="${resto%$'\r'}"   # entrada com CRLF (Windows)
  [ -n "${caminho:-}" ] || continue
  # Renomeação/cópia (R100<TAB>antigo<TAB>novo): vale o novo caminho, tratado como arquivo novo.
  case "$status" in R*|C*) caminho="${resto:-$caminho}"; status=A ;; esac
  status="${status:0:1}"

  # 1. Marcadores de conflito (ignora binário: grep -I).
  if [ "$status" != D ]; then
    padrao='^(<<<<<<< |>>>>>>> )'
    case "$caminho" in *.md|*.rst|*.txt) ;; *) padrao='^(<<<<<<< |>>>>>>> |=======$)' ;; esac
    linha=$(conteudo "$caminho" | grep -IEn "$padrao" | head -1)
    [ -n "$linha" ] && erro "marcador de conflito em $caminho:${linha%%:*}"
  fi

  [ "$status" = A ] || continue

  # 2. Tipos proibidos em arquivo novo.
  nome="${caminho##*/}"
  case "$nome" in
    .env.example) ;;
    *.log|*.har|*.zip|*.tgz|*.tar|*_resultado.json|.env|.env.*)
      erro "arquivo proibido no repositório: $caminho (log, HAR, zip, dump de coleta ou .env)" ;;
    *.csv)
      case "$caminho" in tests/fixtures/*|tests/*/fixtures/*|services/*/tests/fixtures/*|services/*/tests/*/fixtures/*) ;;
        *) erro "CSV fora de tests/**/fixtures/: $caminho (dado de coleta não se versiona)" ;; esac ;;
  esac

  # 3. Raiz: só nomes da lista.
  topo="${caminho%%/*}"
  permitido=0
  for r in "${RAIZ[@]}"; do [ "$r" = "$topo" ] && { permitido=1; break; }; done
  [ "$permitido" = 1 ] || erro "novo item na raiz: $topo (mova para scripts/, docs/ etc. ou inclua em scripts/ci/raiz-permitida.txt)"
done

[ "$rc" -eq 0 ] && echo "higiene: ok"
exit "$rc"

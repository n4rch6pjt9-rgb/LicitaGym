#!/usr/bin/env bash
# Alerta operacional: consulta a saúde (api-saude + readiness + Dashboard) e abre/atualiza/fecha UMA issue com o rótulo
# alerta-operacional. Comenta só quando o conjunto de verificações críticas muda (sem spam a cada 30 min).
# Usado por .github/workflows/saude.yml. Teste local sem GitHub: DRY_RUN=1 SAUDE_JSON=arquivo.json scripts/saude-alerta.sh
#
# Entradas (env):
#   SUPABASE_PROJECT  ref do projeto (padrão ifaiagegyicjzlpskafh)
#   SAUDE_TOKEN       SYNC_CRON_SECRET (Bearer da api-saude)            — obrigatório sem SAUDE_JSON
#   SAUDE_APIKEY      chave publishable (header apikey). Sem ela o gateway responde 500
#                     apikey.authorization.error=invalid e a função nem executa.
#   DASHBOARD_URL     padrão https://licitagym-dashboard.licitagym.workers.dev
#   SAUDE_JSON        arquivo com a resposta da api-saude (pula as chamadas HTTP; para teste)
#   DRY_RUN=1         só imprime o que faria no GitHub
set -euo pipefail

PROJ="${SUPABASE_PROJECT:-ifaiagegyicjzlpskafh}"
FN="https://${PROJ}.supabase.co/functions/v1"
DASH="${DASHBOARD_URL:-https://licitagym-dashboard.licitagym.workers.dev}"
ROTULO="alerta-operacional"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CRIT="$TMP/criticos.tsv"; : > "$CRIT"          # verificacao<TAB>mensagem
TAB="$TMP/tabela.md"

if [ -n "${SAUDE_JSON:-}" ]; then
  cp "$SAUDE_JSON" "$TMP/saude.json"; HTTP_SAUDE=200; HTTP_READY="${HTTP_READY:-200}"; HTTP_DASH="${HTTP_DASH:-200}"
else
  : "${SAUDE_TOKEN:?SAUDE_TOKEN (SYNC_CRON_SECRET) não configurado}"
  : "${SAUDE_APIKEY:?SAUDE_APIKEY (chave publishable, header apikey) não configurada}"
  HTTP_SAUDE=$(curl -s -m 60 -o "$TMP/saude.json" -w '%{http_code}' -X POST "$FN/api-saude" \
    -H "apikey: ${SAUDE_APIKEY}" -H "Authorization: Bearer ${SAUDE_TOKEN}" -H 'Content-Type: application/json' -d '{"action":"resumo"}' || echo 000)
  HTTP_READY=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    -H "apikey: ${SAUDE_APIKEY}" "$FN/api-dashboard-oportunidades?action=readiness" || echo 000)
  HTTP_DASH=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$DASH/" || echo 000)
fi

[ "$HTTP_SAUDE" = 200 ] || printf 'api_saude_http\tapi-saude respondeu HTTP %s\n' "$HTTP_SAUDE" >> "$CRIT"
[ "$HTTP_READY" = 200 ] || printf 'readiness_api\tapi-dashboard-oportunidades readiness respondeu HTTP %s\n' "$HTTP_READY" >> "$CRIT"
[ "$HTTP_DASH" = 200 ] || printf 'dashboard_http\tDashboard respondeu HTTP %s\n' "$HTTP_DASH" >> "$CRIT"

{
  echo "| Verificação | Status | Mensagem |"; echo "|---|---|---|"
  echo "| HTTP api-saude / readiness / Dashboard | $HTTP_SAUDE / $HTTP_READY / $HTTP_DASH | |"
  if [ "$HTTP_SAUDE" = 200 ]; then
    jq -r '.verificacoes[] | "| `\(.verificacao)` | \(if .status=="critico" then "🔴 crítico" elif .status=="atencao" then "🟡 atenção" else "🟢 ok" end) | \(.mensagem) |"' "$TMP/saude.json"
  fi
} > "$TAB"
if [ "$HTTP_SAUDE" = 200 ]; then
  jq -r '.verificacoes[] | select(.status=="critico") | "\(.verificacao)\t\(.mensagem)"' "$TMP/saude.json" >> "$CRIT"
fi

FP="$(cut -f1 "$CRIT" | sort -u | paste -sd, -)"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "## Saúde operacional"; echo; echo "Críticos: ${FP:-nenhum}"; echo; cat "$TAB"; } >> "$GITHUB_STEP_SUMMARY"
echo "críticos: ${FP:-nenhum}"

gh_() { if [ "${DRY_RUN:-}" = 1 ]; then echo "DRY_RUN gh $*"; else gh "$@"; fi; }
ABERTA=""
if [ "${DRY_RUN:-}" != 1 ]; then
  ABERTA=$(gh issue list --label "$ROTULO" --state open --json number,body -q '.[0] | select(.) | "\(.number)\t\(.body)"' | head -c 100000 || true)
else
  ABERTA="${DRY_ISSUE:-}"
fi
NUM="$(cut -f1 <<<"$ABERTA" | head -1)"
FP_ANTIGO="$(grep -o 'fp:[^ ]*' <<<"$ABERTA" | head -1 | cut -d: -f2 || true)"

corpo() {
  echo "Gerado por \`.github/workflows/saude.yml\` em $(date -u +'%Y-%m-%d %H:%M UTC'). Limiares em \`private.saude_limiares\`."
  echo; echo "**Críticos:**"; sed 's/^\([^\t]*\)\t/- `\1`: /' "$CRIT"; echo; cat "$TAB"
  echo; echo "<!-- fp:${FP} -->"
}

if [ -n "$FP" ]; then
  if [ -z "$NUM" ]; then
    gh_ label create "$ROTULO" --color B60205 --description "Saúde operacional crítica (saude.yml)" --force
    gh_ issue create --title "Alerta operacional: ${FP}" --label "$ROTULO" --body "$(corpo)"
  else
    gh_ issue edit "$NUM" --title "Alerta operacional: ${FP}" --body "$(corpo)"
    if [ "$FP" != "$FP_ANTIGO" ]; then
      gh_ issue comment "$NUM" --body "Mudou o conjunto de críticos: \`${FP_ANTIGO:-nenhum}\` → \`${FP}\`."
    fi
  fi
elif [ -n "$NUM" ]; then
  gh_ issue close "$NUM" --comment "Normalizado em $(date -u +'%Y-%m-%d %H:%M UTC'): nenhuma verificação crítica."
fi

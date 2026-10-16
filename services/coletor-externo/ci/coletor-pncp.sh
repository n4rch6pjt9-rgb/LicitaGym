#!/usr/bin/env bash
# Etapas do workflow .github/workflows/coletor-pncp.yml (#357). Fica fora do YAML para ter teste
# (tests/test_ci_coletor_pncp.py).
#   coletor-pncp.sh etapas MODO   JSON com as etapas do modo (matriz do workflow); modo desconhecido sai com 2
#   coletor-pncp.sh rodar ETAPA   roda `python3 -m coletor.pncp` da etapa e devolve o código de saída dele
#                                 (env: ORIGEM obrigatória; DRY_RUN e RAPIDO = "true" ou não; PYTHON, padrão python3;
#                                 LIMITE_ETAPA, padrão 330m: passou do limite, sai com 124 = falha, não cancelamento)
set -euo pipefail

case "${1:-}" in
  etapas)
    case "${2:-}" in
      todos) echo '["leads","monitorar","recoleta"]' ;;
      leads | monitorar | historico | recoleta) echo "[\"$2\"]" ;;
      *) echo "modo desconhecido: ${2:-}" >&2; exit 2 ;;
    esac
    ;;
  rodar)
    dry=(); [ "${DRY_RUN:-false}" = "true" ] && dry=(--dry-run)
    termos=(); [ "${RAPIDO:-false}" = "true" ] && termos=(--termos-padrao)   # só na busca por termos
    case "${2:-}" in
      leads) args=("${termos[@]}") ;;
      monitorar) args=(--modo monitorar "${termos[@]}") ;;
      historico) args=(--modo historico "${termos[@]}") ;;
      recoleta) args=(--recoletar-atualizadas --limite-recoleta 200) ;;
      *) echo "etapa desconhecida: ${2:-}" >&2; exit 2 ;;
    esac
    echo "== coletor.pncp ${args[*]}"
    # O limite fica aqui, abaixo do timeout-minutes do job: job que estoura o timeout termina como "cancelled", e uma
    # perna cancelada pode levar as seguintes da matriz junto; com `timeout` a etapa termina como falha comum.
    exec timeout --kill-after=2m "${LIMITE_ETAPA:-330m}" "${PYTHON:-python3}" -m coletor.pncp "${args[@]}" --origem "${ORIGEM:?ORIGEM ausente}" "${dry[@]}"
    ;;
  *) echo "uso: $0 etapas MODO | rodar ETAPA" >&2; exit 2 ;;
esac

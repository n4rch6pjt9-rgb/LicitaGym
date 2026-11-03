#!/usr/bin/env bash
# Etapas do workflow .github/workflows/coletor-precos.yml (spec 0009 + spec 0031). Fica fora do YAML para ter teste
# (tests/test_ci_coletor_precos.py).
#   coletor-precos.sh etapas MODO   JSON com as etapas do modo (matriz do workflow); modo desconhecido sai com 2
#   coletor-precos.sh rodar ETAPA   roda o coletor da etapa e devolve o código de saída dele
#                                   (env: DRY_RUN = "true" ou não; LIMITE opcional; DELAY_SEGUNDOS, padrão 1.5;
#                                   PYTHON, padrão python3; LIMITE_ETAPA, padrão 180m: passou do limite, sai com 124)
set -euo pipefail

case "${1:-}" in
  etapas)
    case "${2:-}" in
      todos) echo '["catalogo","detalhe","contratacao"]' ;;
      catalogo | detalhe | contratacao) echo "[\"$2\"]" ;;
      *) echo "modo desconhecido: ${2:-}" >&2; exit 2 ;;
    esac
    ;;
  rodar)
    delay="${DELAY_SEGUNDOS:-1.5}"
    comuns=(--delay "${delay}")
    [ "${DRY_RUN:-false}" = "true" ] && comuns+=(--dry-run)
    [ -n "${LIMITE:-}" ] && comuns+=(--limite "${LIMITE}")
    case "${2:-}" in
      catalogo) modulo="coletor.compras_precos"; args=(--modo catalogo "${comuns[@]}") ;;
      detalhe) modulo="coletor.compras_precos"; args=(--modo detalhe "${comuns[@]}") ;;
      contratacao) modulo="coletor.compras_itens_contratacao"; args=("${comuns[@]}") ;;
      *) echo "etapa desconhecida: ${2:-}" >&2; exit 2 ;;
    esac
    echo "== ${modulo} ${args[*]}"
    # O limite fica aqui, abaixo do timeout-minutes do job: job que estoura o timeout termina como "cancelled", e uma
    # perna cancelada pode levar as seguintes da matriz junto; com `timeout` a etapa termina como falha comum.
    exec timeout --kill-after=2m "${LIMITE_ETAPA:-180m}" "${PYTHON:-python3}" -m "${modulo}" "${args[@]}"
    ;;
  *) echo "uso: $0 etapas MODO | rodar ETAPA" >&2; exit 2 ;;
esac

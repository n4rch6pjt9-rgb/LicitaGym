"""Entrypoint do coletor PNCP no Cloud Run Job (uma execução = N tasks, uma por lote).

O Cloud Run injeta CLOUD_RUN_TASK_INDEX (0..N-1) e CLOUD_RUN_TASK_COUNT (N) em cada task; aqui isso vira
`--lote (INDEX+1)/COUNT` e o resto dos argumentos vai direto para `coletor.pncp`. Com --parallelism=1 as
tasks rodam uma de cada vez (o PNCP aguenta ~1 req/s no total) e a task que falha é repetida sozinha,
com o mesmo lote (fatiar_lote é determinístico e os upserts são idempotentes).

  python -m coletor.pncp_cloud_run                     # task 2 de 4 -> python -m coletor.pncp --lote 3/4
  python -m coletor.pncp_cloud_run --modo monitorar    # argumentos extras passam adiante

Fora do Cloud Run (sem as variáveis) roda como 1/1, isto é, a lista inteira.
"""
from __future__ import annotations

import logging
import os
import sys

from . import pncp

log = logging.getLogger("pncp.cloud_run")


def lote_da_task(ambiente: dict[str, str] | None = None) -> str:
    """'K/N' a partir de CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT (0-based -> 1-based)."""
    ambiente = os.environ if ambiente is None else ambiente
    try:
        idx = int(ambiente.get("CLOUD_RUN_TASK_INDEX", "0"))
        total = int(ambiente.get("CLOUD_RUN_TASK_COUNT", "1"))
    except ValueError as e:
        raise ValueError(f"CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT inválidos: {e}") from e
    if total < 1 or not 0 <= idx < total:
        raise ValueError(f"task {idx} fora de 0..{total - 1}")
    return f"{idx + 1}/{total}"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    lote = lote_da_task()
    # Lê as opções com o próprio parser do coletor: abreviações aceitas pelo argparse (--lot, --baixar-p,
    # --corrigir) chegam aqui já resolvidas, então as travas não dependem do texto exato do argumento.
    opcoes = pncp.criar_parser().parse_args(argv)
    if opcoes.lote is not None:
        raise SystemExit("--lote vem de CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT; não passe --lote aqui")
    # Estes modos ignoram --lote e percorrem a tabela inteira: com várias tasks, cada uma repetiria tudo.
    modos_inteiros = [nome for nome, ligado in (("--baixar-pendentes", opcoes.baixar_pendentes),
                                                 ("--corrigir-processos", opcoes.corrigir_processos)) if ligado]
    if modos_inteiros and int(lote.split("/")[1]) > 1:
        raise SystemExit(f"{', '.join(modos_inteiros)} não divide em lotes: use um job com --tasks=1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("Cloud Run: execução %s, task %s (tentativa %s) -> --lote %s",
             os.environ.get("CLOUD_RUN_EXECUTION", "-"), os.environ.get("CLOUD_RUN_TASK_INDEX", "-"),
             os.environ.get("CLOUD_RUN_TASK_ATTEMPT", "-"), lote)
    return pncp.main(["--lote", lote, *argv])


if __name__ == "__main__":
    sys.exit(main())

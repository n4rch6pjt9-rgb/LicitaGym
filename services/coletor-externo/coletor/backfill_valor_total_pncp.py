"""Backfill de licitacoes_externas.valor_total nas compras PNCP gravadas sem valor.

Até esta correção o coletor gravava valor_total a partir de valor_global da busca, que o PNCP deixa
vazio em editais. O valor real está no detalhe da compra (valorTotalEstimado,
/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}). Este script relê o detalhe das linhas PNCP com
valor_total IS NULL e grava SÓ a coluna valor_total, e só quando o detalhe traz valor (> 0).

Padrão: DRY-RUN (consulta o PNCP, mostra contagem e amostra, não grava nada). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.backfill_valor_total_pncp --limit 20            # dry-run
  python -m coletor.backfill_valor_total_pncp --apply               # grava
Usa o cliente PNCP do coletor (espera DELAY_SEGUNDOS entre chamadas, backoff em 429/5xx,
timeout curto do detalhe). Falha de consulta não grava nada; rodar de novo retoma o que faltou.
"""
from __future__ import annotations

import argparse
import logging
import sys

from .destino import Supabase, env
from .pncp import PNCP, compra_de_codigo, valor_total_detalhe

log = logging.getLogger("coletor.backfill_valor_total_pncp")


def backfill(pncp, sb, *, aplicar: bool = False, limite: int | None = None, amostra: int = 10) -> dict:
    """Retorna o resumo; em dry-run (aplicar=False) nunca chama sb.atualizar."""
    filtros = {"select": "id,codigo_externo", "fonte": "eq.pncp", "valor_total": "is.null", "order": "id"}
    if limite:
        filtros["limit"] = str(limite)
    linhas = sb.selecionar("licitacoes_externas", **filtros)
    r = {"lidas": len(linhas), "com_valor": 0, "gravadas": 0, "sem_valor": 0,
         "codigo_invalido": 0, "falha_consulta": 0, "amostra": []}
    for ln in linhas:
        c = compra_de_codigo(ln.get("codigo_externo"))
        if not c:
            r["codigo_invalido"] += 1
            continue
        try:
            det = pncp.compra(c)
        except Exception as e:
            r["falha_consulta"] += 1
            log.warning("  %s: consulta falhou, nada gravado: %s", ln["codigo_externo"], str(e)[:120])
            continue
        valor = valor_total_detalhe(det)
        if valor is None:
            r["sem_valor"] += 1
            continue
        r["com_valor"] += 1
        if len(r["amostra"]) < amostra:
            r["amostra"].append((ln["id"], ln["codigo_externo"], valor))
        if aplicar:
            try:
                sb.atualizar("licitacoes_externas", ln["id"], {"valor_total": valor})
            except RuntimeError as e:
                if " 401 " in str(e) or " 403 " in str(e):
                    raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY.")
                raise
            r["gravadas"] += 1
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Backfill de valor_total (PNCP) a partir de valorTotalEstimado")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, não grava nada)")
    ap.add_argument("--limit", type=int, help="máximo de linhas a processar")
    ap.add_argument("--amostra", type=int, default=10, help="quantas linhas mostrar na amostra (padrão 10)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    pncp = PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5")))
    r = backfill(pncp, sb, aplicar=args.apply, limite=args.limit, amostra=args.amostra)
    for id_, codigo, valor in r.pop("amostra"):
        print(f"  #{id_} {codigo}: valor_total = {valor:,.2f}")
    log.info("RESUMO%s: %s", "" if args.apply else " (DRY-RUN, nada gravado; use --apply)", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

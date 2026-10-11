"""Backfill de licitacoes_externas.amparo_legal (e, pelo gatilho do banco, do regulamento) nas compras PNCP.

O coletor não guardava o amparoLegal do detalhe da compra (/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}), e
regulamento ficou nulo em todas as linhas (spec 0020). Este script relê o detalhe das linhas PNCP com amparo_legal
IS NULL e grava SÓ a coluna amparo_legal, e só quando o detalhe traz amparoLegal.nome. O regulamento é derivado no
banco (public.regulamento_do_amparo, gatilho licext_regulamento_amparo_trg); o resumo usa o espelho Python só para
mostrar a contagem por regulamento.

Padrão: DRY-RUN (consulta o PNCP, mostra contagem e amostra, não grava nada). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.backfill_regulamento_pncp --limit 20            # dry-run
  python -m coletor.backfill_regulamento_pncp --apply               # grava
Usa o cliente PNCP do coletor (espera DELAY_SEGUNDOS entre chamadas, padrão 1 s; backoff em 429/5xx com Retry-After;
timeout curto do detalhe). Falha de consulta não grava nada; rodar de novo retoma o que faltou.
"""
from __future__ import annotations

import argparse
import logging
import sys
from collections import Counter

from .destino import Supabase, env
from .pncp import PNCP, amparo_legal_detalhe, compra_de_codigo, regulamento_do_amparo

log = logging.getLogger("coletor.backfill_regulamento_pncp")


def backfill(pncp, sb, *, aplicar: bool = False, limite: int | None = None, amostra: int = 10) -> dict:
    """Retorna o resumo; em dry-run (aplicar=False) nunca chama sb.atualizar."""
    filtros = {"select": "id,codigo_externo", "fonte": "eq.pncp", "amparo_legal": "is.null", "order": "id"}
    if limite:
        filtros["limit"] = str(limite)
    linhas = sb.selecionar("licitacoes_externas", **filtros)
    r = {"lidas": len(linhas), "com_amparo": 0, "gravadas": 0, "sem_amparo": 0,
         "codigo_invalido": 0, "falha_consulta": 0, "por_regulamento": Counter(), "amostra": []}
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
        amparo = amparo_legal_detalhe(det)
        if amparo is None:
            r["sem_amparo"] += 1
            continue
        r["com_amparo"] += 1
        regulamento = regulamento_do_amparo(amparo["nome"])
        r["por_regulamento"][regulamento] += 1
        if len(r["amostra"]) < amostra:
            r["amostra"].append((ln["id"], ln["codigo_externo"], amparo["nome"], regulamento))
        if aplicar:
            try:
                sb.atualizar("licitacoes_externas", ln["id"], {"amparo_legal": amparo})
            except RuntimeError as e:
                if " 401 " in str(e) or " 403 " in str(e):
                    raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY.")
                raise
            r["gravadas"] += 1
    r["por_regulamento"] = dict(r["por_regulamento"])
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Backfill de amparo_legal/regulamento (PNCP) a partir do detalhe da compra")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, não grava nada)")
    ap.add_argument("--limit", type=int, help="máximo de linhas a processar")
    ap.add_argument("--amostra", type=int, default=10, help="quantas linhas mostrar na amostra (padrão 10)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    delay = float(env("DELAY_SEGUNDOS", "1.0"))
    if delay < 1:
        raise SystemExit("DELAY_SEGUNDOS precisa ser >= 1 (respeito ao PNCP).")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    r = backfill(PNCP(delay=delay), sb, aplicar=args.apply, limite=args.limit, amostra=args.amostra)
    for id_, codigo, nome, regulamento in r.pop("amostra"):
        print(f"  #{id_} {codigo}: {nome} -> {regulamento}")
    log.info("RESUMO%s: %s", "" if args.apply else " (DRY-RUN, nada gravado; use --apply)", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

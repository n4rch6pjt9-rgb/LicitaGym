"""Pergunta ao RAG de licitações pelo terminal.

    python -m coletor.buscar "Por que a Freedom Motors recorreu e qual foi a decisão?"
    python -m coletor.buscar --secao recurso "fundamentos usados em recursos"
"""
from __future__ import annotations

import argparse
import sys

from .destino import Supabase, env
from .ia import Gemini
from .indexador import vetor_pg


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pergunta")
    ap.add_argument("--secao", default=None)
    ap.add_argument("-k", type=int, default=8)
    args = ap.parse_args(argv)

    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    ia = Gemini()
    q = ia.embed([args.pergunta], tarefa="RETRIEVAL_QUERY")[0]
    trechos = sb.rpc("match_licitacao_chunks", {"query_embedding": vetor_pg(q), "match_count": args.k,
                                                "filtro_secao": args.secao, "filtro_fonte": None})
    if not trechos:
        print("Nenhum trecho encontrado. Rode o indexador primeiro.")
        return 1
    print("\n=== Trechos recuperados ===")
    for i, t in enumerate(trechos, 1):
        print(f"[{i}] {t['similaridade']:.3f} | {t['numero_processo']} | {t['secao']} | {t['nome_original']}")
    print("\n=== Resposta ===\n")
    print(ia.responder(args.pergunta, trechos))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Pergunta ao RAG de licitações pelo terminal.

    python -m coletor.buscar "Qual o prazo de entrega exigido no edital do PE 112/2025?"
    python -m coletor.buscar --secao processo "exigências de habilitação técnica"
    python -m coletor.buscar --incluir-partes "O que a Freedom Motors alegou no recurso?"

Usa public.match_licitacao_chunks_v2: nunca devolve chunks 'suspeito'/'bloqueado' e só devolve
'parte_interessada' (recurso, contrarrazões, proposta...) com --incluir-partes, que deve ser usado
apenas quando a pergunta é SOBRE a alegação de uma parte, nunca para perguntas de fato ou de norma.
"""
from __future__ import annotations

import argparse
import sys

from .destino import Supabase, env
from .ia import Gemini
from .indexador import vetor_pg

RPC_BUSCA = "match_licitacao_chunks_v2"


def parametros_busca(vetor: str, k: int, secao: str | None, incluir_partes: bool) -> dict:
    return {"query_embedding": vetor, "match_count": k, "filtro_secao": secao, "filtro_fonte": None,
            "incluir_partes_interessadas": incluir_partes}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pergunta")
    ap.add_argument("--secao", default=None)
    ap.add_argument("-k", type=int, default=8)
    ap.add_argument("--incluir-partes", action="store_true",
                    help="inclui recursos, contrarrazões e propostas (só para perguntas sobre a alegação)")
    args = ap.parse_args(argv)

    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    ia = Gemini()
    q = ia.embed([args.pergunta], tarefa="RETRIEVAL_QUERY")[0]
    trechos = sb.rpc(RPC_BUSCA, parametros_busca(vetor_pg(q), args.k, args.secao, args.incluir_partes))
    if not trechos:
        print("Nenhum trecho encontrado. Rode o indexador primeiro.")
        return 1
    print("\n=== Trechos recuperados ===")
    for i, t in enumerate(trechos, 1):
        print(f"[{i}] {t['similaridade']:.3f} | {t['numero_processo']} | {t['secao']} | "
              f"{t.get('nivel_confianca')} | {t['nome_original']}")
    print("\n=== Resposta ===\n")
    print(ia.responder(args.pergunta, trechos))
    return 0


if __name__ == "__main__":
    sys.exit(main())

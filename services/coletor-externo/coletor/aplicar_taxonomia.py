"""Aplica a taxonomia de 6 blocos (coletor/taxonomia.py) nos itens de licitação já coletados.

Grava em <tabela>.taxonomia (jsonb): blocos + plano +, quando aparelho_ou_fora,
no_taxonomia / metodo=regra / confianca / versao_taxonomia=0.3.

Uso (Cloud Shell, com ~/.licitagym.env carregado):
  python3 -m coletor.aplicar_taxonomia --dry-run --limite 20
  python3 -m coletor.aplicar_taxonomia                          # licitacao_itens, só os ainda sem taxonomia
  python3 -m coletor.aplicar_taxonomia --tabela contratacoes_itens
  python3 -m coletor.aplicar_taxonomia --refazer                # recalcula tudo (após mudar o parser)
"""
from __future__ import annotations

import argparse
import json

from .destino import Supabase, env
from .taxonomia import calcular_taxonomia

TABELAS = ("licitacao_itens", "contratacoes_itens")


def calcular(descricao: str, codigo_item=None, codigo_pdm=None, tipo_catmat: str | None = None) -> dict:
    return calcular_taxonomia(
        descricao or "",
        tipo_catmat=tipo_catmat,
        codigo_pdm=codigo_pdm,
        codigo_item=codigo_item,
    )


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tabela", choices=TABELAS, default="licitacao_itens")
    ap.add_argument("--limite", type=int, default=0, help="máximo de itens (0 = todos)")
    ap.add_argument("--lote", type=int, default=500)
    ap.add_argument("--refazer", action="store_true", help="recalcula também quem já tem taxonomia")
    ap.add_argument("--dry-run", action="store_true", help="só mostra o resultado, não grava")
    a = ap.parse_args(argv)

    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    feitos, vistos_ultimo = 0, None
    select = "id,descricao,catalogo_codigo_item" if a.tabela == "licitacao_itens" else "id,descricao"
    while True:
        filtros = {"select": select, "order": "id", "limit": str(a.lote)}
        if not a.refazer:
            filtros["taxonomia"] = "is.null"
        if vistos_ultimo is not None:
            filtros["id"] = f"gt.{vistos_ultimo}"
        try:
            linhas = sb.selecionar(a.tabela, **filtros)
        except Exception as e:  # coluna ainda não existe -> migration não rodou
            raise SystemExit(f"Falha ao ler {a.tabela}: {e}\n"
                             "Aplicou supabase/migrations/20260925100000_catmat_itens_taxonomia.sql?")
        if not linhas:
            break
        for ln in linhas:
            vistos_ultimo = ln["id"]
            tax = calcular(ln.get("descricao"), codigo_item=ln.get("catalogo_codigo_item"))
            if a.dry_run:
                p = {k: v for k, v in tax["plano"].items() if v is not None}
                print(f"#{ln['id']}: {(ln.get('descricao') or '')[:70]!r}\n    {json.dumps(p, ensure_ascii=False)[:300]}")
            else:
                sb.atualizar(a.tabela, ln["id"], {"taxonomia": tax})
            feitos += 1
            if a.limite and feitos >= a.limite:
                break
        print(f"  {feitos} itens processados…", flush=True)
        if a.limite and feitos >= a.limite:
            break
    print(f"Concluído: {feitos} itens de {a.tabela} {'(dry-run, nada gravado)' if a.dry_run else 'atualizados'}.")


if __name__ == "__main__":
    main()

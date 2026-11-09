"""Extrai o catálogo de produtos de um portal Paradigma (Sistema S) por categoria, com o código interno da entidade.

Usa o mesmo webservice público da tela Catálogo (CatalogoProdutos.aspx), pelo cliente de coletor/paradigma.py:
  PesquisarCatalogoProdutoClasses  acha a categoria (o autocomplete casa por prefixo; aqui o casamento é exato)
  PesquisarCatalogoProdutos        produtos da categoria, em faixas de até 100 (nPaginaDe/nPaginaAte), até página vazia

O código interno é `sCdProdutoEmpresa` (ex.: Sesc DN "310031041500001"). Só leitura, sem login; intervalo entre
chamadas pelo PortalParadigma (DELAY_SEGUNDOS >= 1), 429 respeita Retry-After e 401/403 encerram a coleta.

Uso (dentro de services/coletor-externo):
  python -m coletor.catalogo_paradigma --fonte sescdn --categorias "PT030;ES1205" --saida /caminho/fora/do/repo.csv

`--categorias` aceita o código ("PT030") ou o nome exato ("PT030 - EQUIP CONDICIONAMENTO FISICO"), separados por ';'.
A saída é dado de coleta: grave fora do repositório (não versionar CSV/JSON de coleta).
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable

from .destino import env
from .escopo import normalizar
from .paradigma import FONTES, TIPOS_CATALOGO, PortalParadigma, autorizado_para_coleta

log = logging.getLogger("catalogo_paradigma")

CAMPOS = ["codigo_sesc", "descricao", "tipo", "categoria", "id_categoria", "id_produto", "fonte"]


class CategoriaNaoEncontrada(LookupError):
    pass


def _codigo_da_classe(nome: str) -> str:
    """'PT030 - EQUIP CONDICIONAMENTO FISICO' -> 'PT030' (o portal prefixa o código antes de ' - ')."""
    return nome.split(" - ", 1)[0].strip().upper() if " - " in nome else ""


def resolver_categoria(portal: Any, termo: str) -> dict:
    """Categoria cujo código (antes de ' - ') ou nome inteiro é exatamente `termo`. Ausente: erro, nunca lista vazia."""
    termo = termo.strip()
    candidatas = portal._ws("PesquisarCatalogoProdutoClasses",
                            {"dtoProduto": {"sDsProduto": termo, "dtoIdioma": {"nCdIdioma": 1}}}) or []
    alvo = normalizar(termo).strip()
    for c in candidatas:
        nome = c.get("sDsClasse") or ""
        if normalizar(nome).strip() == alvo or _codigo_da_classe(nome) == termo.upper():
            return c
    nomes = ", ".join(c.get("sDsClasse") or "?" for c in candidatas[:10]) or "nenhuma"
    raise CategoriaNaoEncontrada(f"categoria {termo!r} não encontrada no catálogo (o portal sugeriu: {nomes})")


def _linha(p: dict, slug: str) -> dict:
    texto = lambda k: (str(p[k]).strip() or None) if p.get(k) is not None else None  # noqa: E731
    return {
        "codigo_sesc": texto("sCdProdutoEmpresa"),
        "descricao": texto("sDsProduto"),
        "tipo": texto("sDsProdutoTipo"),
        "categoria": texto("sDsClasse"),
        "id_categoria": p.get("nCdClasse"),
        "id_produto": p.get("nCdProduto"),
        "fonte": slug,
    }


def extrair(portal: Any, categorias: Iterable[str], tipo: str = "todos") -> list[dict]:
    """Produtos das categorias, na ordem do portal, sem repetir `nCdProduto` (o mesmo produto em duas faixas)."""
    vistos: set[Any] = set()
    out: list[dict] = []
    for termo in categorias:
        classe = resolver_categoria(portal, termo)
        produtos = portal.catalogo(classe, tipo)
        novos = 0
        for p in produtos:
            chave = p.get("nCdProduto") if p.get("nCdProduto") is not None else (p.get("sCdProdutoEmpresa"), p.get("sDsProduto"))
            if chave in vistos:
                continue
            vistos.add(chave)
            out.append(_linha(p, portal.fonte.slug))
            novos += 1
        log.info("categoria %s (id %s): %d produtos, %d novos", classe.get("sDsClasse"), classe.get("nCdClasse"),
                 len(produtos), novos)
    return out


def gravar(linhas: list[dict], destino: Path) -> None:
    """CSV (';', UTF-8 com BOM, abre direto no Excel) ou JSON, pela extensão."""
    destino = Path(destino)
    if destino.suffix.lower() == ".csv":
        with destino.open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=CAMPOS, delimiter=";")
            w.writeheader()
            w.writerows(linhas)
    elif destino.suffix.lower() == ".json":
        destino.write_text(json.dumps(linhas, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        raise ValueError(f"extensão {destino.suffix!r} não suportada: use .csv ou .json")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--fonte", required=True, choices=sorted(FONTES))
    ap.add_argument("--categorias", required=True, help="códigos ou nomes exatos, separados por ';' (ex.: PT030;ES1205)")
    ap.add_argument("--tipo", choices=sorted(TIPOS_CATALOGO), default="todos", help="filtro Tipo do catálogo")
    ap.add_argument("--saida", required=True, help="arquivo .csv ou .json (fora do repositório)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    fonte = FONTES[args.fonte]
    portal = PortalParadigma(fonte, delay=float(env("DELAY_SEGUNDOS", "1.5")), autorizado=autorizado_para_coleta(fonte))
    categorias = [c.strip() for c in args.categorias.split(";") if c.strip()]
    try:
        linhas = extrair(portal, categorias, args.tipo)
    except CategoriaNaoEncontrada as e:
        log.error("%s", e)
        return 2
    gravar(linhas, Path(args.saida))
    sem_codigo = sum(1 for x in linhas if not x["codigo_sesc"])
    log.info("%d produtos gravados em %s (%d sem código interno)", len(linhas), args.saida, sem_codigo)
    return 0


if __name__ == "__main__":
    sys.exit(main())

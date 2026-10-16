"""Gabarito das regras de escopo, compartilhado entre o Python e a Edge Function (spec 0029, CA-10).

A trilha do dia classifica no TypeScript; o coletor, no Python. Para os dois decidirem igual, este módulo roda as
funções puras de `coletor/escopo.py` sobre um corpus de textos e grava a resposta de cada uma em
`tests/fixtures/escopo-casos.json`. O pytest confere que o Python continua batendo com o gabarito, e o teste Deno do
porte confere o TypeScript contra o mesmo arquivo.

O corpus são as strings que já aparecem nos testes de escopo (`tests/test_escopo_*.py`): textos de objeto e de item
escritos à mão ou tirados de casos reais citados nos testes. Docstrings ficam de fora.

Mudança de regra muda a saída do Python: o teste falha até o gabarito ser regenerado de propósito com
  python -m coletor.escopo_casos --gravar
e o diff do JSON mostra, caso a caso, o que a regra nova mudou.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Callable

from coletor import escopo

RAIZ = Path(__file__).resolve().parents[1]
ARQUIVO = RAIZ / "tests" / "fixtures" / "escopo-casos.json"
# O próprio teste do gabarito fica de fora: as strings dele são exemplos do filtro, não casos de regra.
FONTES = sorted(f for f in (RAIZ / "tests").glob("test_escopo_*.py")
                if f.name != "test_escopo_casos_compartilhados.py")
TAMANHO_MINIMO = 6
# Ruído dos testes que não é texto de objeto/item: nomes de campo (`termos_busca`), cabeçalhos de parametrize
# (`texto, esperado`) e identificadores com poucas letras (CNPJ, número de controle, data).
_IDENTIFICADOR = re.compile(r"^[a-z]+(_[a-z]+)+$|^[a-z]+[A-Z]\w*$|^\w+(\s*,\s*\w+)+$")


def _texto_de_licitacao(v: str) -> bool:
    limpo = v.strip()
    return (len(limpo) >= TAMANHO_MINIMO and "\n" not in v and not _IDENTIFICADOR.match(limpo)
            and sum(c.isalpha() for c in v) >= 4)


# Funções puras de texto que a trilha do dia usa. Cada uma recebe só o texto (e, quando há, a flag de contexto).
FUNCOES: dict[str, Callable[[str], object]] = {
    "classificar": lambda t: escopo.classificar(t),
    "classificar_texto_item": lambda t: list(escopo.classificar_texto_item(t)),
    "classificar_texto_item_contexto": lambda t: list(escopo.classificar_texto_item(t, contexto=True)),
    "excluir_compra": escopo.excluir_compra,
    "servico_sem_material": escopo.servico_sem_material,
    "academia_ar_livre": escopo.academia_ar_livre,
    "brinquedo_infantil": escopo.brinquedo_infantil,
    "item_core": lambda t: escopo.item_core(t),
    "item_core_esportivo": lambda t: escopo.item_core(t, esportivo=True),
    "piso_item_fora": escopo.piso_item_fora,
    "veto_lista_fixa": escopo.veto_lista_fixa,
    "objeto_esportivo": escopo.objeto_esportivo,
    "objeto_passagem": escopo.objeto_passagem,
    "interesse_borracha": lambda t: escopo.interesse_borracha(t),
    "normalizar": escopo.normalizar,
}


def _docstrings(arvore: ast.AST) -> set[int]:
    ids: set[int] = set()
    for no in ast.walk(arvore):
        if isinstance(no, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            corpo = getattr(no, "body", [])
            if corpo and isinstance(corpo[0], ast.Expr) and isinstance(getattr(corpo[0], "value", None), ast.Constant):
                ids.add(id(corpo[0].value))
    return ids


def corpus(fontes: list[Path] | None = None) -> list[str]:
    """Strings literais dos testes de escopo (sem docstrings), sem repetição, em ordem estável."""
    vistos: dict[str, None] = {}
    for caminho in fontes or FONTES:
        arvore = ast.parse(caminho.read_text(encoding="utf-8"))
        docs = _docstrings(arvore)
        for no in ast.walk(arvore):
            if (isinstance(no, ast.Constant) and isinstance(no.value, str) and id(no) not in docs
                    and _texto_de_licitacao(no.value)):
                vistos.setdefault(no.value, None)
    return sorted(vistos)


def gerar(textos: list[str]) -> dict:
    casos = [{"entrada": t, "esperado": {nome: f(t) for nome, f in sorted(FUNCOES.items())}} for t in textos]
    return {"versao": 1, "gerado_de": "services/coletor-externo/coletor/escopo.py", "funcoes": sorted(FUNCOES),
            "textos": len(textos), "casos": casos}


def serializar(dados: dict) -> str:
    """Um texto por linha: o diff de uma mudança de regra mostra só os textos afetados."""
    cabeca = json.dumps({k: v for k, v in dados.items() if k != "casos"}, ensure_ascii=False)
    linhas = ",\n".join(json.dumps(c, ensure_ascii=False, separators=(",", ":")) for c in dados["casos"])
    return cabeca[:-1] + ', "casos": [\n' + linhas + "\n]}\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Gera o gabarito de escopo compartilhado (spec 0029, CA-10).")
    ap.add_argument("--gravar", action="store_true", help="regrava tests/fixtures/escopo-casos.json")
    a = ap.parse_args(argv)
    dados = gerar(corpus())
    texto = serializar(dados)
    if a.gravar:
        ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
        ARQUIVO.write_text(texto, encoding="utf-8", newline="\n")
    print(f"{dados['textos']} textos x {len(FUNCOES)} funções = {dados['textos'] * len(FUNCOES)} casos"
          f"{' gravados em ' + str(ARQUIVO.relative_to(RAIZ)) if a.gravar else ' (use --gravar para regravar)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

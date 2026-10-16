"""Gabarito das regras de escopo, compartilhado entre o Python e a Edge Function (spec 0029, CA-10).

A trilha do dia classifica no TypeScript; o coletor, no Python. Para os dois decidirem igual, este módulo roda as
funções puras de `coletor/escopo.py` sobre um corpus de textos e grava a resposta de cada uma em
`tests/fixtures/escopo-casos.json`. O pytest confere que o Python continua batendo com o gabarito, e o teste Deno do
porte confere o TypeScript contra o mesmo arquivo.

Corpus:
  - os textos passados às funções de escopo nos testes (`tests/*.py`): argumentos das chamadas a `classificar`,
    `item_core`, `avaliar` etc. e os valores de `pytest.mark.parametrize` cujos nomes são de texto (`texto`, `item`,
    `objeto`, `desc`, `titulo`, `descricao`). Nome de constante do módulo é resolvido. Chave de dict não entra;
  - `CASOS_SINTETICOS`: caracteres que o `normalizar` do Python trata diferente de um porte ingênuo em JavaScript
    (°, travessão, aspas curvas, NBSP, `\\r\\n`, ß, emoji) e quebras de linha, onde `$` e `\\s` mudam de sentido.

Fica para a parte 2 (porte): a decisão composta de `pncp.avaliar` (objeto + itens com `materialOuServico`) num bloco
próprio, e `classificar` com `classes_catmat`/`pdms`. A trilha do dia classifica pelo `objetoCompra` e, para os
ambíguos, pelos itens; CATMAT por item vem do código do item, não do texto.

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
FONTES = sorted(f for f in (RAIZ / "tests").glob("test_*.py") if f.name != "test_escopo_casos_compartilhados.py")


def _norm(f: Callable[[str], object]) -> Callable[[str], object]:
    """Funções de escopo que recebem o texto já normalizado (como o próprio escopo.py as chama)."""
    return lambda t: f(escopo.normalizar(t))


# Funções puras de texto que a trilha do dia usa. Cada uma recebe só o texto; variantes fixam o segundo argumento.
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
    "obra_ou_construcao": escopo.obra_ou_construcao,
    "manutencao_predial": escopo.manutencao_predial,
    "so_tatame": escopo.so_tatame,
    "contexto_academia": escopo.contexto_academia,
    "e_peca": _norm(escopo.e_peca),
    "borracha": _norm(escopo.borracha),
    "interesse_borracha": lambda t: escopo.interesse_borracha(t),
    # `None` explícito reclassifica pelo objeto (como em pncp.avaliar); um porte que trate null como "sem categoria"
    # diverge aqui.
    "interesse_borracha_categoria_none": lambda t: escopo.interesse_borracha(t, None),
    "interesse_borracha_categoria_piso": lambda t: escopo.interesse_borracha(t, "piso"),
    "interesse_borracha_categoria_forte": lambda t: escopo.interesse_borracha(t, "forte"),
    "normalizar": escopo.normalizar,
}

# Nomes de função cujas chamadas nos testes trazem textos de objeto/item.
CHAMADAS = set(FUNCOES) | {"avaliar", "_avaliar", "classificar_item", "classificar_item_detalhe", "e_peca",
                           "borracha", "interesse_borracha"}
PARAMETROS_DE_TEXTO = re.compile(r"\b(texto|item|objeto|desc|descricao|titulo)\b")
# Ruído que não é texto de licitação: nome de campo (`termos_busca`, `numeroItem`), cabeçalho de parametrize.
_IDENTIFICADOR = re.compile(r"^[a-z]+(_[a-z]+)+$|^[a-z]+[A-Z]\w*$|^\w+(\s*,\s*\w+)+$")

CASOS_SINTETICOS = [
    "Aquisição de piso–borracha 10° para academia",
    "Aquisição de piso—borracha para academia",
    "Aquisição de “esteira ergométrica” para academia",
    "Aquisição de esteira ergométrica para academia",
    "AULA MINISTRADA\r\nPilates.",
    "ESTEIRA ERGOMÉTRICA\nUso profissional",
    "Bicicleta ergométrica\tprofissional",
    "Straße Hantel Gewicht 10 kg",
    "Anilha 10 kg 🏋 para academia",
    "Piso de borracha 20 mm ´ academia",
    "HALTER 5KG × 2",
    "SBR",
    "EPDM",
    "polia",
    "Step",
    "Totó",
]


def _texto_de_licitacao(v: str) -> bool:
    limpo = v.strip()
    return bool(limpo) and not _IDENTIFICADOR.match(limpo) and sum(c.isalpha() for c in v) >= 3


def _strings(no: ast.AST, constantes: dict[str, list[ast.AST]]) -> list[str]:
    """Strings literais da subárvore, sem chaves de dict nem índices (`x["descricao"]`), resolvendo nomes atribuídos
    no arquivo e variáveis de laço (`for o in fora: classificar(o)`)."""
    achadas: list[str] = []
    pilha = [no]
    vistos: set[int] = set()
    while pilha:
        atual = pilha.pop()
        if id(atual) in vistos:
            continue
        vistos.add(id(atual))
        if isinstance(atual, ast.Constant) and isinstance(atual.value, str):
            achadas.append(atual.value)
        elif isinstance(atual, ast.Name) and atual.id in constantes:
            pilha.extend(constantes[atual.id])
        elif isinstance(atual, ast.Subscript):
            pilha.append(atual.value)
        elif isinstance(atual, ast.Dict):
            pilha.extend(v for v in atual.values if v is not None)
        else:
            pilha.extend(ast.iter_child_nodes(atual))
    return achadas


def _nome_chamado(no: ast.Call) -> str | None:
    if isinstance(no.func, ast.Name):
        return no.func.id
    if isinstance(no.func, ast.Attribute):
        return no.func.attr
    return None


def corpus(fontes: list[Path] | None = None) -> list[str]:
    """Textos de objeto/item dos testes (ver docstring do módulo) mais os sintéticos, sem repetição, em ordem."""
    vistos: dict[str, None] = {}
    for caminho in fontes if fontes is not None else FONTES:
        arvore = ast.parse(caminho.read_text(encoding="utf-8"))
        constantes: dict[str, list[ast.AST]] = {}
        apelidos = set(CHAMADAS)
        for no in ast.walk(arvore):
            if isinstance(no, ast.ImportFrom):  # `from coletor.escopo import classificar as c`
                apelidos.update(a.asname for a in no.names if a.asname and a.name in CHAMADAS)
                continue
            if isinstance(no, ast.Assign):
                alvos, valor = no.targets, no.value
            elif isinstance(no, (ast.For, ast.comprehension)):
                alvos, valor = [no.target], no.iter
            else:
                continue
            for alvo in alvos:
                nomes = [alvo] if isinstance(alvo, ast.Name) else [e for e in getattr(alvo, "elts", [])
                                                                  if isinstance(e, ast.Name)]
                for n in nomes:
                    constantes.setdefault(n.id, []).append(valor)
                    # `c = classificar` / `c = escopo.classificar`: o apelido também traz textos
                    alvo_func = valor.attr if isinstance(valor, ast.Attribute) else getattr(valor, "id", None)
                    if isinstance(no, ast.Assign) and alvo_func in CHAMADAS:
                        apelidos.add(n.id)
        for no in ast.walk(arvore):
            if not isinstance(no, ast.Call):
                continue
            nome = _nome_chamado(no)
            if nome == "parametrize" and no.args:
                nomes = no.args[0].value if isinstance(no.args[0], ast.Constant) else ""
                if isinstance(nomes, str) and PARAMETROS_DE_TEXTO.search(nomes) and len(no.args) > 1:
                    textos = _strings(no.args[1], constantes)
                else:
                    continue
            elif nome in apelidos:
                textos = [s for a in [*no.args, *(k.value for k in no.keywords)] for s in _strings(a, constantes)]
            else:
                continue
            for t in textos:
                if _texto_de_licitacao(t):
                    vistos.setdefault(t, None)
    if fontes is None:
        for t in CASOS_SINTETICOS:
            vistos.setdefault(t, None)
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
    if a.gravar:
        ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
        ARQUIVO.write_text(serializar(dados), encoding="utf-8", newline="\n")
    print(f"{dados['textos']} textos x {len(FUNCOES)} funções = {dados['textos'] * len(FUNCOES)} casos"
          f"{' gravados em ' + str(ARQUIVO.relative_to(RAIZ)) if a.gravar else ' (use --gravar para regravar)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

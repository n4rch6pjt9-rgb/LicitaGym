"""Extração do catálogo de produtos de um portal Paradigma por categoria (coletor/catalogo_paradigma.py).

Teste unitário: o webservice é simulado (nunca chama a API real).
"""
from __future__ import annotations

import csv
import json

import pytest

from coletor import catalogo_paradigma as cp

CLASSES = [
    {"nCdClasse": 407, "sDsClasse": "PT030 - EQUIP CONDICIONAMENTO FISICO"},
    {"nCdClasse": 49, "sDsClasse": "ES1205 - EQUIP E MAT ESPORTIVO"},
    {"nCdClasse": 50, "sDsClasse": "ES1205X - OUTRA"},
]


def produto(n: int, classe: dict, codigo: str, descricao: str, tipo: str = "Produto") -> dict:
    return {"nCdProduto": n, "sCdProdutoEmpresa": codigo, "sDsProduto": descricao, "sDsProdutoTipo": tipo,
            "nCdClasse": classe["nCdClasse"], "sDsClasse": classe["sDsClasse"]}


class PortalFalso:
    """Imita PortalParadigma: o autocomplete casa por prefixo, o catálogo devolve por classe."""

    def __init__(self, por_classe: dict[int, list[dict]]):
        self.fonte = type("F", (), {"slug": "sescdn"})()
        self.por_classe = por_classe
        self.pedidos: list[tuple[str, dict]] = []

    def _ws(self, metodo: str, body: dict):
        self.pedidos.append((metodo, body))
        assert metodo == "PesquisarCatalogoProdutoClasses"
        termo = body["dtoProduto"]["sDsProduto"].upper()
        return [c for c in CLASSES if c["sDsClasse"].upper().startswith(termo) or termo in c["sDsClasse"].upper()]

    def catalogo(self, classe: dict | None = None, tipo: str = "produto", descricao: str = "", codigo: str = ""):
        self.pedidos.append(("catalogo", {"classe": classe, "tipo": tipo}))
        return list(self.por_classe.get(classe["nCdClasse"], []))


def test_resolve_categoria_pelo_codigo_e_pelo_nome_exato():
    p = PortalFalso({})
    assert cp.resolver_categoria(p, "PT030") == CLASSES[0]
    assert cp.resolver_categoria(p, "pt030") == CLASSES[0]
    assert cp.resolver_categoria(p, "ES1205 - EQUIP E MAT ESPORTIVO") == CLASSES[1]
    # código é casado inteiro: ES1205 não pega ES1205X
    assert cp.resolver_categoria(p, "ES1205") == CLASSES[1]


def test_categoria_inexistente_da_erro_em_vez_de_lista_vazia():
    with pytest.raises(cp.CategoriaNaoEncontrada, match="ZZ999"):
        cp.resolver_categoria(PortalFalso({}), "ZZ999")


def test_extrai_as_duas_categorias_sem_repetir_produto():
    a, b = CLASSES[0], CLASSES[1]
    p = PortalFalso({
        407: [produto(1, a, "310031041500001", "AGACHAMENTO GUIADO SMITH ANILHADO"),
              produto(2, a, "310031041500002", "ESTEIRA ERGOMETRICA")],
        49: [produto(3, b, "310031041200009", "BOLA DE FUTSAL"),
             produto(2, a, "310031041500002", "ESTEIRA ERGOMETRICA")],  # o portal pode repetir
    })
    linhas = cp.extrair(p, ["PT030", "ES1205"], tipo="todos")
    assert [x["codigo_sesc"] for x in linhas] == ["310031041500001", "310031041500002", "310031041200009"]
    assert linhas[0] == {
        "codigo_sesc": "310031041500001", "descricao": "AGACHAMENTO GUIADO SMITH ANILHADO", "tipo": "Produto",
        "categoria": "PT030 - EQUIP CONDICIONAMENTO FISICO", "id_categoria": 407, "id_produto": 1,
        "fonte": "sescdn",
    }
    assert ("catalogo", {"classe": a, "tipo": "todos"}) in p.pedidos


def test_produto_sem_codigo_fica_com_codigo_nulo_nunca_inventado():
    a = CLASSES[0]
    p = PortalFalso({407: [{"nCdProduto": 9, "sDsProduto": "SEM CODIGO", "nCdClasse": 407, "sDsClasse": a["sDsClasse"]}]})
    linhas = cp.extrair(p, ["PT030"])
    assert linhas[0]["codigo_sesc"] is None
    assert linhas[0]["tipo"] is None


def test_grava_csv_e_json(tmp_path):
    linhas = [{"codigo_sesc": "1", "descricao": "Á, \"B\"", "tipo": "Produto", "categoria": "C", "id_categoria": 1,
               "id_produto": 2, "fonte": "sescdn"}]
    c = tmp_path / "x.csv"
    cp.gravar(linhas, c)
    with c.open(encoding="utf-8-sig", newline="") as f:
        lido = list(csv.DictReader(f, delimiter=";"))
    assert lido[0]["descricao"] == "Á, \"B\"" and lido[0]["codigo_sesc"] == "1"
    j = tmp_path / "x.json"
    cp.gravar(linhas, j)
    assert json.loads(j.read_text(encoding="utf-8")) == linhas
    with pytest.raises(ValueError, match="extensão"):
        cp.gravar(linhas, tmp_path / "x.txt")

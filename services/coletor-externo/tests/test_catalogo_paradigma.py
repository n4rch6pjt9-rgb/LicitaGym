"""Extração do catálogo de produtos de um portal Paradigma por categoria (coletor/catalogo_paradigma.py).

Teste unitário: o webservice é simulado (nunca chama a API real).
"""
from __future__ import annotations

import csv
import json

import pytest

from coletor import catalogo_paradigma as cp

PT030 = {"nCdClasse": 407, "sDsClasse": "PT030 - EQUIP CONDICIONAMENTO FISICO"}
ES1205 = {"nCdClasse": 49, "sDsClasse": "ES1205 - EQUIP E MAT ESPORTIVO"}
ES1205X = {"nCdClasse": 50, "sDsClasse": "ES1205X - OUTRA"}
# ES1205X vem antes de ES1205: casamento por prefixo pegaria a errada.
CLASSES = [PT030, ES1205X, ES1205]


def produto(n: int | None, classe: dict, codigo: str, descricao: str, tipo: str = "Produto") -> dict:
    return {"nCdProduto": n, "sCdProdutoEmpresa": codigo, "sDsProduto": descricao, "sDsProdutoTipo": tipo,
            "nCdClasse": classe["nCdClasse"], "sDsClasse": classe["sDsClasse"]}


class PortalFalso:
    """Imita PortalParadigma: o autocomplete casa por prefixo, o catálogo devolve por classe."""

    def __init__(self, por_classe: dict[int, list[dict]] | None = None, classes: list[dict] | None = None,
                 avisos: list[str] | None = None, erro: Exception | None = None):
        self.fonte = type("F", (), {"slug": "sescdn"})()
        self.por_classe = por_classe or {}
        self.classes = CLASSES if classes is None else classes
        self.nulo = False
        self.avisos = avisos or []
        self.erro = erro
        self.pedidos: list[tuple[str, dict]] = []

    def _ws(self, metodo: str, body: dict):
        self.pedidos.append((metodo, body))
        assert metodo == "PesquisarCatalogoProdutoClasses"
        if self.nulo:
            return None
        termo = body["dtoProduto"]["sDsProduto"].upper()
        return [c for c in self.classes if c["sDsClasse"].upper().startswith(termo)]

    def catalogo_com_avisos(self, classe: dict | None = None, tipo: str = "produto", descricao: str = "",
                            codigo: str = ""):
        self.pedidos.append(("catalogo", {"classe": classe, "tipo": tipo}))
        if self.erro:
            raise self.erro
        return list(self.por_classe.get(classe["nCdClasse"], [])), list(self.avisos)


def test_resolve_categoria_pelo_codigo_e_pelo_nome_exato():
    p = PortalFalso()
    assert cp.resolver_categoria(p, "PT030") == PT030
    assert cp.resolver_categoria(p, "pt030") == PT030
    assert cp.resolver_categoria(p, "ES1205 - EQUIP E MAT ESPORTIVO") == ES1205
    # código casado inteiro: ES1205 não pega ES1205X, que vem antes na resposta
    assert cp.resolver_categoria(p, "ES1205") == ES1205


def test_codigo_que_so_existe_como_prefixo_nao_casa():
    with pytest.raises(cp.CategoriaNaoEncontrada, match="ES1205"):
        cp.resolver_categoria(PortalFalso(classes=[ES1205X]), "ES1205")


def test_categoria_inexistente_da_erro_em_vez_de_lista_vazia():
    with pytest.raises(cp.CategoriaNaoEncontrada, match="ZZ999"):
        cp.resolver_categoria(PortalFalso(), "ZZ999")


def test_codigo_ambiguo_da_erro_em_vez_de_escolher():
    duas = [PT030, {"nCdClasse": 408, "sDsClasse": "PT030 - OUTRA COISA"}]
    with pytest.raises(cp.CategoriaNaoEncontrada, match="ambígua"):
        cp.resolver_categoria(PortalFalso(classes=duas), "PT030")


def test_resposta_nula_do_portal_e_erro_da_fonte_nao_categoria_inexistente():
    p = PortalFalso()
    p.nulo = True
    with pytest.raises(RuntimeError, match="nulo"):
        cp.resolver_categoria(p, "PT030")


def test_extrai_as_duas_categorias_sem_repetir_produto():
    p = PortalFalso({
        407: [produto(1, PT030, "310031041500001", "AGACHAMENTO GUIADO SMITH ANILHADO"),
              produto(2, PT030, "310031041500002", "ESTEIRA ERGOMETRICA")],
        49: [produto(3, ES1205, "310031041200009", "BOLA DE FUTSAL"),
             produto(2, PT030, "310031041500002", "ESTEIRA ERGOMETRICA")],  # o portal pode repetir
    })
    linhas = cp.extrair(p, ["PT030", "ES1205"], tipo="todos")
    assert [x["codigo_sesc"] for x in linhas] == ["310031041500001", "310031041500002", "310031041200009"]
    assert linhas[0] == {
        "codigo_sesc": "310031041500001", "descricao": "AGACHAMENTO GUIADO SMITH ANILHADO", "tipo": "Produto",
        "categoria": "PT030 - EQUIP CONDICIONAMENTO FISICO", "id_categoria": 407, "id_produto": 1,
        "fonte": "sescdn",
    }
    assert ("catalogo", {"classe": PT030, "tipo": "todos"}) in p.pedidos


def test_sem_id_de_produto_deduplica_por_codigo_e_descricao():
    p = PortalFalso({407: [produto(None, PT030, "A1", "X"), produto(None, PT030, "A1", "X"),
                           produto(None, PT030, "A2", "X")]})
    assert [x["codigo_sesc"] for x in cp.extrair(p, ["PT030"])] == ["A1", "A2"]


def test_produto_sem_codigo_fica_com_codigo_nulo_nunca_inventado():
    p = PortalFalso({407: [{"nCdProduto": 9, "sDsProduto": "SEM CODIGO", "nCdClasse": 407,
                            "sDsClasse": PT030["sDsClasse"]}]})
    linhas = cp.extrair(p, ["PT030"])
    assert linhas[0]["codigo_sesc"] is None
    assert linhas[0]["tipo"] is None


def test_aviso_de_paginacao_e_catalogo_incompleto_nao_sucesso():
    p = PortalFalso({407: [produto(1, PT030, "A1", "X")]}, avisos=["página repetida na faixa 101-200"])
    with pytest.raises(cp.CatalogoIncompleto, match="página repetida"):
        cp.extrair(p, ["PT030"])


def test_erro_do_webservice_propaga_nao_vira_lista_vazia():
    with pytest.raises(RuntimeError, match="HTTP 500"):
        cp.extrair(PortalFalso(erro=RuntimeError("HTTP 500")), ["PT030"])


def test_csv_neutraliza_formula_e_json_guarda_o_original(tmp_path):
    linhas = [{"codigo_sesc": "1", "descricao": '=HYPERLINK("http://x","clique")', "tipo": "+cmd", "categoria": "C",
               "id_categoria": 1, "id_produto": 2, "fonte": "sescdn"},
              {"codigo_sesc": "2", "descricao": "Á, \"B\"", "tipo": "Produto", "categoria": "C", "id_categoria": 1,
               "id_produto": 3, "fonte": "sescdn"}]
    c = tmp_path / "x.csv"
    cp.gravar(linhas, c)
    with c.open(encoding="utf-8-sig", newline="") as f:
        lido = list(csv.DictReader(f, delimiter=";"))
    assert lido[0]["descricao"] == "'=HYPERLINK(\"http://x\",\"clique\")"
    assert lido[0]["tipo"] == "'+cmd"
    assert lido[1]["descricao"] == "Á, \"B\""
    j = tmp_path / "x.json"
    cp.gravar(linhas, j)
    assert json.loads(j.read_text(encoding="utf-8")) == linhas


def test_valida_saida_antes_de_coletar(tmp_path):
    repo = tmp_path / "repo"
    (repo / "sub").mkdir(parents=True)
    fora = tmp_path / "fora"
    fora.mkdir()
    assert cp.validar_saida(fora / "c.csv", repo) == fora / "c.csv"
    with pytest.raises(ValueError, match="extensão"):
        cp.validar_saida(fora / "c.txt", repo)
    with pytest.raises(ValueError, match="não existe"):
        cp.validar_saida(tmp_path / "nao" / "c.csv", repo)
    with pytest.raises(ValueError, match="dentro do repositório"):
        cp.validar_saida(repo / "sub" / "c.csv", repo)


def test_main_codigos_de_saida(tmp_path, monkeypatch):
    monkeypatch.setattr(cp, "RAIZ_REPO", tmp_path / "repo")
    monkeypatch.setattr(cp.validar_saida, "__defaults__", (tmp_path / "repo",))
    saida = tmp_path / "c.csv"
    base = ["--fonte", "sescdn", "--saida", str(saida)]
    ok = PortalFalso({407: [produto(1, PT030, "A1", "X")], 49: [produto(2, ES1205, "B1", "Y")]})
    assert cp.main([*base, "--categorias", "PT030; ;ES1205"], portal=ok) == 0
    with saida.open(encoding="utf-8-sig", newline="") as f:
        assert [r["codigo_sesc"] for r in csv.DictReader(f, delimiter=";")] == ["A1", "B1"]
    assert cp.main([*base, "--categorias", "ZZ999"], portal=PortalFalso()) == 2
    assert cp.main([*base, "--categorias", " ; "], portal=PortalFalso()) == 2
    saida.unlink()
    cortado = PortalFalso({407: [produto(1, PT030, "A1", "X")]}, avisos=["limite de segurança"])
    assert cp.main([*base, "--categorias", "PT030"], portal=cortado) == 3
    assert not saida.exists()
    # saída inválida falha antes de qualquer chamada ao portal
    nada = PortalFalso()
    assert cp.main(["--fonte", "sescdn", "--saida", str(tmp_path / "c.txt"), "--categorias", "PT030"], portal=nada) == 2
    assert nada.pedidos == []


# ---------------- spec 0052 fase 1: gravação no banco (K-1 classes, K-2 produtos; 0053 K-2) ----------------
class SupabaseFalso:
    """Imita destino.Supabase.upsert: guarda por chave de conflito (merge-duplicates)."""

    def __init__(self):
        self.tabelas: dict[str, dict[tuple, dict]] = {}
        self.chamadas: list[tuple[str, int]] = []

    def upsert(self, tabela: str, linhas, conflito: str):
        linhas = linhas if isinstance(linhas, list) else [linhas]
        self.chamadas.append((tabela, len(linhas)))
        chaves = conflito.split(",")
        t = self.tabelas.setdefault(tabela, {})
        for x in linhas:
            k = tuple(x[c] for c in chaves)
            t[k] = {**t.get(k, {}), **x}
        return linhas


def _catalogo_fieb() -> list[dict]:
    c226 = {"nCdClasse": 226, "sDsClasse": "EQUIPAMENTOS PARA ACADEMIA"}
    return [produto(10, c226, "00000010", "LEG PRESS 45"), produto(11, c226, "00000011", "FLEXORA DEITADA"),
            produto(12, PT030, "PT0300001", "ESTEIRA ERGOMETRICA")]


def test_ca3_gravar_duas_vezes_nao_duplica_nem_muda_hash_e_so_o_produto_alterado_muda():
    """CA-3 (0053 K-2; 0052 fase 1): mesma lista gravada duas vezes não muda linhas nem payload_hash."""
    sb = SupabaseFalso()
    linhas = cp.extrair(PortalFalso({407: _catalogo_fieb()}), ["PT030"])
    cp.gravar_banco(sb, linhas)
    antes = {k: v["payload_hash"] for k, v in sb.tabelas["sistema_s_catalogo_produtos"].items()}
    cp.gravar_banco(sb, linhas)
    depois = {k: v["payload_hash"] for k, v in sb.tabelas["sistema_s_catalogo_produtos"].items()}
    assert antes == depois and len(depois) == 3
    alterado = [dict(x) for x in linhas]
    alterado[1]["descricao"] = "FLEXORA DEITADA ARTICULADA"
    cp.gravar_banco(sb, alterado)
    final = {k: v["payload_hash"] for k, v in sb.tabelas["sistema_s_catalogo_produtos"].items()}
    mudou = [k for k in final if final[k] != antes[k]]
    assert mudou == [("sescdn", 11)]


def test_ca_k1_grava_classes_antes_dos_produtos_com_codigo_e_contagem():
    """K-1 (0052): classe (fonte, id) com nome, código antes de ' - ' e qtd_produtos; classes antes dos produtos (FK)."""
    sb = SupabaseFalso()
    resumo = cp.gravar_banco(sb, cp.extrair(PortalFalso({407: _catalogo_fieb()}), ["PT030"]))
    assert [t for t, _ in sb.chamadas][0] == "sistema_s_catalogo_classes"
    classes = sb.tabelas["sistema_s_catalogo_classes"]
    assert classes[("sescdn", 226)]["nome"] == "EQUIPAMENTOS PARA ACADEMIA"
    assert classes[("sescdn", 226)]["codigo"] is None  # sem ' - ' no nome: código nulo, nunca inventado
    assert classes[("sescdn", 226)]["qtd_produtos"] == 2
    assert classes[("sescdn", 407)]["codigo"] == "PT030"
    assert classes[("sescdn", 407)]["qtd_produtos"] == 1
    p = sb.tabelas["sistema_s_catalogo_produtos"][("sescdn", 10)]
    assert p["codigo_entidade"] == "00000010" and p["id_classe_fonte"] == 226 and p["tipo"] == "Produto"
    assert "primeira_coleta_em" not in p  # só o default do banco grava a primeira coleta
    assert resumo == {"classes": 2, "produtos": 3, "sem_id": 0}


def test_ca_k2_produto_sem_id_nao_e_gravado_e_conta_no_resumo():
    """K-2: sem nCdProduto não há chave (fonte, id_produto_fonte); o produto fica fora e é contado, nunca inventado."""
    sb = SupabaseFalso()
    linhas = [{"codigo_sesc": "A1", "descricao": "X", "tipo": None, "categoria": "C", "id_categoria": 1,
               "id_produto": None, "fonte": "fieb"}]
    assert cp.gravar_banco(sb, linhas) == {"classes": 1, "produtos": 0, "sem_id": 1}
    assert "sistema_s_catalogo_produtos" not in sb.tabelas


def test_ca_k8_catalogo_inteiro_usa_classe_zero_e_grava_todas_as_classes():
    """K-8 (0052 fase 1, decisão 5 de 09/11): --tudo baixa o catálogo inteiro (nCdClasse 0) e grava todas as classes."""
    class PortalTudo(PortalFalso):
        def catalogo_com_avisos(self, classe=None, tipo="produto", descricao="", codigo=""):
            self.pedidos.append(("catalogo", {"classe": classe, "tipo": tipo}))
            return _catalogo_fieb(), []

    sb = SupabaseFalso()
    p = PortalTudo()
    assert cp.main(["--fonte", "sescdn", "--tudo", "--gravar"], portal=p, sb=sb) == 0
    assert p.pedidos == [("catalogo", {"classe": None, "tipo": "todos"})]
    assert set(sb.tabelas["sistema_s_catalogo_classes"]) == {("sescdn", 226), ("sescdn", 407)}
    assert len(sb.tabelas["sistema_s_catalogo_produtos"]) == 3


def test_ca4_aviso_de_paginacao_com_gravar_sai_3_e_nao_grava_nada():
    """CA-4 (0053, regressão do PR #490): catálogo possivelmente cortado não grava nem classe nem produto."""
    sb = SupabaseFalso()
    cortado = PortalFalso({407: [produto(1, PT030, "A1", "X")]}, avisos=["página repetida na faixa 101-200"])
    assert cp.main(["--fonte", "sescdn", "--categorias", "PT030", "--gravar"], portal=cortado, sb=sb) == 3
    assert sb.chamadas == []


def test_gravar_exige_categorias_ou_tudo_e_nao_os_dois():
    sb = SupabaseFalso()
    assert cp.main(["--fonte", "sescdn", "--gravar"], portal=PortalFalso(), sb=sb) == 2
    assert cp.main(["--fonte", "sescdn", "--gravar", "--tudo", "--categorias", "PT030"], portal=PortalFalso(), sb=sb) == 2
    assert cp.main(["--fonte", "sescdn", "--categorias", "PT030"], portal=PortalFalso(), sb=sb) == 2  # nem saída nem gravar
    assert sb.chamadas == []

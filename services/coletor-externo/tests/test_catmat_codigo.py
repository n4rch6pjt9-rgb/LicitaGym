"""Código CATMAT antes do texto em pncp.avaliar (coletor/catmat_codigo.py; 03/10/2026)."""
import pytest

from coletor import catmat_codigo as C
from coletor import pncp as P
from coletor import reclassificar_escopo_pncp as R

COMPRAS_GOV = {"id": 1, "nome": "Catálogo do Compras.gov.br"}
OUTROS = {"id": 2, "nome": "Outros"}
# 230525 = CESTO (PDM 121, fora do catálogo da empresa); 480144 = item de PDM do catálogo (2640)
MAPA = C.MapaCatmat(item_pdm={230525: 121, 480144: 2640, 93882: 762}, pdms_catalogo=frozenset({2640}))
COMPRA = {"description": "Aquisição de materiais diversos para a secretaria"}  # objeto neutro (não classifica)


def _it(n, desc, codigo=None, catalogo=None, ms="M"):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms, "catalogoCodigoItem": codigo,
            "catalogo": catalogo}


@pytest.mark.parametrize("it,esperado", [
    (_it(1, "x", 480144, COMPRAS_GOV), 480144),
    (_it(1, "x", "480144", COMPRAS_GOV), 480144),
    (_it(1, "x", 480144, OUTROS), None),          # código do órgão não é CATMAT
    (_it(1, "x", 480144, None), None),            # sem catálogo (ex.: 449/2026: catalogo = null)
    (_it(1, "x", 25151, COMPRAS_GOV, "S"), None),  # CATSER: mesmo espaço numérico, não é CATMAT
    (_it(1, "x", "AI0300075", COMPRAS_GOV), None),
    (_it(1, "x", "1" * 16, COMPRAS_GOV), None),
    (_it(1, "x", True, COMPRAS_GOV), None),
])
def test_codigo_catmat_so_compras_gov_em_material(it, esperado):
    assert C.codigo_catmat(it, P.material_ou_servico(it)) == esperado


def test_catalogo_id_do_pncp_e_do_banco():
    assert C.catalogo_id({"catalogo": {"id": 1}}) == 1
    assert C.catalogo_id({"catalogo": {"id": "2"}}) == 2
    assert C.catalogo_id({"catalogoId": 1}) == 1
    assert C.catalogo_id({"catalogo_id": 2}) == 2
    assert C.catalogo_id({"catalogo": None}) is None
    assert C.catalogo_id({}) is None


def test_codigo_do_catalogo_no_mapa_decide_catmat():
    # texto neutro ("item 7") não classificaria; o código do Compras.gov.br em PDM do catálogo classifica
    cat, _, por_item = P.avaliar(COMPRA, [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)], MAPA)
    assert cat == "catmat" and por_item[1][0] == "catmat"


def test_codigo_do_catalogo_fora_do_escopo_vence_o_texto():
    # código CATMAT de CESTO (PDM 121, fora do catálogo): o texto "bola de basquete" não reabre
    cat, _, por_item = P.avaliar(COMPRA, [_it(1, "BOLA DE BASQUETE OFICIAL", 230525, COMPRAS_GOV)], MAPA)
    assert por_item[1][0] is None and cat is None


def test_codigo_outros_cai_no_texto_como_antes():
    # licitação 92 item 7: 230525 do catálogo Outros = falso positivo CESTO. Fica o texto (sem o mapa: igual)
    itens = [_it(7, "BOLAS DE BASQUETE INFANTIL PLAYOFF MIRIM", "230525", OUTROS)]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)
    assert P.avaliar(COMPRA, itens, MAPA)[2][7][0] == P.avaliar(COMPRA, [_it(7, itens[0]["descricao"])])[2][7][0]


def test_codigo_fora_do_mapa_cai_no_texto():
    # 19 dos 41 PDMs do catálogo não têm itens nas tabelas CATMAT: código desconhecido não tira o item do escopo
    itens = [_it(1, "Esteira ergométrica profissional", 999999, COMPRAS_GOV)]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)
    assert P.avaliar(COMPRA, itens, MAPA)[0] == "forte"


def test_servico_com_codigo_catser_cai_no_texto():
    itens = [_it(1, "Manutenção de esteira ergométrica", 480144, COMPRAS_GOV, "S")]
    assert P.avaliar(COMPRA, itens, MAPA) == P.avaliar(COMPRA, itens)


def test_sem_mapa_e_so_texto():
    itens = [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)]
    assert P.avaliar(COMPRA, itens)[0] is None
    assert C.categoria_por_codigo(itens[0], None, "M") == (False, None)


def test_travas_do_objeto_valem_para_o_codigo():
    # obra no objeto: categoria só de material não conta, nem quando vem do código
    obra = {"description": "Contratação de empresa para execução de obra de construção de quadra"}
    assert P.avaliar(obra, [_it(1, "ZZ ITEM 7", 480144, COMPRAS_GOV)], MAPA)[2][1][0] is None


class _SB:
    def __init__(self, mapa=None, pdms=None, erro=None):
        self.mapa, self.pdms, self.erro, self.chamadas = mapa, pdms, erro, []

    def selecionar(self, tabela, **filtros):
        self.chamadas.append((tabela, filtros))
        if self.erro:
            raise self.erro
        return self.mapa

    def rpc(self, funcao, params):
        self.chamadas.append((funcao, params))
        return self.pdms


def test_carregar_mapa_le_as_duas_rpcs():
    sb = _SB(mapa=[{"codigo_item": 230525, "codigo_pdm": 121}, {"codigo_item": "480144", "codigo_pdm": "2640"}],
             pdms=[{"codigo_pdm": 2640}])
    m = C.carregar_mapa_catmat(sb)
    assert m.item_pdm == {230525: 121, 480144: 2640} and m.pdms_catalogo == {2640}
    assert sb.chamadas[0] == ("rpc/catmat_itens_mapa", {"select": "codigo_item,codigo_pdm", "order": "codigo_item.asc"})


def test_carregar_mapa_falha_vira_so_texto():
    assert C.carregar_mapa_catmat_ou_texto(_SB(erro=RuntimeError("503"))) is None
    assert C.carregar_mapa_catmat_ou_texto(None) is None
    with pytest.raises(C.MapaCatmatIndisponivel):
        C.carregar_mapa_catmat(_SB(mapa=[{"codigo_item": None, "codigo_pdm": 1}], pdms=[]))


def test_coletor_grava_catalogo_id():
    sb = type("SB", (), {})()
    gravado = {}

    def upsert(tabela, linhas, conflito):
        gravado[tabela] = linhas
        return [{"id": 1}] if tabela == "licitacoes_externas" else []
    sb.upsert, sb.selecionar, sb.atualizar = upsert, lambda *a, **k: [], lambda *a, **k: None
    pncp = type("PN", (), {})()
    itens = [_it(1, "Borracha granulada para gramado sintético", "480144", COMPRAS_GOV),
             _it(2, "Borracha granulada G2", "77", OUTROS), _it(3, "Borracha granulada G3")]
    pncp.itens = lambda c: itens
    pncp.resultados = lambda c, n: []
    pncp.arquivos = lambda c: []
    pncp.compra = lambda c: {"processo": "1/2026"}
    c = {"numero_controle_pncp": "44892693000140-1-000157/2026", "orgao_cnpj": "44892693000140", "ano": 2026,
         "numero_sequencial": 157, "description": "Aquisição de borracha granulada"}
    P._processar(pncp, sb, None, c, "borracha", False, False, 1, False, {}, mapa_catmat=MAPA)
    assert [i["catalogo_id"] for i in gravado["licitacao_itens"]] == [1, 2, None]


def test_reclassificador_le_codigo_e_catalogo_gravados():
    assert "catalogo_codigo_item" in R.SELECT_ITENS and "catalogo_id" in R.SELECT_ITENS
    ln = {"licitacao_itens": [{"numero_item": 1, "descricao": "ZZ", "material_ou_servico": "M",
                               "catalogo_codigo_item": "480144", "catalogo_id": 1}]}
    it = R._itens_gravados(ln)[0]
    assert C.codigo_catmat(it, P.material_ou_servico(it)) == 480144

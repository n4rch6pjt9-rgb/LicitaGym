"""#390 (decisão do Marcelo, 16/10/2026): item vetado por piso_item_fora não marca interesse em borracha.

Antes, o item vetado (ou que já chegava sem categoria, pelo código CATMAT) passava por `interesse_borracha(desc, None)`,
que reclassificava o texto, achava "piso" de novo e marcava interesse. A regra fica em `escopo.interesse_borracha_item`,
usada pelo PNCP (`pncp.avaliar`) e pelo Sistema S (`paradigma.classificar_item_detalhe`). Casos reais de produção
(16/10/2026): escada hospitalar, balança antropométrica, cadeira de alimentação, cera e piso fino de obra.
"""
import pytest

from coletor import catmat_codigo as C
from coletor import paradigma as PG
from coletor import pncp as P
from coletor.escopo import classificar, interesse_borracha_item, piso_item_fora

HOSPITALAR = {"description": "Aquisição de material hospitalar"}
ACADEMIA = {"description": "Aquisição de piso para academia"}
VETADOS = [
    "ESCADA HOSPITALAR, 02 DEGRAUS, PISO DE BORRACHA ANTIDERRAPANTE",
    "BALANÇA ANTROPOMÉTRICA PARA OBESOS, PLATAFORMA DE AÇO CARBONO 1020, PISO DE BORRACHA ANTIDERRAPANTE",
    "CERA, PRETA, PARA PISO DE BORRACHA. EMBALAGEM COM 5 L.",
    "PISO EMBORRACHADO, SUPERFÍCIE TIPO MOEDA, COR PRETO, 50 X 50 CM, ESPESSURA 2,5 MM",
]
PISO_DA_LINHA = "Piso de borracha 20 mm para academia"          # classificar -> "piso", não vetado
OBRA_PISO_DA_LINHA = "Implantação de academia ao ar livre com piso emborrachado"   # -> "obra_piso"
OBRA_PISO_VETADA = "RETIRADA MANUAL DE PISO DE BORRACHA COM APLICAÇÃO DE SOLVENTE, SEM REAPROVEITAMENTO"


def _item(n, desc, ms="M", **extra):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms, **extra}


@pytest.mark.parametrize("desc", VETADOS)
def test_item_vetado_por_piso_item_fora_nao_marca_interesse(desc):
    assert piso_item_fora(desc)
    assert interesse_borracha_item(desc, None) is False
    cat, interesse, por_item = P.avaliar(HOSPITALAR, [_item(1, desc)])
    assert cat is None and interesse is False and por_item == {1: (None, False)}


def test_piso_e_obra_piso_da_linha_continuam_com_interesse():
    assert classificar(PISO_DA_LINHA) == "piso" and not piso_item_fora(PISO_DA_LINHA)
    assert classificar(OBRA_PISO_DA_LINHA) == "obra_piso" and not piso_item_fora(OBRA_PISO_DA_LINHA)
    for desc in (PISO_DA_LINHA, OBRA_PISO_DA_LINHA):
        _, interesse, por_item = P.avaliar(ACADEMIA, [_item(1, desc)])
        assert interesse is True and por_item[1][1] is True, desc


def test_obra_piso_vetada_nao_marca_interesse():
    assert classificar(OBRA_PISO_VETADA) in ("piso", "obra_piso") and piso_item_fora(OBRA_PISO_VETADA)
    assert interesse_borracha_item(OBRA_PISO_VETADA, None) is False


def test_item_vetado_nao_apaga_interesse_de_outro_item():
    itens = [_item(1, VETADOS[0]), _item(2, PISO_DA_LINHA)]
    _, interesse, por_item = P.avaliar(HOSPITALAR, itens)
    assert por_item[1] == (None, False) and por_item[2][1] is True and interesse is True


def test_codigo_catmat_com_pdm_fora_nao_reabre_interesse_pelo_texto():
    """O código decide None (PDM fora do catálogo): o texto vetado não pode marcar interesse."""
    mapa = C.MapaCatmat(item_pdm={123456: 999}, pdms_catalogo=frozenset({1}))
    item = _item(1, VETADOS[0], catalogoId=1, catalogoCodigoItem=123456)
    cat, interesse, por_item = P.avaliar(HOSPITALAR, [item], mapa)
    assert cat is None and interesse is False and por_item == {1: (None, False)}


def test_item_catmat_avulso_vetado_por_obra_nao_reabre_interesse():
    mapa = C.MapaCatmat(itens_avulsos={654321: 999})
    item = _item(1, "ESCADA COM PISO DE BORRACHA ANTIDERRAPANTE", catalogoId=1, catalogoCodigoItem=654321)
    cat, interesse, por_item = P.avaliar({"description": "Construção de creche no bairro X"}, [item], mapa)
    assert interesse is False and por_item[1][1] is False


@pytest.mark.parametrize("desc", VETADOS + ["CADEIRA DE ALIMENTAÇÃO INFANTIL, SAPATAS COM PISO DE BORRACHA"])
def test_sistema_s_item_vetado_nao_marca_interesse(desc):
    cat, interesse, ms, _ = PG.classificar_item_detalhe({"sDsItem": desc})
    assert ms == "M" and cat is None and interesse is False


def test_sistema_s_piso_da_linha_continua():
    cat, interesse, _, _ = PG.classificar_item_detalhe({"sDsItem": PISO_DA_LINHA})
    assert cat == "piso" and interesse is True


# Extensão da #390 (decisão do Marcelo, 16/10/2026): borracha explícita (EPDM, SBR) em outro produto também fica fora.
BORRACHA_EM_OUTRO_PRODUTO = [
    "ESCADA COM PISO DE BORRACHA EPDM",
    "CERA PARA PISO DE BORRACHA EPDM",
    "RETIRADA DE PISO EM BORRACHA SBR",
]
BORRACHA_DA_LINHA = "Aquisição de borracha granulada SBR para reposição do campo sintético"


@pytest.mark.parametrize("desc", BORRACHA_EM_OUTRO_PRODUTO)
def test_borracha_em_outro_produto_e_vetada(desc):
    assert classificar(desc) == "borracha" and piso_item_fora(desc)
    assert interesse_borracha_item(desc, None) is False and interesse_borracha_item(desc, "borracha") is False
    cat, interesse, por_item = P.avaliar(HOSPITALAR, [_item(1, desc)])
    assert cat is None and interesse is False and por_item == {1: (None, False)}
    cat_s, interesse_s, _, _ = PG.classificar_item_detalhe({"sDsItem": desc})
    assert cat_s is None and interesse_s is False


def test_borracha_da_linha_continua():
    assert classificar(BORRACHA_DA_LINHA) == "borracha" and not piso_item_fora(BORRACHA_DA_LINHA)
    cat, interesse, por_item = P.avaliar({"description": "Aquisição de material esportivo"}, [_item(1, BORRACHA_DA_LINHA)])
    assert por_item[1] == ("borracha", True) and interesse is True


# Exceção (decisão do Marcelo, 16/10/2026): remoção/retirada/demolição só veta quando o item não instala nem fornece
# grama ou piso. Caso real: compra 46 ("REMOÇÃO E INSTALAÇÃO DE GRAMADO SINTÉTICO").
REMOCAO_COM_INSTALACAO = [
    "REMOÇÃO E INSTALAÇÃO DE GRAMADO SINTÉTICO - Avaliação técnica do contrapiso ou base de concreto",
    "Remoção do piso existente e fornecimento e instalação de piso de borracha 20 mm",
    "Retirada de grama antiga e assentamento de grama sintética com granulado de borracha SBR",
]
REMOCAO_SO = [
    "RETIRADA MANUAL DE PISO DE BORRACHA COM APLICAÇÃO DE SOLVENTE A BASE DE ÁLCOOL, SEM REAPROVEITAMENTO",
    "DEMOLICAO MANUAL DE PISO VINILICO, INCLUSIVE AFASTAMENTO - PISO EMBORRACHADO",
    "RETIRADA DE PISO EM BORRACHA SBR",
]


@pytest.mark.parametrize("desc", REMOCAO_COM_INSTALACAO)
def test_remocao_com_instalacao_de_grama_ou_piso_nao_veta(desc):
    assert not piso_item_fora(desc)
    assert interesse_borracha_item(desc, None) is True


@pytest.mark.parametrize("desc", REMOCAO_SO)
def test_remocao_sem_instalacao_continua_vetada(desc):
    assert piso_item_fora(desc)
    assert interesse_borracha_item(desc, None) is False

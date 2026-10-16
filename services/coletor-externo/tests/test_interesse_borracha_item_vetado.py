"""#390 (decisão do Marcelo, 16/10/2026): item vetado por piso_item_fora não marca interesse em borracha.

Antes, `pncp.avaliar` vetava o item (categoria None) e depois chamava `interesse_borracha(desc, None)`, que
reclassificava o texto, achava "piso" de novo e marcava interesse. Casos reais de produção (16/10/2026): escada
hospitalar, balança antropométrica, cadeira de alimentação e cera para piso de borracha.
"""
import pytest

from coletor import pncp as P
from coletor.escopo import piso_item_fora

HOSPITALAR = {"description": "Aquisição de material hospitalar"}


def _item(n, desc, ms="M"):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms}


@pytest.mark.parametrize("desc", [
    "ESCADA HOSPITALAR, 02 DEGRAUS, PISO DE BORRACHA ANTIDERRAPANTE",
    "BALANÇA ANTROPOMÉTRICA PARA OBESOS, PLATAFORMA DE AÇO CARBONO 1020, PISO DE BORRACHA ANTIDERRAPANTE",
    "CERA, PRETA, PARA PISO DE BORRACHA. EMBALAGEM COM 5 L.",
    "PISO EMBORRACHADO, SUPERFÍCIE TIPO MOEDA, COR PRETO, 50 X 50 CM, ESPESSURA 2,5 MM",
])
def test_item_vetado_por_piso_item_fora_nao_marca_interesse(desc):
    assert piso_item_fora(desc)
    cat, interesse, por_item = P.avaliar(HOSPITALAR, [_item(1, desc)])
    assert cat is None and interesse is False and por_item == {1: (None, False)}


def test_piso_de_borracha_da_linha_continua_com_interesse():
    desc = "Piso de borracha EPDM 20 mm para academia"
    assert not piso_item_fora(desc)
    cat, interesse, por_item = P.avaliar({"description": "Aquisição de piso para academia"}, [_item(1, desc)])
    assert interesse is True and por_item[1][1] is True


def test_item_vetado_nao_apaga_interesse_de_outro_item():
    itens = [_item(1, "ESCADA HOSPITALAR, 02 DEGRAUS, PISO DE BORRACHA ANTIDERRAPANTE"),
             _item(2, "Piso de borracha EPDM 20 mm para academia")]
    _, interesse, por_item = P.avaliar(HOSPITALAR, itens)
    assert por_item[1] == (None, False) and por_item[2][1] is True and interesse is True

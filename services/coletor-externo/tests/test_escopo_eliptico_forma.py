"""Elíptico como forma (ponta, formato, seção, tubo) não é aparelho: nem "forte" no classificador nem core na regra do
forte por item de passagem. Torniquete nunca é aparelho elíptico (#1025, falso positivo do dry-run oficial do PR #124,
02/10/2026). Aparelho elíptico continua forte e core. Casos sintéticos, sem dado real e sem Supabase."""
import pytest

from coletor import pncp as P
from coletor.escopo import classificar, item_core

HOSPITALAR = "Aquisição de materiais, mobiliários e equipamentos hospitalares para o hospital e as unidades de saúde"

TORNIQUETE = ("Torniquete mecânico: utilizado para contenção de hemorragias de grande intensidade em membros inferiores "
              "e superiores, leve, compacto, ajuste flexível. Fita para diminuir o pinçamento da pele. Pode possuir a "
              "ponta elíptica vermelha, a fim de fornecer melhor visualização")


def _avaliar(objeto, itens):
    return P.avaliar({"description": objeto},
                     [{"numeroItem": n, "descricao": d, "materialOuServico": "M"} for n, d in enumerate(itens, 1)])


@pytest.mark.parametrize("texto", [
    TORNIQUETE,
    "Torniquete para garroteamento com fecho elíptico",            # torniquete: veto mesmo sem palavra de forma
    "Torniquete de aparelho elíptico",                             # veto vale até com o contexto de aparelho
    "Espelho de parede com formato elíptico, 60 x 40 cm",
    "Placa de identificação com formato elíptico em acrílico",
    "Peça metálica com seção elíptica",
    "Tubo elíptico 30 x 15 mm em aço carbono",
    "Caneta com pontas elípticas intercambiáveis",
    "Módulo reforçado de espuma especial em forma elíptica",            # #1473/#1498
    "Canteiro elevado elíptico 3,65 x 6,80 m com bancos em toras de eucalipto",   # #796 (medida com decimal)
])
def test_eliptico_como_forma_nao_e_forte_nem_core(texto):
    assert classificar(texto) != "forte"
    assert not item_core(texto)


def test_torniquete_nao_segura_forte_em_compra_hospitalar():
    cat, _, por_item = _avaliar(HOSPITALAR, ["Berço hospitalar fixo para recém-nascido", TORNIQUETE])
    assert cat is None
    assert "forte" not in {c for c, _ in por_item.values()}


@pytest.mark.parametrize("texto", [
    "Aparelho elíptico",
    "Transport elíptico",
    "Elíptico magnético",
    "Elíptico",
    "Bicicleta elíptica com 8 níveis de esforço",
    "Aparelho elíptico com tubo de aço de seção elíptica",     # forma citada dentro do próprio aparelho: fica
])
def test_aparelho_eliptico_continua_forte_e_core(texto):
    assert classificar(texto) == "forte"
    assert item_core(texto)


@pytest.mark.parametrize("texto", ["Aparelho elíptico", "Transport elíptico", "Elíptico magnético"])
def test_aparelho_eliptico_segura_forte_em_compra_hospitalar(texto):
    cat, _, por_item = _avaliar(HOSPITALAR, ["Tatame EVA 1x1 m 20 mm", texto])
    assert cat == "forte"
    assert por_item[2][0] == "forte"


def test_forma_eliptica_nao_tira_o_forte_que_vem_de_outro_termo():
    # #2106/#2107: o suporte continua forte pela anilha; só o "elíptico" (forma do metalon) deixa de contar
    texto = "Suporte de anilhas e barras - confeccionado em metalon em forma elíptica, suporte tipo pirâmide"
    assert classificar(texto) == "forte"
    assert not item_core(texto)

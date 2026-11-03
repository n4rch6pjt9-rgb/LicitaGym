"""Academia ao ar livre (ATI) fora do escopo (30/09/2026, decisão do Marcelo). Exceção: o mesmo texto cita
piso/grama da linha Playfit -> entra pelo piso (piso, obra_piso ou borracha), nunca como "forte"."""
import pytest

from coletor import pncp as P
from coletor.escopo import academia_ar_livre, classificar, classificar_texto_item


@pytest.mark.parametrize("texto", [
    "Aquisição de equipamentos para academia ao ar livre",
    "Registro de preços para aquisição de academias ao ar livre para praças do município",
    "Aquisição de ATI - academia da terceira idade",
    "Aquisição de academia da melhor idade com 10 aparelhos",
    "Equipamentos de ginástica ao ar livre em tubo galvanizado",
    "Aquisição de aparelhos para ATI em praças",
    "Academia de praça - kit com 8 aparelhos",
    "Leg press duplo para academia ao ar livre",
    "SIMULADOR DE CAVALGADA ACADEMIA AO AR LIVRE",
])
def test_academia_ao_ar_livre_pura_fica_fora(texto):
    assert academia_ar_livre(texto)
    assert classificar(texto) is None
    assert classificar_texto_item(texto)[0] is None


@pytest.mark.parametrize("texto,esperado", [
    ("Aquisição de academia ao ar livre com piso emborrachado", "piso"),
    ("Aquisição de piso para academia ao ar livre", "piso"),
    ("Aquisição de equipamentos de ginástica ao ar livre e grama sintética", "piso"),
    ("Academia da terceira idade com placas de borracha para piso", "piso"),
    ("Implantação de academia ao ar livre com piso emborrachado", "obra_piso"),
    ("Academia ao ar livre com piso de borracha reciclada SBR", "borracha"),
])
def test_academia_ao_ar_livre_com_piso_entra_pelo_piso_nunca_forte(texto, esperado):
    assert classificar(texto) == esperado


def test_compra_de_ati_nao_vira_forte_pelos_itens():
    compra = {"description": "Aquisição de academia ao ar livre para a Praça Central"}
    itens = [{"numeroItem": 1, "descricao": "LEG PRESS DUPLO"},
             {"numeroItem": 2, "descricao": "Remada sentada com pegador"},
             {"numeroItem": 3, "descricao": "Esteira ergométrica"}]
    cat, interesse, por_item = P.avaliar(compra, itens)
    assert cat is None and not interesse and all(c is None for c, _ in por_item.values())


def test_compra_de_ati_com_item_de_piso_vira_piso():
    compra = {"description": "Aquisição de academia ao ar livre para a Praça Central"}
    itens = [{"numeroItem": 1, "descricao": "LEG PRESS DUPLO"},
             {"numeroItem": 2, "descricao": "Piso emborrachado 50x50 cm espessura 25 mm"}]
    cat, interesse, por_item = P.avaliar(compra, itens)
    assert cat == "piso" and interesse and por_item[1][0] is None and por_item[2][0] == "piso"


@pytest.mark.parametrize("texto", [
    "Aquisição de equipamentos de academia",
    "Aquisição de equipamentos para a academia de ginástica do quartel",
    "Atividades ao ar livre: aquisição de bolas e redes",          # "ao ar livre" sem academia/ginástica
    "Placa de vídeo ATI Radeon",                                    # sigla sem contexto de aparelho
])
def test_academia_comum_e_ar_livre_solto_nao_sao_ati(texto):
    assert not academia_ar_livre(texto)

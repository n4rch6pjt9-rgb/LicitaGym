"""Brinquedo infantil fora do escopo (01/10/2026, decisão do Marcelo), no objeto e no item. Playground/parquinho,
cama elástica, gangorra e escorregador continuam no escopo nesta mudança. Textos de itens reais do PNCP."""
import pytest

from coletor.escopo import brinquedo_infantil, classificar, classificar_texto_item
from coletor.pncp import avaliar


@pytest.mark.parametrize("texto", [
    "PISCINA DE BOLINHAS COM 1500 BOLINHAS Piscina de bolinhas com estrutura de ferro galvanizado, em formato de casinha",
    "PISCINA DE BOLINHAS 02 x 02M BOLINHAS TATAME",
    "Aquisição de brinquedos infantis para os Centros Municipais de Educação Infantil",
    "Brinquedos pedagógicos para a brinquedoteca da escola",
    "Kit de jogos pedagógicos de encaixe em madeira",
    "Casinha de Brinquedo, Sem Cerquinha, confeccionada em plástico rotomoldado com aditivo UV",
    "Kit de brinquedos educativos com blocos de montar",
    "Bolinhas coloridas para piscina, pacote com 500 unidades",
])
def test_brinquedo_infantil_fica_fora_no_objeto_e_no_item(texto):
    assert brinquedo_infantil(texto)
    assert classificar(texto) is None
    assert classificar_texto_item(texto)[0] is None


@pytest.mark.parametrize("texto, esperado", [
    ("Playground infantil com escorregador e balanço (brinquedo infantil para praça)", "forte"),
    ("Brinquedos para playground: escorregador, gangorra e balanço", "forte"),
    ("CAMA ELÁSTICA PULA-PULA - diâmetro 3,70 m", "forte"),
    ("Gangorra dupla para crianças de 01 a 04 anos", "forte"),
    ("Escorregador infantil reto com 4 degraus", "forte"),
    ("Parque infantil em madeira com casinha de brinquedo e escorregador", "forte"),
])
def test_playground_cama_elastica_e_gangorra_continuam(texto, esperado):
    assert not brinquedo_infantil(texto)
    assert classificar(texto) == esperado


@pytest.mark.parametrize("texto, esperado", [
    ("Raia antimarola para piscina semiolímpica", "forte"),
    ("Aquisição de materiais esportivos para natação: pranchas e boias de piscina", "fraco"),
    ("Brinquedo inflável tobogã gigante", "fraco"),   # inflável sem "infantil": regra anterior (FRACO)
    ("Boneco de pancada para treino de boxe", None),                  # boneco (de treino) não é boneca
])
def test_piscina_esportiva_e_outros_nao_sao_brinquedo_infantil(texto, esperado):
    assert not brinquedo_infantil(texto)
    assert classificar(texto) == esperado


def _item(n, desc):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": "M"}


def test_compra_de_brinquedos_so_entra_pelos_itens_esportivos():
    compra = {"description": "Aquisição de brinquedos pedagógicos e materiais para a educação infantil"}
    so_brinquedo = [_item(1, "PISCINA DE BOLINHAS COM 1500 BOLINHAS"), _item(2, "Casinha de Brinquedo rotomoldada")]
    assert avaliar(compra, so_brinquedo)[0] is None
    assert avaliar(compra, so_brinquedo + [_item(3, "Bola de futebol de campo oficial")])[0] == "fraco"
    assert avaliar(compra, so_brinquedo + [_item(3, "Cama elástica pula-pula 3,05 m")])[0] == "forte"

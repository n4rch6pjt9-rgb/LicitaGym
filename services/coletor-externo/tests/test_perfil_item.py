"""Perfil do item (dicionário v0.3 + regra de família) e marca normalizada — textos reais do SFIEC PE000652022."""
import pytest

from coletor.fornecedores import linha_fornecedor
from coletor.perfil_item import normalizar_marca, perfil_item


@pytest.mark.parametrize("texto,familia,no", [
    ("AI0300075-MAQUINA PANTURRILHA EM PE", "equipamentos_fitness.musculacao", "panturrilha_em_pe"),
    ("AI0300161-CADEIRA FLEXORA CARGA 120KG", "equipamentos_fitness.musculacao", "cadeira_flexora"),
    ("AI0300147-AIR BIKE COM DISPLAY LCD", "equipamentos_fitness.cardio", "air_bike"),
    ("AI0300014-BANCO GRANDE REGULAVEL", "equipamentos_fitness.peso_livre", "banco_livre"),
    ("AI0300148-REMO", "equipamentos_fitness.cardio", "remo_ergometro"),      # complemento
    ("AI0300174-CADEIRA TRICEPS DIMENSAO", "equipamentos_fitness.musculacao", "triceps_maquina"),
    ("AI0300129-BALANCA ANTR ELETR DIG ACO CAR", "avaliacao_fisica", None),
])
def test_perfil_item(texto, familia, no):
    p = perfil_item(texto)
    assert p["familia_equipamento"] == familia and p["no_taxonomia"] == no
    assert p["perfil_metodo"] in (("dicionario", "complemento") if no else ("regra_perfil",))


def test_fonte_de_carga_quando_o_texto_diz():
    assert "placas" in (perfil_item("Cadeira extensora com bateria de pesos de 80 kg")["fonte_carga"] or "")


@pytest.mark.parametrize("bruta,norm", [("movement", "MOVEMENT"), ("MOVIMENT", "MOVEMENT"), ("MOVEMNT", "MOVEMENT"),
                                        ("MOVMENET", "MOVEMENT"), ("MOVIMENT ASSALT", "MOVEMENT"), ("Embreex", "EMBREEX"),
                                        ("PROMED", "PROMED"), ("", None), ("SIMAFI", "SIMAFI")])
def test_normalizar_marca(bruta, norm):
    assert normalizar_marca(bruta) == norm


def test_fabricante_pelo_cnae():
    fab = linha_fornecedor("06165288000130", {"cnae_fiscal": 3230200}, "brasilapi")
    rev = linha_fornecedor("01548177000190", {"cnae_fiscal": 4763602}, "brasilapi")
    assert fab["fabricante"] is True and rev["fabricante"] is False


def test_brl_no_log():
    from coletor.paradigma import brl
    assert brl(4674.5) == "R$ 4.674,50" and brl(1013305) == "R$ 1.013.305,00" and brl(None) == "-"


@pytest.mark.parametrize("bruta,norm", [("LYON", "LION"), ("SLADE-PUXADOR CORDA", "SLADE FITNESS"), ("CORDA DE PULAR", None),
                                        ("ANILHAS DE FERRO", None), ("IMP", None), ("LIVEUP", "LIVE UP"), ("G-TECH", "G-TECH"),
                                        ("FLEX", "FLEX EQUIPMENT")])
def test_marca_ruido_e_apelidos(bruta, norm):
    assert normalizar_marca(bruta) == norm


def test_complemento_triceps_e_supino_convergente():
    from coletor.perfil_item import perfil_item
    p = perfil_item("PR0000001 - CADEIRA TRICEPS")
    assert p["no_taxonomia"] == "triceps_maquina" and p["perfil_metodo"] == "complemento"
    assert p["produto_padronizado"]
    s = perfil_item("SUPINO RETO CONVERGENTE")
    assert s["no_taxonomia"] == "supino_maquina" and s["cinematica"] == "articulada"


def test_nome_exibicao_e_no_proposto():
    assert perfil_item("CADEIRA TRICEPS DIMENSAO")["produto_padronizado"] == "Máquina de Tríceps"
    b = perfil_item("AI0300197-BANCO NORDICO DENSIDADE AG120")
    assert b["no_taxonomia"] == "banco_nordico" and b["perfil_metodo"] == "complemento_no_proposto"

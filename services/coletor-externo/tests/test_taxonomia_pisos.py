"""Taxonomia de pisos, placas de borracha e grama sintética (linha Playfit): nó, segmento, prioridade e sinais de concorrente."""
import json

import pytest

from coletor.classificar_piso import TAXONOMIA_PISOS_ARQ, classificar_piso
from coletor.escopo import classificar, classificar_texto_item, excluir_compra
from coletor.perfil_item import perfil_item


@pytest.mark.parametrize("texto,contexto,slug,familia,prioridade", [
    ("Placa emborrachada 1000x1000x20 mm preta", None, "placa_emborrachada", "pisos_emborrachados.geral", "alta"),
    ("PISO EMBORRACHADO EM PLACAS 50X50 CM ESPESSURA 25MM", "Aquisição de piso para academia", "placa_emborrachada",
     "pisos_emborrachados.academia", "alta"),
    ("PISO SINTÉTICO, MATERIAL: BORRACHA , TAMANHO: 100 X 100 CM", None, "placa_emborrachada", "pisos_emborrachados.geral", "alta"),
    ("Placa de borracha 1x1m 40mm para creche", None, "placa_emborrachada", "pisos_emborrachados.playground", "alta"),
    ("Piso de borracha reciclada SBR 15 mm para área de peso livre", None, "piso_borracha_reciclada_sbr",
     "pisos_emborrachados.academia", "alta"),
    ("Piso de grânulos de pneus reciclados", None, "piso_borracha_reciclada_sbr", "pisos_emborrachados.geral", "alta"),
    ("Piso EPDM colorido moldado in loco para playground", None, "piso_epdm", "pisos_emborrachados.playground", "alta"),
    ("Piso para crossfit 20mm", None, "piso_emborrachado", "pisos_emborrachados.crossfit", "alta"),
    ("Piso emborrachado", "Reforma da praça do condomínio", "piso_emborrachado", "pisos_emborrachados.playground", "alta"),
    ("Borracha granulada SBR para reposição do campo sintético", None, "borracha_granulada", "pisos_emborrachados.geral", "alta"),
    ("Granulado de borracha colorido para paisagismo", None, "borracha_granulada", "pisos_emborrachados.paisagismo", "media"),
    ("Tapete de borracha para baia de cavalos 1,80 x 1,20 m", None, "tapete_borracha", "pisos_emborrachados.haras", "media"),
    ("Piso modular esportivo em polipropileno copolímero para quadra poliesportiva", None, "piso_modular_pp", "fora", "baixa"),
    ("Piso para quadra de futsal", None, "piso_modular_pp", "fora", "baixa"),
    # v0.2: grama sintética, granulado abreviado de catálogo e infill
    ("PRESTAÇÃO DE SERVIÇOS DE FORNECIMENTO E INSTALAÇÃO DE GRAMA SINTÉTICA", None, "grama_sintetica",
     "gramados_sinteticos.geral", "alta"),
    ("Manutenção de Campo de Gramado Sintético", None, "grama_sintetica", "gramados_sinteticos.geral", "alta"),
    ("Tapete de grama artificial 2x1m", None, "grama_sintetica", "gramados_sinteticos.geral", "alta"),
    ("Grama sintética 50 mm com preenchimento de borracha granulada SBR", None, "grama_sintetica",
     "gramados_sinteticos.geral", "alta"),
    ("Grama sintética com infill EPDM", None, "grama_sintetica", "gramados_sinteticos.geral", "alta"),
    ("BORRACHA GRANUL.P/GRAMA SINT.", None, "borracha_granulada", "pisos_emborrachados.geral", "alta"),
    ("Granulado de borracha SBR 1-3 mm para infill de campo society", None, "borracha_granulada",
     "pisos_emborrachados.geral", "alta"),
])
def test_classificar_piso(texto, contexto, slug, familia, prioridade):
    r = classificar_piso(texto, contexto)
    assert (r["slug"], r["familia"], r["prioridade"]) == (slug, familia, prioridade)


def test_borracha_explicita_vence_o_sinal_de_concorrente_com_confianca_media():
    r = classificar_piso("Piso esportivo modular de borracha para quadra de basquete")
    assert r["slug"] == "piso_emborrachado" and r["confianca"] == "media" and r["sinais_baixa"] == ["modalidades_de_quadra"]


@pytest.mark.parametrize("texto", ["Absorção de impacto", "Proteção contra impacto para segurança infantil",
                                   "ANILHA REVESTIDA DE BORRACHA 10 KG", "HALTERE REVESTIMENTO EMBORRACHADO",
                                   "Manta de borracha para esteira ergométrica", "PISO SINTÉTICO, MATERIAL: VINÍLICO",
                                   "Colchonete de ginástica"])
def test_nao_e_piso_de_borracha(texto):
    assert classificar_piso(texto) is None


def test_piso_moldado_in_loco_vira_sinal_de_contexto_e_obra_piso():
    r = classificar_piso("FORNECIMENTO E INSTALAÇÃO DE PISO EMBORRACHADO MONOLÍTICO")
    assert r["slug"] == "piso_emborrachado" and r["sinais_contexto"] == ["instalacao_in_loco"]
    assert classificar("FORNECIMENTO E INSTALAÇÃO DE PISO EMBORRACHADO MONOLÍTICO") == "obra_piso"
    assert classificar("Aquisição de piso emborrachado em placas 50x50") == "piso"
    assert classificar("SUBSTITUIÇÃO DO GRAMADO SINTÉTICO DA QUADRA DO SESC MAFRA") == "obra_piso"
    assert classificar("Substituição de lâmpadas da quadra") is None


def test_medidas_e_sinais_de_contexto():
    r = classificar_piso("Placa emborrachada 1x1 m 25 mm com absorção de impacto")
    assert r["medidas"] == {"placa": "1x1 m", "espessura_mm": "25 mm"} and r["sinais_contexto"] == ["impacto"]


def test_perfil_item_usa_a_taxonomia_de_pisos_e_mantem_as_chaves():
    p = perfil_item("PLACA EMBORRACHADA 50X50 20MM", contexto="piso para box de crossfit")
    assert p["no_taxonomia"] == "placa_emborrachada" and p["familia_equipamento"] == "pisos_emborrachados.crossfit"
    assert p["perfil_metodo"] == "taxonomia_pisos" and p["versao_taxonomia"] == "pisos-0.2"
    assert set(p) == set(perfil_item("AI0300148-REMO"))  # mesmas colunas de licitacao_itens
    assert perfil_item("AI0300148-REMO")["no_taxonomia"] == "remo_ergometro"


def test_nos_in_apontam_para_pdm_e_out_nao():
    d = json.loads(TAXONOMIA_PISOS_ARQ.read_text(encoding="utf-8"))
    for n in d["nos"]:
        assert bool(n["pdm_catmat"]) == (n["escopo"] == "IN"), n["slug"]


def test_escopo_da_linha_playfit():
    assert classificar("Aquisição de placas emborrachadas 1x1m para academia") == "piso"
    assert classificar("Aquisição de tapetes de borracha para baias do haras municipal") == "piso"
    assert classificar("Aquisição de piso SBR para o CT") == "borracha"
    assert classificar("Aquisição de grânulos de pneus reciclados") == "borracha"
    assert classificar("Aquisição de granulado de borracha para paisagismo") == "borracha"
    assert excluir_compra("Aquisição de granulado de borracha para paisagismo") is False
    assert excluir_compra("Serviços de paisagismo e jardinagem") is True
    assert classificar_texto_item("PLACA EMBORRACHADA 50X50 20MM")[0] == "piso"

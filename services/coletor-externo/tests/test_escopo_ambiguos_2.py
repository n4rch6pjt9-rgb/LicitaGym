"""Segunda rodada de termos ambíguos (reclassificação de 01/10/2026): cardio, elíptico, ergométrico, rolo de
espuma, tatame e escorregador só contam como 'forte' com o contexto certo. Textos de itens reais do PNCP
(descrição de produto, sem dados pessoais)."""
import pytest

from coletor.escopo import classificar, classificar_texto_item, e_peca, normalizar
from coletor.pncp import avaliar


@pytest.mark.parametrize("texto", [
    "DESFIBRLIADOR TIPO CARDIOVERSOR BIFÁSICO CARDIOVERSOR IMPLANTAVEL - tipo cardio-desfibrilador implantável (CDI)",
    "SONAR PORTÁTIL - com indicador digital de batimentos cardio-fetais, bateria recarregável",
    "Papel termossensível compatível com cardio touch 2000. Papel para ECG",
    "Máscara facial tipo duckbill. Em RCP (ressuscitação cardio-pulmonar), a pressão intrapulmonar",
])
def test_cardio_hospitalar_nao_e_academia(texto):
    assert classificar(texto) is None
    assert classificar_texto_item(texto)[0] is None


@pytest.mark.parametrize("texto", [
    "Equipamentos de cardio para academia municipal",
    "Esteira cardio profissional",
    "Bike cardio para condicionamento",
])
def test_cardio_de_academia_continua_forte(texto):
    assert classificar(texto) == "forte"


@pytest.mark.parametrize("texto", [
    "ROLO DE ESPUMA P/ PINTURA",
    "rolo espuma 23 cm c/ cabo",
    "Rolo espuma 09 cm s/cabo",
    "material: plastico, tipo: espaçador rolo de espuma sintética 15cm",
    "Rolo de espuma para posicionamento cirúrgico do paciente",
])
def test_rolo_de_espuma_de_pintura_ou_cirurgico_nao_e_academia(texto):
    assert classificar(texto) is None


@pytest.mark.parametrize("texto", [
    "Kit de rolo de espuma para massagem e treino muscular",
    "Rolo de espuma para liberação miofascial 45 cm",
    "Rolo espuma revestimento: napa, diâmetro: 30 cm",   # rolo de fisioterapia/pilates (PDM 17733)
    "Foam roller rolo de espuma pilates",
])
def test_rolo_de_espuma_de_treino_continua_forte(texto):
    assert classificar(texto) == "forte"


@pytest.mark.parametrize("texto", [
    "CONJUNTO ESCOLAR INFANTIL SEXTAVADO: 6 mesas, 6 cadeiras; tampo com cavidade elíptica para encaixe de porta lápis",
    "Mesa com travessa inferior de tubo de aço elíptico SAE 1020 20x45mm",
    "Estrutura em aço carbono de seção elíptica, cuja medida é 20 x 45",
    "Lixeira removível com formato elíptico medindo 100mmx40mmx100mm",
    "Cadeira para obeso com base elíptica reforçada",
])
def test_eliptico_de_movel_ou_perfil_nao_e_academia(texto):
    assert classificar(texto) is None
    assert classificar_texto_item(texto)[0] is None


@pytest.mark.parametrize("texto", [
    "Elíptico profissional eletromagnético",
    "Equipamento para condicionamento físico tipo: elíptico profissional",
    "Transport elíptico com monitor",
    "ELIPTICO",
])
def test_eliptico_aparelho_continua_forte(texto):
    assert classificar(texto) == "forte"


@pytest.mark.parametrize("texto", [
    "BANCO ERGOMETRICO - estrutura resistente; revestimento impermeável; indicado para exames",
    "Cadeira giratória, ergométrica, concha dupla; com encosto e assento",
    "Contratação de clínica para realização de teste ergométrico",
    "Serviço de ergometria para servidores",
])
def test_ergometrico_nao_aparelho_nao_e_academia(texto):
    assert classificar(texto) is None


@pytest.mark.parametrize("texto", [
    "Bicicleta ergométrica horizontal com monitor digital",
    "Mini bicicleta ergométrica bike pedalinho ciclo ergômetro",
    "Esteira ergométrica para exercícios de reabilitação física",
])
def test_ergometrico_aparelho_continua_forte(texto):
    assert classificar(texto) == "forte"


def test_bicicleta_ergometrica_com_banco_estofado_e_equipamento_nao_peca():
    assert not e_peca(normalizar("Bicicleta ergométrica vertical com banco estofado"))
    assert e_peca(normalizar("Estofamento para bicicleta ergométrica"))


@pytest.mark.parametrize("texto", [
    "Kit de tatames sensoriais com 15 texturas - 50x50 cm",
    "Tapete infantil tatame impermeável dobrável XPE emborrachado",
    "Tatame de letras e números em EVA para creche",
])
def test_tatame_infantil_ou_sensorial_nao_e_academia(texto):
    assert classificar(texto) is None


@pytest.mark.parametrize("texto", [
    "Tatame em EVA 1m x 1m espessura 20 mm",
    "Tatames para lutas, com 8 unidades",
    "Tatame esportivo fabricado em E.V.A.",
    "Tatame infantil para judô 40 mm",
])
def test_tatame_esportivo_continua_forte(texto):
    assert classificar(texto) == "forte"


def test_escorregador_de_batedeira_e_antiescorregador_nao_sao_playground():
    assert classificar("BATEDEIRA PLANETÁRIA INDUSTRIAL 12 L, com batedores (globo, raquete e espiral), "
                       "escorregador para ingredientes, com segurança") is None
    assert classificar("Tapete antiescorregador para banheiro") is None
    assert classificar("Escorregador infantil reto com 4 degraus") == "forte"
    assert classificar("Escorregador de plástico médio com 3 degraus antiderrapantes") == "forte"


def _item(n, desc):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": "M"}


def test_compra_mista_so_com_falso_positivo_sai_do_escopo():
    compra = {"description": "Registro de preços para aquisição de materiais permanentes"}
    cat, _, _ = avaliar(compra, [_item(1, "DESFIBRLIADOR TIPO CARDIOVERSOR cardio-desfibrilador implantável"),
                                 _item(2, "ROLO DE ESPUMA P/ PINTURA")])
    assert cat is None
    cat, _, _ = avaliar(compra, [_item(1, "ROLO DE ESPUMA P/ PINTURA"), _item(2, "KIT 2 PARES HALTER SEXTAVADO 1KG")])
    assert cat == "forte"


def test_item_bicicleta_ergometrica_com_alimentacao_eletrica_continua_forte_no_item():
    # classificar() devolve None por "alimentação" (FORA, comportamento anterior); o item continua forte por regra_item
    assert classificar_texto_item("Bicicleta ergométrica horizontal magnética, alimentação elétrica bivolt")[0] == "forte"
    assert classificar_texto_item("Banco ergométrico indicado para exames, alimentação elétrica")[0] is None


def test_avaliar_aplica_fallback_de_item_para_bicicleta_ergometrica():
    compra = {"description": "Aquisição de materiais permanentes"}
    cat, _, por_item = avaliar(compra, [
        _item(1, "Bicicleta ergométrica horizontal magnética, alimentação elétrica bivolt"),
    ])
    assert cat == "forte"
    assert por_item[1][0] == "forte"


def test_tatame_colado_em_quebra_de_linha_e_cone_dobravel():
    assert classificar("TATAMEx000D Especificações mínimas: EVA 20 mm") == "forte"
    assert classificar("Cone dobrável para atividade física; acompanha tatame esportivo") == "forte"

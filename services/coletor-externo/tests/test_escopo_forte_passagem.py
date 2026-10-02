"""Quarta rodada (02/10/2026): "forte" que entrava por item de passagem. Em compra de mobiliário, brinquedos, material
de expediente ou material hospitalar a linha só fica "forte" com item core de equipamento (esteira, bicicleta
ergométrica/spinning, elíptico, musculação, piso de borracha); sem core, cai para "fraco". Puxador é termo positivo
da categoria acessórios (pegador de polia), mas não é core. Casos sintéticos, sem dado real."""
from datetime import datetime, timezone

import pytest

from coletor import pncp as P
from coletor import reclassificar_escopo_pncp as R
from coletor.escopo import classificar, item_core, objeto_esportivo, objeto_passagem
from coletor.perfil_item import perfil_item

MOVEIS = "Registro de preços para aquisição de mobiliário escolar e móveis para as secretarias municipais"
EXPEDIENTE = "Aquisição de materiais de expediente e papelaria para a administração"
HOSPITALAR = "Aquisição de material médico-hospitalar para as unidades de saúde"
BRINQUEDOS = "Aquisição de brinquedos e jogos pedagógicos para as escolas"
ESPORTIVO_MISTO = "Aquisição de material de expediente e material esportivo para os projetos sociais"


def _avaliar(objeto, itens):
    """itens: texto (material) ou (texto, 'M'|'S')."""
    lst = []
    for n, it in enumerate(itens, 1):
        desc, ms = (it, "M") if isinstance(it, str) else it
        lst.append({"numeroItem": n, "descricao": desc, "materialOuServico": ms})
    return P.avaliar({"description": objeto}, lst)


@pytest.mark.parametrize("objeto,grupo", [
    (MOVEIS, "mobiliario"), (EXPEDIENTE, "expediente"), (HOSPITALAR, "hospitalar"), (BRINQUEDOS, "brinquedo"),
    ("Aquisição de equipamentos de fisioterapia e reabilitação", "hospitalar"),
    ("Aquisição de materiais diversos destinados à implantação e manutenção das atividades pedagógicas", "brinquedo"),
])
def test_objeto_de_passagem(objeto, grupo):
    assert grupo in objeto_passagem(objeto)


@pytest.mark.parametrize("objeto", [
    "Aquisição de materiais esportivos para as escolas municipais",
    "Aquisição de equipamentos de academia",
    "Alienação de bens móveis inservíveis",              # bens móveis não é mobiliário (e já fica fora por venda)
    "Aquisição de brinquedos para playground da praça central",   # playground continua escopo
    "Eventual aquisição de material de consumo para atividades de manobra e patrulhamento",
    "Manutenção e Reparo de Material Esportivo / Brinquedo",          # serviço de manutenção, não compra de brinquedo
    "Prestação de serviços para manutenção e reparo de equipamentos hospitalares e de fisioterapia",
])
def test_objeto_que_nao_e_de_passagem(objeto):
    assert objeto_passagem(objeto) == []


# mobiliário com só item de passagem -> rebaixa
def test_mobiliario_so_com_item_de_passagem_rebaixa():
    itens = ["Mesa escolar com tampo em MDF", "Banco sueco de madeira 3 m", "Tatame EVA 1x1 m 20 mm para judô"]
    assert _avaliar("Aquisição de equipamentos esportivos", itens[1:])[0] == "forte"   # fora da passagem: forte
    cat, _, por_item = _avaliar(MOVEIS, itens)
    assert cat == "fraco"
    assert "forte" not in {c for c, _ in por_item.values()}


# mobiliário com esteira -> continua forte
@pytest.mark.parametrize("core", [
    "ESTEIRA ERGOMÉTRICA ELÉTRICA PROFISSIONAL 3 HP",
    "Bicicleta ergométrica vertical magnética",
    "Bike spinning com roda de inércia 18 kg",
    "Aparelho elíptico magnético com display",
    "Estação de musculação com 4 posições",
    "Par de halteres emborrachados 5 kg",
    "Piso de borracha 20 mm para academia 1x1 m",
    "Bicicleta ergométrica profissional com programas de treinamento e display com cronômetro",
])
def test_mobiliario_com_item_core_continua_forte(core):
    assert item_core(core)
    cat, _, _ = _avaliar(MOVEIS, ["Cadeira fixa empilhável", "Banco sueco de madeira 3 m", core])
    assert cat in ("forte", "piso")


# material esportivo com tatame -> continua forte (casos #562/#564)
def test_material_esportivo_com_tatame_continua_forte():
    tatame = "Tatame EVA 1x1 m 40 mm para lutas"
    assert objeto_esportivo(ESPORTIVO_MISTO) and objeto_passagem(ESPORTIVO_MISTO)
    assert item_core(tatame, esportivo=True) and not item_core(tatame)
    assert _avaliar(ESPORTIVO_MISTO, ["Caneta esferográfica azul", tatame])[0] == "forte"
    # compra de material esportivo/instrução (fora da passagem): a regra nem se aplica
    assert _avaliar("Aquisição de material de instrução e ensino", [tatame, "Rede esportiva de vôlei"])[0] == "forte"


# hospitalar sem core -> rebaixa
def test_hospitalar_sem_core_rebaixa():
    itens = ["Luva de procedimento tamanho M", "Colchonete para ginástica e exercícios 1,00 x 0,50 m",
             "Bola suíça de pilates 65 cm"]
    assert _avaliar("Aquisição de materiais para a academia municipal", itens[1:])[0] == "forte"
    assert _avaliar(HOSPITALAR, itens)[0] == "fraco"
    assert _avaliar(HOSPITALAR, itens + ["Bicicleta ergométrica horizontal para reabilitação"])[0] == "forte"


# serviço não conta como core
def test_servico_nao_conta_como_core():
    itens = ["Colchonete para ginástica e exercícios", ("Manutenção corretiva de esteira ergométrica elétrica", "S")]
    assert _avaliar(HOSPITALAR, itens)[0] == "fraco"
    assert _avaliar(HOSPITALAR, [itens[0], ("Esteira ergométrica elétrica 2 HP", "M")])[0] == "forte"


def test_expediente_e_brinquedos_sem_core_rebaixam():
    assert _avaliar(EXPEDIENTE, ["Papel A4 resma", "Bambolê infantil colorido"])[0] == "fraco"
    assert _avaliar(BRINQUEDOS, ["Cama elástica 3,05 m", "Mesa de pebolim"])[0] == "fraco"
    assert _avaliar(BRINQUEDOS, ["Cama elástica 3,05 m", "Esteira elétrica dobrável"])[0] == "forte"


def test_objeto_com_core_segura_o_forte():
    objeto = "Aquisição de mobiliário e equipamentos de musculação para o centro esportivo"
    assert _avaliar(objeto, ["Cadeira fixa empilhável", "Colchonete para ginástica"])[0] == "forte"


def test_academia_ao_ar_livre_em_compra_de_passagem_so_conta_pelo_piso():
    objeto = "Aquisição de mobiliário urbano e academia ao ar livre"
    assert _avaliar(objeto, ["Leg press duplo para academia ao ar livre"])[0] is None
    assert _avaliar(objeto, ["Piso emborrachado 50 mm para academia ao ar livre"])[0] == "piso"


def test_termo_de_busca_sozinho_nao_faz_forte():
    linha = {"id": 9001, "codigo_externo": "12345678000199-1-009001/2026", "objeto": MOVEIS,
             "categoria_escopo": "forte", "interesse_borracha": False, "prioridade": "leads",
             "termos_busca": ["esteira ergométrica", "tatame"], "situacao": "Divulgada no PNCP", "raw": {},
             "licitacao_itens": [{"id": 1, "numero_item": 1, "descricao": "Banco sueco de madeira 3 m",
                                  "material_ou_servico": "M", "categoria_escopo": "forte"}]}
    r = R.reavaliar(linha, None, datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc))
    assert r["categoria_depois"] == "fraco"


def test_objeto_de_passagem_sem_itens_nao_decide_pelo_objeto():
    linha = {"id": 9002, "objeto": "Aquisição de mobiliário e materiais de ginástica", "categoria_escopo": "forte"}
    assert classificar(linha["objeto"]) == "forte"
    assert not R.objeto_decide(linha)


# ---------------- puxador: termo positivo da categoria acessórios (decisão do Marcelo, 02/10/2026) ----------------
@pytest.mark.parametrize("texto", [
    "PUXADOR TRICEPS CORDA",
    "Puxador romano cromado",
    "Barra para puxador W",
    "Puxador com pegada neutra",
    "Puxador triângulo em aço cromado",
    "puxador reto para polia",
])
def test_puxador_acessorio_e_positivo(texto):
    assert classificar(texto) == "forte"
    assert perfil_item(texto)["familia_equipamento"] == "equipamentos_fitness.acessorios"
    assert _avaliar("Aquisição de acessórios para a academia municipal", [texto])[0] == "forte"


@pytest.mark.parametrize("texto", [
    "PUXADOR DE ALUMINIO PARA PORTA", "puxador para gaveta inox", "Puxador concha 96 mm", "PUXADOR",
    "Puxador tipo alça com pegada ergonômica 128 mm", "Armário de aço com puxador e corda de segurança",
])
def test_puxador_de_porta_gaveta_ou_movel_continua_fora(texto):
    assert classificar(texto) is None


@pytest.mark.parametrize("objeto", [MOVEIS, EXPEDIENTE, HOSPITALAR])
def test_puxador_nao_faz_forte_em_compra_de_passagem(objeto):
    for itens in (["PUXADOR TRICEPS CORDA"], ["Puxador alto com polia para estação"], ["Puxador de alumínio para porta"]):
        assert not item_core(itens[0])
        assert _avaliar(objeto, itens)[0] != "forte"


def test_servico_com_texto_de_equipamento_nao_e_core():
    # "equipamentos" no texto do serviço não o torna material para a regra do core
    itens = ["Tatame EVA 1x1 m 20 mm", ("Manutenção de equipamentos de musculação e esteiras ergométricas", "S")]
    assert _avaliar(BRINQUEDOS, itens)[0] == "fraco"


@pytest.mark.parametrize("texto", [
    "Lona de algodão tipo lonita para aplicação em placas de borracha (chinelo) artesanato",
    "Escada em inox com 2 degraus revestidos com piso de borracha antiderrapante",
    "Cadeira fixa empilhável com furos de aeração em desenho elíptico",
    "Switch 8 portas RJ45 com detecção automática do cabo (normal/crossover)",
    "Anilha de vedação de latão 1/2 polegada",
    "Cadeira ergométrica executiva giratória com rodízio",
])
def test_falso_core(texto):
    assert not item_core(texto, esportivo=True)


# musculação/academia citada como uso ou aplicação de um acessório não é core (revisão do dry-run de 02/10/2026)
@pytest.mark.parametrize("texto", [
    "Caneleiras com carga de 1 kg cada, fechamento em velcro, fácil de higienizar, indicada para treinamentos "
    "funcionais, musculação e condicionamento físico",
    "Aparelho / Acessório - Acondicionamento Físico tipo: faixa elástica, uso: equipamentos de academia para treino "
    "funcional",
    "Aparelho / Acessório - Acondicionamento Físico tipo: bolsa (power bag/sand bag), uso: equipamentos de academia",
    "Mosquetão de aço galvanizado, para aparelhos de musculação, academia, cadeiras de balanço, redes",
    "Kit mini band com cinco faixas elásticas, melhor custo-benefício se comparado com aparelhos de musculação",
    "Protetor adulto em polímero viscoelástico, hipoalergênico, cabeça supino",
])
def test_musculacao_como_uso_de_acessorio_nao_e_core(texto):
    assert not item_core(texto)


@pytest.mark.parametrize("texto", [
    "Aparelhos de Musculação, suporte bola, capacidade de carga 400 kg, em ferro",
    "Equipamento para ginástica e musculação - identificação: cadeira extensora",
    "Aparelho de musculação profissional conjugado",
    "Banco para treino de musculação com encosto e assento reguláveis",
    "Banco supino reto com suporte para barra",
    "Equipamentos de academia: estação multifuncional",
])
def test_musculacao_como_o_proprio_item_continua_core(texto):
    assert item_core(texto)


def test_acessorio_com_uso_em_academia_nao_segura_forte_em_compra_hospitalar():
    itens = ["Caneleiras com carga de 2 kg, indicada para treinamentos funcionais, musculação e condicionamento físico",
             "Luva de procedimento em látex, tamanho M"]
    assert _avaliar(HOSPITALAR, itens)[0] == "fraco"
    assert _avaliar(HOSPITALAR, itens + ["Halter emborrachado 2 kg"])[0] == "forte"


# v2 (decisão do Marcelo, 02/10/2026): polia e espaldar são core; Pilates e o "aparelho para condicionamento físico"
# genérico não são
POLIAS = [
    "Aparelho / Equipamento Para Condicionamento Físico tipo: polia conjugada, material: aço carbono",
    "Polia regulável 70 kg com bateria de cargas de ferro emborrachada",
    "Polia de ombro para fisioterapia com corda de nylon e âncora de porta",
    "Gaiola de agachamento com polia mono cross",
]


@pytest.mark.parametrize("objeto", [MOVEIS, EXPEDIENTE, HOSPITALAR])
@pytest.mark.parametrize("polia", POLIAS)
def test_polia_segura_forte_em_compra_de_passagem(objeto, polia):
    itens = ["Tatame EVA 1x1 m 20 mm", "Colchonete de espuma para ginástica", polia]
    assert _avaliar(objeto, itens[:2])[0] == "fraco"
    assert _avaliar(objeto, itens)[0] == "forte"


@pytest.mark.parametrize("objeto", [MOVEIS, EXPEDIENTE, HOSPITALAR])
@pytest.mark.parametrize("espaldar", [
    "ESPALDAR",
    "Espaldar em madeira (barra/escada de Ling) com 11 barras horizontais, fixação em parede",
    "Espaldar fixo para fisioterapia (barra de Ling) confeccionado em madeira",
    "Barra de Ling/Espaldar, estrutura em madeira, 12 barras de apoio",
])
def test_espaldar_segura_forte(objeto, espaldar):
    assert item_core(espaldar)
    assert _avaliar(objeto, ["Tatame EVA 1x1 m 20 mm", espaldar])[0] == "forte"


@pytest.mark.parametrize("texto", [
    "Batedeira planetária industrial com variação de velocidade por meio de polia variadora",
    "Puxador corda unilateral. Equipamento acessório para puxadas em aparelho de polia",
    "Tornozeleira para glúteos. Equipamento acessório para aparelho de polia",
    "Cadeira giratória, espaldar médio, com braços",
    "Cadeira fixa empilhável sem braços, de espaldar baixo, com assento e encosto em polipropileno",
    "Poltrona com assento e encosto em couro, tipo espaldar: alto",
])
def test_polia_e_espaldar_que_nao_sao_equipamento(texto):
    assert not item_core(texto)


PILATES_ITENS = [
    "Aparelho de Pilates Reformer com polias e molas",
    "Cadillac de Pilates com estrutura em aço, molas e polias",
    "Ladder Barrel: barril estofado e uma escada de madeira (espaldar)",
    "Step Chair para Pilates",
    "Kit Studio Cross Pilates",
]


@pytest.mark.parametrize("objeto", [MOVEIS, EXPEDIENTE, HOSPITALAR])
@pytest.mark.parametrize("pilates", PILATES_ITENS)
def test_pilates_nao_segura_forte(objeto, pilates):
    assert not item_core(pilates)
    assert _avaliar(objeto, ["Tatame EVA 1x1 m 20 mm", pilates])[0] != "forte"


@pytest.mark.parametrize("texto", [
    "Aparelho / Equipamento Para Condicionamento Físico tipo: step, material: plástico",
    "Aparelho, equipamento para condicionamento físico, tipo: bola suíça 65 cm",
])
def test_condicionamento_fisico_generico_nao_segura_forte(texto):
    assert not item_core(texto)
    assert _avaliar(HOSPITALAR, [texto])[0] == "fraco"


def test_espaldar_avulso_segura_forte_mesmo_com_pilates_na_compra():
    # #1394: Reformer não é core, mas o espaldar (barra de Ling) do mesmo pregão é
    itens = ["Aparelho de Pilates Reformer", "Espaldar barra de Ling, estrutura em madeira com 12 barras"]
    assert _avaliar(HOSPITALAR, itens[:1])[0] != "forte"
    assert _avaliar(HOSPITALAR, itens)[0] == "forte"

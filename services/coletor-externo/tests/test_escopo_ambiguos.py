"""Termos ambíguos do escopo (rodada de produção de 30/09/2026): puxador, cross over, SBR/EPDM, step, totó.

Na rodada da noite, 284 dos 507 leads gravados eram compras com "puxador" de porta/gaveta/armário
classificadas como "forte" (aparelho de academia)."""
import pytest

from coletor import pncp as P
from coletor.escopo import classificar, classificar_texto_item, forte_ambiguo, interesse_borracha, normalizar

# Exemplos reais da rodada de 30/09/2026 (descrição de item no PNCP)
PUXADOR_FERRAGEM = [
    "PUXADOR DE ALUMINIO PARA PORTA",
    "puxador para gaveta inox",
    "Puxador para armário de aço 128 mm",
    "PUXADOR TIPO ALÇA PARA MÓVEIS, EM AÇO INOX",
    "Ferragens para marcenaria: puxador, dobradiça e corrediça",
    "Puxador para janela de correr",
    "Puxador de porta de vidro temperado 30 cm",
    "PUXADOR PARA PORTÃO",
]
PUXADOR_SEM_CONTEXTO = [
    "PUXADOR", "Puxador cromado 96mm", "puxador em aço inox escovado",
    "Corda para puxador de partida retrátil de motor",
]
PUXADOR_ACADEMIA = [
    "Puxador alto e baixo",
    "PUXADOR ALTO COM POLIA, ESTRUTURA EM AÇO",
    "PUXADOR TRIÂNGULO PARA REMADA",
    "Puxador costas articulado",
    "Puxador remada baixa",
    "Estação de musculação com puxador",
    "Puxador para estação de musculação",
    "Puxador alto para academia",
    "Puxador cross over",
    "Aparelho de musculação puxador dorsal",
    "Puxador com suporte porta-anilhas",
]


@pytest.mark.parametrize("texto", PUXADOR_FERRAGEM + PUXADOR_SEM_CONTEXTO)
def test_puxador_de_ferragem_ou_sem_contexto_nao_e_forte(texto):
    assert classificar(texto) is None
    assert classificar_texto_item(texto)[0] is None
    assert classificar_texto_item(texto, contexto=True)[0] is None
    assert not forte_ambiguo(normalizar(texto))


@pytest.mark.parametrize("texto", PUXADOR_ACADEMIA)
def test_puxador_com_contexto_de_academia_e_forte(texto):
    assert classificar(texto) == "forte"
    assert classificar_texto_item(texto)[0] == "forte"


def test_porta_de_academia_nao_vira_aparelho_mas_objeto_de_academia_continua():
    assert classificar("Puxador para porta da academia") is None
    assert classificar("Aquisição de equipamentos de academia: puxador alto, leg press e supino") == "forte"


def test_peca_de_puxador_continua_manutencao_e_aparelho_continua_equipamento():
    assert classificar_texto_item("PEGADOR PARA PUXADOR ALTO", contexto=True) == ("manutencao", "regra_item")
    assert classificar_texto_item("CABO DE AÇO PARA PUXADOR ALTO", contexto=True) == ("manutencao", "regra_item")
    assert classificar_texto_item("PUXADOR ALTO COM POLIA E CABO DE AÇO", contexto=True)[0] == "forte"


def test_avaliar_compra_de_mobiliario_com_puxador_de_porta_fica_fora():
    compra = {"description": "Registro de preços para aquisição de materiais de construção"}
    itens = [{"numeroItem": 1, "descricao": "PUXADOR DE ALUMINIO PARA PORTA"},
             {"numeroItem": 2, "descricao": "puxador para gaveta inox"},
             {"numeroItem": 3, "descricao": "Dobradiça 3 polegadas"}]
    cat, interesse, por_item = P.avaliar(compra, itens)
    assert cat is None and not interesse and all(c is None for c, _ in por_item.values())


def test_avaliar_compra_generica_com_puxador_de_academia_entra():
    compra = {"description": "Aquisição de equipamentos e material permanente"}
    itens = [{"numeroItem": 1, "descricao": "Armário de aço com puxador"},
             {"numeroItem": 2, "descricao": "PUXADOR ALTO E BAIXO COM POLIA, CARGA 80 KG"}]
    cat, _, por_item = P.avaliar(compra, itens)
    assert cat == "forte" and por_item[1][0] is None and por_item[2][0] == "forte"


@pytest.mark.parametrize("texto,esperado", [
    ("Cross over 4 estações", "forte"),
    ("Aparelho cross over com polias", "forte"),
    ("Cabo crossover cat6 2 metros", None),
    ("Cabo de rede crossover RJ45", None),
    ("Crossover de áudio 3 vias para caixa acústica", None),
])
def test_cross_over_e_aparelho_salvo_cabo_de_rede_ou_audio(texto, esperado):
    assert classificar(texto) == esperado


@pytest.mark.parametrize("texto", [
    "Adesivo SBR para argamassa e chapisco, balde 18 litros",
    "Aditivo SBR para concreto",
    "Manta EPDM para impermeabilização de laje",
    "Perfil de borracha EPDM para esquadria de alumínio",
    "Gaxeta EPDM para porta de câmara fria",
    "Mangueira EPDM 1/2 polegada",
    "SBR", "EPDM", "Borracha EPDM",
])
def test_sbr_epdm_sem_contexto_ou_de_construcao_nao_e_borracha(texto):
    assert classificar(texto) is None
    assert interesse_borracha(texto) is False


@pytest.mark.parametrize("texto", [
    "Borracha granulada SBR para reposição do campo sintético",
    "Granulado EPDM para grama sintética",
    "Grama sintética com infill EPDM",
    "Piso EPDM colorido para playground",
    "Aquisição de piso SBR para o CT",
    "EPDM para grama sintética",
])
def test_sbr_epdm_com_contexto_de_piso_ou_grama_continua_borracha(texto):
    assert classificar(texto) == "borracha"
    assert interesse_borracha(texto) is True


@pytest.mark.parametrize("texto", ["Step", "Totó", "STEP MOTOR NEMA 17", "Conversor step-down 12V", "Mesa de pebolim (totó)"])
def test_step_e_toto_sem_contexto_nao_sao_forte(texto):
    assert classificar(texto) != "forte"


def test_step_com_contexto_continua_forte():
    assert classificar("Step em EVA para ginástica aeróbica") == "forte"
    assert classificar_texto_item("STEP 20CM EM EVA")[0] == "forte"


# Itens reais da rodada de 30/09/2026 que mantinham compras de mobiliário/informática como "forte"
@pytest.mark.parametrize("texto", [
    "IMPRESSORA MULTIFUNCIONAL LASER DE MÉDIO PORTE",
    "Mesa Funcional-Sistema Modular acabamento da estrutura: pintura eletrostática",
    "CADEIRA ERGONÔMICA GIRATÓRIA PARA ESCRITÓRIO NA COR PRETA, COM ESTRUTURA ROBUSTA E DESIGN FUNCIONAL",
    "KIT DE LIMPEZA PROFISSIONAL Composto por carro funcional para limpeza",
    "GUARDA-ROUPA MODULAR MULTIFUNCIONAL",
    "Colchonete para repouso, fabricado com espuma D23, revestido em courvin lavável",
    "Colchonete tipo trocador para creches",
    "Colchonete- Colchonete med. 78x188x3,3cm, enchimento com espuma D33",
    "CAIXA PLASTICAS 372 LITROS COM TAMPA E PUXADOR FRONTAL",
])
def test_funcional_colchonete_e_puxador_de_utilidade_sem_contexto_nao_sao_forte(texto):
    assert classificar(texto) is None


@pytest.mark.parametrize("texto", [
    "Kit para treinamento funcional com cordas e cones",
    "Aquisição de materiais para treino funcional",
    "Rack funcional com barras",
    "Colchonete para ginástica em napa 100x50 cm",
    "Colchonete de EVA para pilates e alongamento",
    "Aquisição de tatames e colchonetes",
])
def test_funcional_e_colchonete_com_contexto_continuam_forte(texto):
    assert classificar(texto) == "forte"

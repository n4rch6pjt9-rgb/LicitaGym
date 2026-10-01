"""Serviço de pessoas sem material não é oportunidade (30/09/2026, pedido do Marcelo: ele vende produtos do
CATMAT, não serviços). Caso real: id 229, Município de Angatuba/SP (46634234000191-1-000058/2025), modalidade
Credenciamento, termos_busca ["treinamento funcional"], gravado como "forte"/leads pelos itens de oficineiro."""
import pytest

from coletor import pncp as P
from coletor.escopo import classificar, servico_sem_material

ANGATUBA = {
    "numero_controle_pncp": "46634234000191-1-000058/2025", "orgao_cnpj": "46634234000191", "ano": 2025,
    "numero_sequencial": 58, "modalidade_licitacao_nome": "Credenciamento",
    "description": "Credenciamento de Oficineiros para atender ao Serviço de Convivência e Fortalecimento de Vínculos "
                   "(SCFV) através de seus núcleos vinculado à Secretaria de Desenvolvimento Social e da demanda de "
                   "aulas da Secretaria de Esporte e Lazer",
    "data_fim_vigencia": "9999-12-31T23:59",
}
# Itens reais (PNCP /itens, 30/09/2026): todos materialOuServico = "S"
ITENS_ANGATUBA = [
    {"numeroItem": n, "materialOuServico": "S", "materialOuServicoNome": "Serviço",
     "descricao": f"CONTRATAÇAO DE PROFISSIONAL PARA EXERCER ATIVIDADES COMO OFICINEIRO (A) DE {d}"}
    for n, d in [(1, "PINTURA"), (3, "GINASTICA"), (6, "TREINAMENTO FUNCIONAL"), (12, "GINÁSTICA RITMICA")]
]


def test_angatuba_credenciamento_de_oficineiros_fica_fora():
    cat, interesse, por_item = P.avaliar(ANGATUBA, ITENS_ANGATUBA)
    assert cat is None and not interesse and all(c is None for c, _ in por_item.values())


def test_termo_de_busca_nao_classifica():
    """O termo que achou a compra não entra na classificação: só objeto e itens."""
    from unittest.mock import MagicMock
    p = MagicMock()
    p.buscar.return_value = {"items": [ANGATUBA], "total": 1}
    p.itens.return_value = ITENS_ANGATUBA
    r = P.coletar(p, None, None, ["treinamento funcional"], "recebendo_proposta", 1, 50, True, False, 10**8,
                  dry_run=True)
    assert r["fora"] == 1 and r["no_escopo"] == 0


def test_item_servico_sem_material_nao_conta_mesmo_com_objeto_generico():
    compra = {"description": "Contratação para atender a Secretaria de Esporte e Lazer"}
    itens = [{"numeroItem": 1, "materialOuServico": "S", "descricao": "Treinamento funcional para grupos de idosos"},
             # Jaguariúna/SP: aula marcada como material ("M") também fica fora pelo texto
             {"numeroItem": 2, "materialOuServico": "M", "descricao": "AULA MINISTRADA\r\nPilates."}]
    cat, _, por_item = P.avaliar(compra, itens)
    assert cat is None and por_item == {1: (None, False), 2: (None, False)}


def test_item_servico_com_fornecimento_de_equipamento_continua():
    compra = {"description": "Implantação de sala de musculação no ginásio municipal"}
    itens = [{"numeroItem": 1, "materialOuServico": "S",
              "descricao": "Fornecimento e instalação de equipamentos de musculação"}]
    assert P.avaliar(compra, itens)[0] == "forte"


def test_item_servico_de_piso_continua_pela_borracha():
    compra = {"description": "Reforma da quadra"}
    itens = [{"numeroItem": 1, "materialOuServico": "S", "descricao": "Execução de piso emborrachado em EPDM"}]
    assert P.avaliar(compra, itens)[0] == "borracha"


@pytest.mark.parametrize("objeto", [
    ANGATUBA["description"],
    "Credenciamento de oficineiros esportivos/instrutores interessados em prestar serviços para a municipalidade",
    "Credenciamento para seleção de profissionais interessados em prestar serviços como Profissional de Educação "
    "Física e Instrutor de Atividades Físicas e Esportivas",
    "Credenciamento para a contratação de estabelecimentos prestadores de serviços de atividade física (academias, "
    "centros de ginástica, espaços de condicionamento físico) para oferta de vagas subsidiadas",
    "Contratação de empresas especializadas para o fornecimento de vagas em academias e estúdios de atividades físicas",
    "Contratação de pessoa jurídica para prestação de serviços de OFICINA DE GINASTICA, OFICINA DE DANÇA",
    "FORNECIMENTO DE SERVIÇOS DE EDUCADOR FÍSICO PARA AULAS DE HIDROGINÁSTICA",
    "Credenciamento de profissionais para prestação de serviços com Oficinas de Treinamento Funcional",
])
def test_servico_de_pessoas_sem_material_nao_e_forte(objeto):
    assert servico_sem_material(objeto)
    assert classificar(objeto) is None
    assert P.avaliar({"description": objeto}, [{"numeroItem": 1, "descricao": "Treinamento funcional"}])[0] is None


@pytest.mark.parametrize("objeto,esperado", [
    ("Aquisição de materiais e equipamentos esportivos para a Escolinha de Futebol e as aulas de Pilates", "forte"),
    ("Aquisição de materiais esportivos destinados à EMEF Professora Maria", "fraco"),
    ("Aquisição de equipamentos de academia", "forte"),
])
def test_compra_de_material_que_cita_aulas_ou_professor_continua(objeto, esperado):
    assert not servico_sem_material(objeto)
    assert classificar(objeto) == esperado


def test_execucao_de_piso_por_profissional_nao_e_servico_de_pessoas():
    objeto = "Contratação de profissional especializado para execução de piso emborrachado na quadra"
    assert not servico_sem_material(objeto)
    assert classificar(objeto) in ("piso", "obra_piso")
    assert P.avaliar({"description": objeto}, [])[0] in ("piso", "obra_piso")


def test_oficina_de_marcenaria_nao_e_servico_de_pessoas():
    assert not servico_sem_material("Registro de preços para o fornecimento de insumos destinados às Oficinas de "
                                    "Marcenaria e Serralheria")
    assert not servico_sem_material("Ferramentas para oficina mecânica")
    assert servico_sem_material("Credenciamento para realização de oficinas no CRAS")

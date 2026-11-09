"""Regressão: compra de SERVIÇO no Paradigma não fica "forte" pelo objeto nem por item que só nomeia a atividade.

Casos reais da FIEB (licitacoes_externas, fonte 'fieb', consulta de 09/11/2026): ginástica laboral (aulas,
atendimento), manutenção de equipamentos de musculação, troca de fecho e reinstalação de esteira saíam
categoria_escopo = 'forte'. Contrato de serviço nunca vira lead (.claude/rules/regras-negocio.md).
"""
import pytest

from coletor import paradigma as P


def _d(objeto: str) -> dict:
    return {"sDsObjeto": objeto}


def _its(*descricoes: str) -> list[dict]:
    return [{"sDsItem": d} for d in descricoes]


MANUTENCAO_ITEM = ("MANUTENÇÃO EM EQUIPAMENTOS DE MUSCULAÇÃO PREVENTIVO E CORRETIVO GARANTINDO A SEGURANÇA E "
                   "QUALIDADE DO EQUIPAMENTO; O FORNECEDOR GANHADOR DEVE SE RESPONSABILIZAR PELOS SERVIÇOS")

SERVICOS_FIEB = [
    # 27897/m19
    ("Contratação de empresa especializada para ministrar aulas de Ginástica Laboral SOB DEMANDA na cidade de "
     "ITAJUÍPE conforme especificações do Termo de Referência", ["GINASTICA LABORAL"]),
    # 20061/m19
    ("Prestação de Serviço de atendimento em Ginástica Laboral - GE, sob demanda, na cidade de Eunápolis/BA",
     ["GINASTICA LABORAL"]),
    # 13745/m19
    ("Contratação de empresa especializada para ministrar aulas de Ginástica Laboral - SOB DEMANDA / EUNÁPOLIS",
     ["GINASTICA LABORAL"]),
    # 6801/m19
    ("Serviço de ginástica laboral (Eunápolis)", ["ATENDIMENTO DE GINÁSTICA LABORAL"]),
    # 1977/m19
    ("Contratação de empresa especializada para ministrar aulas de Ginástica Laboral e sessão de massagem",
     ["SERVIÇO DE MASSOTERAPIA", "ATENDIMENTO DE GINÁSTICA LABORAL"]),
    # 9527/m59
    ("Contratação de modalidade sem disputa, Contratação de serviço para o desenvolvimento de soluções em Saúde "
     "Corporativa (Ginástica Laboral), na Unidade Senai Alagoinhas. Conforme termo de referência",
     ["1 - GINASTICA LABORAL"]),
    # 31454/m19
    ("Contratação de empresa especializada para ministrar aulas de Ginástica Laboral, na cidade de Itabuna, "
     "Eunápolis e Uruçuca, pelo período de 12 (doze) meses, sob demanda.",
     ["AULA DE GINÁSTICA LABORAL NA CIDADE DE EUNÁPOLIS.", "AULA DE GINÁSTICA LABORAL NA CIDADE DE URUÇUCA/BA.",
      "GINASTICA LABORAL"]),
    # 32/m59 e 1287/m59
    ("Chamamento, com a adoção do critério de julgamento econômico de MENOR PREÇO POR LOTE, destinado a prestação "
     "de serviços de manutenção preventiva e corretiva dos equipamentos de musculação, de acordo com as condições "
     "e especificações contidas neste Instrumento e seus Anexos.", ["1 - " + MANUTENCAO_ITEM, "2 - " + MANUTENCAO_ITEM]),
    # 1730/m18
    ("PREGÃO ELETRÔNICO, tipo MENOR PREÇO GLOBAL, destinada à contratação de empresa para prestação de serviços de "
     "manutenção preventiva e corretiva dos equipamentos de musculação do Centro Esportivo Unidade SESI Feira de "
     "Santana", [MANUTENCAO_ITEM]),
    # 12976/m59
    ("Processo de seleção sem disputa, para manutenção preventiva mensal dos equipamentos da academia de musculação, "
     "do Centro Esportivo da Unidade SESI Feira de Santana, conforme especificações detalhadas no termo de "
     "referência anexo.", ["1 - " + MANUTENCAO_ITEM]),
    # 11894/m19
    ("PRESTAÇÃO DE SERVIÇO DE MANUTENÇÃO CORRETIVA EM FORROS DE EQUIPAMENTOS DE ACADEMIA E POLTRONAS PARA SESI "
     "FEIRA DE SANTANA.",
     ["SERVIÇO DE MANUTENÇÃO CORRETIVA NO FORRO DE EQUIPAMENTOS DE ACADEMIA, COM SUBSTITUIÇÃO DE 15 A 20 METROS DE "
      "TECIDO TIPO COURVIN", "SERVIÇO DE MANUTENÇÃO CORRETIVA NO FORRO DE POLTRONA"]),
    # 38622/m19
    ("Serviço de troca de Fecho De Contato, Macho e Fêmea em equipamentos de academia",
     ["SERVIÇO DE TROCA DE FECHO DE CONTATO, MACHO E FÊMEA EM EQUIPAMENTOS DE ACADEMIA."]),
    # 19072/m19 e 19654/m19
    ("SERVIÇO DE REINSTALAÇÃO DE 01 ESTEIRA ERGOMÉTRICA MODELO C300 E DO SISTEMA DE ERGOMETRIA COMPUTADORIZADO, "
     "MODELO ERGOPC, MARCA MICROMED, SESI LUCAIA, CONFORME TERMO DE REFERÊNCIA",
     ["REINSTALAÇÃO DE UMA ESTEIRA ERGOMÉTRICA MODELO C300 E DO SISTEMA DE ERGOMETRIA COMPUTADORIZADO, MODELO "
      "ERGOPC, MARCA MICROMED."]),
]


@pytest.mark.parametrize("objeto,itens", SERVICOS_FIEB, ids=[o[:40] for o, _ in SERVICOS_FIEB])
def test_compra_de_servico_fica_fora(objeto, itens):
    assert P.avaliar_processo(_d(objeto), _its(*itens))[0] is None


@pytest.mark.parametrize("item", ["GINASTICA LABORAL", "1 - GINASTICA LABORAL", "ATENDIMENTO DE GINÁSTICA LABORAL",
                                  "REINSTALAÇÃO DE UMA ESTEIRA ERGOMÉTRICA MODELO C300"])
def test_item_que_nomeia_a_atividade_e_servico(item):
    cat, _, ms = P.classificar_item({"sDsItem": item})
    assert (cat, ms) == (None, "S")


# Compras de material ligadas à ginástica laboral continuam (aquisição de insumos é compra de produto).
MATERIAIS_FIEB = [
    # 5067/m19
    ("Aquisição de insumos para elaboração de ginástica laboral",
     ["BEXIGA N° 7 - DIMENSÕES: 7 POLEGADAS EMBALAGEM: 50 UNIDADES POR PACOTE",
      "BOLA DE BORRACHA DE INICIAÇÃO Nº 08, PESO: 110-120 G; MATERIAL: BORRACHA; CONDICIONAMENTO FÍSICO"]),
    # 36977/m19
    ("Aquisição de material de ginástica laboral para os clientes do Sesi sul.",
     ["ESCADA DE AGILIDADE (ESCADA AGILIDADE TREINAMENTO FUNCIONAL NYLON E EVA NATURAL FITNESS)",
      "FAIXA ELASTICA BAND DE RESISTÊNCIA NIVEL MÉDIO"]),
    # 14048/m59: fornecimento com instalação de equipamentos (item de esteira marcado S pela garantia/manutenção)
    ("CONTRATAÇÃO MODALIDADE SEM DISPUTA ENTREGA UNICA Contratação de empresa especializada para fornecimento com "
     "instalação de equipamentos de musculação e acessórios para os Cursos Esportivos do Centro esportivo SESI",
     ["5 - SUPINO VERTICAL. COMPRIMENTO(MM) ESTRUTURA:1510MM; BATERIA DE PESO: 80KG; COR: PRETO."]),
]


@pytest.mark.parametrize("objeto,itens", MATERIAIS_FIEB, ids=[o[:40] for o, _ in MATERIAIS_FIEB])
def test_compra_de_material_continua_forte(objeto, itens):
    assert P.avaliar_processo(_d(objeto), _its(*itens))[0] == "forte"


def test_servico_com_fornecimento_de_produto_no_objeto_nao_e_vetado():
    """Só serviço sem produto cai: objeto que fornece o equipamento segue valendo mesmo com itens 'S'."""
    d = _d("Fornecimento e instalação de esteiras ergométricas para a academia do SESI")
    assert P.avaliar_processo(d, _its("SERVIÇO DE INSTALAÇÃO E MONTAGEM DAS ESTEIRAS"))[0] == "forte"


def test_servico_que_cita_piso_de_borracha_nao_passa_pela_trava():
    """SESC SP 1248/m18 (dry-run de 09/11/2026): só serviço civil nos itens, mas o objeto é piso de borracha."""
    d = _d("Substituição do piso de madeira por placas de borracha da sala de Ginástica Multifuncional da Unidade "
           "Birigui")
    assert P.avaliar_processo(d, _its("EXECUÇÃO SERVIÇOS CIVIS E DE INSTALAÇÕES"))[0] == "forte"


def test_piso_de_servico_continua_pelo_interesse_na_borracha():
    """A regra de piso/borracha não muda: execução de piso por serviço segue entrando (interesse na borracha)."""
    d = _d("Prestação de serviço de execução de piso emborrachado em borracha SBR na quadra")
    cat, borr = P.avaliar_processo(d, _its("SERVIÇO DE EXECUÇÃO DE PISO EMBORRACHADO SBR"))
    assert cat == "borracha" and borr

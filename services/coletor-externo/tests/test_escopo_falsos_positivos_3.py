"""Falsos positivos achados no dry-run pós-recoleta 50–556 (01/10/2026, snapshot somente leitura de produção).
Cada teste traz o texto real (encurtado) do item/objeto que disparou o casamento e um caso legítimo que não pode cair."""
import pytest

from coletor import pncp as P
from coletor.escopo import (classificar, excluir_compra, manutencao_predial, obra_ou_construcao, piso_item_fora,
                            servico_sem_material)


def _avaliar(objeto, itens):
    return P.avaliar({"description": objeto}, [{"numeroItem": n, "descricao": d} for n, d in enumerate(itens, 1)])


# R1 — venda de bens (#794 alienação de inservíveis, #247 leilão, #251 alienação de bens móveis)
@pytest.mark.parametrize("objeto", [
    "Alienação de bens móveis inservíveis à Administração, mediante leilão eletrônico",
    "EDITAL DE LEILÃO Nº 3/2025 - venda de veículos e sucatas",
    "Alienação de bens móveis considerados inservíveis ou antieconômicos",
    "Desfazimento de bens permanentes ociosos",
])
def test_venda_de_bens_fica_fora(objeto):
    assert excluir_compra(objeto)
    cat, _, _ = _avaliar(objeto, ["BICICLETA ERGOMÉTRICA HORIZONTAL usada", "Aparelho Bonnet com anilhas"])
    assert cat is None


def test_compra_com_bens_no_texto_continua():
    assert not excluir_compra("Aquisição de bens permanentes: equipamentos de musculação para a academia municipal")


# R4 — obra/construção: item esportivo da planilha da obra não vira lead (#303 creche, #798 material de construção)
@pytest.mark.parametrize("objeto", [
    "Contratação de empresa para construção de creche no bairro Jardim",
    "Registro de preços para aquisição de Material de Construção, elétrico e hidráulico",
    "CONTRATAÇÃO DE EMPRESA ESPECIALIZADA EM ENGENHARIA CIVIL PARA REFORMA DO GINÁSIO MUNICIPAL",
    "Credenciamento de empresas para serviços de manutenção predial com base na tabela SINAPI",
])
def test_obra_nao_aceita_item_forte(objeto):
    assert obra_ou_construcao(objeto)
    cat, _, por_item = _avaliar(objeto, ["200301 - Equipamentos esportivos", "PAR DE REDE DE BASQUETE PROFISSIONAL"])
    assert cat is None and all(c is None for c, _ in por_item.values())


@pytest.mark.parametrize("objeto", [
    # "Secretaria de Obras" na lista de secretarias (#112), "mão de obra" (#165), "reforma" de aparelhos (#246),
    # "Batalhão de Engenharia" (#84)
    "Registro de Preços de materiais esportivos, educativos e de expediente para as Secretarias de Educação e de Obras",
    "Prestação de serviços contínuos, sem dedicação de mão de obra exclusiva, de manutenção dos equipamentos do "
    "Centro de Treinamento Físico",
    "Manutenção preventiva e corretiva em equipamentos de academia, incluindo solda, torno, reforma, pintura e "
    "substituição de peças",
    "Aquisição de materiais de instrução para o 9º Batalhão de Engenharia de Combate",
])
def test_palavra_solta_de_obra_nao_e_obra(objeto):
    assert not obra_ou_construcao(objeto)


def test_compra_esportiva_com_secretaria_de_obras_continua():
    cat, _, _ = _avaliar("Aquisição de materiais esportivos para as Secretarias de Educação e de Obras",
                         ["BAMBOLÊ ARCO EM PLÁSTICO COLORIDO", "Bola de futsal adulto"])
    assert cat == "forte"


def test_manutencao_predial_fica_fora_mesmo_com_piso_esportivo():
    # #799: decisão do Marcelo (01/10/2026) — credenciamento de manutenção predial sai, apesar do piso de 15 mm
    objeto = "CREDENCIAMENTO PARA EVENTUAL PRESTAÇÃO DE SERVIÇOS DE MANUTENÇÃO PREDIAL DE EDIFICAÇÕES PÚBLICAS"
    assert manutencao_predial(objeto)
    cat, ib, por_item = _avaliar(objeto, ["PISO DE BORRACHA ESPORTIVO 15MM ASSENTADO COM ARGAMASSA. AF_09/2020",
                                          "ANILHA (MARCADOR) PARA IDENTIFICAÇÃO DE CABOS"])
    assert cat is None and not ib and all(c is None for c, _ in por_item.values())


@pytest.mark.parametrize("objeto", [
    "Execução de serviços de reforma, manutenção, adequação e intervenções em edificações públicas municipais",
    "Serviços de conservação e pequenos reparos nos prédios públicos da Prefeitura",
])
def test_manutencao_de_edificacoes_e_predial(objeto):
    assert manutencao_predial(objeto)


@pytest.mark.parametrize("objeto,itens,esperada", [
    # #165 e #246: manutenção de EQUIPAMENTOS de academia não é predial
    ("Prestação de serviços contínuos, sem dedicação de mão de obra exclusiva, de manutenção preventiva e corretiva "
     "dos equipamentos e acessórios que compõem os Centros de Treinamento Físico",
     ["Manutenção e Reparo em Equipamento de Condicionamento Físico/ Ergométrico"], "forte"),
    ("Manutenção preventiva e corretiva em equipamentos de academia (ginástica e musculação), incluindo limpeza, "
     "lubrificação, pequenos reparos, solda, torno, reforma, pintura e substituição de peças",
     ["SERVIÇO DE MANUTENÇÃO PERIÓDICA PREVENTIVA DE EQUIPAMENTOS DE ACADEMIA"], "forte"),
    # compra de piso de verdade e obra de quadra com piso esportivo continuam piso
    ("Aquisição de piso emborrachado para a academia municipal", ["Piso emborrachado 50x50 cm, 20 mm"], "piso"),
    ("Reforma da quadra poliesportiva da Escola Municipal", ["PISO DE BORRACHA ESPORTIVO 15MM"], "piso"),
])
def test_manutencao_de_aparelhos_e_piso_de_verdade_continuam(objeto, itens, esperada):
    assert not manutencao_predial(objeto)
    cat, _, _ = _avaliar(objeto, itens)
    assert cat == esperada


def test_manutencao_predial_que_cita_o_piso_no_objeto_continua():
    # só o objeto decide: se ele mesmo pede o piso esportivo, a compra entra
    cat, _, _ = _avaliar("Manutenção predial do ginásio com fornecimento e instalação de piso emborrachado esportivo", [])
    assert cat in ("piso", "obra_piso")


# R11 — contrato de mão de obra (#242 serralheiro; o item cita "playgrounds, etc.")
def test_servico_de_mao_de_obra_fica_fora():
    objeto = "Contratação de empresa para prestação de serviço de mão de obra de serralheiro para as secretarias"
    assert servico_sem_material(objeto)
    cat, _, _ = _avaliar(objeto, ["Fabricação de equipamentos e/ou esquadrias metálicas - Portas, janelas, "
                                  "lixeiras, cavaletes, playgrounds, etc."])
    assert cat is None


# R2/R3 — "piso de borracha" como característica de outro produto, e piso fino de edificação
@pytest.mark.parametrize("item", [
    "ESCADA HOSPITALAR, 02 DEGRAUS - ESTRUTURA EM AÇO TUBULAR, PISO DE BORRACHA ANTIDERRAPANTE",
    "BALANÇA ANTROPOMÉTRICA PARA OBESOS, plataforma com piso emborrachado antiderrapante",
    "CADEIRA ALTA DE ALIMENTAÇÃO INFANTIL DOBRÁVEL, apoio de pés com piso emborrachado",
    "DEMOLICAO MANUAL DE PISO VINILICO, INCLUSIVE AFASTAMENTO E EMPILHAMENTO",
    "PISO DE BORRACHA PASTILHADO 3,5/7MM ASSENTADO COM COLA. AF_09/2020",
])
def test_piso_que_nao_e_piso_esportivo(item):
    assert piso_item_fora(item)


@pytest.mark.parametrize("item", [
    "PISO DE BORRACHA ESPORTIVO 15MM ASSENTADO COM ARGAMASSA",
    "Piso emborrachado para academia, placas 50x50 cm, espessura 20 mm",
    "PISO EMBORRACHADO EM MANTA PARA ÁREA DE MUSCULAÇÃO, 10MM",
])
def test_piso_esportivo_continua(item):
    assert not piso_item_fora(item)


def test_escada_com_piso_nao_faz_compra_virar_piso():
    cat, _, _ = _avaliar("Aquisição de materiais permanentes diversos",
                         ["ESCADA HOSPITALAR, 02 DEGRAUS, PISO DE BORRACHA ANTIDERRAPANTE"])
    assert cat is None


# R5 — "muscula" fora de musculação (#792 vaginal, #211 intramuscular, #373, #415, #788, #266)
@pytest.mark.parametrize("item", [
    "EXERCITADOR MUSCULAR PERINEAL/VAGINAL, cones de silicone com pesos",
    "Dipirona sódica 500mg/ml solução injetável, uso intramuscular ou intravenoso",
    "Aparelho de fototerapia para relaxamento muscular",
    "Tesoura Mayo Reta 15cm, instrumento cirúrgico, indicada para corte de fáscia e tecidos musculares",
    "Balança de bioimpedância com análise de massa muscular",
    "Aparelho Eletroestimulador Neuromuscular, 4 canais, alimentação: 110/220v",
])
def test_muscular_medico_fica_fora(item):
    assert classificar(item) is None


@pytest.mark.parametrize("item", [
    "FAIXA ELÁSTICA EXERCITADORA para fortalecimento muscular, resistência média",
    "Exercitador de membro superior para fortalecimento muscular",
    "Estação de musculação multifuncional",
])
def test_muscular_fitness_continua(item):
    assert classificar(item) in ("forte", "fraco")


# R6/R7 — anilha e gangorra
@pytest.mark.parametrize("item", [
    "ANILHA (MARCADOR) PARA IDENTIFICAÇÃO DE CABOS",
    "FERROLHO cromado tipo gangorra para armário",
    "Armário em MDF com porta tipo gangorra",
])
def test_anilha_gangorra_de_ferragem_fica_fora(item):
    assert classificar(item) is None


@pytest.mark.parametrize("item", [
    "ANILHA DE FERRO FUNDIDO 10 KG para halter",
    "Gangorra infantil em polietileno para 2 crianças",
    # #195: conjunto psicomotor em madeira/MDF e EVA com gangorra (compra de brinquedos pedagógicos)
    "CONJUNTO DE ATIVIDADES E AGILIDADES CORPORAIS em madeira MDF e EVA, com 1 gangorra de equilíbrio",
])
def test_anilha_gangorra_esportivas_continuam(item):
    assert classificar(item) is not None


# R8 — cadeira com "normas/certificação ergométrica" (#794)
@pytest.mark.parametrize("item", [
    "CADEIRA GIRATÓRIA executiva conforme normas ergométricas da NR-17",
    "Cadeira fixa com Laudo de Certificação Ergométrica",
])
def test_cadeira_ergometrica_fica_fora(item):
    assert classificar(item) is None


# R9 — "alimentação elétrica" não é alimentação (falso negativo pendente)
@pytest.mark.parametrize("item", [
    "BICICLETA ERGOMÉTRICA HORIZONTAL com painel digital, alimentação elétrica 220V",
    "Esteira ergométrica profissional, alimentação: bivolt",
    "Elíptico com fonte de alimentação inclusa",
])
def test_alimentacao_eletrica_nao_exclui(item):
    assert classificar(item) == "forte"


def test_alimentacao_de_pessoas_continua_fora():
    assert classificar("Contratação de empresa de alimentação para os atletas dos Jogos Escolares") is None


# R10 — creche + tatame
def test_tatame_de_creche_nao_vira_lead():
    cat, _, _ = _avaliar("Aquisição de mobiliário e brinquedos para a creche municipal",
                         ["Tatame em EVA 1x1m 20mm para berçário"])
    assert cat is None


def test_tatame_de_luta_continua():
    cat, _, _ = _avaliar("Aquisição de materiais esportivos para o projeto de judô",
                         ["Tatame em EVA 1x1m 40mm para judô"])
    assert cat is not None

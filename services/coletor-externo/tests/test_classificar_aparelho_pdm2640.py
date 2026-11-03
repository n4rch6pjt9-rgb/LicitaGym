"""PDM 2640 (APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO): aparelho por item e posição do supino (spec 0030).

As descrições são de itens reais do CATMAT (catmat_itens, PDM 2640). O PDM tem dois formatos:
  A) TIPO é o aparelho ("TIPO: CADEIRA FLEXORA");
  B) TIPO é o mecanismo ("TIPO: ARTICULADO", "CONJUGADO", "ELÉTRICA", "MECÂNICA") e o aparelho vem nas
     CARACTERÍSTICAS ADICIONAIS ou no MODELO ("CARACTERISTICAS ADICIONAIS: SUPINO RETO").
"""
from __future__ import annotations

import pytest

from coletor.classificar_aparelho import Classificador

PDM = 2640


@pytest.fixture(scope="module")
def clf() -> Classificador:
    return Classificador()


def _c(clf, descricao, tipo, codigo_item=None):
    return clf.classificar(descricao, tipo_catmat=tipo, codigo_pdm=PDM, codigo_item=codigo_item)


# ------------------------------------------------------------ CA-1: TIPO mecanismo não define o aparelho
@pytest.mark.parametrize("codigo,tipo,descricao,slug", [
    (442720, "ARTICULADO", "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ARTICULADO , MATERIAL: AÇO CARBONO , "
     "CARACTERISTICAS ADICIONAIS: SUPINO RETO", "supino_maquina"),
    (442719, "ARTICULADO", "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ARTICULADO , MATERIAL: AÇO CARBONO , "
     "CARACTERISTICAS ADICIONAIS: HACK DE AGACHAMENTO", "hack"),
    (480254, "ARTICULADO", "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ARTICULADO , MATERIAL: AÇO CARBONO , "
     "APLICAÇÃO: CONDICIONAMENTO FÍSICO , CARACTERISTICAS ADICIONAIS: SUPINO SENTADO", "supino_maquina"),
    (251309, "ARTICULADO", "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ARTICULADO , ALTURA: 94 CM, LARGURA: 125 CM, "
     "COMPRIMENTO: 106 CM, PESO: 48 KG, MATERIAL: AÇO TEMPERADO , BANCO: ESTOFADO REGULÁVEL COM SUPORTES PARA ACOPLAMENTO D , "
     "APLICAÇÃO: PARA QUADRICEPS (PERNAS) , CARACTERISTICAS ADICIONAIS: FLEXO-EXTENSOR PARA PERNAS", "dual_extensora_flexora"),
])
def test_ca1_tipo_mecanismo_le_o_aparelho_nas_caracteristicas(clf, codigo, tipo, descricao, slug):
    r = _c(clf, descricao, tipo, codigo)
    assert r["slug"] == slug
    assert r["atributos"].get("cinematica") == "articulada"


def test_ca1_tipo_mecanismo_sem_aparelho_no_texto_fica_indefinido_com_confianca_baixa(clf):
    # 251307: CONJUGADO e nada no texto que diga o aparelho ("barra dorsal" é peça, não o aparelho)
    d = ("APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: CONJUGADO , MODELO: NÃO ELÉTRICO , ALTURA: 196 CM, "
         "MATERIAL: AÇO , BANCO: REMOVÍVEL E ESTOFADO , APLICAÇÃO: PARA QUADRICEPS, BICEPS E PEITORAL , COLUNA PESO: 36,6 KG, "
         "CARACTERISTICAS ADICIONAIS: EQUIPADO COM ALçAS DE NYLON, BARRA DORSAL SUPERIOR , PLACAS DE PESO: REVESTIDAS EM VINIL")
    r = _c(clf, d, "CONJUGADO", 251307)
    assert r["slug"] == "aparelho_musculacao_indefinido"
    assert r["confianca"] == "baixa"


def test_ca1_eletrica_sem_aparelho_no_texto_continua_esteira(clf):
    # 225083 sem a exceção por código: o TIPO do PDM 2640 continua valendo como último recurso
    d = ("APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ELÉTRICA , MODELO: ABERTA , LARGURA MANTA: 33 CM, "
         "TIPO MOTOR: 1 HP , CAPACIDADE MÁXIMA: 100 KG, VELOCIDADE MÁXIMA: 8 KM, FUNÇÕES COMPUTADORIZADAS: VELOCIDADE")
    assert _c(clf, d, "ELÉTRICA")["slug"] == "esteira_eletrica"


def test_ca1_eletrica_com_aparelho_no_texto_usa_o_texto(clf):
    # 250339 sem a exceção por código: ELÉTRICA + "SIMULADOR DE ESCADA" é simulador de escada, não esteira
    d = ("APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: ELÉTRICA , MODELO: ABERTA , TIPO MOTOR: 1 HP , "
         "CARACTERISTICAS ADICIONAIS: APARELHO SIMULADOR DE ESCADA (STEPPER) , PROFUNDIDADE: 97 CM")
    assert _c(clf, d, "ELÉTRICA")["slug"] == "simulador_escada"


# ------------------------------------------------------------ CA-2: TIPO genérico refinado pelas características
@pytest.mark.parametrize("codigo,carac,posicao", [
    (473406, "SUPINO DECLINADO", ["declinado"]),
    (480139, "SUPINO INCLINADO", ["inclinado"]),
])
def test_ca2_banco_regulavel_para_supino_vira_banco_supino(clf, codigo, carac, posicao):
    d = ("APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: BANCO REGULÁVEL , MATERIAL: METAL , "
         f"APLICAÇÃO: PARA ABDOMEN, TORAX, BRAÇOS E PERNAS , CARACTERISTICAS ADICIONAIS: {carac}")
    r = _c(clf, d, "BANCO REGULÁVEL", codigo)
    assert r["slug"] == "banco_supino"
    assert r["atributos"]["posicao"] == posicao


# ------------------------------------------------------------ CA-3: posição do supino é característica com vários valores
@pytest.mark.parametrize("texto,esperado", [
    ("Banco supino 3x1 com suporte para barra", ["reto", "inclinado", "declinado"]),
    ("BANCO SUPINO 3 EM 1 (RETO, INCLINADO E DECLINADO)", ["reto", "inclinado", "declinado"]),
    ("Banco supino reto com suporte", ["reto"]),
    ("Banco supino inclinado e declinado", ["inclinado", "declinado"]),
])
def test_ca3_posicao_do_supino(clf, texto, esperado):
    r = clf.classificar(texto)
    assert r["slug"] == "banco_supino"
    assert r["atributos"]["posicao"] == esperado
    assert "angulo" not in r["atributos"] or "inclinado" not in r["atributos"]["angulo"]


def test_ca3_regulavel_nao_informa_posicao(clf):
    r = clf.classificar("Banco regulável para musculação")
    assert "posicao" not in r["atributos"]
    assert r["atributos"].get("ajuste") == "regulavel"


# ------------------------------------------------------------ CA-4: formato A não muda (regressão)
@pytest.mark.parametrize("codigo,tipo,slug", [
    (479577, "CADEIRA FLEXORA", "cadeira_flexora"),
    (480148, "MESA FLEXORA", "mesa_flexora"),
    (636444, "Peck Deck", "voador_peck_deck"),
    (480147, "HACK MACHINE", "hack"),
    (478756, "PUXADA ALTA DUPLA", "academia_ar_livre"),
])
def test_ca4_formato_a_continua_pelo_tipo(clf, codigo, tipo, slug):
    d = f"APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO, TIPO: {tipo} , MATERIAL: AÇO CARBONO"
    r = _c(clf, d, tipo, codigo)
    assert r["slug"] == slug
    assert r["confianca"] == "alta"


# ------------------------------------------------------------ regressões apontadas na revisão (spec 0030)
def test_tipo_mecanismo_sem_pdm_e_sem_campos_usa_o_texto_inteiro(clf):
    # Sem codigo_pdm não há mapeamento do TIPO: vale o texto, como antes da spec 0030
    r = clf.classificar("ESTEIRA ERGOMÉTRICA, TIPO: ELÉTRICA, VELOCIDADE 16 KM/H", tipo_catmat="ELÉTRICA")
    assert r["slug"] == "esteira_eletrica"


def test_refino_por_modalidade_nao_entra_no_caminho_do_tipo(clf):
    # Formato A não muda: só refinos marcados com aplica_no_tipo valem no caminho do TIPO
    d = "BICICLETA ERGOMÉTRICA, TIPO: CICLOERGÔMETRO COMPUTADORIZADO, POSIÇÃO HORIZONTAL"
    r = clf.classificar(d, tipo_catmat="CICLOERGÔMETRO COMPUTADORIZADO", codigo_pdm=3522)
    assert r["slug"] == "bicicleta_vertical"
    assert r["confianca"] == "alta"


def test_peca_continua_peca_no_caminho_de_texto(clf):
    assert clf.classificar("Suporte para barra supino")["slug"] == "suporte_armazenamento"


@pytest.mark.parametrize("texto", ["Estação 3 em 1 para musculação", "Kit 3x1 de elásticos"])
def test_3_em_1_sem_supino_ou_banco_nao_vira_posicao(clf, texto):
    assert "posicao" not in clf.classificar(texto)["atributos"]


def test_tipo_mecanismo_sem_pdm_mantem_o_comportamento_anterior(clf):
    # Revisão do Codex no PR #398: sem codigo_pdm, o desvio pelos campos não roda e o texto inteiro decide
    r = clf.classificar("CADEIRA EXTENSORA, TIPO: ELÉTRICA, MODELO: ESTEIRA COM MOTOR", tipo_catmat="ELÉTRICA")
    assert r["slug"] == "cadeira_extensora"

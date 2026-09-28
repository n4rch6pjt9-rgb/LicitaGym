"""Escopo LicitaGym — derivado da tabela pca_itens (Planos de Contratação Anual).

Base (23/09/2026): 3.331 itens de PCA, 491 planos, ~R$ 146 mi estimados, 100% na
classe CATMAT 7830 — "EQUIPAMENTO PARA GINÁSTICA E RECREAÇÃO" (grupo 78).
Inclui recreação infantil (parque infantil, brinquedos) e aquático.
Ampliado em 24/09/2026:
- classe 7220: grama sintética (PDM 18481) e piso sintético esportivo (PDM 10779, só
  quando o texto indica uso esportivo/borracha — a maior parte do PDM é piso vinílico);
- classe 9320: BORRACHA GRANULADA (PDM 9461, item 150846) — raspa/granulado/SBR;
- obras de quadra/campo society COM grama sintética ou piso emborrachado.
Interesse comercial: fornecer raspa de borracha (infill) aos vencedores desses certames.

Os PDMs abaixo estão ordenados pelo nº de itens de PCA confirmados (pca_item_pdm),
ou seja, pelo que os órgãos públicos de fato planejam comprar.
"""
from __future__ import annotations

import re
import unicodedata

CLASSES_CATMAT = {
    7830: "EQUIPAMENTO PARA GINÁSTICA E RECREAÇÃO",   # núcleo do projeto
}
# Classe 7220 (REVESTIMENTOS PARA PISOS): só estes PDMs entram no escopo
PDMS_POR_CLASSE_PARCIAL = {
    7220: {18481: "GRAMA SINTÉTICA"},
    9320: {9461: "BORRACHA GRANULADA"},
}
# Aceito só se o texto confirmar uso esportivo/borracha (senão é piso vinílico comum)
PDMS_CONDICIONAIS = {10779: "PISO SINTÉTICO"}
ITENS_CATMAT_BORRACHA = {150846: "BORRACHA GRANULADA"}

# Todos os 53 PDMs da classe 7830 (49 ativos oficiais + 4 históricos)
PDMS_CLASSE_7830 = {
    1199: "APITO",
    1386: "PLATAFORMA FUNDO PISCINA",
    1400: "CORDA DE PULAR",
    2638: "APARELHO / ACESSÓRIO - ACONDICIONAMENTO FÍSICO",
    2640: "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO",
    2649: "APARELHO APOLO DE GINÁSTICA / COMPONENTES",
    2746: "APARELHO DE TREINAMENTO FISICO",
    2976: "ARCO DE GINÁSTICA RÍTMICA ( BAMBOLÊ )",
    3233: "BALANÇO INFANTIL",
    3431: "BASTÃO GINÁSTICA",
    3522: "BICICLETA ERGOMÉTRICA",
    3869: "BRINQUEDO INFLAVEL",
    4308: "CAMA ELÁSTICA",
    5026: "CINTO ELÁSTICO - USO NATAÇÃO",
    5028: "CINTO ESCALADA",
    5341: "COLCHONETE GINÁSTICA",
    5349: "COLETE PISCINA",
    6812: "EQUIPAMENTO PARA CAMPO DE RECREACAO",
    6820: "EQUIPAMENTO PARA DIVERSÃO",
    6827: "EQUIPAMENTO PARA GINASIO DE EDUCACAO FISICA",
    6886: "ESCADA HORIZONTAL DE GINASTICA",
    6929: "ESCORREGADEIRA - BRINQUEDO",
    6930: "ESCORREGADOR - FIBRA DE VIDRO",
    7100: "ESTANTE MATERIAL ESPORTIVO",
    7111: "ESTEIRA DE PRAIA",
    7113: "ESTEIRA ERGONOMICA",
    7115: "ESTEIRA ELÉTRICA",
    7116: "ESTEIRA ROLANTE NAO ELETRICA",
    7253: "EXTENSOR DE BRACO PARA GINASTICA",
    7921: "GANGORRA - BRINQUEDO",
    8166: "HALTERE",
    8167: "HALTERE - USO PISCINA",
    9629: "MESA DE PEBOLIM",
    9632: "MESA DE SINUCA",
    9634: "MESA TÊNIS DE MESA / FUTMESA",
    9653: "MESA PARA SINUCA",
    10462: "PARQUE INFANTIL",
    10897: "PLATAFORMA PARA GINÁSTICA",
    11131: "PRANCHA PARA ABDOMINAL",
    11132: "PRANCHA NATAÇÃO",
    11503: "REDE ESPORTE",
    15172: "FITA GINÁSTICA RÍTMICA",
    15243: "ESTILETE GRD",
    15285: "MAÇA",
    15625: "FITA MARCAÇÃO ESPORTIVA",
    15677: "RAIA ANTIMAROLA",
    15679: "CATRACA RAIA ANTIMAROLA",
    15681: "GANCHO RAIA ANTIMAROLA",
    16229: "BANCO SUECO",
    17574: "APARELHO GINÁSTICA",
    17733: "ROLO ESPUMA",
    18452: "TATAME",
    18453: "SACO PANCADA",
}

# Todos os 56 PDMs do escopo LicitaGym (7830 + 7220 + 9320)
PDMS_ESCOPO = {
    **PDMS_CLASSE_7830,
    10779: "PISO SINTÉTICO",
    18481: "GRAMA SINTÉTICA",
    9461: "BORRACHA GRANULADA",
}

# Mapeamento oficial de cada PDM do escopo para termos de busca textual no PNCP
TERMOS_POR_PDM = {
    1199: ["apito"],
    1386: ["plataforma fundo piscina", "plataforma piscina"],
    1400: ["corda de pular", "corda naval"],
    2638: ["condicionamento físico", "treinamento funcional", "fita de suspensão", "trx"],
    2640: [
        "equipamentos de academia", "equipamentos de musculação", "aparelhos de musculação",
        "supino", "leg press", "peck deck", "voador", "cadeira extensora", "mesa flexora",
        "puxador", "cross over", "estação de musculação",
    ],
    2649: ["aparelho apolo de ginástica", "apolo de ginástica"],
    2746: ["aparelho de treinamento físico", "treinamento físico"],
    2976: ["arco de ginástica rítmica", "bambolê"],
    3233: ["balanço infantil"],
    3431: ["bastão ginástica", "bastão de ginástica"],
    3522: ["bicicleta ergométrica", "bike spinning", "air bike"],
    3869: ["brinquedo inflável"],
    4308: ["cama elástica", "trampolim"],
    5026: ["cinto elástico natação", "cinto para natação"],
    5028: ["cinto escalada", "cinto de escalada"],
    5341: ["colchonete ginástica", "colchonete"],
    5349: ["colete piscina", "colete de natação"],
    6812: ["equipamento para campo de recreação", "campo de recreação"],
    6820: ["equipamento para diversão"],
    6827: ["equipamento para ginásio de educação física", "academia ao ar livre", "academia da saúde"],
    6886: ["escada horizontal de ginástica", "escada de ginástica"],
    6929: ["escorregadeira", "escorregadeira brinquedo"],
    6930: ["escorregador", "escorregador infantil"],
    7100: ["estante material esportivo", "suporte para halteres", "suporte para anilhas", "rack de musculação"],
    7111: ["esteira de praia"],
    7113: ["esteira ergonômica"],
    7115: ["esteira elétrica"],
    7116: ["esteira mecânica", "esteira rolante não elétrica", "esteira curva"],
    7253: ["extensor elástico", "extensor de braço", "faixa elástica"],
    7921: ["gangorra", "gangorra infantil"],
    8166: ["halteres", "haltere", "kettlebell", "dumbbells"],
    8167: ["haltere para piscina", "haltere hidroginástica"],
    9461: [
        "borracha granulada", "granulado de borracha", "raspa de borracha",
        "borracha triturada", "borracha reciclada", "pó de borracha", "SBR", "EPDM",
    ],
    9629: ["mesa de pebolim", "pebolim", "totó"],
    9632: ["mesa de sinuca", "sinuca", "bilhar"],
    9634: ["mesa de tênis de mesa", "tênis de mesa", "futmesa"],
    9653: ["mesa para sinuca"],
    10462: ["parque infantil", "playground"],
    10779: [
        "piso sintético", "piso esportivo", "piso vinílico esportivo",
        "piso emborrachado", "piso de borracha", "piso para academia",
    ],
    10897: ["plataforma para ginástica", "step", "plataforma de step"],
    11131: ["prancha para abdominal", "banco abdominal", "prancha abdominal"],
    11132: ["prancha natação", "prancha de natação"],
    11503: ["rede esporte", "rede esportiva", "rede de vôlei", "rede de futebol"],
    15172: ["fita ginástica rítmica", "fita de ginástica"],
    15243: ["estilete grd", "estilete ginástica rítmica"],
    15285: ["maça ginástica", "maça de ginástica"],
    15625: ["fita marcação esportiva", "fita de marcação"],
    15677: ["raia antimarola", "raia para piscina"],
    15679: ["catraca raia antimarola", "catraca de raia"],
    15681: ["gancho raia antimarola", "gancho de raia"],
    16229: ["banco sueco"],
    17574: ["aparelho ginástica", "aparelhos de ginástica"],
    17733: ["rolo espuma", "rolo de liberação", "foam roller"],
    18452: ["tatame", "tatame eva"],
    18453: ["saco pancada", "saco de pancada"],
    18481: ["grama sintética", "gramado sintético", "campo society"],
}

# Termos genéricos do domínio esportivo/fitness para abranger compras agregadas
TERMOS_GENERICOS = [
    "material esportivo", "materiais esportivos", "equipamentos esportivos",
    "anilhas", "pilates", "crossfit",
]

def _montar_termos_completos() -> list[str]:
    termos = []
    for t_list in TERMOS_POR_PDM.values():
        termos.extend(t_list)
    termos.extend(TERMOS_GENERICOS)
    return list(dict.fromkeys(termos))

TERMOS_ESCOPO_COMPLETO = _montar_termos_completos()
TERMOS_BUSCA = TERMOS_ESCOPO_COMPLETO

def termos_do_pdm(codigo_pdm: int) -> list[str]:
    """Retorna os termos de busca que cobrem um determinado PDM do escopo."""
    return list(TERMOS_POR_PDM.get(codigo_pdm, []))

def pdms_sem_termo() -> list[int]:
    """Retorna lista de PDMs do escopo que não possuem termos de busca configurados."""
    return [p for p in PDMS_ESCOPO if not TERMOS_POR_PDM.get(p)]

def pdms_cobertos_por_termo(termo: str) -> list[int]:
    """Retorna códigos PDM cobertos pelo termo (correspondência exata no mapeamento)."""
    t_norm = normalizar(termo)
    return [p for p, tlist in TERMOS_POR_PDM.items() if any(normalizar(t) == t_norm for t in tlist)]

_FORTE = (
    r"(equipamentos?|materia(l|is)|aparelhos?|artigos?)\s+(\w+\s+){0,2}(de|para)\s+academia|academia\s+(de\s+ginastica|ao\s+ar\s+livre|da\s+saude|popular|de\s+musculacao)|"
    r"para\s+(a\s+)?academia|muscula|condicionamento\s+fisico|ginastic|ergometric|esteira\s+(eletric|ergom|profission)|"
    r"eliptic|spinning|halter|anilha|kettlebell|barra\s+olimpica|crossfit|pilates|funcional|"
    r"leg\s*press|supino|puxador|cross\s*over|estacao\s+de\s+musculacao|tatame|colchonete|"
    r"saco\s+(de\s+)?pancada|banco\s+sueco|corda\s+de\s+pular|rolo\s+(de\s+)?espuma|bambole|"
    r"cama\s+elastica|raia\s+antimarola|parque\s+infantil|playground|brinquedos?\s+(para\s+)?(praca|parque|playground)|escorregador|gangorra|balanco\s+infantil"
)
_FRACO = (
    r"esport|desport|poliesportiv|atletismo|natacao|piscina|futebol|volei|basquet|handebol|"
    r"tenis\s+de\s+mesa|futmesa|futsal|atividades?\s+fisicas?|educacao\s+fisica|lazer|recrea|"
    r"brinquedo\s+inflav|parque\s+infantil|playground|apito"
)
_EQUIPAMENTO = r"equipament|materia[il]|aparelh|acessori|artigos?|utensili|kit|brinquedo\s+inflav|rede|bola|mesa"
_FORA = (
    r"hospedagem|transporte|alimentac|veiculo|motocicleta|trofeu|medalha|uniforme|camiset|"
    r"producao\s+audiovisual|promocao\s+de\s+evento|organizacao.*evento|material\s+promocional|"
    r"\bobras?\b|reforma|construcao|engenharia|pavimenta|comunicacao\s+visual|aquecimento|concessao|parceria"
)
# Piso/grama: entram mesmo quando o objeto é "fornecimento e instalação" (costuma vir assim)
_PISO = (
    r"gram(a|ado)\s+sintetic|piso\s+(sintetic|emborrachad|esportiv|vinilico\s+esportiv|de\s+borracha|"
    r"para\s+(academia|quadra|playground|parque))|revestimento\s+esportiv|placas?\s+de\s+borracha\s+para\s+piso|"
    r"campo\s+(de\s+futebol\s+)?society|arena\s+society|quadra\s+society|mini\s*campo|campo\s+sintetic"
)
FORTE, FRACO, EQUIP, FORA, PISO = (re.compile(p, re.I) for p in (_FORTE, _FRACO, _EQUIPAMENTO, _FORA, _PISO))
# Compra inteira fora do escopo, mesmo que algum item cite grama/esporte
# (a busca do PNCP acha termos dentro dos itens: grama sintética como enfeite de Natal etc.)
EXCLUSAO_COMPRA = re.compile(
    r"natal|decorac|enfeite|ornament|arbitragem|arbitro|paisagis|jardinagem|"
    r"grama\s+(natural|esmeralda|batatais|zeon|zoysia|sao\s+carlos|bermuda)|"
    r"locacao\s+de\s+(tenda|palco|estrutura)|evento", re.I)


def excluir_compra(objeto: str) -> bool:
    return bool(EXCLUSAO_COMPRA.search(normalizar(objeto)))


# Borracha para infill/piso: raspa, granulado, SBR, EPDM, pneu triturado
BORRACHA = re.compile(
    r"(raspa|granulad|granulo|triturad|reciclad|po)\s+(de\s+)?borracha|borracha\s+(granulad|triturad|reciclad|moid|sbr|epdm)|"
    r"\bsbr\b|\bepdm\b|pneus?\s+(triturad|inserviv)|preenchimento\s+(com|de)\s+borracha", re.I)
# Obra de quadra/campo: entra quando envolve grama sintética, piso emborrachado ou borracha
OBRA_ESPORTIVA = re.compile(
    r"(constru|reforma|revitaliz|implant|ampliac|recupera|manutenc|execuc).{0,120}"
    r"(campo|quadra|society|arena|minicampo|estadio|praca\s+esportiva|academia\s+ao\s+ar\s+livre|playground)", re.I)


def normalizar(t: str) -> str:
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()


def classificar(objeto: str, classes_catmat: set[int] | None = None,
                pdms: set[int] | None = None) -> str | None:
    """Retorna 'catmat', 'borracha', 'piso', 'obra_piso', 'forte', 'fraco' ou None.
    - catmat: algum item da contratação é da classe 7830 (critério mais confiável)
    - forte : objeto cita equipamento típico de academia/ginástica
    - fraco : objeto esportivo genérico, desde que seja compra de equipamento/material
    Obras/reformas de quadras e serviços de evento ficam de fora."""
    if classes_catmat and classes_catmat & set(CLASSES_CATMAT):
        return "catmat"
    if pdms and any(pdms & set(p) for p in PDMS_POR_CLASSE_PARCIAL.values()):
        return "catmat"
    t = normalizar(objeto)
    if EXCLUSAO_COMPRA.search(t):
        return None
    if BORRACHA.search(t):
        return "borracha"
    if pdms and pdms & set(PDMS_CONDICIONAIS) and (PISO.search(t) or FRACO.search(t) or FORTE.search(t)):
        return "catmat"
    if PISO.search(t):
        return "obra_piso" if OBRA_ESPORTIVA.search(t) else "piso"
    if FORA.search(t):
        return None
    if FORTE.search(t):
        return "forte"
    if FRACO.search(t) and EQUIP.search(t):
        return "fraco"
    return None


def interesse_borracha(objeto: str, categoria: str | None = None) -> bool:
    """Oportunidade para fornecer raspa/granulado de borracha ao vencedor do certame:
    grama sintética (infill), piso emborrachado, obras com esses itens ou compra direta de borracha."""
    cat = categoria if categoria is not None else classificar(objeto)
    if cat in ("borracha", "piso", "obra_piso"):
        t = normalizar(objeto)
        return bool(BORRACHA.search(t) or re.search(r"gram(a|ado)\s+sintetic|emborrachad|borracha|society|campo\s+sintetic", t))
    return False

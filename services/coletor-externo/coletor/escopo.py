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

# (PDM, itens de PCA confirmados, segmento)
PDMS_PRIORITARIOS = [
    ("APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO", 276, "academia"),
    ("REDE ESPORTE", 241, "esporte"),
    ("HALTERE", 206, "academia"),
    ("TATAME", 100, "academia"),
    ("APITO", 71, "esporte"),
    ("APARELHO GINÁSTICA", 62, "academia"),
    ("BRINQUEDO INFLAVEL", 53, "recreacao"),
    ("BICICLETA ERGOMÉTRICA", 50, "academia"),
    ("MESA TÊNIS DE MESA / FUTMESA", 40, "esporte"),
    ("CORDA DE PULAR", 31, "academia"),
    ("COLCHONETE GINÁSTICA", 24, "academia"),
    ("ESTEIRA ELÉTRICA", 24, "academia"),
    ("CAMA ELÁSTICA", 19, "recreacao"),
    ("ROLO ESPUMA", 19, "academia"),
    ("RAIA ANTIMAROLA", 17, "aquatico"),
    ("ARCO DE GINÁSTICA RÍTMICA ( BAMBOLÊ )", 12, "academia"),
    ("APARELHO / ACESSÓRIO - ACONDICIONAMENTO FÍSICO", 11, "academia"),
    ("CINTO ESCALADA", 11, "esporte"),
    ("EQUIPAMENTO PARA GINASIO DE EDUCACAO FISICA", 11, "academia"),
    ("BALANÇO INFANTIL", 8, "recreacao"),
    ("BASTÃO GINÁSTICA", 7, "academia"),
    ("SACO PANCADA", 5, "academia"),
    ("PLATAFORMA FUNDO PISCINA", 5, "aquatico"),
    ("BANCO SUECO", 4, "academia"),
    ("PRANCHA NATAÇÃO", 4, "aquatico"),
    ("PARQUE INFANTIL", 2, "recreacao"),
    ("PISO SINTÉTICO", 0, "piso"),        # classe 7220
    ("GRAMA SINTÉTICA", 0, "piso"),       # classe 7220
    ("BORRACHA GRANULADA", 0, "borracha"),  # classe 9320
]

# Termos para busca textual (PNCP / portais), do mais ao menos relevante.
# "Aplicação" mais frequente nas descrições CATMAT dos itens: CONDICIONAMENTO FÍSICO (451),
# GINÁSTICA E TREINAMENTO DESPORTIVO (65), VOLEIBOL (62), ESPORTE (58), MUSCULAÇÃO, CROSSFIT, PILATES...
TERMOS_BUSCA = [
    "equipamentos de academia", "equipamentos de musculação", "condicionamento físico",
    "academia ao ar livre", "academia da saúde", "aparelhos de ginástica",
    "esteira ergométrica", "bicicleta ergométrica", "halteres", "anilhas", "kettlebell",
    "tatame", "colchonete", "pilates", "crossfit", "treinamento funcional",
    "material esportivo", "materiais esportivos", "equipamentos esportivos",
    "rede de vôlei", "tênis de mesa", "saco de pancada", "cama elástica",
    "raia antimarola", "parque infantil", "playground",
    "grama sintética", "gramado sintético", "piso sintético", "piso emborrachado",
    "piso esportivo", "piso vinílico esportivo", "piso de borracha", "piso para academia",
    "campo society", "gramado sintético", "borracha granulada", "granulado de borracha",
    "raspa de borracha", "borracha triturada", "borracha reciclada", "pó de borracha", "SBR", "EPDM",
]

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

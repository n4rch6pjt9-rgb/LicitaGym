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
PDMS_CONDICIONAIS = {10779: "PISO SINTÉTICO", 757: "REVESTIMENTO PISO", 12550: "TAPETE DE BORRACHA"}
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

# Todos os 58 PDMs do escopo LicitaGym (7830 + 7220 + 9320). 757 e 12550 entram com a taxonomia de pisos v0.2
# (placa/tapete/revestimento de borracha), condicionais como o 10779.
PDMS_ESCOPO = {
    **PDMS_CLASSE_7830,
    757: "REVESTIMENTO PISO",
    10779: "PISO SINTÉTICO",
    12550: "TAPETE DE BORRACHA",
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
    7115: ["esteira elétrica", "esteira ergométrica"],
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
    757: ["revestimento emborrachado", "manta de borracha para piso"],
    10779: [
        "piso sintético", "piso esportivo", "piso vinílico esportivo",
        "piso emborrachado", "piso de borracha", "piso para academia",
        "piso SBR", "piso EPDM", "piso monolítico", "piso para playground", "piso para crossfit",
    ],
    12550: ["tapete de borracha", "placa emborrachada", "placas de borracha"],
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
    18481: ["grama sintética", "gramado sintético", "grama artificial", "campo society"],
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
    r"\bcardio\b|eliptic|spinning|halter|anilha|kettlebell|barra\s+olimpica|crossfit|pilates|funcional|"
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
    r"\bobras?\b|reforma|construcao|engenharia|pavimenta|comunicacao\s+visual|aquecimento|concessao|parceria|"
    r"eletrocardiograf|ergoespirometr"
)
# Piso/grama: entram mesmo quando o objeto é "fornecimento e instalação" (costuma vir assim)
_PISO = (
    r"gram(a|ado)\s+sintetic|piso\s+(sintetic|emborrachad|esportiv|vinilico\s+esportiv|de\s+borracha|"
    r"para\s+(academia|quadra|playground|parque))|revestimento\s+esportiv|placas?\s+de\s+borracha\s+para\s+piso|"
    # Linha Playfit (29/09/2026): placa emborrachada, SBR/EPDM, crossfit, haras
    r"placas?\s+(de\s+piso\s+)?emborrachad|piso\s+(sbr|epdm|drenante|amortecedor|de\s+seguranca|para\s+(crossfit|parque\s+infantil))|"
    r"(piso|tapete|placa)s?\s+(de\s+borracha\s+|emborrachad[oa]s?\s+)?para\s+(baias?|cocheiras?|estabulos?|haras)|"
    r"campo\s+(de\s+futebol\s+)?society|arena\s+society|quadra\s+society|mini\s*campo|campo\s+sintetic"
)
FORTE, FRACO, EQUIP, FORA, PISO = (re.compile(p, re.I) for p in (_FORTE, _FRACO, _EQUIPAMENTO, _FORA, _PISO))
# Compra inteira fora do escopo, mesmo que algum item cite grama/esporte
# (a busca do PNCP acha termos dentro dos itens: grama sintética como enfeite de Natal etc.)
EXCLUSAO_COMPRA = re.compile(
    r"natal|decorac|enfeite|ornament|arbitragem|arbitro|"
    r"grama\s+(natural|esmeralda|batatais|zeon|zoysia|sao\s+carlos|bermuda)|"
    r"locacao\s+de\s+(tenda|palco|estrutura)|evento", re.I)


# Paisagismo/jardinagem só fica fora quando não envolve borracha (granulado de borracha para paisagismo é da linha Playfit)
EXCLUSAO_PAISAGISMO = re.compile(r"paisagis|jardinagem", re.I)


def _excluida(t: str) -> bool:
    return bool(EXCLUSAO_COMPRA.search(t) or (EXCLUSAO_PAISAGISMO.search(t) and not BORRACHA.search(t)))


def excluir_compra(objeto: str) -> bool:
    return _excluida(normalizar(objeto))


# Borracha para infill/piso: raspa, granulado, SBR, EPDM, pneu triturado
BORRACHA = re.compile(
    r"(raspa|granulad[oa]s?|granulos?|triturad[oa]s?|reciclad[oa]s?|po)\s+(de\s+)?borracha|borracha\s+(granulad|triturad|reciclad|moid|sbr|epdm)|"
    r"\bsbr\b|\bepdm\b|pneus?\s+(triturad|inserviv|reciclad)|(granulos?|graos?)\s+de\s+pneus?|preenchimento\s+(com|de)\s+borracha|"
    r"mulch\s+de\s+borracha", re.I)
# Obra de quadra/campo: entra quando envolve grama sintética, piso emborrachado ou borracha
OBRA_ESPORTIVA = re.compile(
    r"(constru|reforma|revitaliz|implant|ampliac|recupera|manutenc|execuc|substitui).{0,120}"
    r"(campo|quadra|society|arena|minicampo|estadio|praca\s+esportiva|academia\s+ao\s+ar\s+livre|playground)", re.I)
# Piso moldado no local (monolítico, EPDM/SBR aplicado in loco) é obra/instalação, não compra de placas.
# "in loco" solto (vistoria, treinamento, instalação in loco) não conta: só execução do piso no local.
PISO_IN_LOCO = re.compile(r"monolitic|(moldad|aplicad|executad|fundid)\w*\s+(in\s+loco|no\s+local)", re.I)


# ---------------- nível de ITEM ----------------
# Texto curto de catálogo do portal (ex.: "AI0300036-PECK DECK C/ CRUCIFIXO"). Só para itens: sem o
# contexto do objeto, termos como "bola" ou "rede" são seguros aqui e perigosos no objeto.
# Termos ambíguos na indústria (polia, step, espaldar, manete) exigem contexto de academia.
_ITEM_FORTE = (
    r"agachament|peck\s*deck|crucifixo|supino|puxador|leg\s*(press|\d+|curl)|hack\s*\d|"
    r"banco\s+(para\s+)?(biceps|scott|supino|abdominal|extensor|adutor|abdutor|regulavel|grande\s+regulavel|romano)|"
    r"maquina\s+(p/?\s*|para\s+)?(peitoral|dorso|adutora|abdutora|desenvolvimento|panturrilha|de\s+agachamento|remada|gluteo|voador)|"
    r"adutora|abdutora|adutor/abdutor|adultor|flexo[\s-]*e?\s*extensor|cadeira\s+(extensora|flexora|adutora|abdutora)|mesa\s+flexora|"
    r"panturrilha|gluteo\s+(guiado|maquina|4\s*apoios)|polia\s+\d+\s+estac|estacao\s+de\s+musculac|barra\s+para\s+pulley|pulley|"
    r"esteira\s+(prof|ergom|eletric|elet\b)|eliptic|ergometric|"
    r"dumbb?ells?|halter|anilha|kettlebell|barra\s+olimpica|suporte\s+(p/?\s*|para\s+)?(dumbb?ells?|halter|anilha|barra)|estante\s+(p/?\s*|para\s+)?barras|"
    r"caneleira|wall\s*ball|mini\s*band|super\s*band|elas?tico\s+de\s+(tracao|treino)|tubo\s+elastic|"
    r"bola\s+(suica|medicine|de\s+pilates|pilates)|gym\s*ball|disco\s+de\s+equilibrio|roda\s+abdominal|aparelho\s+para\s+abdominal|"
    r"cinto\s+lombar|corda\s+(para\s+)?manetes?|trampolim|\(jump\)|cama\s+elastica|step\s+(\d+\s*cm|em\s+eva|de\s+eva|aerob)|"
    r"aparelho/equipamento\s+para\s+cond|pedivela|"
    r"bola\s+(de\s+|para\s+)?(futsal|futebol|volei|handbol|handebol|basquet|iniciacao|dente)|"
    r"redes?\s+(de|para)\s+(os\s+aros\s+de\s+)?(volei|futsal|futebol|basquet|tenis)|forro\s+para\s+segurar\s+a\s+rede|"
    r"bomba\s+(p\.?\s*|para\s+)?encher\s+bola|guarda\s+de\s+bolas|chapeu\s+chines|cone\s+esport|"
    r"colete\s+(dupla\s+face|esportiv|de\s+treino|para\s+treino)|raquete|tenis\s+de\s+mesa|beach\s+tennis|"
    r"prancha\s+(de\s+)?natacao|palmar\s+(em\s+latex|para\s+pratica|de\s+natacao|natacao)|espaguete|hidroginastica|"
    r"poliboia|bandeirola|plataforma\s+redutora|(brinquedos|bamboles)\s+que\s+afu"
)
_ITEM_FORA = (
    r"balanca|estadiometr|aferic|pressao\s+arterial|esfigmoman|bandeira\s+d[oae]s?\b|massageador|"
    r"alfabeto|cronometr|eletrocardiograf|anilhas?\s+(de\s+)?(vedac|pressao|lisa|latao|cobre|nylon)|arruela"
)
# Piso de EVA/borracha no item sem a palavra "piso esportivo" (26/09/2026, pedido do Marcelo).
# Placa de borracha só com espessura de 10 a 99 mm: lençol/placa industrial fina (3 mm, neoprene) fica fora.
_ITEM_PISO = (
    r"(piso|tapete)\s+(de\s+|em\s+)?eva\b|(placas?|manta)\s+(de\s+|em\s+)?eva\b(?=.*(\b\d{2}\s*mm|encaix|piso))|\beva\s+(de\s+)?\d{2}\s*mm|"
    r"placas?\s+(de\s+)?borracha\s+(\d+([.,]\d+)?\s*(cm|m)?\s*x\s*\d+([.,]\d+)?\s*(cm|m)?\s*(x\s*)?)?\d{2}\s*mm|"
    r"manta\s+(de\s+)?borracha\s+(para\s+)?(academia|piso)|placas?\s+(de\s+piso\s+)?emborrachad|"
    r"(tapete|piso|placa)s?\s+(de\s+borracha\s+)?para\s+(baias?|cocheiras?|estabulos?|haras)"
)
# Peças e insumos de manutenção de equipamento de academia (26/09/2026, pedido do Marcelo: entram no escopo,
# em categoria própria 'manutencao' para não misturar preço de peça com preço de equipamento).
# São genéricos na indústria (cabo de aço, polia, rolamento, mola...): só entram com contexto de academia
# no próprio item OU no objeto do processo.
_ITEM_MANUTENCAO = (
    r"cabos?\s+(de\s+)?aco|courvin|corino|courino|curvim|\bnapa\b|couro\s+sintetic|"
    r"\bpolias?\b|rolamentos?\b|correias?\s+(de\s+|da\s+|para\s+)?(esteira|transmiss|dentad|poly|em\s+v\b)|"
    r"(lona|manta)\s+(de\s+|da\s+|para\s+)?esteira|\bestof(ament|ad)|espumas?\s+(para\s+|de\s+)?(estof|banco|rolo|assento|encosto)|manoplas?|pegador|"
    r"pino\s+(seletor|trava|de\s+carga)|\bmolas?\b|esticador|mosquet|terminal\s+(de\s+|para\s+)?cabo|prensa[\s-]*cabo|"
    r"grampo\s+(de\s+|para\s+)?cabo|lubrificante|desengripante|silicone\s+(liquido|spray|em\s+spray|para\s+esteira)|"
    r"oleo\s+(de\s+)?silicone"
)
_CONTEXTO_ACADEMIA = (
    r"academia|musculac|ginastic|fitness|crossfit|pilates|equipamentos?\s+esportiv|"
    r"esteira\s+(ergom|eletric|prof)|aparelhos?\s+de\s+(ginastica|musculacao)"
)
ITEM_FORTE, ITEM_FORA, ITEM_PISO, ITEM_MANUTENCAO, CONTEXTO_ACADEMIA = (
    re.compile(p, re.I) for p in (_ITEM_FORTE, _ITEM_FORA, _ITEM_PISO, _ITEM_MANUTENCAO, _CONTEXTO_ACADEMIA))


def contexto_academia(texto: str | None) -> bool:
    """Objeto/texto fala de academia/musculação/ginástica (habilita peças de manutenção nos itens)."""
    return bool(CONTEXTO_ACADEMIA.search(normalizar(texto or "")))
# Prefixos do catálogo de produtos do portal Paradigma da SFIEC (enviados pelo Marcelo em 26/09/2026):
# AI03 = EQUIPAMENTOS ESPORTIVOS; NE53 e MC06 = ESPORTIVO. O código vem colado na descrição do item.
CATALOGO_ESPORTIVO = re.compile(r"(^|\s)(AI03|NE53|MC06)\d{5}\s*-", re.I)


def e_peca(t: str) -> bool:
    """Peça quando o termo de peça vem ANTES de qualquer nome de equipamento: "LONA PARA ESTEIRA ERGOMÉTRICA"
    e "CABO DE AÇO PARA LEG PRESS" são peça; "LEG PRESS 45 COM CABOS DE AÇO" e "BANCO SUPINO ESTOFADO" são equipamento."""
    p = ITEM_MANUTENCAO.search(t)
    if not p:
        return False
    eq = [m.start() for m in (ITEM_FORTE.search(t), ITEM_PISO.search(t)) if m]
    return not eq or p.start() < min(eq)


def classificar_texto_item(texto: str, contexto: bool = False) -> tuple[str | None, str]:
    """(categoria, metodo) para o texto de UM item. metodo: regra | regra_item | catalogo.
    `contexto`: o objeto do processo é de academia (libera peças de manutenção -> 'manutencao')."""
    t = normalizar(texto)
    if ITEM_FORA.search(t):
        return None, "regra"
    # Peça de reposição citando o aparelho ("cabo de aço para aparelho de musculação") é manutenção, não equipamento;
    # vem antes das regras de objeto, mas depois do vocabulário explícito de equipamento (ITEM_FORTE).
    if e_peca(t) and (contexto or CONTEXTO_ACADEMIA.search(t)):
        return "manutencao", "regra_item"
    cat = classificar(texto)
    if cat:
        return cat, "regra"
    if ITEM_PISO.search(t):
        return "piso", "regra_item"
    if ITEM_FORTE.search(t):
        return "forte", "regra_item"
    if CATALOGO_ESPORTIVO.search(texto or ""):
        return "forte", "catalogo"
    return None, "regra"


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
    if _excluida(t):
        return None
    if BORRACHA.search(t):
        return "borracha"
    if pdms and pdms & set(PDMS_CONDICIONAIS) and (PISO.search(t) or FRACO.search(t) or FORTE.search(t)):
        return "catmat"
    if PISO.search(t):
        return "obra_piso" if (OBRA_ESPORTIVA.search(t) or PISO_IN_LOCO.search(t)) else "piso"
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

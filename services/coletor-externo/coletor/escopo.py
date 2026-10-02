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
    r"(equipamentos?|materia(l|is)|aparelhos?|artigos?)\s+(\w+\s+){0,2}(de|para)\s+academia|academia\s+(de\s+ginastica|da\s+saude|de\s+musculacao)|"
    r"para\s+(a\s+)?academia|musculac|condicionamento\s+fisico|ginastic|esteira\s+(eletric|ergom|profission)|"
    # cardio, elíptico, ergométrico, tatame, rolo de espuma e escorregador: ambíguos, ver forte_ambiguo() (01/10/2026)
    r"spinning|halter|kettlebell|barra\s+olimpica|crossfit|pilates|"
    # "funcional" solto casava "impressora multifuncional", "mesa funcional", "design funcional" (30/09/2026)
    r"(treinamento|treino)\s+funcional|funcional\s+training|(circuito|estacao|rack|gaiola|kit|acessorios?|"
    r"equipamentos?|materia(l|is)|aparelhos?)\s+(de\s+|para\s+)?(treinamento\s+|treino\s+)?funcional\b|"
    r"leg\s*press|supino|estacao\s+de\s+musculacao|"
    r"saco\s+(de\s+)?pancada|banco\s+sueco|corda\s+de\s+pular|bambole|"
    r"cama\s+elastica|raia\s+antimarola|parque\s+infantil|playground|brinquedos?\s+(para\s+)?(praca|parque|playground)|balanco\s+infantil"
)
_FRACO = (
    r"esport|desport|poliesportiv|atletismo|natacao|piscina|futebol|volei|basquet|handebol|"
    r"tenis\s+de\s+mesa|futmesa|futsal|atividades?\s+fisicas?|educacao\s+fisica|lazer|recrea|"
    r"brinquedo\s+inflav|parque\s+infantil|playground|apito"
)
_EQUIPAMENTO = r"equipament|materia[il]|aparelh|acessori|artigos?|utensili|kit|brinquedo\s+inflav|rede|bola|mesa"
_FORA = (
    r"hospedagem|transporte|(?<!fonte de )alimentac(?!ao\s*(:\s*)?(eletric|bivolt|de\s+energia|por\s+(bateria|pilha|energia)|\d|\(|automatic))|veiculo|motocicleta|trofeu|medalha|uniforme|camiset|"
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


# Leilão/alienação de bens inservíveis é VENDA do órgão, não compra (01/10/2026: #794 "Alienação de 19 lotes de bens
# inservíveis" virou "forte" por bicicletas ergométricas usadas no lote; #247 "EDITAL DE LEILÃO"; #251 alienação).
VENDA_DE_BENS = re.compile(
    r"\baliena(cao|coes|r)\b|\bleil(ao|oes)\b|bens\s+(moveis\s+)?(inserviveis|antieconomicos|ociosos)|"
    r"venda\s+de\s+(bens|sucatas?|veiculos|materiais\s+inserviveis)|desfazimento", re.I)


def _excluida(t: str) -> bool:
    return bool(EXCLUSAO_COMPRA.search(t) or (EXCLUSAO_PAISAGISMO.search(t) and not borracha(t)))


def excluir_compra(objeto: str) -> bool:
    t = normalizar(objeto)
    return _excluida(t) or bool(VENDA_DE_BENS.search(t))


# Serviço de pessoas sem fornecimento de material (30/09/2026, pedido do Marcelo: ele vende produtos do CATMAT,
# não serviços). Ex.: id 229 (Angatuba/SP, credenciamento de oficineiros) virou "forte" pelos itens
# "OFICINEIRO (A) DE GINASTICA" e "OFICINEIRO (A) DE TREINAMENTO FUNCIONAL"; Jaguariúna/SP marca "AULA MINISTRADA
# Pilates" como material. Aulas, oficinas, instrutores, professores, educador físico e vagas em academia ficam fora,
# salvo quando o mesmo texto também fala em compra/fornecimento de material ou equipamento.
SERVICO_PESSOAL = re.compile(
    r"\baulas?\b|hora[\s/-]*aula|oficineir|instrutor|"
    # "oficina" sozinha é também oficina mecânica/de marcenaria: só conta como atividade (oficina de ginástica,
    # oficinas esportivas/presenciais) ou quando alguém vai realizar/conduzir/ministrar oficinas
    r"\boficinas?\s+(\w+\s+){0,2}?(ginastic|danca|esportiv|cultur|pedagog|artistic|artes|music|capoeira|treinamento|"
    r"atividades?|presencia|socio|lutas?|ballet|bale|teatro|zumba|recreativ|ludic)|"
    r"(realizacao|conducao|execucao|ministrar|realizar|conduzir)\s+(\w+\s+){0,3}oficinas?\b|\bprofessor(a|es|as)?\b|educador(a|es)?\s+fisic|"
    r"profissiona(l|is)\s+(de\s+educacao\s+fisica|para\s+(exercer|ministrar|atuar|realizar|conduzir)|habilitad|"
    r"especializad|interessad)|contratacao\s+de\s+profissiona|personal\s*trainer|treinador|"
    r"\bministra(r|cao|da|do|das|dos)\b|vagas?\s+(subsidiadas?\s+)?(em|de|para)\s+(academias?|estudios?)|mensalidades?|"
    r"(estabelecimentos?|empresas?|pessoas?\s+juridicas?)\s+prestador\w*\s+de\s+servic|"
    r"servicos?\s+(profissiona|de\s+educador|de\s+atividades?\s+fisicas?|de\s+instrut|de\s+saude)|"
    # contrato de mão de obra (#242 "prestação de serviço de mão de obra de serralheiro"), não "sem dedicação de mão de obra"
    r"servicos?\s+de\s+mao\s+de\s+obra", re.I)
PRODUTO = re.compile(
    r"aquisic|\bcompras?\s+de\b|\binsumos?\b|fornecimento\s+(e\s+instalacao\s+)?(de\s+)?(materia|equipament|aparelh|produt|pecas?|kits?|"
    r"brinquedo|piso|grama|borracha)|com\s+fornecimento\s+de\s+(materia|equipament|pecas?)|\bmateria(l|is)\b|"
    r"equipamentos?\b|aparelhos?\b|\bkits?\b", re.I)


# Academia ao ar livre (ATI, academia da terceira idade, aparelhos de ginástica ao ar livre) está FORA do escopo
# (30/09/2026, decisão do Marcelo). Única exceção: o mesmo texto cita piso/grama da linha Playfit (piso
# emborrachado, piso de borracha, piso para academia ao ar livre, grama sintética, borracha): aí entra pelo piso
# (piso, obra_piso ou borracha), nunca como "forte". Vocabulário do dicionario-aparelhos-v0.3 (academia_ar_livre).
ACADEMIA_AR_LIVRE = re.compile(
    r"academias?\s+(publicas?\s+)?(ao\s+|a\s+)?ar\s+livre|academias?\s+(da|de|para\s+a)\s+(terceira|melhor)\s+idade|"
    r"academias?\s+(de\s+|em\s+)?pracas?|academias?\s+populares|academia\s+popular|"
    r"(ginastica|musculacao|fitness|exercicios?(\s+fisicos?)?)\s+(\w+\s+){0,2}ao\s+ar\s+livre", re.I)
# Siglas só valem com contexto de aparelho ("ATI" e "APE" também são siglas de outras coisas).
ACADEMIA_AR_LIVRE_SIGLA = re.compile(r"\bati\b|\bape\b", re.I)
ACADEMIA_AR_LIVRE_SIGLA_CONTEXTO = re.compile(r"academia|aparelh|equipament|ginastic|exercic|praca|galvaniz", re.I)


def academia_ar_livre(texto: str | None) -> bool:
    """Texto fala de academia ao ar livre / ATI (fora do escopo, salvo o piso)."""
    t = normalizar(texto or "")
    return bool(ACADEMIA_AR_LIVRE.search(t) or
                (ACADEMIA_AR_LIVRE_SIGLA.search(t) and ACADEMIA_AR_LIVRE_SIGLA_CONTEXTO.search(t)))


# Brinquedo infantil está FORA do escopo (01/10/2026, decisão do Marcelo): piscina de bolinhas, brinquedos infantis/
# pedagógicos/educativos, brinquedoteca, kits e jogos pedagógicos, casinha de brinquedo, blocos de montar etc.
# Playground/parquinho, cama elástica, gangorra, escorregador e balanço continuam no escopo nesta mudança
# (BRINQUEDO_INFANTIL_FICA): "playground infantil ... brinquedo infantil para praça" segue "forte".
BRINQUEDO_INFANTIL = re.compile(
    r"piscinas?\s+(de\s+)?bolinhas?|bolinhas?\s+(coloridas\s+|plasticas\s+)?(para|de)\s+piscina|"
    r"brinquedos?\s+(\w+\s+){0,2}?(infantis?|pedagogic|educativ|didatic|de\s+encaixe|de\s+montar|sonoros?|musica(l|is))|"
    r"brinquedoteca|(kits?|conjuntos?|jogos?)\s+(\w+\s+){0,2}?(pedagogic|educativ)|kits?\s+(de\s+)?brinquedos?|"
    r"casinhas?\s+(de\s+brinquedo|infantil|de\s+boneca)|blocos?\s+(de\s+)?(montar|encaixe)|\bbonecas?\b|pelucia|"
    r"chocalho|mordedor|quebra[\s-]*cabeca|massinha|carrinhos?\s+de\s+(brinquedo|controle\s+remoto|empurrar)|"
    r"fantoche|jogo\s+da\s+memoria", re.I)
BRINQUEDO_INFANTIL_FICA = re.compile(
    r"playground|parquinho|parque\s+infantil|cama\s+elastica|pula[\s-]*pula|gangorra|escorregador|balanco|"
    r"brinquedos?\s+(para\s+)?(praca|parque|playground)", re.I)


def brinquedo_infantil(texto: str | None) -> bool:
    """Texto de brinquedo infantil (fora do escopo), salvo playground/cama elástica/gangorra/escorregador."""
    t = normalizar(texto or "")
    return bool(BRINQUEDO_INFANTIL.search(t) and not BRINQUEDO_INFANTIL_FICA.search(t))


def servico_sem_material(texto: str | None) -> bool:
    """Texto de serviço de pessoas (aulas, oficinas, instrutores, vagas em academia) sem compra de material.
    Execução de piso/grama/borracha por profissional não conta (entra pelo piso: interesse na borracha)."""
    t = normalizar(texto or "")
    return bool(SERVICO_PESSOAL.search(t) and not PRODUTO.search(t)
                and not (borracha(t) or PISO.search(t) or _piso_in_loco(t)))


# Borracha para infill/piso: raspa, granulado, SBR, EPDM, pneu triturado
BORRACHA = re.compile(
    r"(raspa|granulad[oa]s?|granulos?|triturad[oa]s?|reciclad[oa]s?|po)\s+(de\s+)?borracha|borracha\s+(granulad|triturad|reciclad|moid)|"
    r"pneus?\s+(triturad|inserviv|reciclad)|(granulos?|graos?)\s+de\s+pneus?|preenchimento\s+(com|de)\s+borracha|"
    r"mulch\s+de\s+borracha", re.I)
# SBR/EPDM sozinhos são ambíguos (30/09/2026): "adesivo/aditivo SBR" para argamassa e chapisco, "manta EPDM" de
# impermeabilização, perfil/gaxeta/mangueira de EPDM. Só contam como borracha da linha Playfit com contexto de
# piso/grama/infill/granulado e sem contexto de construção civil, vedação ou esquadria (ver borracha()).
SBR_EPDM = re.compile(r"\bsbr\b|\bepdm\b", re.I)
SBR_EPDM_CONTEXTO = re.compile(
    r"\bpisos?\b|grama|gramado|infill|preenchimento|granul|graos?\b|raspa|triturad|reciclad|moid|pneu|"
    r"emborrachad|playground|parque\s+infantil|quadra|pista\s+(de\s+)?(atletismo|caminhada|corrida|skate)|"
    r"campo\s+(de\s+futebol|society|sintetic)|society|academia|crossfit|amortec|tatame|placas?\s+de\s+borracha", re.I)
SBR_EPDM_FORA = re.compile(
    r"argamassa|chapisco|reboco|concreto|cimento|graute|adesivo|aditivo|adesao|ponte\s+de\s+aderencia|"
    r"impermeabiliz|telhado|cobertura|calha|laje|vedac|vedant|gaxeta|guarnic|\bo[\s-]*ring|\baneis?\b|\banel\b|"
    r"retentor|mangueira|perfil|esquadri|janela|\bportas?\b|vidro|junta|tubo|conexao|valvula|diafragma|"
    r"\bcabos?\b|isolament|automotiv|veicul|pneumatic", re.I)

# Obra de quadra/campo: entra quando envolve grama sintética, piso emborrachado ou borracha
# "substitui" é genérico ("edital que substitui o anterior... campo"): só conta com o objeto logo em seguida
# ("substituição do gramado", "substituir o piso", "substituição da quadra").
OBRA_ESPORTIVA = re.compile(
    r"(constru|reforma|revitaliz|implant|ampliac|recupera|manutenc|execuc).{0,120}"
    r"(campo|quadra|society|arena|minicampo|estadio|praca\s+esportiva|academia\s+ao\s+ar\s+livre|playground)|"
    r"substitui\w*\s+(d[oa]s?\s+)?(grama|gramado|piso|revestimento|campo|quadra)", re.I)
# Piso moldado no local (monolítico, EPDM/SBR aplicado in loco) é obra/instalação, não compra de placas.
# "in loco" solto (vistoria, treinamento, instalação in loco) não conta: só execução do piso no local.
PISO_IN_LOCO = re.compile(r"monolitic|(moldad|aplicad|executad|fundid)\w*\s+(in\s+loco|no\s+local)", re.I)
# "Piso monolítico moldado in loco" sem material não casa PISO: com a palavra "piso", o in loco basta como sinal de
# piso. Piso monolítico de concreto, granilite, epóxi, cerâmica etc. é piso de obra civil, não da linha Playfit.
PISO_PALAVRA = re.compile(r"\bpisos?\b", re.I)
PISO_NAO_ESPORTIVO = re.compile(
    r"concreto|cimenti|argamassa|granilit|marmorit|epox|porcelanat|ceramic|vinilic|madeira|asfalt|industrial", re.I)


def _piso_in_loco(t: str) -> bool:
    """Piso executado no local, sem material que o tire da linha Playfit."""
    return bool(PISO_IN_LOCO.search(t) and PISO_PALAVRA.search(t) and not PISO_NAO_ESPORTIVO.search(t))


def borracha(t: str) -> bool:
    """Texto (já normalizado) cita borracha da linha Playfit: raspa/granulado/pneu triturado, ou SBR/EPDM com
    contexto de piso/grama/infill e sem contexto de construção, vedação ou esquadria."""
    if BORRACHA.search(t):
        return True
    return bool(SBR_EPDM.search(t) and SBR_EPDM_CONTEXTO.search(t) and not SBR_EPDM_FORA.search(t))


# ---------------- termos ambíguos (rodada de produção de 30/09/2026) ----------------
# "puxador" sozinho é ferragem de porta/gaveta/armário: 284 dos 507 leads da rodada de 30/09/2026 vieram de itens
# como "PUXADOR DE ALUMINIO PARA PORTA" e "puxador para gaveta inox". Só é aparelho de academia com contexto
# (puxador alto/baixo/costas/remada/triângulo, polia, pulley, estação de musculação, academia, cross over) e
# nunca com contexto de porta, gaveta, armário, móvel, ferragem, janela ou marcenaria.
PUXADOR = re.compile(r"\bpuxador(es)?\b", re.I)
# Nome de aparelho (equipamento, não peça): também marca a posição do equipamento em e_peca().
PUXADOR_APARELHO = re.compile(
    r"\bpuxador(es)?\s+(\w+\s+){0,2}?(alto|baixo|triangul\w*|remada|costas|dorsal|articulad\w*|"
    r"polia|pulley|graviton|musculac\w*|academia|ginastic\w*|cross\s*over|crossover)\b", re.I)
# Puxador como ACESSÓRIO fitness (02/10/2026, decisão do Marcelo: "puxador" é termo positivo da categoria acessórios,
# não falso positivo). É o pegador de polia/crossover do dicionário de aparelhos v0.3 (nó pegador_polia, família
# equipamentos_fitness.acessorios, refino "ambiguo:puxador"): "PUXADOR TRICEPS CORDA", "PUXADOR ROMANO", "barra para
# puxador W", "puxador com pegada neutra". Continua valendo PUXADOR_FORA (porta, gaveta, móvel, ferragem...).
# "pegada" só com o tipo de pegada de treino: "puxador tipo alça com pegada ergonômica" é ferragem de móvel.
PUXADOR_ACESSORIO = re.compile(
    r"\bpuxador(es)?\b[^.;]{0,40}?(\btriceps\b|\bbiceps\b|\bcorda\b|\bromano\b|\bw\b|\bestribo\b|\bunilateral\b|"
    r"pegada\s+(neutra|supinad\w*|pronad\w*|aberta|fechada|paralela|dupla)|\bpolias?\b|pulley)|"
    r"\b(barra|corda|triangulo|pegador)\s+(\w+\s+){0,2}?(para\s+|de\s+|p/\s*)?puxador", re.I)
PUXADOR_CONTEXTO = re.compile(
    r"musculac|academia|ginastic|fitness|crossfit|cross\s*over|crossover|\bpolias?\b|pulley|remada|anilha|halter|"
    r"graviton|leg\s*press|supino|peck\s*deck|voador|aparelhos?\s+de\s+(ginastica|musculacao)", re.I)
# "porta" de "porta-anilhas", "porta halteres", "porta toalha" (acessório de academia) não conta como porta.
PUXADOR_FORA = re.compile(
    r"\bportas?\b(?!\s*[-/]?\s*(anilhas?|halteres?|pesos?|barras?|toalhas?|squeeze|garrafas?|bolas?)\b)|portao|portoes|"
    r"gavetas?|gaveteir|armari|\bmove(l|is)\b|moveleir|mobiliari|ferrage|janelas?|esquadri|marcenari|dobradic|"
    r"fechadur|macaneta|cozinha|guarda[\s-]*roupa|gabinete|criado[\s-]*mudo|escrivaninha|box\s+(de\s+|para\s+)?banheiro|vidro|"
    # utilidades com puxador ("CAIXA PLASTICA 372 LITROS COM TAMPA E PUXADOR FRONTAL", rodada de 30/09/2026)
    r"\bcaixas?\b|tampa|rodizi|lixeir|contain|contein|\bmalas?\b|\bbolsas?\b|carrinho", re.I)
# "cross over" também é cabo de rede (cabo crossover) e divisor de frequência de áudio.
CROSS_OVER = re.compile(r"cross\s*over", re.I)
CROSS_OVER_FORA = re.compile(
    r"cabos?\s+(de\s+)?(rede|utp|lan|crossover|cross\s*over)|\bcat\.?\s*[5-7]e?\b|\butp\b|rj[\s-]*45|ethernet|patch|"
    r"rede\s+de\s+(dados|computadores)|\baudio\b|\bsom\b|acustic|alto[\s-]*falante|divisor|amplificad|automovel|"
    r"veicul|\bsuv\b", re.I)


# "colchonete" sozinho é colchonete de creche/repouso/trocador (22 compras da rodada de 30/09/2026): só é
# colchonete de ginástica (PDM 5341) com contexto de exercício e sem contexto de repouso/creche/hospital.
COLCHONETE = re.compile(r"\bcolchonetes?\b", re.I)
COLCHONETE_CONTEXTO = re.compile(
    r"ginastic|academia|exercic|pilates|\byoga\b|\bioga\b|abdominal|alongamento|educacao\s+fisica|esportiv|treino|"
    r"treinamento|fitness|muscula|funcional|\bjudo\b|lutas?\b|capoeira|tatame", re.I)
COLCHONETE_FORA = re.compile(
    r"repouso|descanso|dormir|soneca|creche|berc|trocador|bebe|maca\b|hospital|enfermaria|acolhimento|abrigo|"
    r"casa\s+de\s+passagem|camping|acampamento|colchao|colchoes|travesseiro|lencol|desabrigad|defesa\s+civil", re.I)


def _colchonete_academia(t: str) -> bool:
    return bool(COLCHONETE.search(t) and COLCHONETE_CONTEXTO.search(t) and not COLCHONETE_FORA.search(t))


def _puxador_academia(t: str) -> bool:
    return bool(PUXADOR.search(t) and not PUXADOR_FORA.search(t)
                and (PUXADOR_APARELHO.search(t) or PUXADOR_ACESSORIO.search(t) or PUXADOR_CONTEXTO.search(t)))


def _cross_over_academia(t: str) -> bool:
    return bool(CROSS_OVER.search(t) and not CROSS_OVER_FORA.search(t))


# ---------------- segunda rodada de falsos positivos (reclassificação de 01/10/2026) ----------------
# Cada termo: (padrão, contexto que o tira do escopo, contexto de academia que o mantém mesmo assim).
# - "cardio": "CARDIOVERSOR ... cardio-desfibrilador implantável", "batimentos cardio-fetais", "RCP (ressuscitação
#   cardio-pulmonar)", "compatível com cardio touch" (itens hospitalares). Fica: esteira/bike/equipamento de cardio.
# - "elíptico": "tubo de aço elíptico", "seção elíptica", "formato elíptico", "cavidade elíptica para porta-lápis",
#   mesa/conjunto escolar sextavado/hexagonal. Fica: elíptico/transport (aparelho).
# - "ergométrico": "banco ergométrico ... indicado para exames", "cadeira giratória ergométrica", teste
#   ergométrico/ergometria (exame). Fica: bicicleta/esteira ergométrica, cicloergômetro.
# - "rolo de espuma": rolo de pintura ("ROLO DE ESPUMA P/ PINTURA", "rolo espuma 23 cm c/ cabo", espaçador),
#   rolo de posicionamento cirúrgico/decúbito. Fica: liberação miofascial, massagem, pilates, rolo revestido.
# - "tatame": tatame sensorial/de texturas, tapete infantil dobrável para creche/berçário. Fica: lutas, judô,
#   academia, esportivo.
# - "escorregador": "escorregador para ingredientes" (batedeira planetária), antiescorregador/antiderrapante.
#   Fica: playground (o escopo inclui parque infantil).
_AMBIGUOS = {
    "cardio": (
        r"\bcardio\b",
        # "implant" solto casava "implantação de academia"; "monitor multi" casava "monitor multifunção" (Codex, PR #114)
        r"desfibril|cardiovers|implantave|implantad|marca[\s-]*passo|cardio[\s-]+(fetal|fetais|pulmonar|vascular|respirat|touch)|"
        r"ressuscit|\brcp\b|\becg\b|eletrocardio|cardiolog|hospital|ambulator|cateter|\bstent|paciente|doppler|"
        r"monitor\s+multiparametr",
        r"esteira|bicicleta|\bbike\b|eliptic|academia|fitness|equipamentos?\s+(de\s+)?cardio|aparelhos?\s+(de\s+)?cardio",
    ),
    "eliptico": (
        r"eliptic",
        # Peça/forma: o substantivo vem colado ("tubo de aço elíptico", "seção elíptica"); "aço ... movimento elíptico"
        # e "forma"/"desenho" soltos casavam descrição de aparelho. Iluminação só como objeto de iluminação:
        # "lumin" solto casava "display iluminado"/"painel luminoso" do próprio elíptico (Codex, PR #114).
        r"(secao|formato|cavidade|perfil|tubos?(\s+de\s+aco)?|travessa|tampo|furo|recorte|contorno)\s+(\w+\s+)?eliptic|"
        r"eliptic\w*\s+(sae\b|\d+\s*x\s*\d+)|\bmesas?\b|\bcadeiras?\b|conjunto\s+escolar|\bcarteiras?\b|sextavad|hexagon|"
        r"mobiliari|porta[\s-]*lapis|\bespelhos?\b|"
        r"luminaria|\blustres?\b|arandela|plafon|refletor|\bspots?\b|lampada|abajur|pendente\s+(de\s+)?(teto|luz)",
        # "^eliptico...": item que começa pelo nome do aparelho ("Elíptico com display iluminado e monitor LCD")
        r"^\W*(\d+\W+)?((aparelho|equipamento)\s+(\w+\s+)?)?(transport\s+)?eliptic|"
        r"(aparelho|equipamento|simulador|transport)\w*\s+(\w+\s+){0,2}?eliptic|eliptic\w*\s+(profission|residencial|magnetic|"
        r"eletromagnetic|ergometric|sentado|duplo|simulador)|bicicleta\s+eliptic|condicionamento\s+fisico",
    ),
    "ergometrico": (
        r"ergometric",
        r"bancos?\s+ergometric|cadeiras?\b[^.;]{0,30}?ergometric|teste\s+ergometric|exames?\s+(\w+\s+){0,2}?ergometric|"
        r"ergometria|indicado\s+para\s+exa|normas?\s+ergometric|certificac\w*\s+ergometric",
        r"bicicleta|\bbike\b|esteira|cicloergometr|eliptic|remo\s+ergometric|condicionamento\s+fisico|academia",
    ),
    "rolo_espuma": (
        r"rolo\s+(de\s+)?espuma",
        # "pintura" só como finalidade ("p/ pintura", "pintura de parede"; não "pintura eletrostática" da base);
        # "textura" saiu ("rolo de espuma texturizado" é de liberação miofascial) (Codex, PR #114)
        r"(para|p/|de)\s+pintura|pintura\s+(de\s+)?(parede|imobiliaria|latex|acrilica)|pintar|\btintas?\b|verniz|esmalte|"
        r"parede|\bcabo\b|c/\s*cabo|s/\s*cabo|espacador|pincel|trincha|bandeja|posicionament|posicionador|cirurg|"
        r"decubito|coxim",
        r"miofascial|liberacao|massag|pilates|\byoga\b|\bioga\b|foam\s+roller|alongamento|treino|academia|fitness",
    ),
    "tatame": (
        r"tatame",   # sem \b: catálogo cola "TATAMEx000D" (quebra de linha do Excel)
        r"sensorial|texturas|tapete\s+infantil|\bbebes?\b|creche|bercari|brinquedoteca|\bxpe\b|"   # \b: "bebedouro"
        r"alfabet|tatames?\s+(\w+\s+){0,3}?(letras|numeros|numerais)|quebra[\s-]*cabeca",
        r"\bjudo\b|\blutas?\b|karate|jiu|artes\s+marciais|taekwondo|capoeira|esportiv|academia|ginastic",
    ),
    "escorregador": (
        r"(?<!anti)(?<!anti-)(?<!anti\s)escorregador",
        r"ingrediente|batedeira|liquidific|cozinha|alimento|antiderrapante",
        r"playground|parque|infantil|crianc|brinquedo|degraus|rampa|toboga|escalada|polietileno|rotomoldad",
    ),
    # Terceira rodada (01/10/2026, recoleta dos ids 50-556):
    # - "muscular": "via intramuscular" (medicamentos), eletroestimulador neuromuscular, eletromiógrafo, balança de
    #   bioimpedância ("massa muscular"), dinamômetro, treinador muscular respiratório, exercitador vaginal/perineal,
    #   massageador. Fica: faixa exercitadora, exercitador de membro, fortalecimento muscular, caneleira, halter.
    #   ("musculação" continua em _FORTE.)
    "muscular": (
        r"muscula(?!c)",
        r"intramuscular|neuromuscular|injetav|ampolas?\b|eletroestimul|eletromiogra|bioimpedanc|massa\s+muscular|"
        r"dinamometr|respirat|inspirat|expirat|vaginal|perine|pelvic|massag|relaxa|lesao|lesoes|fototerap|"
        r"infravermelh|cirurg|bandagem|\bluvas?\b|medicament|comprimid",
        r"exercitador\w*(?![^.;]{0,80}(vaginal|perine|pelvic))|faixas?\s+(elastic|exercitador)|"
        r"fortalecimento\s+muscular|caneleira|tornozeleira|halter|hand\s*grip|bola\s+(suica|terapeutica|de\s+pilates)|"
        r"academia|ginastic|pilates|treino\b|exercicios?\s+(fisicos|terapeuticos)",
    ),
    # - "anilha": anilha marcadora de cabo elétrico, anilha de vedação/pressão/latão (hidráulica). Fica: peso.
    "anilha": (
        r"anilha",
        r"anilhas?\s+(\(?\s*marcador|de\s+identific|para\s+identific|numerad|de\s+vedac|de\s+pressao|lisa|de\s+latao|"
        r"de\s+cobre|de\s+nylon|plastic)|marcador\w*\s+(de\s+|para\s+)?cabos?|identificac\w*\s+de\s+cabos?",
        r"halter|academia|musculac|ginastic|ferro\s+fundido|olimpic|\d\s*kg\b|bonnet|"
        r"anilhas?\s+(de\s+)?(peso|ferro|emborrachad|revestid|injetad|olimpic)",
    ),
    # - "gangorra": ferrolho/fecho/chave "tipo gangorra" (ferragem de armário, interruptor). Fica: brinquedo.
    "gangorra": (
        r"gangorra",
        r"ferrolho|fecho|trinco|dobradic|fechadura|armario|interruptor|tecla|chave|tipo\s+gangorra",
        r"crianc|infantil|playground|parque|brinquedo|lugares?\b|polietileno|cavalo|balanco|rotomold",
    ),
}
AMBIGUOS = {k: tuple(re.compile(p, re.I) for p in v) for k, v in _AMBIGUOS.items()}


def _ambiguo_academia(t: str, nome: str):
    """Match do termo ambíguo `nome` quando conta como academia; None quando falta ou o contexto o tira."""
    termo, fora, fica = AMBIGUOS[nome]
    m = termo.search(t)
    if not m or (fora.search(t) and not fica.search(t)):
        return None
    return m


def forte_ambiguo(t: str) -> bool:
    """Termo ambíguo (puxador, cross over, colchonete, cardio, elíptico, ergométrico, rolo de espuma, tatame,
    escorregador) no texto normalizado conta como 'forte' só com o contexto certo."""
    return bool(_puxador_academia(t) or _cross_over_academia(t) or _colchonete_academia(t)
                or any(_ambiguo_academia(t, k) for k in AMBIGUOS))


def _posicao_aparelho_ambiguo(t: str):
    """Match do nome de aparelho ambíguo (puxador alto..., cross over, elíptico, bicicleta ergométrica...) para
    e_peca(); None sem contexto."""
    if _puxador_academia(t) and PUXADOR_APARELHO.search(t):
        return PUXADOR_APARELHO.search(t)
    ms = [m for m in [CROSS_OVER.search(t) if _cross_over_academia(t) else None] +
          [_ambiguo_academia(t, k) for k in ("eliptico", "ergometrico", "cardio")] if m]
    return min(ms, key=lambda m: m.start()) if ms else None


def _forte(t: str) -> bool:
    return bool(FORTE.search(t) or forte_ambiguo(t))


# ---------------- nível de ITEM ----------------
# Texto curto de catálogo do portal (ex.: "AI0300036-PECK DECK C/ CRUCIFIXO"). Só para itens: sem o
# contexto do objeto, termos como "bola" ou "rede" são seguros aqui e perigosos no objeto.
# Termos ambíguos na indústria (polia, step, espaldar, manete) exigem contexto de academia.
_ITEM_FORTE = (
    r"agachament|peck\s*deck|crucifixo|supino|leg\s*(press|\d+|curl)|hack\s*\d|"
    r"banco\s+(para\s+)?(biceps|scott|supino|abdominal|extensor|adutor|abdutor|regulavel|grande\s+regulavel|romano)|"
    r"maquina\s+(p/?\s*|para\s+)?(peitoral|dorso|adutora|abdutora|desenvolvimento|panturrilha|de\s+agachamento|remada|gluteo|voador)|"
    r"adutora|abdutora|adutor/abdutor|adultor|flexo[\s-]*e?\s*extensor|cadeira\s+(extensora|flexora|adutora|abdutora)|mesa\s+flexora|"
    r"panturrilha|gluteo\s+(guiado|maquina|4\s*apoios)|polia\s+\d+\s+estac|estacao\s+de\s+musculac|barra\s+para\s+pulley|pulley|"
    r"esteira\s+(prof|ergom|eletric|elet\b)|"   # eliptic/ergometric: ambíguos, ver forte_ambiguo()
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
    eq = [m.start() for m in (ITEM_FORTE.search(t), ITEM_PISO.search(t), _posicao_aparelho_ambiguo(t)) if m]
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
    if academia_ar_livre(t) or brinquedo_infantil(t):
        return None, "regra"
    # elíptico/ergométrico saíram de ITEM_FORTE (ambíguos): continuam valendo aqui com o contexto certo, como antes
    # ("BICICLETA ERGOMÉTRICA ... alimentação elétrica" cai em FORA no classificar() e era salva por ITEM_FORTE)
    if ITEM_FORTE.search(t) or _ambiguo_academia(t, "eliptico") or _ambiguo_academia(t, "ergometrico"):
        return "forte", "regra_item"
    if CATALOGO_ESPORTIVO.search(texto or ""):
        return "forte", "catalogo"
    return None, "regra"


# ---------------- terceira rodada: regras de ITEM do PNCP e de contexto do OBJETO (01/10/2026) ----------------
# "piso de borracha"/"piso emborrachado" como característica de OUTRO produto: escada hospitalar "com piso de
# borracha antiderrapante", balança "plataforma com piso de borracha", cadeira de alimentação, bancada, cera
# "para piso de borracha", demolição/remoção de piso. O item começa pelo nome do outro produto.
PISO_EM_OUTRO_PRODUTO = re.compile(
    r"^\W*(\d+\W+)?(catmat\s+\d+\W+)?(cera|escadas?|escadinhas?|balancas?|cadeiras?|bancadas?|demolic\w*|remoc\w*|"
    r"retirada|limpeza|mesas?|banquetas?|macas?|carrinhos?|andador\w*)\b", re.I)
# Piso de borracha fino de obra civil (pastilhado/frisado/canelado/moeda, ou espessura abaixo de 10 mm), como nas
# composições SINAPI de manutenção predial: a linha Playfit é placa de 10 a 99 mm (mesma régua de _ITEM_PISO).
# Fica quando o mesmo texto fala de academia/esporte/playground/amortecimento.
PISO_FINO = re.compile(
    r"piso\s+(de\s+borracha|emborrachad\w*)\s+(\w+\s+)?(pastilhad|frisad|canelad|moeda)|"
    r"piso\s+(de\s+borracha|emborrachad\w*)\b[^;]{0,60}?\b(espessura|esp\.|espressura)\s*(de\s*|:\s*|minima\s*(de\s*)?)?"
    r"[1-9]([.,]\d+)?\s*mm\b", re.I)
PISO_ESPORTIVO_CONTEXTO = re.compile(r"academia|esportiv|crossfit|playground|parque|quadra|amortec|ginastic", re.I)


def piso_item_fora(texto: str | None) -> bool:
    """Item do PNCP que casa piso mas não é piso da linha Playfit (outro produto, ou piso fino de obra)."""
    t = normalizar(texto or "")
    return bool(PISO_EM_OUTRO_PRODUTO.search(t) or (PISO_FINO.search(t) and not PISO_ESPORTIVO_CONTEXTO.search(t)))


# Objeto de obra/construção/engenharia/manutenção predial ou compra de material de construção: os itens só contam
# pelo piso/grama/borracha (interesse da Playfit), nunca como "forte"/"fraco" (01/10/2026: #303 construção de creche
# com o item "Equipamentos esportivos"; #798 material de construção com "FERROLHO ... tipo gangorra"). O objeto já
# ficava fora por _FORA; agora os itens desses objetos também não puxam a compra para equipamento.
# Frases de obra, não palavras soltas: "Secretaria de Obras", "mão de obra", "Batalhão de Engenharia" e "reforma"
# numa lista de serviços de manutenção de aparelhos não contam (#112, #165, #84, #246 são compras/serviços legítimos).
OBRA_OBJETO = re.compile(
    r"(execucao|construcao|reforma|ampliacao|edificacao|revitalizacao|requalificacao|recuperacao)\s+(\w+\s+){0,4}?"
    r"(d[aoe]s?|na|no|em)\s+(\w+\s+){0,2}?(creche|escola|unidade|predio|sede|ponte|muro|calcad|edificio|edificac|ubs|"
    r"posto|cmei|obras?|imovel|hospital|centro|ginasio|quadra|praca|campo|estadio|bairro|ruas?|avenida|estrada|rodovia|"
    r"galeria|drenagem|rede)|\bobras?\s+(de\s+)?(engenharia|civil|construcao|reforma|pavimenta|infraestrutura)|"
    r"materia(l|is)\s+(\w+\s+){0,3}?de\s+construcao|manutencao\s+predial|engenharia\s+civil|"
    r"servicos?\s+(comuns\s+)?de\s+engenharia|empresa\s+(\w+\s+){0,2}?de\s+engenharia|pavimentac|\bempreitada", re.I)
# Compra para creche/educação infantil: tatame de EVA ali é tapete infantil, não tatame de luta/academia.
CRECHE_OBJETO = re.compile(r"creche|\bcmeis?\b|\bceis?\b|educacao\s+infantil|bercario|pre[\s-]*escola", re.I)


# Serviço de manutenção de prédios (#799 "CREDENCIAMENTO ... SERVIÇOS DE MANUTENÇÃO PREDIAL DE EDIFICAÇÕES PÚBLICAS",
# planilha SINAPI com "PISO DE BORRACHA ESPORTIVO 15MM"): decisão do Marcelo (01/10/2026), fica fora mesmo com o piso;
# nenhum item conta, só o objeto. Manutenção de EQUIPAMENTOS de academia (#165, #246) não é predial.
MANUTENCAO_PREDIAL = re.compile(
    r"manutenc\w*\s+(\w+\s+){0,4}?predia|"
    r"(manutenc|conservac|reparos?|adequac|intervenc)\w*\s+(\w+\s+|,\s*){0,8}?(em|de|d[aoe]s?|nos?|nas?)\s+"
    r"(edificac|edificios?|imoveis|predios|bens\s+imoveis|proprios\s+(publicos|municipais))", re.I)


def obra_ou_construcao(objeto: str | None) -> bool:
    return bool(OBRA_OBJETO.search(normalizar(objeto or "")))


def manutencao_predial(objeto: str | None) -> bool:
    return bool(MANUTENCAO_PREDIAL.search(normalizar(objeto or "")))


def so_tatame(texto: str | None) -> bool:
    """O único sinal de academia do texto é "tatame" (para a regra de creche)."""
    t = normalizar(texto or "")
    if not _ambiguo_academia(t, "tatame") or FORTE.search(t):
        return False
    return not (_puxador_academia(t) or _cross_over_academia(t) or _colchonete_academia(t)
                or any(_ambiguo_academia(t, k) for k in AMBIGUOS if k != "tatame"))


# ---------------- quarta rodada: "forte" por item de passagem (02/10/2026) ----------------
# Revisão do forte (leads+monitorar) de 02/10/2026: 99 linhas forte vinham de compras de mobiliário, brinquedos/
# material pedagógico, material de expediente ou material hospitalar/de saúde em que só um item "de passagem"
# (tatame EVA, colchonete, bola, banco, cama elástica, mesa de pebolim, puxador...) casava o vocabulário de academia.
# Regra (decisão do Marcelo): nessas compras a linha só fica "forte" com item CORE de equipamento de fato (esteira,
# bicicleta ergométrica/spinning, elíptico, equipamento de musculação, polia, espaldar, piso de borracha). Sem core, o item forte cai
# para "fraco" (continua no escopo, sai do forte). Puxador nunca é core (ali é puxador de porta/gaveta).
# Exceção: se o objeto também é de material esportivo, tatame continua valendo como core.
# Brinquedo de playground/parque/praça (BRINQUEDO_INFANTIL_FICA) não é compra de passagem: o playground é escopo.
OBJETO_PASSAGEM = {
    "mobiliario": re.compile(r"mobiliari|\bmobilias?\b|(?<!bens\s)(?<!bem\s)\bmoveis\b", re.I),
    "brinquedo": re.compile(
        r"brinquedo|\bludic|pedagogic|didatic|\bjogos?\s+(\w+\s+){0,2}?(educativ|pedagogic|terapeutic|ludic)", re.I),
    "expediente": re.compile(r"expediente|papelaria", re.I),
    "hospitalar": re.compile(
        r"hospitala|ambulatori|enfermagem|odontologic|fisioterap|reabilitac\w*\s+(fisic|fisioterap|motor)|"
        r"insumos?\s+(\w+\s+)?(de\s+)?saude|(equipamentos?|materia(l|is))\s+(\w+\s+){0,2}?medic", re.I),
}
# Serviço de manutenção/reparo (#2053 "Manutenção e Reparo de Material Esportivo / Brinquedo", #2119 manutenção de
# aparelhos de condicionamento físico) não é compra de móveis/brinquedos: a regra do item core não se aplica.
OBJETO_MANUTENCAO = re.compile(
    r"\bmanutenc\w*\s+(e\s+reparo|preventiva|corretiva)|"
    r"\b(manutenc\w*|reparos?|conserto)\s+(\w+\s+){0,2}?(de|em|d[aoe]s?)\s+(\w+\s+){0,2}?"
    r"(equipament|aparelh|materia|mobiliari|moveis|brinquedo|esteira|bicicleta)", re.I)
OBJETO_ESPORTIVO = re.compile(r"esportiv|desportiv|educacao\s+fisica|\blutas?\b|\bjudo\b|artes\s+marciais", re.I)
# Item core: equipamento de academia de fato. Halter/anilha/kettlebell contam como musculação (peso livre), como na
# lista "core estrito" da revisão de 02/10/2026; elíptico só com o contexto de aparelho (_ambiguo_academia).
ITEM_CORE = re.compile(
    r"esteiras?\s+(\w+\s+)?(ergometr|eletric|elet\b|profission|rolante|mecanic|curva|de\s+caminhada|para\s+caminhada|"
    r"de\s+corrida|motorizad)|"
    r"bicicletas?\s+(\w+\s+){0,2}?(ergometr|spinning|estacionari|horizontal|vertical)|\bspinning\b|"
    r"\bbikes?\s+(\w+\s+)?(spinning|indoor|ergometr|estacionari|horizontal|vertical)|cicloergometr|air\s*bike|"
    r"musculac|leg\s*press|supino|peck\s*deck|crucifixo|cadeira\s+(extensora|flexora|adutora|abdutora)|mesa\s+flexora|"
    r"maquina\s+(p/?\s*|para\s+)?(peitoral|dorso|adutora|abdutora|desenvolvimento|panturrilha|de\s+agachamento|remada|gluteo)|"
    r"agachamento\s+(guiado|hack|livre|smith|maquina)|\bhack\b|\bsmith\b|graviton|pulley|polia\s+\d|"
    r"puxada\s+(alta|frontal|articulad)|remada\s+(sentada|baixa|cavalinho|articulad)|multi[\s-]*estac|"
    r"estac(ao|oes)\s+(\w+\s+)?(de\s+)?musculac|"
    r"halter|dumbb?ells?|kettlebell|barra\s+olimpica|anilhas?\s+(de\s+)?(peso|ferro|emborrachad|revestid|injetad|olimpic|\d)|"
    r"(equipamentos?|aparelhos?)\s+(\w+\s+){0,2}?(de\s+|para\s+)(academia|musculacao|ginastica\s+de\s+academia)", re.I)
# "musculação"/"equipamento de academia" citados como uso ou aplicação de um acessório não fazem o item core:
# caneleira "indicada para ... musculação" (#179), faixa elástica/sand bag do CATMAT "uso: equipamentos de academia
# para treino funcional" (#1706, #1867), mosquetão "para aparelhos de musculação" (#2071, #2088), mini band "comparado
# com aparelhos de musculação" (#2120). E "cabeça supino" é posição do paciente (protetor de posicionamento, #256).
ITEM_CORE_USO = re.compile(
    r"(\buso\b|aplicac\w*|indicad[oa]s?|utilizad[oa]s?|\bideal\b|comparad[oa]s?|"
    r"\bpara\s+((os?|as?)\s+)?(aparelhos?|equipamentos?)\b)[^.;]{0,60}$|\bpara\s*$")
ITEM_CORE_POSICAO = re.compile(r"(cabeca|decubito|posicao|paciente)\s*$")
# Decisão do Marcelo (02/10/2026, v2): polia e espaldar são equipamento core e seguram o "forte". Pilates não é core
# (nem o aparelho de Pilates com polia/escada), nem o "aparelho/equipamento para condicionamento físico" genérico.
PILATES = re.compile(r"pilates|reformer|cadillac|\bbarrel\b|barril|step\s+chair|wunda", re.I)
POLIA = re.compile(r"\bpolias?\b")
# polia de aparelho de exercício: conjugada, regulável, cross, de ombro, com torre/carga/peso...
POLIA_CONTEXTO = re.compile(
    r"conjugad|regulav|cross|ombro|musculac|academia|carga|\bpesos?\b|torre|exercic|condicionamento|ginastic|treino|"
    r"fisioterap|reabilitac|gaiola|agachamento|\d\s*kg\b")
# polia como peça de outra coisa (batedeira "polia variadora", #425), acessório "para puxadas em aparelho de polia"
# (#2050) ou tração hospitalar
POLIA_FORA = re.compile(
    r"acessori\w*\s+(\w+\s+){0,4}?(para|de|em)\s+(\w+\s+){0,3}?polia|batedeira|liquidific|\bmotor\b|correia|"
    r"cortina|persiana|varal|portao|elevador|guincho|tracao\s+(cervical|lombar)|balcanic")
ACESSORIO_INICIO = re.compile(
    r"^\W*(\(\w+\)\s*)?(puxador|pegador|barra|corda|triangulo|tornozeleira|mosquet|cabo|alca|manopla)")
ESPALDAR = re.compile(r"\bespaldar\b")
# espaldar de parede (barra de Ling) x espaldar de cadeira ("espaldar médio", "tipo espaldar: alto", #355/#492)
ESPALDAR_PAREDE = re.compile(
    r"barras?\s+(/\s*escada\s+)?de\s+lingu?e?|escada\s+de\s+ling|barras?\s+horizonta|barras?\s+de\s+apoio|"
    r"\d+\s+barras|alongamento|fisioterap|ginastic|musculac|parede")
ESPALDAR_CADEIRA = re.compile(
    r"espaldar\s+(baixo|medio|alto)|(tipo|de|encosto)\s+espaldar|\b(cadeira|poltrona|longarina|banqueta|sofa)|"
    r"assento|giratori")


def objeto_passagem(objeto: str | None) -> list[str]:
    """Grupos de compra "de passagem" (mobiliario, brinquedo, expediente, hospitalar) que o objeto cita. Vazio = a
    regra do item core não se aplica."""
    t = normalizar(objeto or "")
    if OBJETO_MANUTENCAO.search(t):
        return []
    grupos = [g for g, rx in OBJETO_PASSAGEM.items() if rx.search(t)]
    if grupos == ["brinquedo"] and BRINQUEDO_INFANTIL_FICA.search(t):
        return []   # playground/parque infantil/praça é escopo, não compra de passagem
    return grupos


def objeto_esportivo(objeto: str | None) -> bool:
    return bool(OBJETO_ESPORTIVO.search(normalizar(objeto or "")))


def _core_de_fato(t: str, m: re.Match) -> bool:
    g, antes = m.group(0), t[max(0, m.start() - 80):m.start()]
    if g.startswith("anilha"):
        return _ambiguo_academia(t, "anilha")
    if g.startswith(("musculac", "equipament", "aparelh")):
        return not ITEM_CORE_USO.search(antes)
    if g.startswith("supino"):
        return not ITEM_CORE_POSICAO.search(antes)
    return True


def item_core(texto: str | None, esportivo: bool = False) -> bool:
    """Item é equipamento de academia de fato (esteira, bike ergométrica/spinning, elíptico, musculação, polia,
    espaldar, piso de borracha). Pilates não é core. `esportivo`: compra também de material esportivo, onde tatame
    também é core. Puxador nunca é core.
    Só o texto: quem chama tira os itens de serviço ('S'), que nunca são core."""
    t = normalizar(texto or "")
    # ITEM_FORA não vale aqui: "bicicleta ergométrica ... display com cronômetro" é core (#1831, 02/10/2026); anilha de
    # vedação/marcadora já fica de fora pelo _ambiguo_academia("anilha")
    if any(_core_de_fato(t, m) for m in ITEM_CORE.finditer(t)):
        return True
    # piso de borracha: só quando o classificador já o lê como piso/borracha da linha Playfit (não "escada com piso de
    # borracha", "placas de borracha (chinelo) artesanato", nem piso fino de obra)
    if classificar(texto or "") in ("piso", "obra_piso", "borracha") and not piso_item_fora(texto):
        return True
    if _cross_over_academia(t) or _ambiguo_academia(t, "eliptico"):
        return True
    if _polia_core(t) or _espaldar_core(t):
        return True
    return bool(esportivo and _ambiguo_academia(t, "tatame"))


def _polia_core(t: str) -> bool:
    """Polia de aparelho de exercício (conjugada, regulável, mono cross, de ombro...). Não conta acessório de polia
    (puxador, barra, corda), polia como peça de outro equipamento, uso citado ("uso em... sistemas de polia") nem
    aparelho de Pilates."""
    m = POLIA.search(t)
    if not m or PILATES.search(t) or POLIA_FORA.search(t) or ACESSORIO_INICIO.search(t):
        return False
    if ITEM_CORE_USO.search(t[max(0, m.start() - 80):m.start()]):
        return False
    return bool(POLIA_CONTEXTO.search(t))


def _espaldar_core(t: str) -> bool:
    """Espaldar (barra de Ling) de parede. Não conta espaldar de cadeira nem a escada do Ladder Barrel (Pilates)."""
    if not ESPALDAR.search(t) or PILATES.search(t):
        return False
    return bool(ESPALDAR_PAREDE.search(t) or not ESPALDAR_CADEIRA.search(t))


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
    # "borracha" vem antes de "piso"/"obra_piso" de propósito: o material explícito (raspa, granulado, SBR, EPDM,
    # pneu) é o produto que a Playfit vende e é a categoria de maior prioridade em pncp.avaliar e
    # paradigma.avaliar_processo. Por isso "Piso monolítico em EPDM moldado in loco" é "borracha", nunca
    # "obra_piso": a obra não se perde para o comercial, porque interesse_borracha() é True nos dois casos.
    # "obra_piso" fica para obra/execução de piso ou gramado sem material de borracha explícito no texto.
    if borracha(t):
        return "borracha"
    if pdms and pdms & set(PDMS_CONDICIONAIS) and (PISO.search(t) or FRACO.search(t) or _forte(t)):
        return "catmat"
    if _piso_in_loco(t):
        return "obra_piso"
    if PISO.search(t):
        return "obra_piso" if (OBRA_ESPORTIVA.search(t) or PISO_IN_LOCO.search(t)) else "piso"
    if FORA.search(t):
        return None
    if SERVICO_PESSOAL.search(t) and not PRODUTO.search(t):  # depois do piso: execução de piso continua
        return None
    if academia_ar_livre(t):  # piso/grama/borracha já saíram acima; aparelho de academia ao ar livre fica fora
        return None
    if brinquedo_infantil(t):  # piscina de bolinhas, brinquedo pedagógico etc. (playground continua)
        return None
    if _forte(t):
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
        return bool(borracha(t) or re.search(r"gram(a|ado)\s+sintetic|emborrachad|borracha|society|campo\s+sintetic", t))
    return False

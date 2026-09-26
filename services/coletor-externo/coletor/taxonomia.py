"""Decomposição de descrições de itens em taxonomia fixa.

Todo item (CATMAT ou texto livre de edital/PCA) vira 6 blocos:
  caracteristica : o que o produto é (tipo, material, revestimento, aplicação, modelo...)
  unidade        : unidade de fornecimento (UN, PAR, KIT...) e unidade de medida do peso
  peso           : valor numérico em kg
  cor            : cor normalizada
  formato        : forma/formato/perfil normalizado
  adicionais     : todo o resto (dimensões, furo, capacidade, garantia, observações)

Quando TIPO_PRODUTO = aparelho_ou_fora, o dicionário de aparelhos v0.3 resolve o nó
(`no_taxonomia`) via classificar_aparelho (método=regra).

Duas entradas:
  decompor_catmat(caracteristicas, unidades)  -> usa as características estruturadas do CATMAT
                                                 (verdade de referência para treinar/validar)
  decompor_texto(texto)                       -> texto livre de edital/PCA/PNCP
  calcular_taxonomia(texto, ...)              -> blocos + plano + classificação de aparelho
"""
from __future__ import annotations

import re
import unicodedata

from .classificar_aparelho import DICIONARIO_VERSAO, classificar as classificar_aparelho


def _n(t: str | None) -> str:
    return unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower().strip()


BLOCOS = ("caracteristica", "unidade", "peso", "cor", "formato", "adicionais")

# ---------------------------------------------------------------- mapa característica -> bloco
_CARAC = re.compile(r"^(tipo|material|revestimento|aplicacao|uso|acabamento|estrutura|modelo|tratamento|"
                    r"composicao|funcao|funcoes|sistema|componentes|resistencia|densidade|nome)\b")


def bloco_da_caracteristica(nome: str) -> str:
    """Nome de característica CATMAT -> bloco da taxonomia."""
    n = _n(nome)
    if "fornecimento" in n or n in ("unidade", "unidade fornecimento", "embalagem"):
        return "unidade"
    if n.startswith("cor"):
        return "cor"
    if n in ("forma", "formato") or n.startswith(("forma ", "formato ")):
        return "formato"
    if n == "peso" or n.startswith("peso ") and "imersao" not in n:
        return "peso"
    if _CARAC.match(n):
        return "caracteristica"
    return "adicionais"


# ---------------------------------------------------------------- vocabulários (texto livre)
CORES = {
    "preta": r"pret[oa]s?", "branca": r"branc[oa]s?", "azul": r"azu(l|is)", "vermelha": r"vermelh[oa]s?",
    "verde": r"verdes?", "amarela": r"amarel[oa]s?", "laranja": r"laranjas?", "rosa": r"rosa|pink",
    "roxa": r"rox[oa]s?|lilas", "cinza": r"cinzas?|grafite", "prata": r"prata|cromad[oa]", "variada": r"colorid[oa]s?|sortid[oa]s?|cor(es)?:? variad[oa]s?",
}
FORMATOS = [  # (padrão, valor canônico) — ordem importa
    (r"bolas? nas laterais|formato bola|tipo bola|\bbola\b", "BOLAS NAS LATERAIS"),
    (r"geometrica redonda nas extremidades", "GEOMÉTRICA REDONDA NAS EXTREMIDADES"),
    (r"sextavad|hexagonal", "SEXTAVADO"),
    (r"chaleira|kettlebell", "CHALEIRA"),
    (r"triangular", "TRIANGULAR"),
    (r"cilindric", "CILÍNDRICA"),
    (r"formato:? redond|redond[oa]", "REDONDA"),
    (r"formato:? disco|\bdisco\b", "DISCO"),
    (r"barra\s+(montada\s+)?(w|romana|ondulada|curvada|ez)\b|\bem w\b", "BARRA W"),
    (r"barra\s+(montada\s+)?(macica\s+)?reta", "BARRA RETA"),
    (r"quadrad", "QUADRADA"), (r"retangular", "RETANGULAR"),
]
MATERIAIS = [
    (r"ferro fundido", "FERRO FUNDIDO"), (r"aco\s+inox|inoxidavel", "AÇO INOX"), (r"aco", "AÇO"),
    (r"\bferro\b|granalha", "FERRO"), (r"\beva\b", "BORRACHA EVA"), (r"\bborracha\b", "BORRACHA"),
    (r"concreto|cimento", "CONCRETO"), (r"plastico|polipropileno|polietileno", "PLÁSTICO"), (r"madeira", "MADEIRA"),
]
REVESTIMENTOS = [
    (r"\bpvc\b|vinil", "PVC"), (r"polipropileno", "POLIPROPILENO"), (r"neoprene", "NEOPRENE"),
    (r"cromad|cromo|hard chrome", "CROMADO"), (r"pintura|pintad", "PINTURA"),
    (r"emborrachad|revestid[oa] (em|com) borracha", "BORRACHA"),
]
UNIDADES = [
    (r"\bpar(es)?\b|forma fornecimento: par|\(par\)", "PAR"), (r"\bkit\b", "KIT"), (r"\bjogo\b", "JOGO"),
    (r"\bconjunto\b", "CONJUNTO"), (r"\bund\b|\bun\b|unidade|\(und\)", "UN"),
]
TIPOS = [  # tipo grosso; nó fino (slug) vem do dicionário de aparelhos quando aplicável
    (r"^\W*(suporte|estante|rack|presilha|expositor)|\b(suporte|estante|rack|expositor) (para|de|p/) (halter|dumb|barra|anilha|kettle)|aplicacao: guardar", "acessorio"),
    (r"estofad|sistema (de )?carga|leg press|estacao de musculacao|regulage|aparelho|obras?\b|terraplan", "aparelho_ou_fora"),
    # Decisão 26/09: anilha, barra, haltere, colchonete, step = acessório
    (r"barra montada|barras? com peso fixo|barra (macica|cromada|olimpica|para anilha|reta|w\b)|diametro da barra", "acessorio"),
    (r"barra ductil.{0,60}anilha|barra anatomica", "acessorio"),
    (r"\banilhas?\b", "acessorio"),
    (r"dumb+el+s?|halter", "acessorio"),
    (r"colchonete|tapete de (yoga|exercicio)|mat de yoga", "acessorio"),
    (r"\bsteps?\b|plataforma step|step (profissional|ajustavel|aerobico)", "acessorio"),
    (r"kettlebell|chaleira", "kettlebell"),
    (r"presilha", "acessorio"),
]

_ATTR = re.compile(r"([A-ZÇÃÕÁÉÍÓÚÂÊÔ][A-ZÇÃÕÁÉÍÓÚÂÊÔ /\-]{1,40}?)\s*:\s*([^,;:]+?)(?=\s*[,;]\s*[A-ZÇÃÕÁÉÍÓÚÂÊÔ][A-ZÇÃÕÁÉÍÓÚÂÊÔa-zçãõáéíóúâêô /\-]{1,40}?\s*:|\s*$|\s+-\s+[A-Z][a-z]+\s*:)")
_PESO = re.compile(r"(?:peso[^:\d]{0,15}:?\s*)?(\d+(?:[.,]\d+)?)\s*(kg|kgs|quilos?|g|gr|gramas)\b", re.I)
_PESO_ATTR = re.compile(r"\bpeso\s*:?\s*(\d+(?:[.,]\d+)?)(?:\s*(kg|g))?", re.I)
_DIM = re.compile(r"(di[aâ]metro(?: do)? (?:furo|externo|da barra|da pegada)?|comprimento(?: interno| da barra)?|largura|altura|espessura|furo)"
                  r"[^\d]{0,25}(\d+(?:[.,]\d+)?)\s*(mm|cm|m|pol|\")", re.I)


def _primeiro(padroes, texto):
    for p, v in padroes:
        if re.search(p, texto):
            return v
    return None


def _pares_catmat(texto: str) -> list[tuple[str, str]]:
    """Extrai pares 'ATRIBUTO: valor' (estilo CATMAT ou 'Nome - Especificação: A: x - B: y')."""
    t = re.sub(r"\s+-\s+(?=[A-ZÇÃÁÉÍÓÚ][\wçãõáéíóúâêô ]{1,30}:)", ", ", texto)  # "Material: X - Tipo: Y"
    pares = []
    for m in re.finditer(r"([A-Za-zÇÃÕÁÉÍÓÚÂÊÔçãõáéíóúâêô][A-Za-zÇÃÕÁÉÍÓÚÂÊÔçãõáéíóúâêô /]{1,40}?)\s*:\s*((?:[^,;]|,(?=\d))+)", t):
        k, v = m.group(1).strip(), m.group(2).strip().rstrip(".")
        mk = re.search(r"(material|cor|formato|forma|aplicacao|aplicação|tipo|acabamento superficial|acabamento|revestimento|capacidade)$", k, re.I)
        if mk and mk.start() > 0 and not re.search(r"(forma fornecimento|revestimento externo|material|cor) ", k, re.I):
            k = k[mk.start():]
        if _n(k) in ("especificacao", "nome") or not v:
            continue
        pares.append((k.upper(), v.upper()))
    return pares


def _num(v: str) -> float | None:
    try:
        return float(v.replace(",", "."))
    except (ValueError, AttributeError):
        return None


def _vazio() -> dict:
    return {"caracteristica": {}, "unidade": {}, "peso": {}, "cor": None, "formato": None, "adicionais": {}}


def decompor_catmat(caracteristicas: list, unidades: list | None = None) -> dict:
    """caracteristicas: [(nome, valor, sigla_unidade)], unidades: ['SIGLA|NOME|cap|un'] do PDM."""
    out = _vazio()
    for nome, valor, sigla in caracteristicas or []:
        if valor is None or _n(valor) in ("nao aplicavel", "n/a", ""):
            continue
        b = bloco_da_caracteristica(nome)
        if b == "peso" and _n(nome) == "peso":
            out["peso"] = {"valor": _num(str(valor)), "unidade": (sigla or "KG").upper()}
        elif b == "peso":
            out["adicionais"][nome] = f"{valor} {sigla or ''}".strip()
        elif b in ("cor", "formato") and _n(nome) in ("cor", "forma", "formato"):
            out[b] = str(valor).upper()
        elif b in ("cor", "formato"):
            out["adicionais"][nome] = valor
        else:
            out[b][nome] = f"{valor} {sigla}".strip() if sigla else valor
    if unidades:
        out["unidade"]["fornecimento_opcoes"] = sorted({(u.split("|") + ["", ""])[1] or u.split("|")[0] for u in unidades if u})
    if out["peso"]:
        out["unidade"]["medida_peso"] = out["peso"].get("unidade")
    return out


def decompor_texto(texto: str) -> dict:
    """Texto livre -> 6 blocos. Usa pares 'ATRIBUTO: valor' quando existem e regex/vocabulário no resto."""
    out = _vazio()
    bruto = re.sub(r"\s+", " ", texto or "").strip()
    t = _n(bruto)

    # 1) pares estruturados (descrições CATMAT, PCA, especificações "Material: ...")
    for k, v in _pares_catmat(bruto):
        b = bloco_da_caracteristica(k)
        if b == "peso" and _n(k) == "peso" and not out["peso"]:
            m = re.match(r"(\d+(?:[.,]\d+)?)\s*(KG|G)?", v)
            if m:
                out["peso"] = {"valor": _num(m.group(1)), "unidade": (m.group(2) or "KG")}
        elif b == "cor" and _n(k) == "cor":
            out["cor"] = v
        elif b == "formato" and _n(k) in ("forma", "formato"):
            out["formato"] = v
        elif b == "caracteristica":
            out["caracteristica"][k] = v
        elif b == "unidade":
            out["unidade"]["fornecimento"] = {"UNIDADE": "UN"}.get(v, v)
        elif _n(v) not in ("nao aplicavel", "n/a"):
            out["adicionais"][k] = v

    # 2) completa o que faltou pelo texto livre
    if not out["peso"]:
        m = _PESO_ATTR.search(bruto)
        if not m:
            m = next((x for x in _PESO.finditer(bruto)
                      if not re.search(r"(carga|suporta\w*|ate|capacidade|maxim\w*|impactos?)[^\d]{0,25}$", _n(bruto[max(0, x.start()-30):x.start()]))), None)
        if m:
            val, un = _num(m.group(1)), (m.group(2) or "kg").lower()
            if un in ("g", "gr", "gramas") and val:
                val = val / 1000
            out["peso"] = {"valor": val, "unidade": "KG"}
    if not out["cor"]:
        for canon, p in CORES.items():
            if re.search(rf"\b(cor:?\s*)?({p})\b", t):
                out["cor"] = canon.upper()
                break
    if not out["formato"]:
        out["formato"] = _primeiro(FORMATOS, t)
    car = out["caracteristica"]
    tipo = _primeiro(TIPOS, t)
    if tipo and "TIPO_PRODUTO" not in car:
        car["TIPO_PRODUTO"] = tipo
    if not any(_n(k).startswith("material") for k in car):
        mat = _primeiro(MATERIAIS, t)
        if mat:
            car["MATERIAL"] = mat
    if not any(_n(k).startswith("revestimento") for k in car):
        rev = _primeiro(REVESTIMENTOS, t)
        if rev:
            car["REVESTIMENTO"] = rev
    und = _primeiro(UNIDADES, t)
    if und and "fornecimento" not in out["unidade"]:
        out["unidade"]["fornecimento"] = und
    if out["peso"]:
        out["unidade"]["medida_peso"] = "KG"

    # 3) adicionais: dimensões e demais trechos úteis
    for m in _DIM.finditer(bruto):
        out["adicionais"][m.group(1).strip().upper()] = f"{m.group(2)} {m.group(3).lower()}"
    for p, k in ((r"garantia de (\d+)", "GARANTIA_MESES"), (r"marcas? de referencia:?\s*([^.]+)", "MARCAS_REFERENCIA"),
                 (r"carga (?:maxima|max\.?|total)[^\d]{0,5}(\d+)\s*kg", "CARGA_MAX_KG"), (r"inmetro", "INMETRO")):
        m = re.search(p, t)
        if m:
            out["adicionais"][k] = m.group(1).strip() if m.groups() else "sim"
    return out


def _tipo_catmat_dos_blocos(blocos: dict) -> str | None:
    """Valor do campo TIPO estruturado (CATMAT), se presente nos blocos."""
    car = blocos.get("caracteristica") or {}
    for k, v in car.items():
        if _n(k) == "tipo" and v:
            return str(v).strip()
    return None


def classificar_se_aparelho(
    blocos: dict,
    texto: str,
    *,
    tipo_catmat: str | None = None,
    codigo_pdm=None,
    codigo_item=None,
) -> dict | None:
    """Se TIPO_PRODUTO em aparelho_ou_fora|acessorio, classifica o nó; senão None."""
    tipo_produto = (blocos.get("caracteristica") or {}).get("TIPO_PRODUTO")
    if tipo_produto not in ("aparelho_ou_fora", "acessorio"):
        return None
    tipo = tipo_catmat or _tipo_catmat_dos_blocos(blocos)
    return classificar_aparelho(
        texto or "",
        tipo_catmat=tipo,
        codigo_pdm=codigo_pdm,
        codigo_item=codigo_item,
    )


def achatar(d: dict, aparelho: dict | None = None) -> dict:
    """Dict de blocos -> colunas planas para planilha/tabela."""
    car = d["caracteristica"]
    get = lambda *ks: next((car[k] for k in car if _n(k) in ks), None)
    out = {
        "tipo_produto": car.get("TIPO_PRODUTO"),
        "tipo": get("tipo"),
        "material": get("material"),
        "revestimento": get("revestimento"),
        "aplicacao": get("aplicacao", "uso"),
        "caracteristica_outros": "; ".join(f"{k}={v}" for k, v in car.items()
                                           if _n(k) not in ("tipo_produto", "tipo", "material", "revestimento", "aplicacao", "uso")) or None,
        "unidade_fornecimento": d["unidade"].get("fornecimento") or ", ".join(d["unidade"].get("fornecimento_opcoes", [])) or None,
        "peso": d["peso"].get("valor"),
        "unidade_peso": d["peso"].get("unidade"),
        "cor": d["cor"],
        "formato": d["formato"],
        "adicionais": "; ".join(f"{k}={v}" for k, v in d["adicionais"].items()) or None,
    }
    if aparelho is not None:
        out["no_taxonomia"] = aparelho.get("slug")
        out["metodo"] = "regra"
        out["confianca"] = aparelho.get("confianca")
        out["escopo_aparelho"] = aparelho.get("escopo")
        out["versao_taxonomia"] = DICIONARIO_VERSAO
    return out


VERSAO_PIPELINE = "v1-2026-09-25"


def calcular_taxonomia(
    texto: str,
    *,
    tipo_catmat: str | None = None,
    codigo_pdm=None,
    codigo_item=None,
) -> dict:
    """Decompõe o texto e, se for aparelho, resolve o nó da taxonomia v0.3."""
    blocos = decompor_texto(texto or "")
    aparelho = classificar_se_aparelho(
        blocos,
        texto or "",
        tipo_catmat=tipo_catmat,
        codigo_pdm=codigo_pdm,
        codigo_item=codigo_item,
    )
    out: dict = {
        "versao": VERSAO_PIPELINE,
        "blocos": blocos,
        "plano": achatar(blocos, aparelho),
    }
    if aparelho is not None:
        out["versao_taxonomia"] = DICIONARIO_VERSAO
        out["aparelho"] = aparelho
        out["metodo"] = "regra"
        out["no_taxonomia"] = aparelho.get("slug")
        out["confianca"] = aparelho.get("confianca")
    return out

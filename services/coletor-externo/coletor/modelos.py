"""Modelo do equipamento em 3 partes, sem repetição: linha de produto, código (SKU) e nome do produto.

No CSV existe UMA coluna de modelo (`modelo` = só o nome do produto, sem linha e sem SKU) ao lado de `modelo_linha`
e `modelo_codigo`. O texto bruto que o fornecedor digitou fica em `modelo_original` (banco/cache), fora do CSV.

Decisões do Marcelo (26/09/2026), conferidas no site dos fabricantes quando possível:
  - LION: "08450 Tríceps Paralelo PRO"  -> código 08450, nome "Tríceps Paralelo", linha PRO
  - MOVEMENT: "Cadeira Tríceps Edge"     -> nome "Cadeira Tríceps", linha EDGE (também EDGE+, NEW EDGE, IDEA, RT...)
  - TOTAL HEALTH: "505BRX"               -> código 505BRX = máquina 505 (tríceps) da linha RX. O sufixo depois do número
    é a linha: RRF, RRX (Premium), RXS, RX. O site da Total Health mostra o mesmo tríceps como 505RRF (linha RRF);
    "505BRX" do edital não aparece no site e fica como linha RX, como o Marcelo indicou.
Marca sem regra: separa só o código (token com dígito, ex.: "CR0790", "VSS72H", "P200C") do nome.
Peso/medida ("20KG", "90X15", "50CM") não é código: é especificação e fica no nome.
"""
from __future__ import annotations

import re

from .perfil_item import normalizar_marca

_LINHAS = {
    "LION": [r"\bPRO\b", r"\bLFR\b", r"\bOPTIMUS\b", r"\bG2\b"],
    "MOVEMENT": [r"\bNEW\s+EDGE\b", r"\bEDGE\s*\+", r"\bEDGE\b", r"\bNEW\s+IDEA\b", r"\bIDEI?A\b", r"\bNEXT\b", r"\bRT\b", r"\bWIRE\b", r"\bROCK\b",
                 r"\bLINHA\s+CYCLE\b", r"\bBOLT\b"],
    "PROMED": [r"\bTUBULAR\s+CARENADA\b", r"\bTUBUKLAR\s+CARENADA\b", r"\bTUBULAR\b"],
    "FLEX EQUIPMENT": [r"\bCLASSIC\s+PREMIUM\b", r"\bCLASSIC\b"],
    "MACSPORT": [r"\bCROMUS\s+FECHADA(\s+CONJUGADA)?\b", r"\bCROMUS\b", r"\bURANOS\b", r"\bNEW\s+EVO\b", r"\bEVO\b", r"\bSIGMA\b", r"\bPESO\s+LIVRE\b"],
    "MATRIX": [r"\bVERSA\b", r"\bVERDA\b", r"\bMAGNUM\b", r"\bMAGNUN\b", r"\bAURA\b", r"\bVISION\b"],
}
_CORRIGE_LINHA = {"TUBUKLAR": "TUBULAR", "IDEIA": "IDEA", "MAGNUN": "MAGNUM", "VERDA": "VERSA"}
_CODIGO = re.compile(r"(?<![\d,.])\b(?=[A-Z0-9_-]*\d)[A-Z0-9][A-Z0-9_-]{3,}\b\+?(?![,.]\d)")
_MEDIDA = re.compile(r"^\d+([.,]\d+)?(KGS?|LBS?|CM|MM|MTS?|M|GR?|L)$|^\d+X\d+|^\d+$")
_TH = re.compile(r"\b(?:MAQ)?(\d{3,4})([A-Z]{1,4})\b")
_MOV_RT = re.compile(r"\bRT[-\s]?(\d{3})\b")
_RUIDO_COMERCIAL = re.compile(r"\s*-?\s*\b(FATURAMENTO|PEDIDO)\s+(M[IÍ]NIMO\s*)?.*$", re.I)
_SEM_NOME = re.compile(r"^(UND?|UNID(ADE)?S?|PAR|PC|PCS|PE[CÇ]A|IMP|NACIONAL|PADR[AÃ]O|DIVERSOS?|\W*)$", re.I)


def _limpa(t: str) -> str:
    t = re.sub(r"\s+[-–:/]\s*$|^\s*[-–:/]\s+", " ", t)
    return re.sub(r"\s{2,}", " ", re.sub(r"^[\s\-–:,]+|[\s\-–:,]+$", "", t)).strip()


def _mascara(up: str, ini: int, fim: int) -> str:
    return up[:ini] + " " * (fim - ini) + up[fim:]


def _eh_codigo(tok: str) -> bool:
    if _MEDIDA.match(tok):
        return tok.isdigit() and len(tok) >= 5  # "08450" (Lion) é código; "1200", "20KG", "90X15" não
    return True


def decompor_modelo(marca: str | None, modelo: str | None) -> dict:
    """{linha, codigo, nome} do modelo. nome = só o produto (sem linha, sem SKU, sem a marca). Vazios ficam None."""
    m = normalizar_marca(marca) or ""
    txt = re.sub(r"\s+", " ", (modelo or "").strip())
    txt = _RUIDO_COMERCIAL.sub("", txt).strip()
    if not txt:
        return {"linha": None, "codigo": None, "nome": None}
    up = txt.upper()
    linha = codigo = None
    if m == "TOTAL HEALTH" and (t := _TH.search(up)):
        codigo, suf = t.group(0), t.group(2)
        linha = suf if suf in ("RRX", "RRF", "RXS") else "RX" if suf.endswith("RX") else suf
        up = _mascara(up, t.start(), t.end())
    elif m == "MOVEMENT" and (t := _MOV_RT.search(up)):
        linha, codigo = "RT", f"RT-{t.group(1)}"
        up = _mascara(up, t.start(), t.end())
    else:
        for rx in _LINHAS.get(m, []):
            achou = re.search(rx, up)
            if achou:
                linha = re.sub(r"\s+", " ", achou.group(0)).replace("LINHA ", "")
                linha = re.sub(r"\s*\+", "+", linha)
                for errado, certo in _CORRIGE_LINHA.items():
                    linha = linha.replace(errado, certo)
                up = _mascara(up, achou.start(), achou.end())
                break
        for c in _CODIGO.finditer(up):
            if _eh_codigo(c.group(0)):
                codigo = c.group(0)
                up = _mascara(up, c.start(), c.end())
                break
    # a própria marca repetida no texto não é nome de produto ("ANILHA 10KG GEARS", "RT-150 MOVEMENT")
    if m:
        for w in {m, m.split()[0]}:
            for achou in re.finditer(rf"\b{re.escape(w)}\b", up):
                up = _mascara(up, achou.start(), achou.end())
    nome = _nome_de(txt, up)
    if not nome or _SEM_NOME.match(nome) or re.sub(r"\W", "", nome.upper()) == re.sub(r"\W", "", m):
        nome = None
    return {"linha": linha, "codigo": codigo, "nome": nome}


def _nome_de(original: str, mascarado_upper: str) -> str:
    """Recupera do texto original (com acentos/caixa) só os trechos que não viraram linha/código/marca."""
    out = "".join(ch if (i < len(mascarado_upper) and (mascarado_upper[i] != " " or ch == " ")) else " "
                  for i, ch in enumerate(original))
    return _limpa(out)

"""Dicionário versionado de chaves e leitura de número/faixa como o site escreveu."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

_ARQ = Path(__file__).resolve().parent.parent / "data" / "atributos_catalogo.json"
_CACHE: dict | None = None

_UNIDADES = {
    "kg": "kg", "kgs": "kg", "cm": "cm", "mm": "mm", "%": "%", "m2": "m²", "m²": "m²",
    "km/h": "km/h", "kmh": "km/h", "cv": "cv", "hp": "hp", "php": "php", "v": "V",
}
_FAIXA = re.compile(
    r"(?ix)^\s*(-?\d+(?:[.,]\d+)?)\s*(%|kg|kgs|cm|mm|km/h|kmh|m²|m2)?\s*"
    r"(?:a|até|ate|–|—|-)\s*(-?\d+(?:[.,]\d+)?)\s*(%|kg|kgs|cm|mm|km/h|kmh|m²|m2)?\s*$"
)


def dicionario() -> dict:
    global _CACHE
    if _CACHE is None:
        _CACHE = json.loads(_ARQ.read_text(encoding="utf-8"))
    return _CACHE


def norm_rotulo(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto or "")
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.lower()
    t = re.sub(r"\([^)]*\)", " ", t)
    t = t.replace("&", " e ")
    t = re.sub(r"[^a-z0-9]+", " ", t).strip()
    return t


def unidade_do_rotulo(rotulo: str) -> str | None:
    m = re.search(r"\(([^)]+)\)\s*$", (rotulo or "").strip())
    if not m:
        return None
    chave = norm_rotulo(m.group(1)).replace(" ", "")
    return _UNIDADES.get(chave) or _UNIDADES.get(m.group(1).strip().lower())


def chave_de(rotulo: str, familia: str) -> tuple[str | None, list[str]]:
    """Chave do dicionário para o rótulo, só se `aplica_a` inclui a família ou `comum`."""
    alvo = norm_rotulo(rotulo)
    if not alvo:
        return None, []
    melhor: tuple[int, str, list[str]] | None = None
    for item in dicionario()["chaves"]:
        aplica = item["aplica_a"]
        if "comum" not in aplica and familia not in aplica:
            continue
        for rot in item["rotulos"]:
            if rot == alvo and (melhor is None or len(rot) > melhor[0]):
                melhor = (len(rot), item["chave"], aplica)
    if melhor is None:
        return None, []
    return melhor[1], melhor[2]


def _num(token: str) -> int | float:
    s = token.strip()
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    valor = float(s)
    if abs(valor - round(valor)) < 1e-9:
        return int(round(valor))
    return valor


def _unidade_token(token: str | None, dica: str | None) -> str | None:
    if token:
        return _UNIDADES.get(token.lower(), token)
    return dica


def interpretar(texto: str, unidade_dica: str | None = None):
    """(valor, unidade). Faixa vira {min, max}. Um número vira número. O resto fica texto."""
    bruto = re.sub(r"\s+", " ", (texto or "").strip())
    if not bruto:
        return None, None
    faixa = _FAIXA.match(bruto)
    if faixa:
        unidade = _unidade_token(faixa.group(4) or faixa.group(2), unidade_dica)
        return {"min": _num(faixa.group(1)), "max": _num(faixa.group(3))}, unidade
    numeros = re.findall(r"-?\d+(?:[.,]\d+)?", bruto)
    if len(numeros) == 1:
        unidade = unidade_dica
        m = re.search(r"(?i)(km/h|kmh|m²|m2|kgs?|cms?|mm|%|php|hp|cv|v)\b", bruto)
        if m:
            unidade = _UNIDADES.get(m.group(1).lower(), unidade)
        return _num(numeros[0]), unidade
    m = re.search(r"(?i)(km/h|m²|m2|kg|cm|mm|%)\s*$", bruto)
    unidade = _UNIDADES.get(m.group(1).lower(), unidade_dica) if m else unidade_dica
    return bruto, unidade


def montar_atributo(*, rotulo: str, valor_original: str, familia: str, secao: str, ev: str) -> dict:
    dica = unidade_do_rotulo(rotulo)
    chave, aplica = chave_de(rotulo, familia)
    # A unidade sugerida pela chave entra só quando o texto não trouxe outra.
    if chave and dica is None:
        for item in dicionario()["chaves"]:
            if item["chave"] == chave and item.get("unidade") and chave.endswith(("_kg", "_cm")):
                dica = item["unidade"]
                break
    valor, unidade = interpretar(valor_original, dica)
    return {
        "chave": chave,
        "rotulo_original": rotulo.strip(),
        "valor_original": re.sub(r"\s+", " ", valor_original).strip(),
        "valor": valor,
        "unidade": unidade,
        "aplica_a": aplica or None,
        "secao": secao,
        "ev": ev,
    }

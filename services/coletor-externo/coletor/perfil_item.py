"""Perfil do item para o BI: família de equipamento (dicionário de aparelhos v0.3), fonte de carga e marca normalizada.

- Família/nó: `classificar_aparelho` (dicionário do LicitaGym). Quando o dicionário não reconhece o texto curto do
  portal (ex.: "REMO", "CADEIRA TRICEPS DIMENSAO", "MAQUINA DESENVOLVIMENTO"), uma regra grossa dá só a família
  (metodo='regra_perfil'), para o BI não ficar com buraco. Os textos que caem nessa regra são candidatos a sinônimo
  novo no dicionário.
- Fonte de carga (placas = bateria de peso × anilhas × motor...) vem dos atributos do dicionário quando o texto diz.
  No portal Paradigma o texto curto quase nunca diz; a ficha técnica do edital (Anexo II) diz. Ver documentos.
"""
from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

from .classificar_aparelho import DICIONARIO_VERSAO, get_classificador, norm

_COD = re.compile(r"^\s*[A-Z]{2}\d{7}\s*-\s*")

_FAMILIA_REGRA = [
    ("avaliacao_fisica", r"balanca|estadiometr|adipometr|plicometr|antropometr"),
    ("equipamentos_fitness.pilates", r"pilates|reformer|cadillac|\bchair\b|barrel|bola suica|bola de pilates"),
    ("equipamentos_fitness.funcional", r"plyo|caixa degrau|caixa p|abmat|\bghd\b|climb rope|corda (de )?escalada|carbonato|"
                                       r"kettlebell|wall ?ball|slam ?ball|medicine|bolas? de peso|tonific|trx|suspensao"),
    ("equipamentos_fitness.acessorios", r"\bcone|chapeu chines|mini ?band|hip ?band|super ?band|elastic|colete|bastao|bomba|"
                                        r"\brolo\b|presilha|collar|tornozeleira|caneleira|luva|corda de pular|step|colchonete|tapete"),
    ("aquatico_hidro", r"boia|espaguete|flutua|hidro|natacao|piscina|prancha|palmar|touca|oculos de natacao"),
    ("esportes_coletivos_raquete", r"\bbola\b|\brede\b|raquete|beach tennis|\btenis\b|futsal|futebol|volei|handebol|"
                                   r"basquet|peteca|apito|placar|trave|dente de leite"),
    ("equipamentos_fitness.cardio", r"\bremo\b|bike|bicicleta|ergometr|esteira|eliptic|transport|simulador de escada|stepper"),
    ("equipamentos_fitness.suportes", r"suporte|rack|gaiola|estante|porta anilha"),
    ("equipamentos_fitness.peso_livre", r"\bbanco\b|halter|dumbb|anilha|kettlebell|barra"),
    ("equipamentos_fitness.musculacao", r"maquina|\bmaq\b|cadeira|mesa|graviton|crossover|puxada|desenvolvimento|supino|hack|"
                                        r"smith|agachamento|panturrilha|gluteo|adutor|abdutor|remada|triceps|biceps|leg press|"
                                        r"voador|peck|extensor|flexor|pelvica"),
]


def texto_do_item(descricao: str | None) -> str:
    return _COD.sub("", descricao or "").strip()


_COMPLEMENTO_ARQ = Path(__file__).resolve().parent / "data" / "dicionario-aparelhos-complemento.json"
_complemento: list[tuple[re.Pattern, dict]] | None = None
_propostos: dict[str, dict] = {}
VERSAO_COMPLEMENTO = "0.3+c1"


def _regras_complemento() -> list[tuple[re.Pattern, dict]]:
    """Sinônimos decididos para os textos curtos dos portais (aplicados antes do dicionário v0.3)."""
    global _complemento
    if _complemento is None:
        d = json.loads(_COMPLEMENTO_ARQ.read_text(encoding="utf-8")) if _COMPLEMENTO_ARQ.exists() else {"regras": []}
        _complemento = [(re.compile(r["padrao"]), r) for r in d["regras"]]
        _propostos.update({n["slug"]: n for n in d.get("nos_propostos", [])})
    return _complemento


def perfil_item(descricao: str | None) -> dict:
    """{no_taxonomia, produto_padronizado, familia_equipamento, fonte_carga, cinematica, perfil_metodo, ...}."""
    t = texto_do_item(descricao)
    clf = get_classificador()
    tn = norm(t)
    base = {"versao_taxonomia": VERSAO_COMPLEMENTO}
    for rx, regra in _regras_complemento():
        no = clf.nos.get(regra["slug"]) or _propostos.get(regra["slug"])
        if rx.search(tn) and no:
            attrs = regra.get("atributos") or {}
            proposto = regra["slug"] not in clf.nos
            return {**base, "no_taxonomia": regra["slug"], "produto_padronizado": regra.get("produto") or no["nome"],
                    "familia_equipamento": no["familia"], "fonte_carga": attrs.get("fonte_carga"),
                    "cinematica": attrs.get("cinematica"),
                    "perfil_metodo": "complemento_no_proposto" if proposto else "complemento",
                    "perfil_confianca": "media" if proposto else "alta"}
    r = clf.classificar(t)
    at = r.get("atributos") or {}
    fc = at.get("fonte_carga")
    fonte = ",".join(fc) if isinstance(fc, list) else fc
    if r.get("slug"):
        no = clf.nos[r["slug"]]
        return {**base, "no_taxonomia": r["slug"], "produto_padronizado": no["nome"], "familia_equipamento": no["familia"],
                "fonte_carga": fonte, "cinematica": at.get("cinematica"), "perfil_metodo": "dicionario",
                "perfil_confianca": r["confianca"]}
    for familia, rx in _FAMILIA_REGRA:
        if re.search(rx, tn):
            return {**base, "no_taxonomia": None, "produto_padronizado": None, "familia_equipamento": familia,
                    "fonte_carga": fonte, "cinematica": at.get("cinematica"), "perfil_metodo": "regra_perfil",
                    "perfil_confianca": "baixa"}
    return {**base, "no_taxonomia": None, "produto_padronizado": None, "familia_equipamento": None,
            "fonte_carga": fonte, "cinematica": at.get("cinematica"), "perfil_metodo": None, "perfil_confianca": None}


# Marcas vistas nos certames. A lista cresce com os dados; variações de digitação caem na mais parecida.
MARCAS = ["MOVEMENT", "PROMED", "FLEX EQUIPMENT", "MACSPORT", "MATRIX", "EMBREEX", "LIDER", "WELMY", "BALMAK",
          "LION", "TOTAL HEALTH", "WETTOR FITNESS", "ALFA FITNESS", "PHYSICUS", "RIGHETTO", "PROTEUS", "G-TECH",
          "LIFE FITNESS", "TECHNOGYM", "SLADE FITNESS", "KAUFFER PILATES", "FUNDIDOS UNIBRAS", "CROW FITNESS", "GLADIUS",
          "PENALTY", "EQUILIBRIO", "RINO FORCE", "ARKTUS", "VOLLO", "PRAXIS", "POLIMET", "JOHNSON", "KIKOS", "ATHLETIC", "OLYMPIKUS", "RIGHETTO", "GEARS", "MK FITNESS"]
_ALIAS = {"LYON": "LION", "LIVEUP": "LIVE UP", "MK": "MK FITNESS", "FLEX": "FLEX EQUIPMENT", "MONVIMENT": "MOVEMENT", "BRITÂNIA": "BRITANIA", "MOVIMENT": "MOVEMENT", "MOVEMNT": "MOVEMENT", "MOVMENET": "MOVEMENT", "MOVIMENT ASSALT": "MOVEMENT",
          "MOVEMENT ASSAULT": "MOVEMENT", "LION FITNESS": "LION"}


# Valores que aparecem no campo marca mas são produto ou "sem marca": não contam como marca.
_NAO_MARCA = re.compile(r"^(IMP|IMPORTAD[OA]|GENERIC[OA]|SEM MARCA|NACIONAL|PROPRIA|DIVERS[OA]S?|N/?A|-+|\.+|UND?|UNID|"
                        r"BANCO DE PRE[CÇ]OS?|.*INTERNET.*|REFER[EÊ]NCIA.*|VALOR DE REFER.*|EMBORRACHAD[OA]|"
                        r"POLI[EÉ]STER|COLETE|ESPORTES?|SPORTS?|BRASIL|"
                        r"(CORDA|ANILHAS?|BOLAS?|PUXADOR|HALTER(ES)?|BARRA|CONE|COLCHONETE|TAPETE)\b.*)$")


def normalizar_marca(marca: str | None) -> str | None:
    m = re.sub(r"\s+", " ", (marca or "").strip().upper())
    if not m or _NAO_MARCA.match(m):
        return None
    if "-" in m and not m.startswith("-"):  # "SLADE-PUXADOR CORDA" -> "SLADE" quando a 1ª parte é marca conhecida
        primeira = m.split("-", 1)[0].strip()
        if primeira and (primeira in _ALIAS or any(x.split()[0] == primeira for x in MARCAS)):
            m = primeira
    if m in _ALIAS:
        return _ALIAS[m]
    if m in MARCAS:
        return m
    # Só a palavra distintiva decide (FITNESS/EQUIPMENT/SPORTS são genéricas: "SLADE FITNESS" não é "LIFE FITNESS").
    genericas = {"FITNESS", "EQUIPMENT", "EQUIPAMENTOS", "SPORTS", "SPORT", "ESPORTES", "PRO", "LINE"}
    chave = next((w for w in m.split() if w not in genericas), "")
    if len(chave) >= 5:
        alvo = {x.split()[0]: x for x in MARCAS}
        parecida = difflib.get_close_matches(chave, list(alvo), n=1, cutoff=0.85)
        if parecida:
            return alvo[parecida[0]]
    return m

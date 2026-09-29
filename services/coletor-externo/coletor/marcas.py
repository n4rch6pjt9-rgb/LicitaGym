"""Gate de marca para o BI: quem fabrica × quem revende, e se a marca ofertada é uma das marcas de referência do edital.

Fornecedor (olhando TODAS as propostas dele no conjunto de dados, não um item só):
  - fabricante — marca própria         CNAE de indústria (10–33) e oferta só a própria marca
  - fabricante + revenda               CNAE de indústria, mas também oferta marca de terceiro (ex.: PROMED com FUNDIDOS UNIBRAS)
  - revenda monomarca                  comércio/serviço, 1 marca
  - revenda multimarca                 comércio/serviço, N marcas
  Marca própria do fabricante: marca cujo nome aparece na razão social (PROMED, KAUFFER, SLADE); se nenhuma aparece,
  a marca que ele mais oferta (ex.: JULIO CESAR GASPARINI -> FLEX EQUIPMENT), marcada como 'mais_frequente'.

Linha (proposta):
  - relacao_marca: 'marca própria' (fabricante ofertando a própria marca) | 'revenda'
  - ref_marca_1..3 / ref_modelo_1..3: marcas e modelos citados no edital (Anexo II), quando transcritos em
    coletor/data/referencias_edital/<fonte>_<processo>.json
  - marca_ofertada_na_referencia: SIM / NÃO / SEM REFERÊNCIA (comparação pela marca normalizada, nunca por pedaço de texto)
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from .classificar_aparelho import norm
from .modelos import decompor_modelo
from .perfil_item import normalizar_marca, perfil_item

_REF_DIR = Path(__file__).resolve().parent / "data" / "referencias_edital"
_FAB_ARQ = Path(__file__).resolve().parent / "data" / "fabricantes_marcas.json"


def _fabricantes_curados() -> dict:
    return json.loads(_FAB_ARQ.read_text(encoding="utf-8"))["fabricantes"] if _FAB_ARQ.exists() else {}
MAX_MARCAS_FORNECEDOR = 10  # colunas marca_fornecedor_1..10; a lista completa vai no CSV fornecedor × marca
_GENERICAS = {"FITNESS", "EQUIPMENT", "EQUIPAMENTOS", "SPORTS", "SPORT", "ESPORTES", "PRO", "LINE", "INDUSTRIA", "COMERCIO"}
MAX_REF = 3


def carregar_referencias(pasta: Path = _REF_DIR) -> dict[tuple[str, str], dict]:
    """(processo, item) -> referência do edital."""
    refs = {}
    for arq in sorted(pasta.glob("*.json")):
        d = json.loads(arq.read_text(encoding="utf-8"))
        for item, r in d["itens"].items():
            refs[(d["processo"], str(item))] = r
    return refs


def _marca_no_nome(marca: str, razao: str) -> bool:
    razao_n = f" {norm(razao)} "
    tokens = [t for t in norm(marca).split() if t.upper() not in _GENERICAS and len(t) >= 4]
    return bool(tokens) and all(f" {t} " in razao_n for t in tokens)


def gate_fornecedores(linhas: list[dict]) -> dict[str, dict]:
    """cnpj -> perfil comercial calculado sobre todas as propostas com posição."""
    marcas = defaultdict(Counter)
    info = {}
    for l in linhas:
        c = l.get("cnpj")
        if not c or not l.get("ranking"):
            continue
        m = normalizar_marca(l.get("marca"))
        if m:
            marcas[c][m] += 1
        info.setdefault(c, l)
    out = {}
    curados = _fabricantes_curados()
    for c, l in info.items():
        cont = marcas.get(c, Counter())
        fab = (l.get("tipo_empresa") or "").startswith("fabricante")
        propria, metodo = None, None
        curado = curados.get(c)
        if curado:
            propria, metodo = normalizar_marca(curado["marca"]), "curado"
        elif fab and cont:
            razao = f"{l.get('razao_social_receita') or ''} {l.get('empresa') or ''}"
            no_nome = [m for m, _ in cont.most_common() if _marca_no_nome(m, razao)]
            propria, metodo = (no_nome[0], "nome") if no_nome else (cont.most_common(1)[0][0], "mais_frequente")
        n = len(cont)
        if not cont:
            perfil = "sem marca informada"
        elif fab:
            perfil = "fabricante — marca própria" if n == 1 else "fabricante + revenda"
        else:
            perfil = "revenda monomarca" if n == 1 else "revenda multimarca"
        out[c] = {"perfil_comercial": perfil, "marca_propria": propria, "marca_propria_metodo": metodo,
                  "qtd_marcas_fornecedor": n, "_marcas": cont.most_common()}
        for i in range(1, MAX_MARCAS_FORNECEDOR + 1):
            out[c][f"marca_fornecedor_{i}"] = cont.most_common()[i - 1][0] if i <= n else None
    return out


def perfil_taxonomia(perfil: str | None) -> str | None:
    """'Musculação — placas (bateria de peso)' -> 'Musculação'. Só o grupo da taxonomia; o tipo de carga vai para
    fonte_carga_edital."""
    if not perfil:
        return None
    return re.split(r"\s+[—–-]\s+|\s*\(", perfil, maxsplit=1)[0].strip() or None


def fonte_e_carga(fonte: str | None) -> tuple[str | None, float | None]:
    """'placas (carga 100 kg)' -> ('placas', 100.0); 'placas (80–110 kg)' -> ('placas', 80.0) = carga mínima exigida;
    'anilhas (articulado)' -> ('anilhas', None); '-' -> (None, None)."""
    if not fonte or fonte.strip() in ("-", "—"):
        return None, None
    tipo = re.split(r"\s*\(", fonte, maxsplit=1)[0].strip() or None
    carga = None
    if tipo == "placas":
        achou = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:[–-]\s*\d+(?:[.,]\d+)?\s*)?kg", fonte, re.I)
        if achou:
            carga = float(achou.group(1).replace(",", "."))
    return tipo, carga


def marcas_por_fornecedor(linhas: list[dict]) -> list[dict]:
    """Formato longo (1 linha por fornecedor × marca) para o BI: a lista completa, sem limite de colunas."""
    gate = gate_fornecedores(linhas)
    nomes = {l.get("cnpj"): l.get("empresa") for l in linhas if l.get("cnpj")}
    out = []
    for c, g in gate.items():
        for ordem, (marca, n) in enumerate(g["_marcas"], 1):
            out.append({"cnpj": c, "empresa": nomes.get(c), "perfil_comercial": g["perfil_comercial"], "ordem": ordem,
                        "marca": marca, "qtd_propostas": n, "marca_propria": marca == g["marca_propria"]})
    return out


def enriquecer(linhas: list[dict], refs: dict | None = None) -> list[dict]:
    """Aplica o gate de fornecedor e as referências do edital em cada linha (dicts do relatório/CSV)."""
    refs = carregar_referencias() if refs is None else refs
    gate = gate_fornecedores(linhas)
    for l in linhas:
        # produto padronizado pela taxonomia (dicionário v0.3 + complemento), recalculado a partir da descrição
        if l.get("descricao"):
            p = perfil_item(l["descricao"])
            for k in ("no_taxonomia", "produto_padronizado", "familia_equipamento", "cinematica"):
                l[k] = p.get(k)
        m = normalizar_marca(l.get("marca"))
        l["marca_normalizada"] = m
        # uma coluna de modelo: só o nome do produto; linha e SKU em colunas próprias; texto bruto em modelo_original
        l.setdefault("modelo_original", l.get("modelo"))
        dm = decompor_modelo(m, l.get("modelo_original"))
        l["modelo"], l["modelo_linha"], l["modelo_codigo"] = dm["nome"], dm["linha"], dm["codigo"]
        g = {k: v for k, v in gate.get(l.get("cnpj") or "", {}).items() if not k.startswith("_")}
        l.update(g)
        if m and g:
            l["relacao_marca"] = "marca própria" if g.get("marca_propria") == m else "revenda"
        r = refs.get((l.get("processo"), str(l.get("item"))))
        if not r:
            l["marca_ofertada_na_referencia"] = "SEM REFERÊNCIA"
            continue
        opcoes = r["referencias"][:MAX_REF]
        for i, o in enumerate(opcoes, 1):
            rm = normalizar_marca(o["marca"])
            dr = decompor_modelo(rm, o.get("modelo"))
            l[f"ref_marca_{i}"] = rm
            l[f"ref_modelo_{i}"] = dr["nome"]          # só o nome do produto; linha e código nas colunas ao lado
            l[f"ref_linha_{i}"], l[f"ref_codigo_{i}"] = dr["linha"], dr["codigo"]
        l["qtd_marcas_referencia"] = len(r["referencias"])
        l["perfil_edital"] = perfil_taxonomia(r.get("perfil"))
        l["fonte_carga_edital"], l["carga_placas_kg_edital"] = fonte_e_carga(r.get("fonte_carga"))
        pos = next((i for i, o in enumerate(r["referencias"], 1) if normalizar_marca(o["marca"]) == m), None)
        l["marca_ofertada_na_referencia"] = ("SIM" if pos else "NÃO") if m else ""
        l["posicao_na_referencia"] = pos
    return linhas

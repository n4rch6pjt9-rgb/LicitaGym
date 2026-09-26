"""Classificador por regras do dicionário de aparelhos LicitaGym (baseline do Agente de Edital).

Fonte editável: docs/agente-editais/dicionario-aparelhos/ (dados.py → gerar.py).
Cópia operacional: coletor/data/dicionario-aparelhos-v0.3.json.

Uso:
    from coletor.classificar_aparelho import classificar
    classificar("Cadeira extensora com bateria de pesos de 80 kg")
    classificar(descricao, tipo_catmat="ELÉTRICA", codigo_pdm=2640, codigo_item=225083)

Retorna: {slug, confianca (alta|media|baixa), candidatos, termo, atributos, escopo, pdm_catmat}
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

DICIONARIO_VERSAO = "0.3"
_DATA_DIR = Path(__file__).resolve().parent / "data"
_DICIONARIO_PADRAO = _DATA_DIR / f"dicionario-aparelhos-v{DICIONARIO_VERSAO}.json"


def caminho_dicionario(caminho: str | Path | None = None) -> Path:
    p = Path(caminho) if caminho else _DICIONARIO_PADRAO
    if not p.is_file():
        raise FileNotFoundError(f"Dicionário de aparelhos não encontrado: {p}")
    return p


def norm(t: str | None) -> str:
    t = unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()
    t = re.sub(r"[º°]", " ", t)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9/+ ]", " ", t)).strip()


def singular(t: str) -> str:
    """Plural simples -> singular, aplicado igual ao texto e aos sinônimos (halteres->haltere, faixas->faixa)."""
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in t.split())


SUBORDINADOS = {"anilha", "barra_livre", "haltere", "pegador_polia", "suporte_armazenamento"}
FALLBACK = {"aparelho_musculacao_indefinido", "cardio_indefinido", "leg_press_indefinido"}


class Classificador:
    def __init__(self, caminho: str | Path | None = None):
        with open(caminho_dicionario(caminho), encoding="utf-8") as f:
            d = json.load(f)
        self.versao = str(d.get("versao") or DICIONARIO_VERSAO)
        self.nos = {n["slug"]: n for n in d["nos"]}
        self.pistas = d["pistas"]
        self.ambiguos = d["ambiguos"]
        self.refinos = d.get("refinos", [])
        self.catmat_item = {str(k): v for k, v in d.get("catmat_item", {}).items()}
        self.tipo_catmat = {}
        for n in d["nos"]:
            for t in n["catmat_tipo"]:
                pdm, _, tipo = t.rpartition(":") if ":" in t else ("", "", t)
                self.tipo_catmat.setdefault((pdm, norm(tipo)), []).append(n["slug"])
        self.duais = {n["slug"]: set(n["componentes"]) for n in d["nos"] if len(n["componentes"]) >= 2}
        pares = list(dict.fromkeys((singular(norm(s)), n["slug"]) for n in d["nos"] for s in n["sinonimos"]))
        pares.sort(key=lambda p: -len(p[0]))
        self.sinonimos = [(re.compile(rf"(?<![a-z0-9]){re.escape(s)}(?![a-z0-9])"), s, slug) for s, slug in pares]

    def atributos(self, t: str) -> dict:
        out = {}
        for eixo, regras in self.pistas.items():
            if isinstance(regras, str):
                if re.search(regras, t):
                    out[eixo] = True
                continue
            achados = [v for v, rx in regras.items() if re.search(rx, t)]
            if achados:
                out[eixo] = achados if eixo == "angulo" else achados[0]
        return out

    def classificar(self, texto: str, tipo_catmat: str | None = None, codigo_pdm=None, codigo_item=None) -> dict:
        t = norm(texto)
        attrs = self.atributos(t)
        if codigo_item is not None and str(codigo_item) in self.catmat_item:
            slug = self.catmat_item[str(codigo_item)]
            return self._res(slug, "alta", [slug], f"ITEM:{codigo_item}", attrs)
        if tipo_catmat:
            chave = next((k for k in ((str(codigo_pdm or ""), norm(tipo_catmat)), ("", norm(tipo_catmat)))
                          if k in self.tipo_catmat and k[0] in ("", str(codigo_pdm or ""))), None)
            if chave:
                cands = self.tipo_catmat[chave]
                return self._res(cands[0], "alta" if len(cands) == 1 else "media", cands, f"TIPO:{tipo_catmat}", attrs)
        ts = singular(t)
        hits, ocupado = [], []
        for rx, s, slug in self.sinonimos:
            for m in rx.finditer(ts):
                if not any(a <= m.start() and m.end() <= b for a, b in ocupado):
                    ocupado.append(m.span())
                    hits.append((s, slug))
        hits = [(s, slug) for s, slug in hits if s not in self.ambiguos]
        if hits:
            achados = {x for _, x in hits}
            for dual, comps in self.duais.items():
                if comps <= achados:
                    return self._res(dual, "media", [dual] + sorted(comps), "componentes", attrs)
            fortes = [h for h in hits if h[1] not in SUBORDINADOS | FALLBACK]
            s, slug = (fortes or hits)[0]
            outros = list(dict.fromkeys(x for _, x in hits[1:] if x != slug))
            relevantes = [x for x in outros if x not in SUBORDINADOS]
            conf = "alta" if len(s.split()) >= 2 and not relevantes and slug not in FALLBACK else "media"
            novo = self._refinar(slug, t)
            if novo:
                return self._res(novo, "media", [novo, slug] + outros, f"{s} + refino", attrs)
            return self._res(slug, conf, [slug] + outros, s, attrs)
        for termo, cands in self.ambiguos.items():
            if re.search(rf"(?<![a-z0-9]){re.escape(singular(termo))}(?![a-z0-9])", ts):
                novo = self._refinar(f"ambiguo:{termo}", t)
                if novo:
                    return self._res(novo, "media", [novo] + [x for x in cands if x != novo], f"{termo} + refino", attrs)
                return self._res(None, "baixa", cands, termo, attrs)
        return self._res(None, "baixa", [], None, attrs)

    def _refinar(self, slug: str, t: str) -> str | None:
        mod = self.nos[slug]["modalidade"] if slug in self.nos else None
        for r in self.refinos:
            alvo = r["de"]
            if (alvo == slug or (alvo.startswith("*") and alvo[1:] == mod)) and r["para"] != slug and re.search(r["se"], t):
                return r["para"]
        return None

    def _res(self, slug, conf, cands, termo, attrs):
        n = self.nos.get(slug) if slug else None
        return {"slug": slug, "confianca": conf, "candidatos": cands, "termo": termo, "atributos": attrs,
                "escopo": n["escopo"] if n else None, "pdm_catmat": n["pdm_catmat"] if n else []}


_classificador: Classificador | None = None


def get_classificador(caminho: str | Path | None = None) -> Classificador:
    global _classificador
    if caminho is not None:
        return Classificador(caminho)
    if _classificador is None:
        _classificador = Classificador()
    return _classificador


def classificar(texto: str, tipo_catmat: str | None = None, codigo_pdm=None, codigo_item=None) -> dict:
    return get_classificador().classificar(texto, tipo_catmat=tipo_catmat, codigo_pdm=codigo_pdm, codigo_item=codigo_item)


if __name__ == "__main__":
    import sys
    c = Classificador(sys.argv[1] if len(sys.argv) > 1 else None)
    for linha in sys.stdin:
        print(json.dumps(c.classificar(linha), ensure_ascii=False))

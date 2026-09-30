"""Classificador de pisos, placas de borracha e grama sintética (taxonomia-pisos-v0.2.json, linha Playfit).

O dicionário de aparelhos v0.3 não tem pisos. Esta taxonomia dá, para o texto de um item:
- nó (produto): placa_emborrachada, piso_borracha_reciclada_sbr, piso_epdm, grama_sintetica, borracha_granulada,
  tapete_borracha, piso_emborrachado — ou piso_modular_pp (escopo OUT, indício de concorrente);
- ambiente (segmento): crossfit, academia, playground, haras, paisagismo — do próprio item e, se não houver, do
  objeto da licitação (`contexto`);
- prioridade comercial: alta | media | baixa.

Regras:
- sinais de contexto (absorção de impacto, segurança infantil) nunca classificam sozinhos;
- sinal de concorrente (PP/TPE, polipropileno, quadra modular, desmontável, futsal/basquete/handebol) sem borracha
  nem grama sintética explícita no texto -> piso_modular_pp; com borracha ou grama explícita o nó IN vence, com
  confiança média;
- piso/tapete de borracha com medida de placa (1x1 m, 1000x1000 mm, 500x500 mm) -> placa_emborrachada;
- grama sintética disputa com EPDM, SBR e granulado: vence o termo que aparece primeiro no texto. Se a grama vem
  primeiro, é grama_sintetica ("grama sintética com infill EPDM", "piso de grama sintética com borracha reciclada
  SBR"); se a borracha vem primeiro, ela é o infill da grama e vira borracha_granulada ("EPDM para grama sintética",
  "borracha granulada para grama sintética").

Uso:
    from coletor.classificar_piso import classificar_piso
    classificar_piso("Placa emborrachada 1000x1000x20 mm", contexto="piso para academia")
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from .classificar_aparelho import norm

TAXONOMIA_PISOS_ARQ = Path(__file__).resolve().parent / "data" / "taxonomia-pisos-v0.2.json"
# Piso/tapete de borracha com medida de placa (1x1 m, 500x500 mm...) é placa emborrachada.
_VIRA_PLACA = {"piso_emborrachado", "tapete_borracha"}
# Grama sintética costuma vir com infill de EPDM/SBR/granulado no mesmo texto: vence quem aparece primeiro.
# Borracha antes da grama é o infill da grama: vira borracha_granulada (PDM 9461), não piso EPDM/SBR.
_GRAMA = "grama_sintetica"
_INFILL = "borracha_granulada"
_DISPUTA_GRAMA = {"piso_epdm", "piso_borracha_reciclada_sbr", "borracha_granulada"}


class ClassificadorPiso:
    def __init__(self, caminho: str | Path | None = None):
        d = json.loads(Path(caminho or TAXONOMIA_PISOS_ARQ).read_text(encoding="utf-8"))
        self.versao = d["versao"]
        self.gatilho = re.compile(d["gatilho"])
        self.borracha = re.compile(d["borracha_explicita"])
        self.contexto = {k: re.compile(v) for k, v in d["sinais_contexto"].items()}
        self.baixa = {k: re.compile(v) for k, v in d["sinais_baixa"].items()}
        self.medidas = {k: re.compile(v) for k, v in d["medidas"].items()}
        self.ambientes = [(a["slug"], a["prioridade"], re.compile(a["padrao"])) for a in d["ambientes"]]
        self.nos = {n["slug"]: n for n in d["nos"]}
        self._padroes = [(re.compile(n["padrao"]), n) for n in d["nos"]]
        self._rx = {n["slug"]: rx for rx, n in self._padroes}

    def _desempatar_grama(self, t: str, no: dict) -> dict:
        """Grama sintética x EPDM/SBR/granulado no mesmo texto: vence o termo que aparece primeiro.

        A posição do rival é a do material de borracha dentro do trecho casado, não o início do trecho: o padrão de
        SBR começa em "piso" ("piso de grama sintética com borracha reciclada SBR" casa desde "piso"), e o que conta
        é onde a borracha aparece. Borracha antes da grama é infill: vira borracha_granulada, se o nó existir.
        Nós ausentes do JSON são ignorados (self._rx.get), sem KeyError."""
        if no["slug"] != _GRAMA and no["slug"] not in _DISPUTA_GRAMA:
            return no
        rx_grama = self._rx.get(_GRAMA)
        g = rx_grama.search(t) if rx_grama else None
        if g is None:
            return no
        rivais = []
        for s in sorted(_DISPUTA_GRAMA):
            rx = self._rx.get(s)
            m = rx.search(t) if rx else None
            if m:
                b = self.borracha.search(t, m.start(), m.end())
                rivais.append(((b or m).start(), s))
        if not rivais:
            return no
        pos, slug = min(rivais)
        if pos > g.start():
            return self.nos[_GRAMA]
        return self.nos.get(_INFILL) or self.nos[slug]

    def _ambiente(self, t: str) -> tuple[str, str] | None:
        for slug, prioridade, rx in self.ambientes:
            if rx.search(t):
                return slug, prioridade
        return None

    def classificar(self, texto: str | None, contexto: str | None = None) -> dict | None:
        """None quando o texto não é de piso/borracha; senão {slug, nome, familia, escopo, ambiente, prioridade,
        confianca, sinais_baixa, sinais_contexto, medidas, pdm_catmat, versao}."""
        t = norm(texto)
        if not t or not self.gatilho.search(t):
            return None
        baixa = [k for k, rx in self.baixa.items() if rx.search(t)]
        # Material explícito da linha Playfit (borracha ou grama sintética): o sinal de concorrente não vira
        # piso_modular_pp ("grama sintética para quadra de futsal", fio de polipropileno) — só baixa a confiança.
        tem_material = bool(self.borracha.search(t)) or bool(_GRAMA in self._rx and self._rx[_GRAMA].search(t))
        no = None
        for rx, n in self._padroes:
            if n["escopo"] == "OUT":
                if not tem_material and (rx.search(t) or baixa):
                    no = n
                    break
                continue
            if rx.search(t):
                no = n
                break
        if no is None:
            return None
        no = self._desempatar_grama(t, no)
        medidas = {k: m.group(0) for k, rx in self.medidas.items() if (m := rx.search(t))}
        if no["slug"] in _VIRA_PLACA and "placa" in medidas:
            no = self.nos["placa_emborrachada"]

        amb = self._ambiente(t) or (self._ambiente(norm(contexto)) if contexto else None)
        if no["escopo"] == "OUT":
            prioridade = "baixa"
        elif amb:
            prioridade = amb[1]
        else:
            prioridade = no["prioridade"]
        confianca = "media" if (baixa and no["escopo"] == "IN") else "alta"
        return {
            "slug": no["slug"],
            "nome": no["nome"],
            "familia": no["familia"] if no["escopo"] == "OUT" else f"{no['familia']}.{amb[0] if amb else 'geral'}",
            "escopo": no["escopo"],
            "ambiente": amb[0] if amb else None,
            "prioridade": prioridade,
            "confianca": confianca,
            "sinais_baixa": baixa,
            "sinais_contexto": [k for k, rx in self.contexto.items() if rx.search(t)],
            "medidas": medidas,
            "pdm_catmat": list(no["pdm_catmat"]),
            "versao": self.versao,
        }


@lru_cache(maxsize=1)
def get_classificador_piso() -> ClassificadorPiso:
    return ClassificadorPiso()


def classificar_piso(texto: str | None, contexto: str | None = None) -> dict | None:
    return get_classificador_piso().classificar(texto, contexto)

"""Nome do adaptador no manifesto → classe."""
from __future__ import annotations

from .adaptadores.generico import Generico
from .adaptadores.konnen_wc import Konnen
from .adaptadores.macsport_rsc import Macsport
from .adaptadores.movement_wp import Movement

ADAPTADORES = {
    "macsport_rsc": Macsport,
    "movement_wp": Movement,
    "konnen_wc": Konnen,
    "generico": Generico,
}
# Qualquer um destes recusa --gravar e --pdf: a fase 1 não escreve no banco nem baixa arquivo.
NOVOS = frozenset(ADAPTADORES)


def obter(nome: str):
    try:
        return ADAPTADORES[nome]()
    except KeyError as exc:
        raise KeyError(f"adaptador desconhecido: {nome}") from exc

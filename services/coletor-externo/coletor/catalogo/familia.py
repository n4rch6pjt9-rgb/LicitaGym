"""Família do produto a partir do que a página declara. perfil_item só entra quando a categoria não diz."""
from __future__ import annotations

from ..perfil_item import perfil_item
from .atributos import norm_rotulo

# None = a página citou o nome, mas ele não decide a família (ex.: "Profissional").
_MAPA = {
    "musculacao": "musculacao",
    "estacoes": "musculacao",
    "estacao": "musculacao",
    "baterias de peso": "musculacao",
    "bateria de peso": "musculacao",
    "para anilhas": "musculacao",
    "cardio": "cardio",
    "esteiras": "cardio",
    "treadmill": "cardio",
    "acessorios": "acessorio",
    "peso livre": "acessorio",
    "profissional": None,
}


def familia_de(nomes: list[str], titulo: str) -> tuple[str, str]:
    for nome in nomes:
        if not nome:
            continue
        chave = norm_rotulo(nome)
        if chave in _MAPA and _MAPA[chave]:
            return _MAPA[chave], "categoria_declarada"
    fam = (perfil_item(titulo or "") or {}).get("familia_equipamento") or ""
    if "cardio" in fam:
        return "cardio", "perfil_item"
    if "musculacao" in fam:
        return "musculacao", "perfil_item"
    if "acessor" in fam or "peso_livre" in fam:
        return "acessorio", "perfil_item"
    return "outro", "perfil_item" if fam or titulo else "ausente"

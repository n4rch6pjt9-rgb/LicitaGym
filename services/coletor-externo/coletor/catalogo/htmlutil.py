"""Trechos de HTML sem navegador. Comentário HTML não é conteúdo (preço comentado não conta)."""
from __future__ import annotations

import re
from html import unescape

_COMENTARIO = re.compile(r"(?s)<!--.*?-->")
_TAG = re.compile(r"<[^>]+>")
_BR = re.compile(r"(?i)<br\s*/?>")


def sem_comentario(html: str) -> str:
    return _COMENTARIO.sub(" ", html or "")


def texto_de(fragmento: str) -> str:
    fragmento = sem_comentario(fragmento or "")
    fragmento = _BR.sub("\n", fragmento)
    fragmento = re.sub(r"(?i)</p\s*>", "\n", fragmento)
    fragmento = _TAG.sub(" ", fragmento)
    return unescape(fragmento)


def uma_linha(fragmento: str) -> str:
    return re.sub(r"\s+", " ", texto_de(fragmento)).strip()


def linhas(fragmento: str) -> list[str]:
    bruto = texto_de(fragmento)
    return [re.sub(r"[ \t]+", " ", x).strip() for x in bruto.splitlines() if x.strip()]

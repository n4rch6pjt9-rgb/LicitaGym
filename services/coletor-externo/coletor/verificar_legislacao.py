"""Spec 0042, K-5: esqueleto (implementação no commit seguinte)."""
from __future__ import annotations

from pathlib import Path

CORPUS_PADRAO = Path(__file__).parent / "data" / "legislacao_corpus.json"
SAIDA_FALHA_PARCIAL = 2


class ErroDownload(Exception):
    pass


def normalizar_html(html: bytes) -> str:
    raise NotImplementedError


def ler_dispositivos(sb) -> list[dict]:
    raise NotImplementedError


def verificar(corpus, dispositivos, baixar):
    raise NotImplementedError

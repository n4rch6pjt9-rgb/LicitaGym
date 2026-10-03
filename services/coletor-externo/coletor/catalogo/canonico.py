"""URL canônica de produto: tira rastreio e fragmento. Não deduplica por título."""
from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Parâmetros de campanha e de carrinho. O resto da query permanece.
_RASTREIO = re.compile(r"^(?:utm_.+|gclid|fbclid|msclkid|srsltid|_rsc|add-to-cart)$", re.I)
_TAMANHO = re.compile(r"-\d+x\d+(?=\.[a-z0-9]+$)", re.I)


def url_canonica(url: str) -> str:
    partes = urlsplit(url.strip())
    query = [(k, v) for k, v in parse_qsl(partes.query, keep_blank_values=True) if not _RASTREIO.match(k)]
    host = (partes.hostname or "").lower()
    if partes.port and not ((partes.scheme == "https" and partes.port == 443) or (partes.scheme == "http" and partes.port == 80)):
        netloc = f"{host}:{partes.port}"
    else:
        netloc = host
    return urlunsplit((partes.scheme.lower(), netloc, partes.path or "/", urlencode(query), ""))


def chave_url(url: str) -> str:
    """Chave de dedup: canônica e sem barra final (a barra não distingue o produto)."""
    canon = url_canonica(url)
    partes = urlsplit(canon)
    caminho = partes.path.rstrip("/") or "/"
    return urlunsplit((partes.scheme, partes.netloc, caminho, partes.query, ""))


def url_arquivo(url: str) -> str:
    """Arquivo original, sem o sufixo de miniatura do WordPress (`-600x600`)."""
    base = url.split("?", 1)[0].split("#", 1)[0]
    return _TAMANHO.sub("", base)

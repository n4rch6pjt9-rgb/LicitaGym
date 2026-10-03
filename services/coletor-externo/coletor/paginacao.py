"""Paginação dos coletores: no máximo 100 itens e parada pelo total da API.

Regra de 03/10/2026: uma página com menos itens que o pedido só encerra a coleta
se `totalRegistros`, `totalPaginas`, `paginasRestantes` ou `total` confirmar o fim.
Total ausente ou inconsistente não encerra em silêncio: a coleta segue até uma
página vazia, ou para com aviso explícito. 404 e corpo inesperado não são fim.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

TAMANHO_PAGINA_MAX = 100


def clamp_tamanho(pedido, *, padrao: int = TAMANHO_PAGINA_MAX, minimo: int = 1,
                  maximo: int = TAMANHO_PAGINA_MAX) -> int:
    """Teto de página. Pedido acima de `maximo` (100) vira `maximo`."""
    if pedido is None:
        pedido = padrao
    try:
        n = int(pedido)
    except (TypeError, ValueError):
        n = padrao
    return max(minimo, min(maximo, n))


def interpretar_content_range(valor: str | None) -> tuple[int | None, bool]:
    """Lê o total do `Content-Range` do PostgREST (`0-99/1234` ou `*/0`).

    Devolve `(total, ilegivel)`. Ausente ou `*` no total = desconhecido, não ilegível.
    """
    if valor is None or str(valor).strip() == "":
        return None, False
    texto = str(valor).strip()
    if "/" not in texto:
        return None, True
    total = texto.split("/")[-1].strip()
    if total == "*":
        return None, False
    if total.isdigit():
        return int(total), False
    return None, True


def _inteiro(valor) -> int | None:
    if isinstance(valor, bool) or valor is None:
        return None
    if isinstance(valor, int):
        return valor
    if isinstance(valor, float) and valor.is_integer():
        return int(valor)
    if isinstance(valor, str):
        s = valor.strip()
        if s.isdigit():
            return int(s)
    return None


@dataclass(frozen=True)
class DecisaoPagina:
    encerrar: bool
    aviso: str | None


def avaliar_pagina(itens, *, tamanho: int, pagina: int, corpo: dict | None,
                   acumulado: int | None = None) -> DecisaoPagina:
    """Decide se esta página encerra a coleta.

    `acumulado`, quando informado, é o total de itens já lidos incluindo esta
    página (usado no PostgREST, em que o offset inicial pode não ser zero).
    """
    if not isinstance(itens, list):
        return DecisaoPagina(True, "resposta sem lista de itens; encerrando com aviso")
    if corpo is not None and not isinstance(corpo, dict):
        return DecisaoPagina(True, "corpo da resposta não é objeto; encerrando com aviso")
    corpo = corpo or {}
    n = len(itens)
    tamanho = max(1, int(tamanho))
    pagina = max(1, int(pagina))
    vistos = (pagina - 1) * tamanho + n if acumulado is None else int(acumulado)

    presentes: dict[str, int] = {}
    ilegivel = False
    for chave in ("totalRegistros", "totalPaginas", "paginasRestantes", "total"):
        if chave not in corpo or corpo[chave] is None:
            continue
        num = _inteiro(corpo[chave])
        if num is None:
            ilegivel = True
        else:
            presentes[chave] = num

    if ilegivel:
        if n == 0:
            return DecisaoPagina(True, "total ilegível e página vazia; encerrando com aviso")
        return DecisaoPagina(False, "total ilegível; seguindo até uma página vazia")

    votos: list[bool] = []
    if "paginasRestantes" in presentes:
        votos.append(presentes["paginasRestantes"] == 0)
    if "totalPaginas" in presentes:
        if presentes["totalPaginas"] <= 0:
            votos.append(n == 0)
        else:
            votos.append(pagina >= presentes["totalPaginas"])
    for chave in ("totalRegistros", "total"):
        if chave not in presentes:
            continue
        declarado = presentes[chave]
        if declarado <= 0:
            votos.append(n == 0)
        else:
            votos.append(vistos >= declarado)

    if votos and all(votos):
        return DecisaoPagina(True, None)
    if votos and any(votos) and not all(votos):
        if n == 0:
            return DecisaoPagina(True, "totais divergem e a página veio vazia; encerrando com aviso")
        return DecisaoPagina(False, "totais divergem; seguindo até uma página vazia")
    if votos and not any(votos):
        if n == 0:
            return DecisaoPagina(True, "página vazia mas o total indica que ainda há registros; encerrando com aviso")
        if n < tamanho:
            return DecisaoPagina(
                False,
                f"página com {n} itens (pedido {tamanho}) mas o total indica que ainda há registros; seguindo",
            )
        return DecisaoPagina(False, None)

    # Sem total nenhum: página vazia encerra; página curta não.
    if n == 0:
        return DecisaoPagina(True, None)
    return DecisaoPagina(False, None)


def pagina_repetida(itens: list, vistos: set[str]) -> bool:
    marca = json.dumps(itens, ensure_ascii=False, sort_keys=True, default=str)
    if marca in vistos:
        return True
    vistos.add(marca)
    return False

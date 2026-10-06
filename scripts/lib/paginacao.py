"""Paginação dos coletores em scripts/: no máximo 100 itens e parada pelo total.

Mesma regra de `coletor/paginacao.py` (03/10/2026). Os dois módulos ficam
separados porque o coletor externo e os scripts não compartilham o mesmo pacote.
"""
from __future__ import annotations

import json
import logging
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


class PaginaNaoConfirmada(RuntimeError):
    """Página repetida ou corpo inesperado. Não é fim de coleta."""


@dataclass(frozen=True)
class DecisaoPagina:
    encerrar: bool
    aviso: str | None


def avaliar_pagina(itens, *, tamanho: int, pagina: int, corpo: dict | None,
                   acumulado: int | None = None) -> DecisaoPagina:
    """Decide se esta página encerra a coleta.

    Página curta só encerra se o total confirmar. Sem total, só a página vazia encerra.
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

    if n == 0:
        return DecisaoPagina(True, None)
    return DecisaoPagina(False, None)


def acao_pagina(registros, corpo, *, tamanho: int, pagina: int, vistos: set[str],
                logger: logging.Logger, ja_lidos: int = 0) -> tuple[bool, bool]:
    """(parar, incluir). Página repetida ou corpo inesperado levanta PaginaNaoConfirmada.

    `ja_lidos` é quantos itens das páginas anteriores já entraram na coleta. O total
    da API é comparado com essa soma, não com página × tamanho (página curta anterior
    não pode fazer o total parecer atingido).
    """
    if not isinstance(corpo, dict):
        logger.warning("página %s: corpo inesperado; não é fim de coleta", pagina)
        raise PaginaNaoConfirmada(f"página {pagina}: corpo inesperado; não é fim de coleta")
    if not isinstance(registros, list):
        logger.warning("página %s: resposta sem lista; não é fim de coleta", pagina)
        raise PaginaNaoConfirmada(f"página {pagina}: resposta sem lista; não é fim de coleta")
    marca = json.dumps(registros, ensure_ascii=False, sort_keys=True, default=str)
    if marca in vistos:
        logger.warning("página %s: conteúdo repetido; não é fim de coleta", pagina)
        raise PaginaNaoConfirmada(f"página {pagina}: conteúdo repetido; não é fim de coleta")
    vistos.add(marca)
    decisao = avaliar_pagina(
        registros, tamanho=tamanho, pagina=pagina, corpo=corpo,
        acumulado=ja_lidos + len(registros),
    )
    if decisao.aviso:
        logger.warning("página %s: %s", pagina, decisao.aviso)
    return decisao.encerrar, True

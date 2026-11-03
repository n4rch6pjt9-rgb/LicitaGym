"""Espera entre tentativas HTTP dos coletores: Retry-After e backoff exponencial com jitter.

Um só lugar para o cálculo, usado pelo PNCP (pncp.py) e pelos coletores Compras.gov
(compras_arp, compras_pgc, compras_precos). Sem dependências do resto do pacote.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

MAX_RETRY_AFTER_S = 60


def retry_after_s(r, maximo: float = MAX_RETRY_AFTER_S) -> float | None:
    """Segundos pedidos no cabeçalho Retry-After (delta-seconds ou HTTP-date), limitados a [0, maximo].
    None quando o cabeçalho falta ou não é interpretável (quem chama usa o backoff)."""
    try:
        bruto = (r.headers or {}).get("Retry-After")
    except AttributeError:
        return None
    if bruto is None:
        return None
    valor = str(bruto).strip()
    if not valor:
        return None
    try:
        segundos = float(valor)
    except ValueError:
        try:
            data = parsedate_to_datetime(valor)
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
        if data is None:
            return None
        if data.tzinfo is None:
            data = data.replace(tzinfo=timezone.utc)
        segundos = (data - datetime.now(timezone.utc)).total_seconds()
    if not math.isfinite(segundos):
        return None
    return max(0.0, min(segundos, maximo))


def backoff_s(tentativa: int, base: float, maximo: float = MAX_RETRY_AFTER_S) -> float:
    """Backoff exponencial (base, 2*base, 4*base...) limitado a `maximo`, com jitter de até 25%."""
    espera = min(maximo, base * 2 ** max(0, tentativa - 1))
    return min(maximo, espera + random.uniform(0.0, espera * 0.25))


def espera_retry(r, tentativa: int, base: float, maximo: float = MAX_RETRY_AFTER_S) -> float:
    """Espera antes da próxima tentativa: Retry-After em 429 (quando válido), senão backoff_s."""
    if r is not None and getattr(r, "status_code", None) == 429:
        pedido = retry_after_s(r, maximo)
        if pedido is not None:
            return pedido
    return backoff_s(tentativa, base, maximo)

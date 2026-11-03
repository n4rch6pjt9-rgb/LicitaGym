"""coletor.retry: Retry-After (segundos e HTTP-date) e backoff exponencial com jitter."""
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import MagicMock

import pytest

from coletor import pncp, retry


def _r(status=429, valor=None):
    r = MagicMock()
    r.status_code = status
    r.headers = {} if valor is None else {"Retry-After": valor}
    return r


@pytest.mark.parametrize("valor,esperado", [("7", 7.0), (" 2.5 ", 2.5), ("0", 0.0), ("-3", 0.0), ("999", 60.0)])
def test_retry_after_segundos(valor, esperado):
    assert retry.retry_after_s(_r(valor=valor)) == esperado


def test_retry_after_http_date():
    futuro = datetime.now(timezone.utc) + timedelta(seconds=30)
    v = retry.retry_after_s(_r(valor=format_datetime(futuro, usegmt=True)))
    assert 25.0 <= v <= 30.0


def test_retry_after_http_date_no_passado_vira_zero():
    passado = datetime.now(timezone.utc) - timedelta(minutes=5)
    assert retry.retry_after_s(_r(valor=format_datetime(passado, usegmt=True))) == 0.0


@pytest.mark.parametrize("valor", [None, "", "amanhã", "nan", "inf"])
def test_retry_after_ausente_ou_invalido(valor):
    assert retry.retry_after_s(_r(valor=valor)) is None


def test_espera_retry_usa_backoff_sem_retry_after(monkeypatch):
    monkeypatch.setattr(retry.random, "uniform", lambda a, b: b)  # jitter máximo (25%)
    assert retry.espera_retry(_r(503, "7"), 1, base=4.0) == 5.0      # 503 ignora Retry-After
    assert retry.espera_retry(_r(429), 2, base=4.0) == 10.0          # 8 + 25%
    assert retry.espera_retry(None, 10, base=4.0) == 60.0            # teto


def test_pncp_reusa_o_mesmo_helper():
    assert pncp._retry_after_s is retry.retry_after_s
    assert pncp.MAX_RETRY_AFTER_S == retry.MAX_RETRY_AFTER_S

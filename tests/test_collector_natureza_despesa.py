"""Tests for E5: collector_natureza_despesa.py."""

import io
import json
import socket
import urllib.error
from unittest.mock import patch
import pytest

from scripts.collector_natureza_despesa import (
    collect_naturezas_por_grupo_classe,
    collect_naturezas_por_pdm,
    fetch_naturezas,
)
from scripts.lib.catmat_pdm_source import InvalidEnvelopeError, PdmSourceError
from scripts.lib.http_fetch import HttpFetchError, LEGACY_EMPTY_ON_ERROR_ENV
from scripts.lib.sync_state import SyncStateManager


class DummyHttpResponse:
    def __init__(self, data, status: int = 200, raw: bytes = None):
        self._data = raw if raw is not None else json.dumps(data).encode("utf-8")
        self.status = status

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


def _http_error(code: int, headers=None):
    return urllib.error.HTTPError(
        url="http://test", code=code, msg="err", hdrs=headers or {}, fp=io.BytesIO(b"error")
    )


@pytest.fixture(autouse=True)
def _no_real_sleep():
    with patch("scripts.lib.http_client.time.sleep"), patch("time.sleep"):
        yield


@pytest.fixture
def workdir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _write_e3(path, grupo: int, pdms):
    path.write_text(
        json.dumps({"data": {f"grupo_{grupo}": [{"codigoPdm": p} for p in pdms]}}),
        encoding="utf-8",
    )


def test_fetch_naturezas_with_codigo_pdm():
    payload = {
        "resultado": [{"codigoNatureza": 339030, "nomeNatureza": "MATERIAL DE CONSUMO"}],
        "totalRegistros": 1,
        "paginasRestantes": 0,
    }
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)) as mock_urlopen:
        res = fetch_naturezas(codigo_pdm=2640, pagina=1, tamanho_pagina=500)
        assert len(res["resultado"]) == 1
        req = mock_urlopen.call_args[0][0]
        assert "codigoPdm=2640" in req.full_url


def test_fetch_naturezas_200_empty_is_valid():
    payload = {"resultado": [], "totalRegistros": 0, "paginasRestantes": 0}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        assert fetch_naturezas(codigo_pdm=2640)["resultado"] == []


def test_collect_por_pdm_empty_valid_returns_empty_list(workdir):
    payload = {"resultado": [], "paginasRestantes": 0}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        assert collect_naturezas_por_pdm(2640, resume=False) == []


def test_fetch_naturezas_500_raises():
    with patch("urllib.request.urlopen", side_effect=_http_error(500)):
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)


def test_fetch_naturezas_502_retried_then_raises():
    with patch("urllib.request.urlopen", side_effect=_http_error(502)) as mock_urlopen:
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)
        assert mock_urlopen.call_count == 3


def test_fetch_naturezas_429_with_retry_after_exhausted_raises():
    with patch("urllib.request.urlopen", side_effect=_http_error(429, {"Retry-After": "1"})) as mock_urlopen:
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)
        assert mock_urlopen.call_count == 3


def test_fetch_naturezas_transient_then_success():
    ok = DummyHttpResponse({"resultado": [{"codigoNatureza": 1}], "paginasRestantes": 0})
    with patch("urllib.request.urlopen", side_effect=[_http_error(503), ok]):
        assert fetch_naturezas(codigo_pdm=2640)["resultado"] == [{"codigoNatureza": 1}]


def test_fetch_naturezas_timeout_raises():
    with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)


def test_fetch_naturezas_invalid_json_raises():
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(None, raw=b"<html>oops")):
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)


def test_collect_por_pdm_invalid_envelope_raises(workdir):
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse({"mensagem": "ok"})):
        with pytest.raises(InvalidEnvelopeError):
            collect_naturezas_por_pdm(2640, resume=False)


def test_legacy_rollback_env_does_not_mask_error(monkeypatch):
    monkeypatch.setenv(LEGACY_EMPTY_ON_ERROR_ENV, "1")
    with patch("urllib.request.urlopen", side_effect=_http_error(500)):
        with pytest.raises(HttpFetchError):
            fetch_naturezas(codigo_pdm=2640)


def test_collect_without_e3_e4_raises_instead_of_fallback(workdir):
    with patch("urllib.request.urlopen") as mock_urlopen:
        with pytest.raises(PdmSourceError):
            collect_naturezas_por_grupo_classe(78, 7830)
        assert not mock_urlopen.called


def test_collect_with_corrupt_e3_raises(workdir):
    (workdir / "collector_pdm_material_resultado.json").write_text("{not json", encoding="utf-8")
    with patch("urllib.request.urlopen") as mock_urlopen:
        with pytest.raises(PdmSourceError):
            collect_naturezas_por_grupo_classe(78, 7830)
        assert not mock_urlopen.called


def test_collect_iterates_official_pdms_from_e3(workdir):
    _write_e3(workdir / "collector_pdm_material_resultado.json", 78, [111, 222])
    urls = []

    def fake_urlopen(req, *args, **kwargs):
        urls.append(req.full_url)
        return DummyHttpResponse({"resultado": [{"codigoNatureza": 339030}], "paginasRestantes": 0})

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        naturezas = collect_naturezas_por_grupo_classe(78, 7830, resume=False)
    assert len(naturezas) == 2
    assert any("codigoPdm=111" in u for u in urls)
    assert any("codigoPdm=222" in u for u in urls)
    assert not any("codigoPdm=2640" in u for u in urls)


def test_collect_e3_without_pdms_for_group_is_valid_empty(workdir):
    _write_e3(workdir / "collector_pdm_material_resultado.json", 78, [])
    with patch("urllib.request.urlopen") as mock_urlopen:
        assert collect_naturezas_por_grupo_classe(78, 7830) == []
        assert not mock_urlopen.called


def test_collect_naturezas_fails_on_502(workdir):
    with patch("urllib.request.urlopen", side_effect=_http_error(502)):
        with pytest.raises(HttpFetchError):
            collect_naturezas_por_grupo_classe(78, 7830, pdms=[2640], resume=False)


def test_collect_naturezas_partial_failure_and_resume(tmp_path):
    manager = SyncStateManager("test_collect_naturezas", state_dir=tmp_path)

    payload_p1 = {
        "resultado": [{"codigoNatureza": 339030, "nomeNatureza": "NAT 1"}],
        "paginasRestantes": 1,
    }
    call_count = 0

    def mock_urlopen(req, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return DummyHttpResponse(payload_p1)
        raise _http_error(500)

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        with pytest.raises(HttpFetchError):
            collect_naturezas_por_grupo_classe(78, 7830, sync_manager=manager, resume=False)

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "failed_partial"
    assert checkpoint.partial is True
    assert checkpoint.last_page == 1
    assert checkpoint.total_records == 1

    payload_p2 = {
        "resultado": [{"codigoNatureza": 339031, "nomeNatureza": "NAT 2"}],
        "paginasRestantes": 0,
    }
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload_p2)):
        naturezas = collect_naturezas_por_grupo_classe(78, 7830, sync_manager=manager, resume=True)
        assert len(naturezas) == 2
        assert naturezas[0]["codigoNatureza"] == 339030
        assert naturezas[1]["codigoNatureza"] == 339031

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "completed"
    assert checkpoint.partial is False
    assert checkpoint.last_page == 2
    assert checkpoint.total_records == 2

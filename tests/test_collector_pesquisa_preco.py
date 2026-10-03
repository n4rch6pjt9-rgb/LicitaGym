"""Tests for collector_pesquisa_preco.py."""

import io
import json
import urllib.error
from unittest.mock import patch
import pytest

from scripts.collector_pesquisa_preco import fetch_material, fetch_detalhe, collect_pesquisa_preco
from scripts.lib.http_fetch import HttpFetchError, LEGACY_EMPTY_ON_ERROR_ENV
from scripts.lib.sync_state import SyncStateManager


class DummyHttpResponse:
    def __init__(self, data: dict, status: int = 200):
        self._data = json.dumps(data).encode("utf-8")
        self.status = status

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


def test_fetch_material_200_success():
    payload = {"resultado": [{"codigoMaterial": 999, "descricao": "ANILHA"}], "totalRegistros": 1}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_material(codigo_item=374066)
        assert len(res["resultado"]) == 1


def test_fetch_material_200_empty():
    payload = {"resultado": [], "totalRegistros": 0}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_material(codigo_item=374066)
        assert res["resultado"] == []


def test_fetch_material_500_raises():
    http_err = urllib.error.HTTPError(
        url="http://test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        with pytest.raises(HttpFetchError):
            fetch_material(codigo_item=374066)


def test_fetch_detalhe_timeout_raises():
    with patch("urllib.request.urlopen", side_effect=TimeoutError("Timed out")):
        with pytest.raises(HttpFetchError):
            fetch_detalhe(codigo_material=999)


def test_fetch_material_legacy_rollback(monkeypatch):
    monkeypatch.setenv(LEGACY_EMPTY_ON_ERROR_ENV, "1")
    http_err = urllib.error.HTTPError(
        url="http://test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        res = fetch_material(codigo_item=374066)
        assert res == {"resultado": []}


def test_collect_pesquisa_preco_partial_failure_and_resume(tmp_path):
    manager = SyncStateManager("test_collect_pesquisa_preco", state_dir=tmp_path)

    # Item 1 material + detalhe
    payload_mat_1 = {
        "resultado": [{"codigoMaterial": 100, "codigoItem": 1}],
        "totalRegistros": 1,
    }
    payload_det_1 = {
        "resultado": [{"preco": 50.0, "fornecedor": "FORN 1"}],
        "totalRegistros": 1,
    }
    # Item 2 material fails with 500
    http_err_p2 = urllib.error.HTTPError(
        url="http://test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"error"),
    )

    call_count = 0

    def mock_urlopen(req, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return DummyHttpResponse(payload_mat_1)
        if call_count == 2:
            return DummyHttpResponse(payload_det_1)
        raise http_err_p2

    items = [1, 2]
    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        with patch("time.sleep"):
            with pytest.raises(HttpFetchError):
                collect_pesquisa_preco(items_e4=items, max_items=2, sync_manager=manager, resume=False)

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "failed_partial"
    assert checkpoint.partial is True
    assert checkpoint.last_page == 1
    assert checkpoint.total_records == 1

    # Resume item 2: returns material and detail, verifying accumulation
    payload_mat_2 = {"resultado": [{"codigoMaterial": 200, "codigoItem": 2}], "totalRegistros": 1}
    payload_det_2 = {"resultado": [{"codigoMaterial": 200, "preco": 500.0}]}
    with patch("urllib.request.urlopen", side_effect=[DummyHttpResponse(payload_mat_2), DummyHttpResponse(payload_det_2)]):
        with patch("time.sleep"):
            res = collect_pesquisa_preco(items_e4=items, max_items=2, sync_manager=manager, resume=True)
            assert len(res["materiais"]) == 2
            assert len(res["detalhes"]) == 2
            assert res["items_processados"] == 2

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "completed"
    assert checkpoint.partial is False
    assert checkpoint.total_records == 2


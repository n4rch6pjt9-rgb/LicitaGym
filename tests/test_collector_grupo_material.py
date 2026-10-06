"""Tests for E1: collector_grupo_material.py."""

import io
import json
import urllib.error
from unittest.mock import patch
import pytest

from scripts.collector_grupo_material import fetch_grupos, collect_grupos
from scripts.lib.http_fetch import HttpFetchError
from scripts.lib.sync_state import SyncStateManager, SYNC_RESUME_ENV


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


def test_fetch_grupos_200_success():
    payload = {
        "resultado": [{"codigoGrupo": 78, "nomeGrupo": "EQUIPAMENTOS FITNESS"}],
        "totalRegistros": 1,
    }
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_grupos(pagina=1)
        assert len(res["resultado"]) == 1


def test_fetch_grupos_200_empty():
    payload = {"resultado": []}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_grupos(pagina=1)
        assert res["resultado"] == []


def test_fetch_grupos_500_raises():
    http_err = urllib.error.HTTPError(
        url="http://test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        with pytest.raises(HttpFetchError):
            fetch_grupos(pagina=1, max_retries=1)


def test_collect_grupos_fails_on_500():
    http_err = urllib.error.HTTPError(
        url="http://test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_err):
        with pytest.raises(HttpFetchError):
            collect_grupos()


def test_collect_grupos_records_partial_failure_and_resumes(tmp_path):
    manager = SyncStateManager("test_collect_grupos", state_dir=tmp_path)

    # Page 1 returns valid grupo
    payload_p1 = {
        "resultado": [{"codigoGrupo": 78, "nomeGrupo": "EQUIPAMENTOS FITNESS"}],
        "totalRegistros": 2,
        "paginasRestantes": 1,
    }
    # Page 2 fails with 500
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
            return DummyHttpResponse(payload_p1)
        raise http_err_p2

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        with pytest.raises(HttpFetchError):
            collect_grupos(sync_manager=manager, resume=False)

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "failed_partial"
    assert checkpoint.partial is True
    assert checkpoint.last_page == 1
    assert checkpoint.total_records == 1

    # Resume from page 2: page 2 returns 1 new group, and page 3 returns empty (done)
    payload_p2 = {
        "resultado": [{"codigoGrupo": 72, "nomeGrupo": "OUTRO GRUPO"}],
        "totalRegistros": 1,
    }
    payload_p3 = {"resultado": []}

    call_count_p2 = 0

    def mock_urlopen_p2(req, *args, **kwargs):
        nonlocal call_count_p2
        call_count_p2 += 1
        if call_count_p2 == 1:
            return DummyHttpResponse(payload_p2)
        return DummyHttpResponse(payload_p3)

    with patch("urllib.request.urlopen", side_effect=mock_urlopen_p2):
        grupos = collect_grupos(sync_manager=manager, resume=True)
        assert len(grupos) == 2  # Reconstituted p1 (1) + fetched p2 (1)

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "completed"
    assert checkpoint.partial is False
    assert checkpoint.last_page == 2
    assert checkpoint.total_records == 2  # 1 from p1 + 1 from p2

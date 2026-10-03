"""Tests for scripts/comprasgov_consulta_collector.py.

Covers:
1. carrega_schema with 'endpoints' and 'modulos' structures
2. _monta_url with parameter clamping
3. consultar_endpoint on missing endpoint
4. consultar_endpoint on HTTP 200 success
5. consultar_endpoint on HTTP 500 failure (NOT masked as empty success)
6. consultar_endpoint on HTTP 429 with Retry-After
7. consultar_endpoint with LICITAGYM_LEGACY_EMPTY_ON_ERROR=1 rollback flag
8. batch queries and relatorio computation
All tests run offline.
"""

import io
import json
import asyncio
import urllib.error
from unittest.mock import patch, MagicMock
import pytest

from scripts.comprasgov_consulta_collector import (
    ConsultaComprasGovCollector,
    EndpointConsulta,
    ConsultaResultado,
    BASE_URL,
)
from scripts.lib.http_client import LEGACY_EMPTY_ON_ERROR_ENV
from scripts.lib.sync_state import SyncStateManager


class DummyHttpResponse:
    def __init__(self, data: dict, status: int = 200, headers: dict = None):
        self.data = data
        self.status = status
        self.headers = headers or {}

    def read(self):
        return json.dumps(self.data).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass


@pytest.fixture
def collector_with_sample_schema(tmp_path):
    schema_file = tmp_path / "schema.json"
    schema_data = {
        "endpoints": [
            {
                "modulo": "01-PCA",
                "nome": "consultarPca",
                "metodo": "GET",
                "path": "/modulo-pca/1_consultarPca",
                "parametros": {
                    "dataInicio": {"tipo": "date"},
                    "dataFim": {"tipo": "date"},
                    "pagina": {"tipo": "integer"},
                    "pageSize": {"tipo": "integer"},
                },
                "temPaginacao": True,
                "temVarianteCsv": False,
                "descricao": "Consulta PCA",
            }
        ]
    }
    schema_file.write_text(json.dumps(schema_data), encoding="utf-8")
    return ConsultaComprasGovCollector(str(schema_file))


def test_carrega_schema_modulos_format(tmp_path):
    schema_file = tmp_path / "schema_modulos.json"
    schema_data = {
        "modulos": [
            {
                "modulo": "08 - ARP",
                "endpoints": [
                    {
                        "metodo": "GET",
                        "path": "/modulo-arp/1_consultarARP",
                        "operationId": "consultarARP",
                        "summary": "Consulta ARP",
                    }
                ],
            }
        ]
    }
    schema_file.write_text(json.dumps(schema_data), encoding="utf-8")
    collector = ConsultaComprasGovCollector(str(schema_file))
    assert "consultarARP" in collector.catalogo
    ep = collector.catalogo["consultarARP"]
    assert ep.modulo == "08 - ARP"
    assert ep.path == "/modulo-arp/1_consultarARP"


def test_monta_url_clamps_page_size(collector_with_sample_schema):
    ep = collector_with_sample_schema.catalogo["consultarPca"]
    url = collector_with_sample_schema._monta_url(ep, {"pageSize": 1000, "pagina": 2})
    assert "pageSize=100" in url
    assert "pagina=2" in url

    url_small = collector_with_sample_schema._monta_url(ep, {"tamanhoPagina": 2})
    assert "tamanhoPagina=10" in url_small


def test_consultar_endpoint_not_found(collector_with_sample_schema):
    res = asyncio.run(collector_with_sample_schema.consultar_endpoint("inexistente"))
    assert res.sucesso is False
    assert res.registrosTotais == 0
    assert any("não encontrado" in e for e in res.erros)


def test_consultar_endpoint_success_http_200(collector_with_sample_schema):
    payload = {
        "resultado": [
            {"id": 101, "objeto": "Equipamento A"},
            {"id": 102, "objeto": "Equipamento B"},
        ],
        "totalRegistros": 2,
    }
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = asyncio.run(collector_with_sample_schema.consultar_endpoint("consultarPca"))
        assert res.sucesso is True
        assert res.registrosTotais == 2
        assert res.registrosProcessados == 2
        assert len(res.erros) == 0


def test_consultar_endpoint_http_500_failure_not_masked_as_empty(collector_with_sample_schema):
    http_500 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_500):
        res = asyncio.run(collector_with_sample_schema.consultar_endpoint("consultarPca"))
        # Critical P0 requirement: NOT masked as sucesso=True with 0 records
        assert res.sucesso is False
        assert res.registrosTotais == 0
        assert len(res.erros) > 0
        assert "500" in res.erros[0]


def test_consultar_endpoint_429_respects_retry_after(collector_with_sample_schema):
    http_429 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=429,
        msg="Rate limit",
        hdrs={"Retry-After": "3"},
        fp=io.BytesIO(b"Rate limit"),
    )
    success_payload = {"resultado": [{"id": 1}], "totalRegistros": 1}
    responses = [http_429, DummyHttpResponse(success_payload)]

    with patch("urllib.request.urlopen", side_effect=responses):
        with patch("time.sleep") as mock_sleep:
            res = asyncio.run(collector_with_sample_schema.consultar_endpoint("consultarPca"))
            assert res.sucesso is True
            assert res.registrosTotais == 1
            assert mock_sleep.call_count == 1
            assert mock_sleep.call_args[0][0] == 3.0


def test_consultar_endpoint_legacy_rollback_mode(collector_with_sample_schema, monkeypatch):
    monkeypatch.setenv(LEGACY_EMPTY_ON_ERROR_ENV, "1")
    http_500 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_500):
        res = asyncio.run(collector_with_sample_schema.consultar_endpoint("consultarPca"))
        # In legacy mode, it falls back to empty envelope
        assert res.sucesso is True
        assert res.registrosTotais == 0
        assert len(res.erros) == 0


def test_relatorio_and_batch_methods(collector_with_sample_schema):
    payload = {"resultado": [{"id": 1}], "totalRegistros": 1}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        with patch("asyncio.sleep"):
            async def run_batch():
                res_modulo = await collector_with_sample_schema.consultar_por_modulo("01-PCA")
                assert len(res_modulo) == 1
                assert res_modulo[0].sucesso is True

                res_periodo = await collector_with_sample_schema.consultar_periodo("2026-09-01", "2026-09-30")
                assert len(res_periodo) == 1

                rel = collector_with_sample_schema.relatorio()
                assert rel["total_consultadas"] == 2
                assert rel["sucesso"] == 2
                assert rel["falha"] == 0
                assert rel["taxa_sucesso_pct"] == 100.0

                await collector_with_sample_schema.fechar()

            asyncio.run(run_batch())


def test_consultar_multiplos_checkpoint_and_resume(collector_with_sample_schema, tmp_path):
    manager = SyncStateManager("test_comprasgov_batch", state_dir=tmp_path)

    # Add a second endpoint to the catalog
    ep2 = EndpointConsulta(
        modulo="01-PCA",
        nome="consultarPca2",
        metodo="GET",
        path="/modulo-pca/2_consultarPca2",
        parametros={},
        temPaginacao=True,
        temVarianteCsv=False,
    )
    collector_with_sample_schema.catalogo["consultarPca2"] = ep2

    # In batch 1: consultarPca succeeds, consultarPca2 fails with 500
    p1 = {"resultado": [{"id": 1}], "totalRegistros": 1}
    http_500 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Error"),
    )

    call_count = 0

    def mock_urlopen(req, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if "1_consultarPca" in req.full_url:
            return DummyHttpResponse(p1)
        raise http_500

    with patch("urllib.request.urlopen", side_effect=mock_urlopen):
        with patch("asyncio.sleep"):
            async def run_failing_batch():
                res = await collector_with_sample_schema.consultar_multiplos(
                    ["consultarPca", "consultarPca2"],
                    resume=False,
                    sync_manager=manager,
                )
                assert len(res) == 2
                assert res[0].sucesso is True
                assert res[1].sucesso is False

            asyncio.run(run_failing_batch())

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "failed_partial"
    assert checkpoint.partial is True
    assert checkpoint.cursor["completed_endpoints"] == ["consultarPca"]

    # Now resume: only consultarPca2 is executed, and it succeeds
    p2 = {"resultado": [{"id": 2}], "totalRegistros": 1}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(p2)):
        with patch("asyncio.sleep"):
            async def run_resuming_batch():
                res = await collector_with_sample_schema.consultar_multiplos(
                    ["consultarPca", "consultarPca2"],
                    resume=True,
                    sync_manager=manager,
                )
                assert len(res) == 2
                assert res[0].endpoint == "consultarPca"
                assert res[0].sucesso is True
                assert res[1].endpoint == "consultarPca2"
                assert res[1].sucesso is True

            asyncio.run(run_resuming_batch())

    checkpoint = manager.load_checkpoint()
    assert checkpoint is not None
    assert checkpoint.status == "completed"
    assert checkpoint.partial is False
    assert "consultarPca2" in checkpoint.cursor["completed_endpoints"]


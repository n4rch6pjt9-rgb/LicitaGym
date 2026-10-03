"""Tests for scripts/lib/http_client.py and scripts/lib/http_fetch.py.

Covers:
1. HTTP 200 with data
2. HTTP 200 with empty resultado / empty data
3. HTTP 500 error -> raises HttpFetchError (or returns structured error if raise_for_status=False)
4. Transport TimeoutError and socket.timeout -> mapped to error_type="timeout"
5. URLError(socket.timeout) and URLError with 'timed out' -> mapped to error_type="timeout"
6. URLError (DNS/connection) -> mapped to error_type="transport"
7. HTTP 429 rate limit with Retry-After seconds -> sleeps exact Retry-After seconds
8. HTTP 429 rate limit with Retry-After HTTP-date (RFC 2822 / RFC 7231) -> sleeps delta seconds
9. HTTP 429 rate limit without Retry-After -> falls back to exponential backoff
10. Transient 503 error -> retries and succeeds on next attempt
11. Transient 502/503/504 error -> exhausts retries and raises HttpFetchError
12. Non-transient 500 error -> does not retry (unless configured)
13. Page size clamp helper -> respects Compras.gov limits (10 to 500)
14. Legacy rollback flag returns empty envelope when enabled
"""

import io
import os
import json
import socket
import urllib.error
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from unittest.mock import patch, MagicMock

import pytest

from scripts.lib.http_client import (
    HttpClient,
    HttpFetchError,
    LEGACY_EMPTY_ON_ERROR_ENV,
    ALLOWED_HOSTS_ENV,
    DEFAULT_ALLOWED_HOSTS,
    COMPRAS_GOV_PAGE_SIZE,
    clamp_compras_gov_page_size,
    parse_retry_after,
    classify_exception,
    is_host_allowed,
    validate_url,
    SafeRedirectHandler,
)
from scripts.lib.http_fetch import fetch_json


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


def test_fetch_json_200_success():
    payload = {"resultado": [{"codigoClasse": 7830, "nomeClasse": "EQUIPAMENTOS FITNESS"}]}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_json("https://dadosabertos.compras.gov.br/test")
        assert res == payload
        assert len(res["resultado"]) == 1


def test_fetch_json_200_empty_page():
    payload = {"resultado": [], "totalRegistros": 0, "paginasRestantes": 0}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_json("https://dadosabertos.compras.gov.br/test")
        assert res == payload
        assert res["resultado"] == []


def test_fetch_json_500_raises_http_fetch_error():
    http_error = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Server Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Server Error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_error):
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=1)
        assert exc_info.value.status_code == 500
        assert exc_info.value.error_type == "http_status"
        assert "500" in str(exc_info.value)


def test_fetch_json_500_structured_error_when_no_raise():
    http_error = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Server Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Server Error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_error):
        res = fetch_json(
            "https://dadosabertos.compras.gov.br/test",
            max_retries=1,
            raise_for_status=False,
        )
        assert res["sucesso"] is False
        assert res["status_code"] == 500
        assert res["error_type"] == "http_status"
        assert "resultado" not in res  # Crucial: NOT masked as empty resultado list


def test_fetch_json_timeout_raises_http_fetch_error():
    with patch("urllib.request.urlopen", side_effect=TimeoutError("Connection timed out")):
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=1)
        assert exc_info.value.status_code is None
        assert exc_info.value.error_type == "timeout"
        assert "Timeout" in str(exc_info.value)


def test_fetch_json_urlerror_wrapping_socket_timeout():
    # urllib raises URLError with socket.timeout reason
    socket_timeout = socket.timeout("timed out")
    url_err = urllib.error.URLError(socket_timeout)
    with patch("urllib.request.urlopen", side_effect=url_err):
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=1)
        assert exc_info.value.status_code is None
        assert exc_info.value.error_type == "timeout"
        assert "Timeout" in str(exc_info.value)


def test_fetch_json_transport_urlerror_raises():
    url_err = urllib.error.URLError("Name or service not known")
    with patch("urllib.request.urlopen", side_effect=url_err):
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=1)
        assert exc_info.value.error_type == "transport"
        assert "URLError" in str(exc_info.value) or "Name or service not known" in str(exc_info.value)


def test_fetch_json_429_retries_and_exhausts_with_fallback_backoff():
    http_429 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=429,
        msg="Too Many Requests",
        hdrs={},
        fp=io.BytesIO(b"Rate limit exceeded"),
    )
    with patch("urllib.request.urlopen", side_effect=http_429) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(HttpFetchError) as exc_info:
                fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=3, backoff_factor=1.5)
            assert mock_urlopen.call_count == 3
            assert mock_sleep.call_count == 2
            # Exponential backoff checks: 1.5**1 = 1.5, 1.5**2 = 2.25
            assert mock_sleep.call_args_list[0][0][0] == 1.5
            assert mock_sleep.call_args_list[1][0][0] == 2.25
            assert exc_info.value.status_code == 429
            assert exc_info.value.attempts == 3


def test_fetch_json_429_respects_retry_after_seconds():
    headers = {"Retry-After": "5"}
    http_429 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=429,
        msg="Too Many Requests",
        hdrs=headers,
        fp=io.BytesIO(b"Rate limit exceeded"),
    )
    with patch("urllib.request.urlopen", side_effect=http_429) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(HttpFetchError) as exc_info:
                fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=2)
            assert mock_urlopen.call_count == 2
            assert mock_sleep.call_count == 1
            # Slept exactly 5.0 seconds as specified by Retry-After
            assert mock_sleep.call_args[0][0] == 5.0
            assert exc_info.value.status_code == 429


def test_fetch_json_429_respects_retry_after_http_date():
    future_time = datetime.now(timezone.utc) + timedelta(seconds=12)
    http_date = format_datetime(future_time, usegmt=True)
    headers = {"Retry-After": http_date}
    http_429 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=429,
        msg="Too Many Requests",
        hdrs=headers,
        fp=io.BytesIO(b"Rate limit exceeded"),
    )
    with patch("urllib.request.urlopen", side_effect=http_429) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(HttpFetchError) as exc_info:
                fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=2)
            assert mock_urlopen.call_count == 2
            assert mock_sleep.call_count == 1
            slept = mock_sleep.call_args[0][0]
            # Difference should be ~12 seconds (allow 10-14s margin)
            assert 10.0 <= slept <= 14.0
            assert exc_info.value.status_code == 429


def test_fetch_json_transient_503_retries_and_succeeds():
    http_503 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=503,
        msg="Service Unavailable",
        hdrs={},
        fp=io.BytesIO(b"Service Unavailable"),
    )
    success_payload = {"resultado": [{"id": 1, "nome": "Item 1"}]}
    responses = [http_503, DummyHttpResponse(success_payload)]

    with patch("urllib.request.urlopen", side_effect=responses) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            res = fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=3)
            assert res == success_payload
            assert mock_urlopen.call_count == 2
            assert mock_sleep.call_count == 1


def test_fetch_json_transient_503_retries_and_exhausts():
    http_503 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=503,
        msg="Service Unavailable",
        hdrs={},
        fp=io.BytesIO(b"Service Unavailable"),
    )
    with patch("urllib.request.urlopen", side_effect=http_503) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(HttpFetchError) as exc_info:
                fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=3)
            assert mock_urlopen.call_count == 3
            assert mock_sleep.call_count == 2
            assert exc_info.value.status_code == 503
            assert exc_info.value.attempts == 3


def test_fetch_json_non_transient_500_does_not_retry_by_default():
    http_500 = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=500,
        msg="Internal Server Error",
        hdrs={},
        fp=io.BytesIO(b"Internal Error"),
    )
    with patch("urllib.request.urlopen", side_effect=http_500) as mock_urlopen:
        with patch("time.sleep") as mock_sleep:
            with pytest.raises(HttpFetchError) as exc_info:
                fetch_json("https://dadosabertos.compras.gov.br/test", max_retries=3)
            # 500 is not in default transient codes (502, 503, 504), so does not retry
            assert mock_urlopen.call_count == 1
            assert mock_sleep.call_count == 0
            assert exc_info.value.status_code == 500


def test_fetch_json_legacy_rollback_mode_when_env_enabled(monkeypatch):
    monkeypatch.setenv(LEGACY_EMPTY_ON_ERROR_ENV, "1")
    http_error = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/test",
        code=503,
        msg="Service Unavailable",
        hdrs={},
        fp=io.BytesIO(b"Service Unavailable"),
    )
    with patch("urllib.request.urlopen", side_effect=http_error):
        res = fetch_json(
            "https://dadosabertos.compras.gov.br/test",
            max_retries=1,
            legacy_empty_envelope_key="resultado",
        )
        assert res == {"resultado": []}


def test_clamp_compras_gov_page_size():
    assert clamp_compras_gov_page_size(None) == 100
    assert clamp_compras_gov_page_size(5) == 10
    assert clamp_compras_gov_page_size(100) == 100
    assert clamp_compras_gov_page_size(500) == 500
    assert clamp_compras_gov_page_size(1000) == 500
    assert clamp_compras_gov_page_size(-10) == 10


def test_parse_retry_after_edge_cases():
    # Empty or None
    assert parse_retry_after(None, default_wait=3.0) == 3.0
    assert parse_retry_after("", default_wait=3.0) == 3.0
    # Invalid string fallback
    assert parse_retry_after("invalid_header_val", default_wait=4.0) == 4.0
    # Negative seconds clamped to 0
    assert parse_retry_after("-5", default_wait=2.0) == 0.0
    # Seconds exceeding max_cap clamped
    assert parse_retry_after("120", default_wait=2.0, max_cap=60.0) == 60.0


def test_http_client_instance_usage():
    client = HttpClient(
        timeout=15,
        max_retries=2,
        backoff_factor=1.5,
        allowed_hosts=["example.com"],
    )
    payload = {"data": [1, 2, 3]}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = client.fetch_json("https://example.com/api")
        assert res == payload


# ============================================================================
# SSRF Protection & Host Allowlist Tests
# ============================================================================


def test_ssrf_allowed_host_succeeds_by_default():
    """Default allowlist allows dadosabertos.compras.gov.br, pncp.gov.br, and supabase.co."""
    payload = {"status": "ok"}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res1 = fetch_json("https://dadosabertos.compras.gov.br/modulo-material/1")
        assert res1 == payload

        res2 = fetch_json("https://pncp.gov.br/api/consulta/v1/contratacoes")
        assert res2 == payload

        # Subdomains of allowed hosts should also succeed
        res3 = fetch_json("https://www.pncp.gov.br/api/test")
        assert res3 == payload

        # Supabase project URLs (e.g. xyz.supabase.co) should succeed by default
        res4 = fetch_json("https://xyzcompany.supabase.co/rest/v1/icatmat_item_material")
        assert res4 == payload


def test_ssrf_supabase_url_env_derived_host(monkeypatch):
    """When SUPABASE_URL is set in environment, its hostname is automatically added to allowed hosts."""
    monkeypatch.setenv("SUPABASE_URL", "https://custom-project-id.supabase.co/rest/v1")
    payload = {"data": "supabase_rest"}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_json("https://custom-project-id.supabase.co/rest/v1/icatmat_pdm_material")
        assert res == payload

    # Also supports non-supabase.co custom self-hosted Supabase instances via SUPABASE_URL
    monkeypatch.setenv("SUPABASE_URL", "https://my-supabase.internal.licitagym.com.br")
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res2 = fetch_json("https://my-supabase.internal.licitagym.com.br/rest/v1/rpc/upsert")
        assert res2 == payload


def test_ssrf_disallowed_host_raises_http_fetch_error():
    """Disallowed hosts must raise HttpFetchError with error_type='ssrf_protection'."""
    with pytest.raises(HttpFetchError) as exc_info:
        fetch_json("https://evil.com/data")

    err = exc_info.value
    assert err.error_type == "ssrf_protection"
    assert "não está na lista de hosts permitidos" in str(err)
    assert err.url == "https://evil.com/data"


def test_ssrf_disallowed_host_returns_dict_when_no_raise():
    """When raise_for_status=False, returns structured error dict without network call."""
    res = fetch_json("https://evil.com/data", raise_for_status=False)
    assert res["sucesso"] is False
    assert res["error_type"] == "ssrf_protection"
    assert "não está na lista de hosts permitidos" in res["erro"]


def test_ssrf_override_allowed_hosts_via_param():
    """Constructor param and fetch_json param allowed_hosts can override the default list."""
    payload = {"data": "custom"}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        # Via fetch_json param
        res = fetch_json("https://custom-api.org/test", allowed_hosts=["custom-api.org"])
        assert res == payload

        # Via HttpClient constructor
        client = HttpClient(allowed_hosts=["custom-api.org"])
        res_client = client.fetch_json("https://custom-api.org/test")
        assert res_client == payload


def test_ssrf_override_allowed_hosts_via_env(monkeypatch):
    """Env var LICITAGYM_HTTP_ALLOWED_HOSTS can add or override allowed hosts."""
    monkeypatch.setenv(ALLOWED_HOSTS_ENV, "myhost.local, trusted.internal.gov.br")
    payload = {"env": "override"}
    with patch("urllib.request.urlopen", return_value=DummyHttpResponse(payload)):
        res = fetch_json("https://myhost.local/path")
        assert res == payload

        res2 = fetch_json("https://trusted.internal.gov.br/path")
        assert res2 == payload

        # Original default shouldn't be allowed if completely overridden by env var
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/test")
        assert exc_info.value.error_type == "ssrf_protection"


def test_ssrf_rejects_non_http_schemes():
    """file://, ftp://, gopher://, javascript: schemes must be rejected."""
    for bad_url in [
        "file:///etc/passwd",
        "ftp://dadosabertos.compras.gov.br/test",
        "gopher://dadosabertos.compras.gov.br/",
        "data:text/plain;base64,SGVsbG8=",
    ]:
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json(bad_url)
        assert exc_info.value.error_type == "ssrf_protection"
        assert "Esquema de URL não permitido" in str(exc_info.value) or "Host ausente" in str(exc_info.value)


def test_ssrf_rejects_literal_private_and_loopback_ips():
    """Direct access to private or loopback IPs (127.0.0.1, 169.254.169.254, 10.0.0.1) is blocked."""
    # Even if someone accidentally adds an IP to allowed_hosts, private IPs should be refused
    for ip_url in [
        "http://127.0.0.1:8080/admin",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/internal",
        "http://192.168.1.1/router",
        "http://[::1]/secret",
    ]:
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json(ip_url, allowed_hosts=["*"])
        assert exc_info.value.error_type == "ssrf_protection"
        assert "Acesso a endereço IP local/privado bloqueado" in str(exc_info.value)


class DummyRedirectResponse(DummyHttpResponse):
    """Dummy response simulating a redirect that ended up at a different final URL."""

    def __init__(self, data: dict, final_url: str, status: int = 200):
        super().__init__(data, status=status)
        self._final_url = final_url

    def geturl(self):
        return self._final_url


def test_ssrf_redirect_to_disallowed_host_fails():
    """If urlopen followed a redirect to an off-allowlist host, it must be detected and blocked."""
    payload = {"secret": "leak"}
    # Simulates request to allowed host that redirects to evil.com
    with patch(
        "urllib.request.urlopen",
        return_value=DummyRedirectResponse(payload, final_url="https://evil.com/hijacked"),
    ):
        with pytest.raises(HttpFetchError) as exc_info:
            fetch_json("https://dadosabertos.compras.gov.br/modulo-material/redirect")

        err = exc_info.value
        assert err.error_type == "ssrf_protection"
        assert "não está na lista de hosts permitidos" in str(err)


def test_ssrf_safe_redirect_handler_validates():
    """Test SafeRedirectHandler directly to ensure redirect_request validates target URL."""
    handler = SafeRedirectHandler(lambda u: validate_url(u, ["dadosabertos.compras.gov.br"]))

    # Redirect to allowed host succeeds
    req = urllib.request.Request("https://dadosabertos.compras.gov.br/start")
    res_req = handler.redirect_request(
        req, None, 302, "Found", {}, "https://dadosabertos.compras.gov.br/target"
    )
    assert res_req.get_full_url() == "https://dadosabertos.compras.gov.br/target"

    # Redirect to off-allowlist host raises HttpFetchError
    with pytest.raises(HttpFetchError) as exc_info:
        handler.redirect_request(req, None, 302, "Found", {}, "https://attacker.org/exfil")
    assert exc_info.value.error_type == "ssrf_protection"
    assert "não está na lista de hosts permitidos" in str(exc_info.value)


def test_ssrf_safe_redirect_handler_used_on_live_fetch_path():
    """Prove that SafeRedirectHandler is actually wired and invoked on the live opener fetch path.

    When urllib.request.urlopen is not mocked, fetch_json uses opener.open(...),
    which invokes SafeRedirectHandler.redirect_request BEFORE following any redirect,
    preventing requests to private IP addresses (e.g. AWS metadata 169.254.169.254).
    """
    import urllib.response
    from email.message import Message

    class Mock302HTTPHandler(urllib.request.HTTPHandler):
        """Simulate HTTP 302 redirect directly at the HTTPHandler level."""

        def __init__(self, target_redirect_url: str):
            super().__init__()
            self.target_redirect_url = target_redirect_url
            self.redirect_occurred = False

        def http_open(self, req):
            headers = Message()
            headers["Location"] = self.target_redirect_url
            resp = urllib.response.addinfourl(io.BytesIO(b""), headers, req.get_full_url(), code=302)
            resp.msg = "Found"
            resp.code = 302
            self.redirect_occurred = True
            return resp

    # 1. Test redirect to private cloud metadata IP (169.254.169.254) is blocked by handler
    mock_302 = Mock302HTTPHandler("http://169.254.169.254/latest/meta-data/")
    original_build_opener = urllib.request.build_opener

    def custom_build_opener(*handlers):
        # Insert mock HTTP handler so opener does not touch the network
        return original_build_opener(mock_302, *handlers)

    with patch("urllib.request.build_opener", side_effect=custom_build_opener):
        client = HttpClient(max_retries=1)
        with pytest.raises(HttpFetchError) as exc_info:
            client.fetch_json("http://dadosabertos.compras.gov.br/redirect-to-metadata")

        err = exc_info.value
        assert err.error_type == "ssrf_protection"
        assert "Acesso a endereço IP local/privado bloqueado" in str(err)
        assert mock_302.redirect_occurred

    # 2. Test redirect to disallowed domain (evil.com) is blocked by handler
    mock_302_evil = Mock302HTTPHandler("https://evil.com/leak")

    def custom_build_opener_evil(*handlers):
        return original_build_opener(mock_302_evil, *handlers)

    with patch("urllib.request.build_opener", side_effect=custom_build_opener_evil):
        client = HttpClient(max_retries=1)
        with pytest.raises(HttpFetchError) as exc_info:
            client.fetch_json("http://dadosabertos.compras.gov.br/redirect-to-evil")

        err = exc_info.value
        assert err.error_type == "ssrf_protection"
        assert "não está na lista de hosts permitidos" in str(err)
        assert mock_302_evil.redirect_occurred


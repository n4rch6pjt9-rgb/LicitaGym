"""Modelo de geração (Gemini 3.8 Flash no lugar do 2.5, descontinuado em 22/10/2026) e classificação das falhas da
ficha do documento (licitação 3558: prazo estourado parava a indexação inteira)."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from google.genai import errors, types

from coletor import ia as IA


def _gemini(monkeypatch, modelo="gemini-3.8-flash", pensamento=""):
    monkeypatch.setattr(IA, "GEN_MODEL", modelo)
    monkeypatch.setattr(IA, "GEN_THINKING", pensamento)
    monkeypatch.setattr(IA.time, "sleep", lambda s: None)
    g = object.__new__(IA.Gemini)
    g.types = types
    g.client = MagicMock()
    return g


def _erro(codigo, status):
    cls = errors.ServerError if codigo >= 500 else errors.ClientError
    return cls(codigo, {"error": {"code": codigo, "status": status, "message": "texto do modelo com 429 no meio"}})


def test_padrao_e_o_38_flash_no_endpoint_global(monkeypatch):
    import importlib
    for var in ("GEN_MODEL", "GEN_LOCATION", "GEN_THINKING"):
        monkeypatch.delenv(var, raising=False)
    try:
        m = importlib.reload(IA)
        assert (m.GEN_MODEL, m.GEN_LOCATION, m.GEN_THINKING) == ("gemini-3.8-flash", "global", "")
        assert m.pensamento_padrao(m.GEN_MODEL) == "low"
    finally:
        importlib.reload(IA)


def test_geracao_no_global_e_embedding_regional(monkeypatch):
    criados = []
    import google.genai as genai
    monkeypatch.setattr(genai, "Client", lambda **kw: criados.append(kw) or SimpleNamespace(**kw))
    monkeypatch.setattr(IA, "GEN_LOCATION", "global")
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    g = IA.Gemini(project="p")
    assert g.client_embed.location == "us-central1" and g.client.location == "global"
    assert all(c["project"] == "p" for c in criados)


@pytest.mark.parametrize("modelo,esperado", [("gemini-3.8-flash", True), ("gemini-3-pro", True), ("gemini-10.0-flash", True),
                                             ("gemini-2.5-flash", False), ("gemini-2.5-pro", False), ("outro", False)])
def test_gemini_3_ou_mais(modelo, esperado):
    assert IA.gemini_3_ou_mais(modelo) is esperado


def test_ocr_no_38_usa_thinking_level_low_e_nao_manda_temperature(monkeypatch):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.return_value = SimpleNamespace(text="t", candidates=[])
    g.ocr_pagina(b"%PDF-1.4")
    cfg = g.client.models.generate_content.call_args.kwargs["config"]
    assert g.client.models.generate_content.call_args.kwargs["model"] == "gemini-3.8-flash"
    assert cfg.thinking_config.thinking_level == types.ThinkingLevel.LOW and cfg.thinking_config.thinking_budget is None
    assert cfg.temperature is None and cfg.max_output_tokens == IA.OCR_MAX_TOKENS


def test_ocr_no_25_flash_mantem_thinking_budget_zero(monkeypatch):
    g = _gemini(monkeypatch, "gemini-2.5-flash")
    g.client.models.generate_content.return_value = SimpleNamespace(text="t", candidates=[])
    g.ocr_pagina(b"%PDF-1.4")
    cfg = g.client.models.generate_content.call_args.kwargs["config"]
    assert cfg.thinking_config.thinking_budget == 0 and cfg.temperature == 0


def test_gen_thinking_explicito_vale_sobre_o_padrao(monkeypatch):
    g = _gemini(monkeypatch, pensamento="medium")
    assert g._config(temperatura=0).thinking_config.thinking_level == types.ThinkingLevel.MEDIUM
    g = _gemini(monkeypatch, pensamento="padrao")
    assert g._config(temperatura=0).thinking_config is None


def test_gen_thinking_invalido_falha_a_vista(monkeypatch):
    g = _gemini(monkeypatch, pensamento="minimal")   # o 3.8 Flash recusa minimal: melhor falhar aqui que no Vertex
    with pytest.raises(ValueError, match="GEN_THINKING"):
        g._config()
    with pytest.raises(ValueError, match="GEN_THINKING"):
        IA.Gemini(project="p")   # ao criar o cliente, antes de qualquer documento


def test_resposta_do_rag_usa_o_pensamento_padrao_do_modelo(monkeypatch):
    g = _gemini(monkeypatch)
    assert g._config(temperatura=0.2, pensamento_minimo=False).thinking_config is None


# --- ficha: só prazo estourado e JSON inválido viram "ficha indisponível" ---

def _ficha(g):
    return g.extrair_campos("texto", "doc.pdf", "edital", "58/2026")


def test_ficha_ok(monkeypatch):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.return_value = SimpleNamespace(text='{"tipo_documento": "edital"}')
    assert _ficha(g) == {"tipo_documento": "edital"}
    cfg = g.client.models.generate_content.call_args.kwargs["config"]
    assert cfg.response_mime_type == "application/json" and cfg.max_output_tokens == IA.FICHA_MAX_TOKENS


@pytest.mark.parametrize("erro", [_erro(504, "DEADLINE_EXCEEDED"), httpx.ReadTimeout("lento")])
def test_ficha_com_prazo_estourado_vira_indisponivel(monkeypatch, erro):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.side_effect = erro
    with pytest.raises(IA.FichaIndisponivel) as e:
        _ficha(g)
    assert e.value.categoria == "prazo_estourado"
    assert g.client.models.generate_content.call_count == IA.FICHA_TENTATIVAS


def test_ficha_com_json_invalido_vira_indisponivel(monkeypatch):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.return_value = SimpleNamespace(text="{ CPF 123")
    with pytest.raises(IA.FichaIndisponivel) as e:
        _ficha(g)
    assert e.value.categoria == "json_invalido" and "123" not in str(e.value)


@pytest.mark.parametrize("codigo,status", [(503, "UNAVAILABLE"), (500, "INTERNAL"), (429, "RESOURCE_EXHAUSTED")])
def test_ficha_com_5xx_ou_cota_sobe_como_transitoria(monkeypatch, codigo, status):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.side_effect = _erro(codigo, status)
    with pytest.raises(errors.APIError) as e:
        _ficha(g)
    assert not isinstance(e.value, IA.FichaIndisponivel) and e.value.code == codigo


@pytest.mark.parametrize("codigo,status", [(404, "NOT_FOUND"), (403, "PERMISSION_DENIED"), (401, "UNAUTHENTICATED"),
                                           (400, "INVALID_ARGUMENT")])
def test_ficha_com_erro_de_configuracao_falha_a_vista_sem_retry(monkeypatch, codigo, status):
    g = _gemini(monkeypatch)
    g.client.models.generate_content.side_effect = _erro(codigo, status)
    with pytest.raises(errors.ClientError):
        _ficha(g)
    assert g.client.models.generate_content.call_count == 1


@pytest.mark.parametrize("erro,esperado", [
    (lambda: _erro(429, "RESOURCE_EXHAUSTED"), "cota do Vertex atingida (429)"),
    (lambda: _erro(500, "INTERNAL"), "erro 500 do Vertex"),
    (lambda: _erro(504, "DEADLINE_EXCEEDED"), "prazo do Vertex estourado (504/timeout)"),
    (lambda: httpx.ReadTimeout("lento"), "prazo do Vertex estourado (504/timeout)"),
])
def test_tipo_falha_pelo_codigo_nao_pela_mensagem(erro, esperado):
    # a mensagem de todos traz "429 no meio": quem decide é o código
    assert IA.tipo_falha(erro()) == esperado


def test_retry_com_esperas_proprias(monkeypatch):
    dormidas = []
    monkeypatch.setattr(IA.time, "sleep", dormidas.append)
    g = object.__new__(IA.Gemini)
    falhas = [_erro(429, "RESOURCE_EXHAUSTED"), _erro(504, "DEADLINE_EXCEEDED"), _erro(500, "INTERNAL")]

    def fn():
        if falhas:
            raise falhas.pop(0)
        return "ok"

    assert g._retry(fn, tentativas=4, esperas=(30, 60)) == "ok"
    assert dormidas == [30, 60, 60]          # a última espera se repete


def test_retry_sem_esperas_mantem_o_backoff_padrao(monkeypatch):
    dormidas = []
    monkeypatch.setattr(IA.time, "sleep", dormidas.append)
    g = object.__new__(IA.Gemini)
    with pytest.raises(errors.ServerError):
        g._retry(lambda: (_ for _ in ()).throw(_erro(500, "INTERNAL")), tentativas=3)
    assert dormidas == [5, 10]


def test_prazo_proprio_por_cliente(monkeypatch):
    criados = []
    import google.genai as genai
    monkeypatch.setattr(genai, "Client", lambda **kw: criados.append(kw) or SimpleNamespace(**kw))
    IA.Gemini(project="p", timeout_ms=40000)
    assert {c["http_options"].timeout for c in criados} == {40000}
    criados.clear()
    IA.Gemini(project="p")
    assert {c["http_options"].timeout for c in criados} == {IA.TIMEOUT_MS}

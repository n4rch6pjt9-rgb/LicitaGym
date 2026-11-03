"""Regressoes offline: prazo do PNCP e sinalizacao de recoleta incompleta."""
from unittest.mock import MagicMock

import pytest

from coletor import pncp as P


@pytest.mark.parametrize("download", [False, True])
@pytest.mark.parametrize("prazo,esperado", [("120", 120.0), ("invalido", 5.0)])
def test_429_espera_antes_de_repetir(monkeypatch, download, prazo, esperado):
    eventos = []
    monkeypatch.setattr(P.time, "sleep", lambda segundos: eventos.append(("espera", segundos)))
    limitado = MagicMock(status_code=429, headers={"Retry-After": prazo})
    sucesso = MagicMock(status_code=200, headers={"content-type": "application/json"})
    sucesso.json.return_value = {"ok": True}
    sucesso.iter_content.return_value = [b"conteudo"]
    for resposta in (limitado, sucesso):
        resposta.__enter__.return_value = resposta
    respostas = iter((limitado, sucesso))

    def obter(*args, **kwargs):
        eventos.append(("request", None))
        return next(respostas)

    cliente = P.PNCP(delay=0, tentativas=2)
    if download:
        monkeypatch.setattr(cliente, "_abrir", obter)
        assert cliente.baixar("https://pncp.gov.br/arquivo", 100) == (b"conteudo", "application/json")
    else:
        sessao = MagicMock()
        sessao.get.side_effect = obter
        cliente._local.s = sessao
        assert cliente._get("/teste") == {"ok": True}
    relevantes = [evento for evento in eventos if evento != ("espera", 0)]
    assert relevantes == [("request", None), ("espera", esperado), ("request", None)]


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("resumo,esperado", [
    ({"falha_detalhe": 0, "erros": 0, "recoletadas": 1}, 0),
    ({"falha_detalhe": 1, "erros": 0}, 1),
    ({"falha_detalhe": 0, "erros": 1}, 1),
    ({"falha_detalhe": 1, "erros": 1}, 1),
])
def test_cli_recoleta_sinaliza_pendencias(monkeypatch, dry_run, resumo, esperado):
    monkeypatch.setenv("SUPABASE_URL", "https://example.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "credencial-ficticia")
    banco = MagicMock()
    monkeypatch.setattr(P, "Supabase", lambda *args: banco)
    monkeypatch.setattr(P, "PNCP", lambda **kwargs: object())
    monkeypatch.setattr(P, "_mapa_catmat_ou_abortar", lambda obter: (True, None))
    recoletar = MagicMock(return_value=resumo)
    drenar = MagicMock()
    monkeypatch.setattr(P, "recoletar_atualizadas", recoletar)
    monkeypatch.setattr(P, "drenar_licitacao_match", drenar)
    args = ["--recoletar-atualizadas"] + (["--dry-run"] if dry_run else [])
    assert P.main(args) == esperado
    assert recoletar.call_args.kwargs["dry_run"] is dry_run
    assert drenar.call_count == (0 if dry_run else 1)

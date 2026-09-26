"""Detalhe da compra: timeout curto e poucas tentativas."""
from unittest.mock import MagicMock

import pytest
import requests

from coletor import pncp as P


def test_detalhe_usa_timeout_curto_e_desiste_rapido(monkeypatch):
    monkeypatch.setattr(P.time, "sleep", lambda *_: None)
    cli = P.PNCP(delay=0)
    sessao = MagicMock()
    sessao.get.side_effect = requests.Timeout("sem resposta")
    cli._local.s = sessao
    c = {"orgao_cnpj": "88186424000133", "ano": 2026, "numero_sequencial": 40}
    with pytest.raises(Exception):
        cli.compra(c)
    assert sessao.get.call_count == P.DETALHE_TENTATIVAS == 2
    assert all(k.kwargs["timeout"] == P.DETALHE_TIMEOUT == 20 for k in sessao.get.call_args_list)
    assert "/api/consulta/v1/" in sessao.get.call_args_list[0].args[0]


def test_outras_chamadas_mantem_timeout_padrao(monkeypatch):
    monkeypatch.setattr(P.time, "sleep", lambda *_: None)
    cli = P.PNCP(delay=0)
    sessao = MagicMock()
    resp = MagicMock(status_code=200, headers={"content-type": "application/json"})
    resp.json.return_value = []
    sessao.get.return_value = resp
    cli._local.s = sessao
    cli.arquivos({"orgao_cnpj": "88186424000133", "ano": 2026, "numero_sequencial": 40})
    assert sessao.get.call_args.kwargs["timeout"] == cli.timeout

"""Spec 0029, CA-1: medição da consulta do PNCP por data (sem rede, sem gravar)."""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

from coletor import medir_consulta_pncp as m


class Resp:
    def __init__(self, status: int, corpo=None, headers=None):
        self.status_code = status
        self._corpo = corpo
        self.headers = headers or {}

    def json(self):
        return self._corpo


class Sessao:
    """Devolve as respostas em ordem e guarda os parâmetros pedidos."""

    def __init__(self, respostas):
        self.respostas = list(respostas)
        self.pedidos = []

    def get(self, url, params=None, timeout=None):
        self.pedidos.append((url, dict(params or {})))
        r = self.respostas.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def pagina(registros, total_paginas, total_registros, numero=1):
    return Resp(200, {"data": registros, "totalPaginas": total_paginas, "totalRegistros": total_registros,
                      "numeroPagina": numero, "paginasRestantes": max(0, total_paginas - numero), "empty": not registros})


def compra(objeto):
    return {"objetoCompra": objeto, "numeroControlePNCP": "x"}


def medir(sessao, **kw):
    esperas = []
    kw.setdefault("modalidades", [6])
    kw.setdefault("endpoints", ["publicacao"])
    rel = m.medir(sessao, date(2026, 10, 15), dormir=esperas.append, relogio=iter(range(0, 10_000, 2)).__next__,
                  delay=1.0, **kw)
    return rel, esperas


def test_ultimo_dia_util_em_brasilia():
    # sábado 17/10 01:00 em Brasília (04:00 UTC) -> sexta 16/10
    assert m.ultimo_dia_util(datetime(2026, 10, 17, 4, 0, tzinfo=timezone.utc)) == date(2026, 10, 16)
    # segunda 19/10 10:00 -> sexta 16/10 (dia completo anterior)
    assert m.ultimo_dia_util(datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)) == date(2026, 10, 16)
    # quinta 16/10 02:00 UTC ainda é quarta 15/10 23:00 em Brasília -> terça 14/10
    assert m.ultimo_dia_util(datetime(2026, 10, 16, 2, 0, tzinfo=timezone.utc)) == date(2026, 10, 14)


def test_pagina_ate_total_da_api_e_conta_escopo():
    sessao = Sessao([
        pagina([compra("Aquisição de esteira ergométrica para academia"), compra("Contratação de serviço de limpeza")],
               total_paginas=2, total_registros=3),
        pagina([compra("Aquisição de piso de borracha EPDM")], total_paginas=2, total_registros=3, numero=2),
    ])
    rel, esperas = medir(sessao)
    linha = rel["medicoes"][0]
    assert (linha["endpoint"], linha["modalidade"]) == ("publicacao", 6)
    assert linha["paginas"] == 2 and linha["registros_api"] == 3 and linha["recebidos"] == 3
    assert linha["no_escopo"] == 2
    assert linha["por_categoria"] == {"forte": 1, "borracha": 1}
    assert linha["completa"] is True and linha["http_429"] == 0
    url, params = sessao.pedidos[0]
    assert url.endswith("/api/consulta/v1/contratacoes/publicacao")
    assert params == {"dataInicial": "20261015", "dataFinal": "20261015", "codigoModalidadeContratacao": 6,
                      "pagina": 1, "tamanhoPagina": 50}
    assert esperas.count(1.0) == 2  # DELAY entre chamadas


def test_pagina_curta_nao_encerra_antes_do_total():
    sessao = Sessao([
        pagina([compra("bola")], total_paginas=3, total_registros=3),
        pagina([compra("rede")], total_paginas=3, total_registros=3, numero=2),
        pagina([compra("trave")], total_paginas=3, total_registros=3, numero=3),
    ])
    rel, _ = medir(sessao)
    assert rel["medicoes"][0]["paginas"] == 3


def test_204_e_vazio():
    rel, _ = medir(Sessao([Resp(204)]))
    linha = rel["medicoes"][0]
    assert linha["paginas"] == 1 and linha["recebidos"] == 0 and linha["registros_api"] == 0 and linha["completa"]


def test_429_respeita_retry_after_e_conta():
    sessao = Sessao([Resp(429, headers={"Retry-After": "7"}), pagina([compra("halter")], 1, 1)])
    rel, esperas = medir(sessao)
    linha = rel["medicoes"][0]
    assert linha["http_429"] == 1 and linha["completa"]
    assert 7.0 in esperas


def test_erro_persistente_marca_incompleta_e_nao_vira_zero():
    sessao = Sessao([Resp(503)] * m.TENTATIVAS)
    rel, _ = medir(sessao)
    linha = rel["medicoes"][0]
    assert linha["completa"] is False
    assert linha["erros"] and "503" in linha["erros"][0]
    assert rel["resumo"]["incompletas"] == 1


def test_resumo_soma_endpoints_e_modalidades():
    sessao = Sessao([
        pagina([compra("esteira ergométrica")], 1, 1),
        pagina([compra("serviço de vigilância")], 1, 1),
        pagina([], 1, 0),
        pagina([compra("bicicleta ergométrica")], 1, 1),
    ])
    rel, _ = medir(sessao, modalidades=[6, 8], endpoints=["publicacao", "atualizacao"])
    r = rel["resumo"]
    assert r["chamadas"] == 4 and r["recebidos"] == 3 and r["no_escopo"] == 2 and r["incompletas"] == 0
    assert r["segundos"] > 0


def test_delay_abaixo_de_1_e_recusado():
    with pytest.raises(SystemExit):
        m.main(["--delay", "0.5", "--saida", "x.json"])

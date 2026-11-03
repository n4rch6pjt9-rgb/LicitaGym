"""HTTP 400 "Erro ao efetuar a consulta" do Compras.gov é instabilidade: entra no retry; os outros 400 não.

Caso real: Job coletor-precos, 21/10/2026 18:39 UTC. A mesma consulta respondeu 200 minutos depois.
"""
from __future__ import annotations

import json

import pytest

from coletor import compras_api, compras_precos

CORPO_INSTAVEL = {"type": "about:blank", "title": "Bad Request", "status": 400, "detail": "Erro ao efetuar a consulta "}
CORPO_400_COMUM = {"status": 400, "detail": "codigoPdm deve ser numérico"}
OK = {"resultado": [], "totalRegistros": 0, "totalPaginas": 0, "paginasRestantes": 0}


class Resp:
    def __init__(self, status: int, corpo: dict):
        self.status_code = status
        self._corpo = corpo
        self.text = json.dumps(corpo, ensure_ascii=False)
        self.headers: dict[str, str] = {}

    def json(self):
        return self._corpo


def _sequencia(*respostas):
    fila = list(respostas)
    chamadas = []

    def get(url, params=None, timeout=None):
        chamadas.append(params)
        return fila.pop(0)

    return get, chamadas


def test_instabilidade_reconhece_so_o_400_do_compras():
    assert compras_api.instabilidade_compras(Resp(400, CORPO_INSTAVEL))
    assert not compras_api.instabilidade_compras(Resp(400, CORPO_400_COMUM))
    assert not compras_api.instabilidade_compras(Resp(500, CORPO_INSTAVEL))
    assert not compras_api.instabilidade_compras(Resp(200, OK))


def test_precos_400_instavel_tenta_de_novo_e_recupera(monkeypatch):
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    get, chamadas = _sequencia(Resp(400, CORPO_INSTAVEL), Resp(200, OK))
    esperas = []
    monkeypatch.setattr(cliente.s, "get", get)
    monkeypatch.setattr(compras_precos.time, "sleep", esperas.append)

    assert cliente.consultar_detalhe(602701)["resultado"] == []
    assert len(chamadas) == 2
    assert max(esperas) >= 5  # backoff de instabilidade (base 10 s), não o delay entre chamadas


def test_precos_400_instavel_esgotado_e_erro_nunca_vazio(monkeypatch):
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    get, chamadas = _sequencia(*[Resp(400, CORPO_INSTAVEL)] * 3)
    monkeypatch.setattr(cliente.s, "get", get)
    monkeypatch.setattr(compras_precos.time, "sleep", lambda *_: None)

    with pytest.raises(compras_api.ErroApiCompras, match="instabilidade do Compras.gov"):
        cliente.consultar_material("codigoPdm", 2640)
    assert len(chamadas) == 3


def test_precos_400_comum_continua_sem_retry(monkeypatch):
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    get, chamadas = _sequencia(Resp(400, CORPO_400_COMUM), Resp(200, OK))
    monkeypatch.setattr(cliente.s, "get", get)
    monkeypatch.setattr(compras_precos.time, "sleep", lambda *_: None)

    with pytest.raises(compras_api.ErroApiCompras, match="HTTP 400"):
        cliente.consultar_material("codigoPdm", 2640)
    assert len(chamadas) == 1

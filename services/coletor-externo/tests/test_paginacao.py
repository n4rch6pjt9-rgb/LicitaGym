"""Paginação do coletor externo: teto 100 e parada pelo total da API."""
from unittest.mock import MagicMock

import pytest
import requests

from coletor import compras_arp, compras_pgc, pncp as P
from coletor.destino import Supabase
from coletor.fornecedores import cnpjs_de_resultados
from coletor.paginacao import avaliar_pagina, clamp_tamanho


COMPRA = {
    "numero_controle_pncp": "44892693000140-1-000157/2026",
    "orgao_cnpj": "44892693000140",
    "ano": 2026,
    "numero_sequencial": 157,
}


def test_ultima_pagina_curta_com_total_encerra():
    decisao = avaliar_pagina(
        [{"id": 1}, {"id": 2}],
        tamanho=100,
        pagina=2,
        corpo={"totalRegistros": 102, "totalPaginas": 2, "paginasRestantes": 0},
    )
    assert decisao.encerrar is True
    assert decisao.aviso is None


def test_pagina_curta_sem_total_segue():
    decisao = avaliar_pagina([{"id": 1}], tamanho=100, pagina=1, corpo={})
    assert decisao.encerrar is False
    assert decisao.aviso is None


def test_total_ausente_encerra_so_na_pagina_vazia():
    assert avaliar_pagina([{"id": 1}], tamanho=50, pagina=1, corpo={}).encerrar is False
    vazia = avaliar_pagina([], tamanho=50, pagina=2, corpo={})
    assert vazia.encerrar is True and vazia.aviso is None


def test_404_do_helper_nao_entra_aqui_corpo_inesperado_avisa():
    decisao = avaliar_pagina("nao-lista", tamanho=100, pagina=1, corpo={})
    assert decisao.encerrar is True
    assert decisao.aviso


def test_clamp_tam_500():
    assert clamp_tamanho(500) == 100
    assert clamp_tamanho(20) == 20


def test_buscar_tam_500_pede_100(monkeypatch):
    cli = P.PNCP(delay=0, tentativas=1)
    visto = {}

    def fake_get(caminho, **params):
        visto.update(params)
        return {"items": [], "total": 0}

    monkeypatch.setattr(cli, "_get", fake_get)
    cli.buscar("equipamento", tam=500)
    assert visto["tam_pagina"] == 100


def test_itens_pagina_curta_sem_total_segue_ate_vazia():
    cli = P.PNCP(delay=0, tentativas=1)
    paginas = [[{"numeroItem": 1}], [{"numeroItem": 2}], []]
    cli._lista = MagicMock(side_effect=paginas)
    itens = cli.itens(COMPRA)
    assert [it["numeroItem"] for it in itens] == [1, 2]
    assert cli._lista.call_count == 3
    assert cli._lista.call_args_list[0].kwargs["tamanhoPagina"] == 100


def test_itens_404_nao_encerra_em_silencio(caplog):
    cli = P.PNCP(delay=0, tentativas=1)
    resposta = MagicMock(status_code=404)
    erro = requests.HTTPError("404")
    erro.response = resposta
    cli._lista = MagicMock(side_effect=[[{"numeroItem": 1}], erro])
    with caplog.at_level("WARNING"):
        with pytest.raises(requests.HTTPError):
            cli.itens(COMPRA)
    assert "404" in caplog.text
    assert "não é fim" in caplog.text


def test_coleta_tam_500_e_pagina_curta_sem_total(monkeypatch):
    chamadas = []

    def buscar(termo, st, pagina, tam):
        chamadas.append((pagina, tam))
        if pagina == 1:
            return {"items": [{"numero_controle_pncp": "z-1"}]}
        return {"items": []}

    pncp = MagicMock()
    pncp.buscar.side_effect = buscar
    monkeypatch.setattr(P, "_processar", lambda *a, **k: None)
    P.coletar(pncp, None, None, ["x"], "todos", 4, 500, False, False, 1, True)
    assert [c[0] for c in chamadas] == [1, 2]
    assert chamadas[0][1] == 100


def test_pgc_404_nao_e_pagina_vazia(monkeypatch, caplog):
    cliente = compras_pgc.ClienteComprasPGC(delay=0)
    resposta = MagicMock(status_code=404)
    resposta.text = '{"statusCode": 404, "message": "Resource not found"}'
    resposta.json.return_value = {"statusCode": 404, "message": "Resource not found"}
    monkeypatch.setattr(cliente.s, "get", lambda *a, **k: resposta)
    monkeypatch.setattr(compras_pgc.time, "sleep", lambda *_: None)
    with caplog.at_level("WARNING"):
        with pytest.raises(Exception, match="404"):
            cliente.consultar_classe(7830, 2026)
    assert "404" in caplog.text
    sb = MagicMock()
    cliente.consultar_classe = MagicMock(side_effect=RuntimeError("HTTP 404 em PGC"))
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026], dry_run=True)
    assert res["sucesso"] is False and res["erros"] == 1 and res["total_coletados"] == 0
    sb.upsert.assert_not_called()


def test_pgc_pagina_curta_sem_total_segue(monkeypatch):
    cliente = MagicMock()
    paginas = [
        {"resultado": [{"numeroItemPncp": "1", "orgaoCnpj": "1", "codigoUasg": "1"}]},
        {"resultado": []},
    ]
    cliente.consultar_classe.side_effect = paginas
    # normalizar pode descartar o item incompleto; o que importa é a segunda chamada
    compras_pgc.coletar(cliente, None, classes=[7830], anos=[2026], dry_run=True)
    assert cliente.consultar_classe.call_count == 2
    assert cliente.consultar_classe.call_args_list[0].kwargs["tamanho_pagina"] == 100


def test_arp_tamanho_500_vai_100(monkeypatch):
    cliente = compras_arp.ClienteComprasARP(delay=0)
    visto = {}

    def fake_get(url, params=None, timeout=None):
        visto.update(params or {})
        m = MagicMock(status_code=200)
        m.json.return_value = {"resultado": [], "totalRegistros": 0}
        return m

    monkeypatch.setattr(cliente.s, "get", fake_get)
    monkeypatch.setattr(compras_arp.time, "sleep", lambda *_: None)
    cliente.consultar_itens_pdm(2640, "2026-01-01", "2026-06-01", tamanho_pagina=500)
    assert visto["tamanhoPagina"] == 100


def test_arp_pagina_curta_com_total_para():
    cliente = MagicMock()
    cliente.consultar_itens_pdm.return_value = {"resultado": [{"x": 1}], "totalRegistros": 1}
    compras_arp.coletar(cliente, None, pdms=[2640], data_min="2026-01-01", data_max="2026-06-01", dry_run=True)
    assert cliente.consultar_itens_pdm.call_count == 1


def test_selecionar_pagina_curta_sem_content_range_segue_ate_vazia(monkeypatch):
    import coletor.destino as Destino
    chamadas = []

    class Resp:
        def __init__(self, payload):
            self._payload = payload
            self.headers = {}

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    prefer = {}

    def fake_get(url, params, headers, timeout):
        chamadas.append(params["offset"])
        prefer["valor"] = headers.get("Prefer")
        if params["offset"] == "0":
            return Resp([{"id": 1}])
        return Resp([])

    monkeypatch.setattr(Destino, "POSTGREST_MAX_ROWS", 100)
    monkeypatch.setattr("coletor.destino.requests.get", fake_get)
    sb = Supabase("https://example.supabase.co", "token")
    assert sb.selecionar("licitacoes_externas") == [{"id": 1}]
    assert chamadas == ["0", "1"]
    assert prefer["valor"] == "count=exact"


def test_selecionar_content_range_confirma_fim(monkeypatch):
    import coletor.destino as Destino

    class Resp:
        def __init__(self, payload, total):
            self._payload = payload
            self.headers = {"Content-Range": f"0-{max(len(payload) - 1, 0)}/{total}"}

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def fake_get(url, params, headers, timeout):
        assert headers["Prefer"] == "count=exact"
        if params["offset"] == "0":
            return Resp([{"id": 1}], 1)
        raise AssertionError("total já confirmou o fim")

    monkeypatch.setattr(Destino, "POSTGREST_MAX_ROWS", 100)
    monkeypatch.setattr("coletor.destino.requests.get", fake_get)
    sb = Supabase("https://example.supabase.co", "token")
    assert sb.selecionar("licitacoes_externas") == [{"id": 1}]


def test_cnpjs_para_so_na_pagina_vazia_e_pede_no_maximo_100():
    vistos = []

    def selecionar(tabela, **kw):
        vistos.append(int(kw["limit"]))
        if kw["offset"] == "0":
            return [{"fornecedor_cnpj": "111"}]
        return []

    sb = MagicMock()
    sb.selecionar.side_effect = selecionar
    assert cnpjs_de_resultados(sb, pagina=1000) == ["111"]
    assert vistos == [100, 100]

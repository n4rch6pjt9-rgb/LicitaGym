"""Paginação dos coletores em scripts/: teto 100 e parada pelo total."""
import io
import json
import urllib.error
from unittest.mock import patch

import pytest

from scripts.collector_grupo_material import collect_grupos, fetch_grupos
from scripts.lib.http_client import clamp_compras_gov_page_size
from scripts.lib.http_fetch import HttpFetchError
from scripts.lib.paginacao import PaginaNaoConfirmada, acao_pagina, avaliar_pagina, clamp_tamanho
from scripts.lib.sync_state import SyncStateManager


class _Resp:
    def __init__(self, data):
        self._data = json.dumps(data).encode("utf-8")

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        return False


def test_avaliar_ultima_pagina_curta_com_total():
    itens = [{"id": 1}]
    decisao = avaliar_pagina(itens, tamanho=100, pagina=2, corpo={"totalRegistros": 101, "paginasRestantes": 0})
    assert decisao.encerrar is True
    assert decisao.aviso is None


def test_avaliar_pagina_curta_sem_total_nao_encerra():
    decisao = avaliar_pagina([{"id": 1}], tamanho=100, pagina=1, corpo={})
    assert decisao.encerrar is False
    assert decisao.aviso is None


def test_avaliar_total_ausente_so_encerra_na_pagina_vazia():
    assert avaliar_pagina([{"id": 1}, {"id": 2}], tamanho=100, pagina=1, corpo={}).encerrar is False
    vazia = avaliar_pagina([], tamanho=100, pagina=2, corpo={})
    assert vazia.encerrar is True
    assert vazia.aviso is None


def test_avaliar_total_ilegivel_nao_encerra_em_silencio():
    decisao = avaliar_pagina([{"id": 1}], tamanho=100, pagina=1, corpo={"totalRegistros": "muitos"})
    assert decisao.encerrar is False
    assert decisao.aviso


def test_clamp_tamanho_corta_500():
    assert clamp_tamanho(500) == 100
    assert clamp_compras_gov_page_size(500) == 100
    assert clamp_tamanho(None) == 100


def test_grupo_pagina_curta_com_total_nao_pede_a_seguinte(tmp_path):
    manager = SyncStateManager("test_pag_grupo_total", state_dir=tmp_path)
    payload = {
        "resultado": [{"codigoGrupo": 78, "nomeGrupo": "EQUIPAMENTOS"}],
        "totalRegistros": 1,
        "paginasRestantes": 0,
    }
    chamadas = {"n": 0}

    def urlopen(req, *args, **kwargs):
        chamadas["n"] += 1
        if chamadas["n"] > 1:
            raise AssertionError("página seguinte não deveria ser pedida")
        return _Resp(payload)

    with patch("urllib.request.urlopen", side_effect=urlopen):
        grupos = collect_grupos(sync_manager=manager, resume=False)
    assert chamadas["n"] == 1
    assert len(grupos) == 1


def test_grupo_pagina_curta_sem_total_segue_ate_vazia(tmp_path):
    manager = SyncStateManager("test_pag_grupo_sem_total", state_dir=tmp_path)
    paginas = [
        {"resultado": [{"codigoGrupo": 78, "nomeGrupo": "EQUIPAMENTOS"}]},
        {"resultado": []},
    ]

    def urlopen(req, *args, **kwargs):
        return _Resp(paginas.pop(0))

    with patch("urllib.request.urlopen", side_effect=urlopen):
        grupos = collect_grupos(sync_manager=manager, resume=False)
    assert [g["codigoGrupo"] for g in grupos] == [78]
    assert paginas == []


def test_grupo_404_nao_e_fim(tmp_path):
    manager = SyncStateManager("test_pag_grupo_404", state_dir=tmp_path)
    erro = urllib.error.HTTPError(
        url="https://dadosabertos.compras.gov.br/modulo-material/1_consultarGrupoMaterial",
        code=404,
        msg="Not Found",
        hdrs={},
        fp=io.BytesIO(b'{"message":"Resource not found"}'),
    )
    with patch("urllib.request.urlopen", side_effect=erro):
        with pytest.raises(HttpFetchError) as exc:
            collect_grupos(sync_manager=manager, resume=False)
    assert exc.value.status_code == 404


def test_fetch_grupos_tamanho_500_vai_como_100():
    visto = {}

    def urlopen(req, *args, **kwargs):
        visto["url"] = req.full_url
        return _Resp({"resultado": [], "totalRegistros": 0})

    with patch("urllib.request.urlopen", side_effect=urlopen):
        fetch_grupos(pagina=1, tamanho_pagina=500)
    assert "tamanhoPagina=100" in visto["url"]


def test_acao_repetida_nao_inclui(caplog):
    vistos: set[str] = set()
    logger = __import__("logging").getLogger("teste.paginacao")
    parar, incluir = acao_pagina([{"id": 1}], {}, tamanho=100, pagina=1, vistos=vistos, logger=logger)
    assert parar is False and incluir is True
    with pytest.raises(PaginaNaoConfirmada):
        acao_pagina([{"id": 1}], {}, tamanho=100, pagina=2, vistos=vistos, logger=logger)

"""Motor: fim de página, retry, bloqueio, dedup, retomada e recusa de --gravar. Sem rede."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from coletor.catalogo.adaptadores.konnen_wc import Konnen
from coletor.catalogo.adaptadores.movement_wp import Movement
from coletor.catalogo.motor import Limites, coletar
from coletor.catalogo.rede import Resposta
from coletor.catalogos import main

FIX = Path(__file__).parent / "fixtures" / "catalogo"
MUS = "https://www.movement.com.br/produtos/musculacao/"
CARDIO = "https://www.movement.com.br/produtos/cardio/"
KONNEN = "https://www.konnenfitness.com.br/categoria-produto/cardio/"


class ClienteFalso:
    def __init__(self, fn):
        self.fn = fn
        self.chamadas: list[str] = []
        self.bloqueados: dict[str, str] = {}

    def get(self, url: str) -> Resposta:
        host = (urlsplit(url).hostname or "").lower()
        if host in self.bloqueados:
            return Resposta(url=url, status=0, bloqueado=True, motivo_bloqueio=self.bloqueados[host], erro="bloqueado")
        self.chamadas.append(url)
        return self.fn(url)

    def bloquear(self, url: str, motivo: str) -> None:
        self.bloqueados[(urlsplit(url).hostname or "").lower()] = motivo


def _arquivo(url: str, status: int = 200) -> Resposta:
    nome = {
        CARDIO: "movement-cardio-pg1.html",
        CARDIO + "?pg=2": "movement-cardio-pg2.html",
        CARDIO + "?pg=3": "movement-cardio-pg3.html",
        CARDIO + "?pg=4": "movement-cardio-pg4.html",
        KONNEN: "konnen-cardio-pg1.html",
        KONNEN + "page/2/": "konnen-cardio-pg2.html",
        KONNEN + "page/3/": "konnen-cardio-pg3.html",
    }[url]
    return Resposta(url=url, status=status, corpo=(FIX / nome).read_bytes(), url_final=url)


def _detalhe_movement(url: str) -> Resposta:
    html = (
        '<html><body><p class="product__right__name">Produto</p>'
        '<p class="product__right__ref">Ref.: </p>'
        '<button class="buy-btn">Quero negociar</button>'
        '<div class="product__left__especs"><table></table></div></body></html>'
    )
    return Resposta(url=url, status=200, corpo=html.encode(), url_final=url)


def _detalhe_konnen(url: str) -> Resposta:
    n = int(hashlib.md5(url.encode()).hexdigest()[:6], 16) % 100000 + 1
    html = (
        f'<html><body class="postid-{n}"><h1>Produto</h1><p class="price"></p>'
        f'<a data-product_id="{n}">Adicionar ao orçamento</a>'
        f'<div id="tab-description"></div></body></html>'
    )
    return Resposta(url=url, status=200, corpo=html.encode(), url_final=url)


def _card(pid: str, slug: str) -> str:
    return (
        f'<div class="catalog__item" data-product-id="{pid}">'
        f'<a class="catalog__item__link" href="https://www.movement.com.br/produto/{slug}/"></a></div>'
    )


def _lista(cards: str, contador: int = 2) -> str:
    return f'<span class="catalog__filter__results--counter">[{contador}]</span><div class="catalog__items">{cards}</div>'


def test_paginacao_movement_cardio_fecha_no_vazio_e_bate_o_contador():
    def fn(url: str) -> Resposta:
        if url.startswith("https://www.movement.com.br/produto/"):
            return _detalhe_movement(url)
        return _arquivo(url)

    cliente = ClienteFalso(fn)
    estado = coletar(
        Movement(), {"entradas": [CARDIO]}, cliente, marca="MOVEMENT", fornecedor="movement",
    )
    assert estado["status"] == "completa"
    assert estado["progresso"]["novos_por_pagina"] == [12, 12, 11, 0]
    assert estado["progresso"]["declarado"] == 35
    assert estado["progresso"]["unicos"] == 35
    assert "pagina_vazia" in estado["progresso"]["fim"]
    assert not estado["progresso"]["falhas"]


def test_paginacao_konnen_fecha_no_404():
    def fn(url: str) -> Resposta:
        if url == KONNEN + "page/4/":
            return Resposta(url=url, status=404, corpo=b"nao encontrado", url_final=url)
        if "/produto/" in url:
            return _detalhe_konnen(url)
        return _arquivo(url)

    cliente = ClienteFalso(fn)
    estado = coletar(Konnen(), {"entradas": [KONNEN]}, cliente, marca="KONNEN", fornecedor="konnen")
    assert estado["status"] == "completa"
    assert estado["progresso"]["novos_por_pagina"] == [12, 12, 2, 0]
    assert estado["progresso"]["unicos"] == 26
    assert "http_404" in estado["progresso"]["fim"]
    assert not estado["progresso"]["falhas"]
    assert cliente.chamadas.count(KONNEN + "page/4/") == 1


def test_dedup_entre_entradas_une_fontes():
    card = _card("19675", "lat-pull-axis")
    vazio = _lista("", 0)

    def fn(url: str) -> Resposta:
        if url in {MUS, CARDIO}:
            return Resposta(url=url, status=200, corpo=_lista(card, 1).encode(), url_final=url)
        if url.endswith("?pg=2"):
            return Resposta(url=url, status=200, corpo=vazio.encode(), url_final=url)
        return _detalhe_movement(url)

    cliente = ClienteFalso(fn)
    estado = coletar(
        Movement(), {"entradas": [MUS, CARDIO]}, cliente, marca="MOVEMENT", fornecedor="movement",
    )
    assert estado["status"] == "completa"
    assert len(estado["produtos"]) == 1
    assert set(estado["produtos"][0]["fontes"]) == {MUS, CARDIO}
    assert cliente.chamadas.count("https://www.movement.com.br/produto/lat-pull-axis/") == 1


def test_5xx_no_meio_e_parcial_e_nao_e_fim_e_retry_para_em_3():
    pagina = _lista(_card("1", "um"), 24)
    vazias = {"n": 0}

    def fn(url: str) -> Resposta:
        if url.endswith("?pg=2"):
            vazias["n"] += 1
            return Resposta(url=url, status=500, corpo=b"erro", url_final=url)
        if "/produto/" in url:
            return _detalhe_movement(url)
        return Resposta(url=url, status=200, corpo=pagina.encode(), url_final=url)

    cliente = ClienteFalso(fn)
    estado = coletar(Movement(), {"entradas": [MUS]}, cliente, marca="MOVEMENT", fornecedor="movement")
    assert vazias["n"] == 3
    assert estado["status"] == "parcial"
    assert estado["motivo"] == "http_500"
    assert "pagina_vazia" not in estado["progresso"]["fim"]
    assert len(estado["produtos"]) == 1


def test_429_persistente_bloqueia_o_dominio():
    def fn(url: str) -> Resposta:
        return Resposta(url=url, status=429, corpo=b"calma", url_final=url, headers={"Retry-After": "0"})

    cliente = ClienteFalso(fn)
    estado = coletar(Movement(), {"entradas": [MUS]}, cliente, marca="MOVEMENT", fornecedor="movement",
                     dormir=lambda _s: None)
    assert len(cliente.chamadas) == 3
    assert estado["status"] == "bloqueada"
    assert estado["motivo"] == "429_persistente"
    assert cliente.bloqueados


def test_robots_nao_busca_e_nao_fecha_como_vazio():
    def fn(url: str) -> Resposta:
        return Resposta(url=url, status=0, erro="robots", motivo_bloqueio="robots")

    cliente = ClienteFalso(fn)
    estado = coletar(Movement(), {"entradas": [MUS]}, cliente, marca="MOVEMENT", fornecedor="movement")
    assert estado["status"] == "parcial"
    assert estado["motivo"] == "robots"
    assert estado["produtos"] == []
    assert "pagina_vazia" not in estado["progresso"]["fim"]


def test_403_bloqueia():
    def fn(url: str) -> Resposta:
        return Resposta(url=url, status=403, corpo=b"no", bloqueado=True, motivo_bloqueio="403", erro="403")

    cliente = ClienteFalso(fn)
    estado = coletar(Movement(), {"entradas": [MUS]}, cliente, marca="MOVEMENT", fornecedor="movement")
    assert estado["status"] == "bloqueada"
    assert len(cliente.chamadas) == 1


def test_fim_por_primeiro_item_repetido_e_por_duas_paginas_sem_novo():
    p1 = _lista(_card("1", "um") + _card("2", "dois"), 4)
    repetida = _lista(_card("1", "um") + _card("2", "dois"), 4)

    def fn(url: str) -> Resposta:
        if url.endswith("?pg=2"):
            return Resposta(url=url, status=200, corpo=repetida.encode(), url_final=url)
        if "/produto/" in url:
            return _detalhe_movement(url)
        return Resposta(url=url, status=200, corpo=p1.encode(), url_final=url)

    estado = coletar(Movement(), {"entradas": [MUS]}, ClienteFalso(fn), marca="MOVEMENT", fornecedor="movement")
    assert "primeiro_item_repetido" in estado["progresso"]["fim"]
    assert estado["progresso"]["unicos"] == 2

    ordem = [
        _lista(_card("1", "um") + _card("2", "dois"), 40),
        _lista(_card("2", "dois") + _card("1", "um"), 40),
        _lista(_card("1", "um") + _card("2", "dois"), 40),
    ]
    n = {"i": 0}

    def fn2(url: str) -> Resposta:
        if "/produto/" in url:
            return _detalhe_movement(url)
        corpo = ordem[min(n["i"], 2)]
        n["i"] += 1
        return Resposta(url=url, status=200, corpo=corpo.encode(), url_final=url)

    estado = coletar(Movement(), {"entradas": [CARDIO]}, ClienteFalso(fn2), marca="MOVEMENT", fornecedor="movement")
    assert "sem_item_novo" in estado["progresso"]["fim"]
    assert estado["progresso"]["unicos"] == 2


def test_retomada_nao_repete_o_que_ja_foi_feito(tmp_path):
    a = "https://www.movement.com.br/produto/a/"
    b = "https://www.movement.com.br/produto/b/"
    lista = _lista(_card("10", "a") + _card("11", "b"), 2).replace(
        "/produto/a/", "/produto/a/",
    )
    # o helper usa o slug; troca o segundo card para a URL b
    lista = _lista(_card("10", "a") + _card("11", "b"), 2)
    vazio = _lista("", 0)
    falhas_b = {"n": 0}

    def fn(url: str) -> Resposta:
        if url == MUS + "?pg=2":
            return Resposta(url=url, status=200, corpo=vazio.encode(), url_final=url)
        if url == b:
            falhas_b["n"] += 1
            return Resposta(url=url, status=500, corpo=b"x", url_final=url)
        if url == a:
            return _detalhe_movement(url)
        return Resposta(url=url, status=200, corpo=lista.encode(), url_final=url)

    primeiro = coletar(Movement(), {"entradas": [MUS]}, ClienteFalso(fn), marca="MOVEMENT", fornecedor="movement")
    assert primeiro["status"] == "parcial"
    assert falhas_b["n"] == 3
    assert any(p["url_canonica"].rstrip("/").endswith("/produto/a") for p in primeiro["produtos"])
    salvo = json.loads(json.dumps(primeiro))

    def fn2(url: str) -> Resposta:
        if url in {MUS, MUS + "?pg=2", a}:
            raise AssertionError(f"não deveria rebusar {url}")
        return _detalhe_movement(url)

    cliente = ClienteFalso(fn2)
    segundo = coletar(
        Movement(), {"entradas": [MUS]}, cliente, marca="MOVEMENT", fornecedor="movement", estado=salvo,
    )
    assert segundo["status"] == "completa"
    assert cliente.chamadas == [b]
    assert len(segundo["produtos"]) == 2


def test_teto_de_paginas_quando_o_contador_existe():
    n = {"i": 0}

    def fn(url: str) -> Resposta:
        if "/produto/" in url:
            return _detalhe_movement(url)
        n["i"] += 1
        pid = 1000 + n["i"]
        corpo = _lista(_card(str(pid), f"p{pid}"), 35)
        return Resposta(url=url, status=200, corpo=corpo.encode(), url_final=url)

    estado = coletar(Movement(), {"entradas": [CARDIO]}, ClienteFalso(fn), marca="MOVEMENT", fornecedor="movement")
    assert n["i"] == 4  # ceil(35/12)+1
    assert "teto_paginas" in estado["progresso"]["fim"]


def test_gravar_e_pdf_recusados_sem_supabase(monkeypatch, tmp_path):
    def boom(*_a, **_k):
        raise AssertionError("Supabase não pode ser construído")
    monkeypatch.setattr("coletor.destino.Supabase", boom)
    saida = tmp_path / "x.jsonl"
    rc = main(["--marca", "KONNEN", "--gravar", "--saida", str(saida)])
    assert rc == 2
    assert not saida.exists()
    rc = main(["--marca", "MACSPORT", "--pdf", "--saida", str(saida)])
    assert rc == 2
    assert not saida.exists()


def test_limite_de_requisicoes_marca_parcial():
    def fn(url: str) -> Resposta:
        return Resposta(url=url, status=200, corpo=b"<html></html>", url_final=url)

    estado = coletar(
        Movement(), {"entradas": [MUS]}, ClienteFalso(fn), marca="MOVEMENT", fornecedor="movement",
        limites=Limites(max_requisicoes=0),
    )
    assert estado["status"] == "parcial"
    assert estado["motivo"] == "limite_requisicoes"

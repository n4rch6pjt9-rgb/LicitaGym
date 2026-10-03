"""Aceite dos adaptadores com as páginas capturadas em 02–03/10/2026. Sem rede."""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import requests

from coletor.catalogo.adaptadores.base import Ctx
from coletor.catalogo.adaptadores.generico import Generico
from coletor.catalogo.adaptadores.konnen_wc import Konnen
from coletor.catalogo.adaptadores.macsport_rsc import Macsport, aplicar_detalhe
from coletor.catalogo.adaptadores.movement_wp import Movement
from coletor.catalogo.contrato import validar
from coletor.catalogo.rede import Resposta

FIX = Path(__file__).parent / "fixtures" / "catalogo"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
QUANDO = "2026-10-02T23:17:00-03:00"


@pytest.fixture(autouse=True)
def _sem_rede(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("teste de catálogo não pode usar a rede")
    monkeypatch.setattr(requests.sessions.Session, "request", boom)


def _resp(nome: str, url: str, status: int = 200) -> Resposta:
    return Resposta(url=url, status=status, corpo=(FIX / nome).read_bytes(), url_final=url)


def _ctx(marca: str, fornecedor: str) -> Ctx:
    return Ctx(coletado_em=QUANDO, marca=marca, fornecedor=fornecedor, cfg={})


def test_macsport_payload_227_ids_codigos_e_urls_compartilhadas():
    ctx = _ctx("MACSPORT", "macsport")
    pagina = Macsport().listar(
        _resp("macsport-equipamentos.html", "https://macsport.com.br/equipamentos"),
        "https://macsport.com.br/equipamentos", ctx,
    )
    produtos = [item.produto for item in pagina.itens]
    assert len(produtos) == 227
    for produto in produtos:
        validar(produto)
    ids = [p["id_externo"] for p in produtos]
    assert len(set(ids)) == 227
    assert sum(1 for i in ids if _UUID.match(i)) == 176
    assert sum(1 for i in ids if not _UUID.match(i)) == 51
    codigos = [p["modelos"][0]["codigo_fabricante"] for p in produtos]
    assert len(set(codigos)) == 226
    ms = next(p for p in produtos if p["modelos"][0]["codigo_fabricante"] == "MS-200i")
    assert ms["id_externo_tipo"] == "id_payload"
    assert "MS200" != ms["modelos"][0]["codigo_fabricante"]
    compartilhadas = {p["url_canonica"] for p in produtos if p["url_motivo"] == "url_compartilhada"}
    assert len(compartilhadas) == 4
    assert sum(1 for p in produtos if p["url_motivo"] == "url_compartilhada") == 8
    assert all(p["url_validada"] is False for p in produtos if p["url_motivo"] == "url_compartilhada")
    # A garantia padrão não está no payload; nenhum atributo nasce dela.
    for produto in produtos:
        for atributo in produto["atributos"]:
            texto = f"{atributo.get('rotulo_original')} {atributo.get('valor_original')}".lower()
            assert "5 anos" not in texto


def test_macsport_cr0925_diverge_80_e_100_e_garantia_fica_no_fornecedor():
    ctx = _ctx("MACSPORT", "macsport")
    pagina = Macsport().listar(
        _resp("macsport-equipamentos.html", "https://macsport.com.br/equipamentos"),
        "https://macsport.com.br/equipamentos", ctx,
    )
    cr = next(i.produto for i in pagina.itens if i.produto["modelos"][0]["codigo_fabricante"] == "CR-0925")
    aplicar_detalhe(cr, _resp("macsport-cr-0925.html", cr["url_canonica"]), "macsport_rsc@1", QUANDO)
    validar(cr)
    divergencia = cr["divergencias"][0]
    assert divergencia["chave"] == "carga_maxima_kg"
    assert {divergencia["valor_a"], divergencia["valor_b"]} == {80, 100}
    assert {divergencia["secao_a"], divergencia["secao_b"]} == {"nome", "especificacoes_tecnicas"}
    assert cr["oferta"]["preco"] is None and cr["oferta"]["status_preco"] == "sob_consulta"
    assert cr["oferta"]["cta_texto"] == "ADICIONAR AO ORÇAMENTO"
    assert cr["garantia"][0]["nivel"] == "fornecedor"
    assert "5 anos" in cr["garantia"][0]["texto"]
    assert all("5 anos" not in (a.get("valor_original") or "") for a in cr["atributos"])
    assert cr["url_validada"] is True
    assert not any(a["chave"] == "velocidade_kmh" for a in cr["atributos"])


def test_macsport_ms200i_le_o_codigo_da_pagina():
    ctx = _ctx("MACSPORT", "macsport")
    pagina = Macsport().listar(
        _resp("macsport-equipamentos.html", "https://macsport.com.br/equipamentos"),
        "https://macsport.com.br/equipamentos", ctx,
    )
    ms = next(i.produto for i in pagina.itens if i.produto["id_externo"] == "KYj3WX6rDOBpBhxv4n0O")
    aplicar_detalhe(ms, _resp("macsport-ms-200i.html", ms["url_canonica"]), "macsport_rsc@1", QUANDO)
    validar(ms)
    assert ms["modelos"][0]["codigo_fabricante"] == "MS-200i"
    assert ms["oferta"]["status_preco"] == "sob_consulta"
    assert ms["url_validada"] is True
    assert ms["imagens"] and ms["imagens"][0]["url"].startswith("https://i.ibb.co/")
    assert len(ms["imagens"]) <= 2


def test_movement_lat_pull_e_aria():
    ctx = _ctx("MOVEMENT", "movement")
    mov = Movement()
    lat = mov.detalhar(
        _resp("movement-lat-pull-axis.html", "https://www.movement.com.br/produto/lat-pull-axis/"),
        {"url": "https://www.movement.com.br/produto/lat-pull-axis/", "id_externo": "19675",
         "fontes": ["https://www.movement.com.br/produtos/musculacao/"]},
        ctx,
    )
    validar(lat)
    assert lat["id_externo"] == "19675"
    assert lat["linhas"][0]["nome"] == "AXIS"
    assert lat["modelos"][0]["nome_modelo"] == "AXIS LAT PULL PLA"
    assert len(lat["atributos"]) == 26
    assert len(lat["imagens"]) == 2
    assert "Lat-Pulldown-6.png" in lat["imagens"][0]["url"]
    assert lat["imagens"][0]["url"] != lat["imagens"][1]["url"]
    assert lat["documentos"][0]["nivel"] == "fornecedor" and lat["documentos"][0]["tipo"] == "catalogo"
    assert lat["oferta"]["preco"] is None and lat["oferta"]["status_preco"] == "sob_consulta"
    assert lat["oferta"]["cta_texto"] == "Quero negociar"
    assert [c["nome"] for c in lat["categorias"]] == ["Musculação", "Para Anilhas"]
    assert not any(a["chave"] == "velocidade_kmh" for a in lat["atributos"])

    aria = mov.detalhar(
        _resp("movement-aria-itouch.html", "https://www.movement.com.br/produto/esteira-aria-itouch-3-0/"),
        {"url": "https://www.movement.com.br/produto/esteira-aria-itouch-3-0/", "id_externo": "17555",
         "fontes": ["https://www.movement.com.br/produtos/cardio/"]},
        ctx,
    )
    validar(aria)
    assert len(aria["atributos"]) == 44
    vel = next(a for a in aria["atributos"] if a["chave"] == "velocidade_kmh")
    assert vel["valor"] == {"min": 1.2, "max": 18} and vel["unidade"] == "km/h"
    manuais = [d for d in aria["documentos"] if d["nivel"] == "produto"]
    assert manuais and "MU-ESTEIRA-ARIA" in manuais[0]["url"]
    assert any(d["nivel"] == "fornecedor" for d in aria["documentos"])
    assert aria["divergencias"][0]["chave"] == "motor"
    assert "3.0 HP" in str(aria["divergencias"][0]["valor_a"])
    assert "2 cv" in str(aria["divergencias"][0]["valor_b"])

    bruto = (FIX / "movement-product-19675.json").read_bytes()
    mov.aplicar_json(lat, Resposta(
        url="https://www.movement.com.br/wp-json/wp/v2/product/19675", status=200, corpo=bruto,
        url_final="https://www.movement.com.br/wp-json/wp/v2/product/19675",
    ), ctx)
    validar(lat)
    assert lat["modificado_na_origem"] == "2026-09-17T11:45:02Z"
    assert any(c["id_externo"] == "35" and c["origem"] == "json_alternate" for c in lat["categorias"])


def test_movement_paginas_de_cardio_12_12_11_0():
    ctx = _ctx("MOVEMENT", "movement")
    mov = Movement()
    entrada = "https://www.movement.com.br/produtos/cardio/"
    contagens = []
    declarados = []
    for nome in ("movement-cardio-pg1.html", "movement-cardio-pg2.html",
                 "movement-cardio-pg3.html", "movement-cardio-pg4.html"):
        pagina = mov.listar(_resp(nome, entrada), entrada, ctx)
        contagens.append(len(pagina.itens))
        declarados.append(pagina.declarado)
    assert contagens == [12, 12, 11, 0]
    assert declarados[0] == 35
    assert sum(contagens) == 35


def test_konnen_e12_supino_e_paginas():
    ctx = _ctx("KONNEN", "konnen")
    kn = Konnen()
    entrada = "https://www.konnenfitness.com.br/categoria-produto/cardio/"
    contagens = [len(kn.listar(_resp(nome, entrada), entrada, ctx).itens) for nome in (
        "konnen-cardio-pg1.html", "konnen-cardio-pg2.html", "konnen-cardio-pg3.html", "konnen-cardio-pg4.html",
    )]
    assert contagens == [12, 12, 2, 0]

    e12 = kn.detalhar(
        _resp("konnen-esteira-e12.html", "https://www.konnenfitness.com.br/produto/cardio-esteira-e12/"),
        {"url": "https://www.konnenfitness.com.br/produto/cardio-esteira-e12/",
         "fontes": [entrada]},
        ctx,
    )
    validar(e12)
    assert e12["id_externo"] == "98"
    assert e12["modelos"][0]["codigo_fabricante"] == "E12"
    assert [c["nome"] for c in e12["categorias"]] == ["Cardio", "Profissional"]
    vel = next(a for a in e12["atributos"] if a["chave"] == "velocidade_kmh")
    assert vel["valor"]["max"] == 25
    assert e12["divergencias"][0]["valor_a"]["max"] == 22
    assert e12["divergencias"][0]["valor_b"]["max"] == 25
    assert e12["imagens"][0]["url"].endswith("/E12-Black.png")
    assert "-600x" not in e12["imagens"][0]["url"] and "-1024x" not in e12["imagens"][0]["url"]
    assert len(e12["imagens"]) <= 2
    assert e12["oferta"]["preco"] is None and e12["oferta"]["status_preco"] == "sob_consulta"
    assert e12["oferta"]["cta_texto"] == "Adicionar ao orçamento"

    supino = kn.detalhar(
        _resp("konnen-supino-vertical.html", "https://www.konnenfitness.com.br/produto/exoform-supino-vertical/"),
        {"url": "https://www.konnenfitness.com.br/produto/exoform-supino-vertical/", "fontes": [entrada]},
        ctx,
    )
    validar(supino)
    assert supino["id_externo"] == "220"
    assert supino["modelos"][0]["codigo_fabricante"] == "FE9701"
    carga = next(a for a in supino["atributos"] if a["chave"] == "carga_maxima_kg")
    assert carga["valor"] == 134 and carga["unidade"] == "kg"
    assert supino["declaracao_fabricante"]["valor"] == "Konnen by Impulse"
    assert len(supino["imagens"]) == 2
    assert supino["imagens"][0]["url"].endswith("FE9701.836.png")


def test_generico_reaproveita_extrair_ficha():
    html = """<html><head><meta property="og:title" content="Triceps Press Machine - Total Health"/></head>
<body><h1>Triceps Press Machine</h1><p>Código</p><p>505RRF</p><p>DIMENSÕES</p><p>143 x 116 x 145 cm</p>
<p>PESO</p><p>225 kg</p><p>CARGA</p><p>105 kg</p></body></html>"""
    ctx = Ctx(coletado_em=QUANDO, marca="TOTAL HEALTH", fornecedor="total-health", cfg={
        "produtos": {"padrao_url": "/", "exige_codigo": True},
    })
    produto = Generico().detalhar(
        Resposta(url="https://totalhealth.com.br/triceps-press", status=200, corpo=html.encode(), url_final="https://totalhealth.com.br/triceps-press"),
        {"url": "https://totalhealth.com.br/triceps-press", "fontes": ["https://totalhealth.com.br/sitemap.xml"]},
        ctx,
    )
    validar(produto)
    assert produto["modelos"][0]["codigo_fabricante"] == "505RRF"
    assert produto["id_externo_tipo"] == "url_validada"
    carga = next(a for a in produto["atributos"] if a["chave"] == "carga_maxima_kg")
    assert carga["valor"] == 105

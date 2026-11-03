"""Cliente educado: SSRF, robots, intervalo por host, 403 e desafio. Sem rede real."""
from __future__ import annotations

from pathlib import Path
from urllib import robotparser

import pytest

from coletor.catalogo.contrato import ContratoError, validar
from coletor.catalogo.rede import (
    UA, DestinoRecusado, HttpEducado, eh_pagina_de_desafio, validar_destino,
)
from coletor.catalogos import UA as UA_CATALOGOS

HOSTS = ["macsport.com.br", "a.example", "b.example", "*.previews.dropboxusercontent.com"]


class RelogioFalso:
    def __init__(self):
        self.t = 0.0
        self.sonos: list[float] = []

    def monotonic(self) -> float:
        return self.t

    def sleep(self, segundos: float) -> None:
        self.sonos.append(segundos)
        self.t += segundos


def _resolver_publico(_host: str) -> list[str]:
    return ["1.1.1.1"]


def _cliente(abrir, resolver=None, intervalo=2.0, limites=None, hosts=None):
    return HttpEducado(
        hosts or ["macsport.com.br"], intervalo=intervalo, relogio=RelogioFalso(),
        transporte=type("T", (), {"abrir": staticmethod(abrir)})(),
        resolver=resolver or _resolver_publico, limites=limites,
    )


def test_ua_e_o_mesmo_do_coletor_atual():
    assert UA == UA_CATALOGOS


@pytest.mark.parametrize("url,motivo", [
    ("http://macsport.com.br/equipamentos", "esquema"),
    ("https://macsport.com.br:8443/equipamentos", "porta"),
    ("https://user:senha@macsport.com.br/equipamentos", "credencial_na_url"),
    ("https://127.0.0.1/equipamentos", "ip_literal"),
    ("https://10.0.0.8/", "ip_literal"),
    ("https://evil.example/", "fora_da_allowlist"),
])
def test_destino_recusado_antes_do_dns(url, motivo):
    with pytest.raises(DestinoRecusado) as exc:
        validar_destino(url, ["macsport.com.br"], _resolver_publico)
    assert exc.value.motivo == motivo


@pytest.mark.parametrize("ip", ["10.1.1.1", "192.168.0.5", "172.16.0.1", "127.0.0.1",
                                 "169.254.1.1", "100.64.0.5", "fd00::1", "::1"])
def test_dns_privado_falha_fechado(ip):
    with pytest.raises(DestinoRecusado) as exc:
        validar_destino("https://macsport.com.br/x", ["macsport.com.br"], lambda _h: [ip])
    assert exc.value.motivo == "dns_privado"


def test_dns_falho_falha_fechado():
    def resolver(_h):
        raise OSError("sem dns")
    with pytest.raises(DestinoRecusado) as exc:
        validar_destino("https://macsport.com.br/x", ["macsport.com.br"], resolver)
    assert exc.value.motivo == "dns_falhou"


def test_robots_negando_nao_busca_a_pagina():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nDisallow: /privado\nAllow: /\n"
        return 200, {"Content-Type": "text/html"}, b"<html>ok</html>"

    c = _cliente(abrir)
    negado = c.get("https://macsport.com.br/privado")
    assert negado.erro == "robots"
    assert not any(u.endswith("/privado") for u in chamadas)
    livre = c.get("https://macsport.com.br/equipamentos")
    assert livre.status == 200
    assert any(u.endswith("/equipamentos") for u in chamadas)


def test_robots_com_redirect_vale_e_5xx_nao_libera():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 302, {"Location": "https://macsport.com.br/regras.txt"}, b""
        if url.endswith("/regras.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nDisallow: /secreto\nAllow: /\n"
        return 200, {"Content-Type": "text/html"}, b"pagina"

    c = _cliente(abrir)
    assert c.get("https://macsport.com.br/secreto").erro == "robots"
    assert not any(u.endswith("/secreto") for u in chamadas)
    assert any(u.endswith("/regras.txt") for u in chamadas)

    chamadas.clear()

    def abrir_erro(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 503, {"Content-Type": "text/plain"}, b"down"
        return 200, {"Content-Type": "text/html"}, b"pagina"

    c2 = _cliente(abrir_erro)
    assert c2.get("https://macsport.com.br/equipamentos").erro == "robots"
    assert not any(u.endswith("/equipamentos") for u in chamadas)


def test_intervalo_por_host_com_relogio_falso():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        return 200, {"Content-Type": "text/html"}, b"ok"

    relogio = RelogioFalso()
    c = HttpEducado(
        ["a.example", "b.example"], intervalo=2.0, relogio=relogio,
        transporte=type("T", (), {"abrir": staticmethod(abrir)})(), resolver=_resolver_publico,
    )
    parser = robotparser.RobotFileParser()
    parser.parse(["User-agent: *", "Allow: /"])
    c._robots["https://a.example"] = parser
    c._robots["https://b.example"] = parser
    c.get("https://a.example/1")
    c.get("https://b.example/1")
    c.get("https://a.example/2")
    assert relogio.sonos == [2.0]
    assert all(pausa >= 2.0 for pausa in relogio.sonos)


def test_403_e_desafio_bloqueiam_o_dominio_sem_contornar():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nAllow: /\n"
        if url.endswith("/bloqueio"):
            return 403, {"Content-Type": "text/html"}, b"forbidden"
        return 200, {"Content-Type": "text/html"}, b"<html><title>Just a moment...</title></html>"

    c = _cliente(abrir)
    primeiro = c.get("https://macsport.com.br/bloqueio")
    assert primeiro.bloqueado and primeiro.motivo_bloqueio == "403"
    segundo = c.get("https://macsport.com.br/outra")
    assert segundo.bloqueado
    assert not any(u.endswith("/outra") for u in chamadas)

    c2 = _cliente(abrir)
    desafio = c2.get("https://macsport.com.br/ficha")
    assert desafio.motivo_bloqueio == "desafio"


def test_redirect_revalida_cada_salto():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nAllow: /\n"
        if url.endswith("/vai-http"):
            return 302, {"Location": "http://macsport.com.br/x"}, b""
        if url.endswith("/vai-outro"):
            return 302, {"Location": "https://evil.example/x"}, b""
        if url.endswith("/vai-ip"):
            return 302, {"Location": "https://10.0.0.1/x"}, b""
        if url.endswith("/vai-ok"):
            return 302, {"Location": "https://macsport.com.br/ok"}, b""
        return 200, {"Content-Type": "text/html"}, b"chegou"

    c = _cliente(abrir)
    assert c.get("https://macsport.com.br/vai-http").erro == "esquema"
    assert c.get("https://macsport.com.br/vai-outro").erro == "fora_da_allowlist"
    assert c.get("https://macsport.com.br/vai-ip").erro == "ip_literal"
    ok = c.get("https://macsport.com.br/vai-ok")
    assert ok.status == 200 and ok.corpo == b"chegou"
    assert not any(u.startswith("http://") for u in chamadas)
    assert not any("evil.example" in u or "10.0.0.1" in u for u in chamadas)


def test_limite_de_bytes_nao_entrega_corpo_cortado():
    def abrir(url, max_bytes):
        if url.endswith("/robots.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nAllow: /\n"
        return 200, {"Content-Type": "text/html"}, b"x" * 50

    c = _cliente(abrir, limites={"html": 10, "json": 10, "js": 10})
    resp = c.get("https://macsport.com.br/grande")
    assert resp.erro == "limite_bytes"
    assert resp.corpo == b""


def test_wildcard_de_imagem_na_allowlist_nao_abre_host_alheio():
    chamadas = []

    def abrir(url, max_bytes):
        chamadas.append(url)
        if url.endswith("/robots.txt"):
            return 200, {"Content-Type": "text/plain"}, b"User-agent: *\nAllow: /\n"
        return 200, {"Content-Type": "text/html"}, b"ok"

    c = _cliente(abrir, hosts=["*.previews.dropboxusercontent.com"])
    ok = c.get("https://abc.previews.dropboxusercontent.com/foto")
    assert ok.status == 200
    ruim = c.get("https://previews.dropboxusercontent.com/foto")
    assert ruim.erro == "fora_da_allowlist"


def test_pagina_real_nao_e_desafio_e_intersticial_e():
    lat = (Path(__file__).parent / "fixtures" / "catalogo" / "movement-lat-pull-axis.html").read_text(encoding="utf-8")
    assert eh_pagina_de_desafio(200, lat) is False
    longa = "<h1>ESTEIRA</h1>" + ("product " * 50) + "cloudflare-turnstile-js " + ("x" * 25000)
    assert eh_pagina_de_desafio(200, longa) is False
    assert eh_pagina_de_desafio(200, "<html><title>Just a moment...</title></html>") is True
    assert eh_pagina_de_desafio(403, "<html>ok</html>") is True


def test_validar_recusa_valor_sem_evidencia():
    produto = {
        "contrato": "ProdutoColetado/1", "fornecedor": "x", "fontes": ["https://x"],
        "id_externo_tipo": "wp_post_id", "id_externo": "1", "url_canonica": "https://x/p",
        "url_validada": True, "url_motivo": None, "nome": {"valor": "A"},
        "marca_declarada": None, "declaracao_fabricante": None, "categorias": [], "linhas": [],
        "modelos": [], "familia": "outro", "familia_metodo": None, "atributos": [], "textos": [],
        "imagens": [], "documentos": [], "oferta": {"preco": None, "moeda": None, "status_preco": "ausente",
                                                     "cta_texto": None, "ev": "e1"},
        "garantia": [], "modificado_na_origem": None,
        "evidencias": {"e1": {"url": "https://x/p", "secao": "oferta", "seletor": "x", "trecho": "x",
                              "coletado_em": "2026-10-02T23:17:00-03:00", "http_status": 200,
                              "corpo_sha256": "a" * 64, "parser": "t@1"}},
        "divergencias": [],
    }
    with pytest.raises(ContratoError):
        validar(produto)

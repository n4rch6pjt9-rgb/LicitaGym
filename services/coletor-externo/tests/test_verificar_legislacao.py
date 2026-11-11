"""Spec 0044, K-5: verificador trimestral do corpus de legislação (sem rede: o download é injetado)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
import requests

from coletor import verificar_legislacao as vl

URL_LEI = "https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm"
URL_DECRETO = "https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/decreto/d12807.htm"

# Trecho no formato do Planalto: Windows-1252, entidades HTML, espaços e quebras irregulares.
HTML_LEI = (
    "<html><head><meta http-equiv=Content-Type content='text/html; charset=windows-1252'>"
    "<style>p{}</style><script>var x = 1;</script></head><body>"
    "<p>Art.&nbsp;41.&nbsp;No caso de licita\xe7\xe3o que envolva o fornecimento de bens, a Administra\xe7\xe3o "
    "poder\xe1 excepcionalmente:</p>\r\n<p>I - indicar uma ou mais marcas ou modelos,\n   desde que "
    "formalmente justificado;</p>"
    "<p>Art. 42. A prova de qualidade de produto apresentado pelos proponentes como similar \xe0s das marcas "
    "eventualmente indicadas no edital ser\xe1 admitida.</p>"
    "</body></html>"
).encode("cp1252")


def _hash(html: bytes) -> str:
    return hashlib.sha256(vl.normalizar_html(html).encode("utf-8")).hexdigest()


def _corpus(sha_lei: str | None) -> list[dict]:
    return [{"norma": "LEI_14133_2021", "titulo": "Lei nº 14.133/2021", "url_oficial": URL_LEI,
             "sha256_texto_normalizado": sha_lei, "conferido_em": None,
             "vigencia_inicio": None, "revogada_em": None}]


class Baixador:
    def __init__(self, respostas: dict[str, bytes | Exception]):
        self.respostas = respostas
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        r = self.respostas[url]
        if isinstance(r, Exception):
            raise r
        return r


class SupabaseFalso:
    """Registra toda chamada; só selecionar devolve dado."""

    def __init__(self, linhas: list[dict] | Exception):
        self.linhas = linhas
        self.chamadas: list[str] = []
        self.filtros: dict[str, str] = {}

    def selecionar(self, tabela: str, **filtros: str) -> list[dict]:
        self.chamadas.append(f"selecionar:{tabela}")
        self.filtros = filtros
        if isinstance(self.linhas, Exception):
            raise self.linhas
        return list(self.linhas)

    def __getattr__(self, nome: str):
        def proibido(*_a, **_k):
            self.chamadas.append(nome)
            raise AssertionError(f"verificador chamou {nome}: só select é permitido")
        return proibido


def test_normalizar_html_decodifica_cp1252_tira_tags_e_colapsa_espacos():
    texto = vl.normalizar_html(HTML_LEI)
    assert "Art. 41. No caso de licitação" in texto
    assert "I - indicar uma ou mais marcas ou modelos, desde que formalmente justificado;" in texto
    assert "var x" not in texto and "p{}" not in texto and "<" not in texto


def test_ca6_texto_diferente_marca_mudou_com_norma_url_e_saida_diferente_de_zero():
    outro = HTML_LEI.replace(b"excepcionalmente", b"em regra")
    rel = vl.verificar(_corpus(_hash(HTML_LEI)), [], Baixador({URL_LEI: outro}))
    [n] = rel.normas
    assert (n.norma, n.url, n.status) == ("LEI_14133_2021", URL_LEI, "mudou")
    assert n.sha256_atual == _hash(outro)
    assert rel.codigo_saida() != 0


def test_ca6_mesmo_texto_marca_igual_e_sai_com_zero():
    # Mudança só de marcação/espaço não conta como mudança de texto.
    mesmo = HTML_LEI.replace(b"<p>", b"<p class='x'>  ").replace(b"\r\n", b"\n\n")
    rel = vl.verificar(_corpus(_hash(HTML_LEI)), [], Baixador({URL_LEI: mesmo}))
    assert [n.status for n in rel.normas] == ["igual"]
    assert rel.codigo_saida() == 0


def test_norma_sem_hash_de_referencia_nao_e_igual_nem_mudou():
    rel = vl.verificar(_corpus(None), [], Baixador({URL_LEI: HTML_LEI}))
    [n] = rel.normas
    assert n.status == "sem_referencia"
    assert n.sha256_atual == _hash(HTML_LEI)
    assert rel.codigo_saida() != 0


def test_ca7_artigo_conferido_que_nao_e_mais_substring_sai_divergente_e_so_ha_select():
    dispositivos = [
        {"norma": "LEI_14133_2021", "artigo": 41, "fonte_url": URL_LEI,
         "texto": "Art. 41. No caso de licitação que envolva o fornecimento de bens, a Administração poderá "
                  "excepcionalmente:\n\nI - indicar uma ou mais marcas ou modelos, desde que formalmente justificado;"},
        {"norma": "LEI_14133_2021", "artigo": 42, "fonte_url": URL_LEI,
         "texto": "Art. 42. A prova de qualidade de produto apresentado pelos proponentes como similar às das marcas "
                  "eventualmente indicadas no edital será sempre admitida."},  # "sempre": não está no oficial
    ]
    sb = SupabaseFalso(dispositivos)
    baixar = Baixador({URL_LEI: HTML_LEI})
    rel = vl.verificar(_corpus(_hash(HTML_LEI)), vl.ler_dispositivos(sb), baixar)
    status = {(a.norma, a.artigo): a.status for a in rel.artigos}
    assert status == {("LEI_14133_2021", 41): "confere", ("LEI_14133_2021", 42): "divergente"}
    assert rel.codigo_saida() != 0
    assert sb.chamadas == ["selecionar:norma_dispositivos"]
    # só os conferidos: sem o filtro, os não conferidos voltariam como "divergente" todo trimestre
    assert sb.filtros == {"select": "norma,artigo,texto,fonte_url", "conferido_oficial": "eq.true"}
    assert baixar.urls == [URL_LEI]  # a mesma página é baixada uma vez só


@pytest.mark.parametrize("erro", [
    requests.ConnectionError("Connection reset by peer"),
    requests.Timeout("timeout"),
    vl.ErroDownload("HTTP 403"),
    vl.ErroDownload("HTTP 503"),
])
def test_ca8_erro_de_rede_ou_http_vira_nao_verificado_nunca_igual_nem_mudou(erro):
    dispositivos = [{"norma": "LEI_14133_2021", "artigo": 41, "fonte_url": URL_LEI, "texto": "Art. 41."}]
    rel = vl.verificar(_corpus(_hash(HTML_LEI)), dispositivos, Baixador({URL_LEI: erro}))
    assert [n.status for n in rel.normas] == ["nao_verificado"]
    assert [a.status for a in rel.artigos] == ["nao_verificado"]
    assert rel.codigo_saida() == vl.SAIDA_FALHA_PARCIAL


def test_ca8_uma_norma_falha_e_a_outra_e_verificada():
    corpus = _corpus(_hash(HTML_LEI)) + [{"norma": "DECRETO_12807_2025", "titulo": "Decreto nº 12.807/2025",
                                          "url_oficial": URL_DECRETO, "sha256_texto_normalizado": "x",
                                          "conferido_em": None, "vigencia_inicio": None, "revogada_em": None}]
    rel = vl.verificar(corpus, [], Baixador({URL_LEI: HTML_LEI, URL_DECRETO: requests.ConnectionError("reset")}))
    assert {n.norma: n.status for n in rel.normas} == {"LEI_14133_2021": "igual", "DECRETO_12807_2025": "nao_verificado"}
    assert rel.codigo_saida() == vl.SAIDA_FALHA_PARCIAL


def test_corpus_versionado_tem_os_campos_da_k4_e_nao_inventa_hash():
    corpus = json.loads(Path(vl.CORPUS_PADRAO).read_text(encoding="utf-8"))
    assert corpus, "corpus vazio"
    normas = {c["norma"] for c in corpus}
    assert "LEI_14133_2021" in normas
    for c in corpus:
        assert set(c) >= {"norma", "titulo", "url_oficial", "vigencia_inicio", "revogada_em",
                          "sha256_texto_normalizado", "conferido_em"}
        assert c["url_oficial"].startswith("https://")
        # hash e data de conferência andam juntos: sem conferência, os dois ficam nulos (nunca hash inventado)
        assert (c["sha256_texto_normalizado"] is None) == (c["conferido_em"] is None)


class Resp:
    def __init__(self, status: int, conteudo: bytes = b"<p>ok</p>", headers: dict | None = None):
        self.status_code, self.content, self.headers = status, conteudo, headers or {}

    def iter_content(self, chunk_size: int):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]


class SessaoFalsa:
    def __init__(self, respostas: list):
        self.respostas = list(respostas)
        self.chamadas = 0

    def get(self, url, timeout, headers, stream=False):
        assert timeout == vl.TIMEOUT_S and stream
        self.chamadas += 1
        r = self.respostas.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def test_baixar_http_transitorio_depois_sucesso_sem_sleep_real():
    esperas: list[float] = []
    s = SessaoFalsa([Resp(503), requests.ConnectionError("reset"), Resp(200, b"<p>lei</p>")])
    assert vl.baixar_http("https://x", s, esperas.append) == b"<p>lei</p>"
    assert s.chamadas == 3 and len(esperas) == 2


def test_baixar_http_429_respeita_retry_after():
    esperas: list[float] = []
    s = SessaoFalsa([Resp(429, headers={"Retry-After": "7"}), Resp(200)])
    vl.baixar_http("https://x", s, esperas.append)
    assert esperas == [7.0]


def test_baixar_http_403_nao_repete_e_falha():
    s = SessaoFalsa([Resp(403)])
    with pytest.raises(vl.ErroDownload, match="HTTP 403"):
        vl.baixar_http("https://x", s, lambda _s: None)
    assert s.chamadas == 1


def test_baixar_http_falha_ate_o_limite_e_200_vazio_nao_e_sucesso():
    s = SessaoFalsa([requests.Timeout("t")] * vl.TENTATIVAS)
    with pytest.raises(requests.Timeout):
        vl.baixar_http("https://x", s, lambda _s: None)
    assert s.chamadas == vl.TENTATIVAS
    with pytest.raises(vl.ErroDownload):
        vl.baixar_http("https://x", SessaoFalsa([Resp(200, b"")] * vl.TENTATIVAS), lambda _s: None)


def test_resposta_acima_do_teto_e_erro_nao_texto_truncado(monkeypatch):
    monkeypatch.setattr(vl, "MAX_BYTES", 10)
    with pytest.raises(vl.ErroDownload, match="maior que"):
        vl.baixar_http("https://x", SessaoFalsa([Resp(200, b"<p>" + b"a" * 100 + b"</p>")]), lambda _s: None)


def test_html_utf8_declarado_e_decodificado_como_utf8():
    pagina = ("<html><head><meta charset=\"utf-8\"></head><body><p>Instrução Normativa nº 65</p>"
              "</body></html>").encode("utf-8")
    assert "Instrução Normativa nº 65" in vl.normalizar_html(pagina)


def test_tag_sem_fechamento_nao_trava_e_some_do_texto():
    texto = vl.normalizar_html(("<p>Art. 1. " + "<a" * 20000 + " fim</p>").encode("cp1252"))
    assert texto.startswith("Art. 1.")


@pytest.mark.parametrize("url", ["http://www.planalto.gov.br/x.htm", "https://www.legjur.com/x",
                                 "https://169.254.169.254/computeMetadata/v1/", "https://gov.br.exemplo.com/x"])
def test_url_fora_dos_dominios_oficiais_nao_e_baixada(url):
    baixar = Baixador({})
    rel = vl.verificar([], [{"norma": "LEI_14133_2021", "artigo": 41, "fonte_url": url, "texto": "Art. 41."}], baixar)
    assert [a.status for a in rel.artigos] == ["nao_verificado"]
    assert baixar.urls == []


@pytest.mark.parametrize("falha", [requests.HTTPError("401 Unauthorized"), RuntimeError("Supabase: página repetida")])
def test_falha_ao_ler_o_banco_e_erro_de_execucao_nunca_mudou(falha, tmp_path):
    corpus = tmp_path / "corpus.json"
    corpus.write_text(json.dumps(_corpus(None)), encoding="utf-8")
    baixar = Baixador({})
    assert vl.executar(str(corpus), SupabaseFalso(falha), baixar) == vl.SAIDA_ERRO
    assert baixar.urls == []


def test_corpus_ilegivel_e_erro_de_execucao(tmp_path):
    ruim = tmp_path / "corpus.json"
    ruim.write_text("{nao e json", encoding="utf-8")
    assert vl.executar(str(ruim), SupabaseFalso([]), Baixador({})) == vl.SAIDA_ERRO
    assert vl.executar(str(tmp_path / "nao-existe.json"), SupabaseFalso([]), Baixador({})) == vl.SAIDA_ERRO

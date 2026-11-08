"""Verificador trimestral do corpus de legislação (spec 0042, K-5).

Para cada norma de `data/legislacao_corpus.json`, baixa o texto oficial, normaliza e compara o sha256 com o da última
conferência. Para os artigos de `public.norma_dispositivos` com `conferido_oficial = true`, confere se o texto gravado
ainda é trecho literal do texto oficial (mesma regra da migration 20261011100500: HTML do Planalto em Windows-1252,
comparação depois de colapsar espaços).

Só lê: o banco recebe um único `select` em `norma_dispositivos`; nada é gravado. O relatório vai para o log
(stdout) e o código de saída avisa o Cloud Run (decisão P-8 da spec: sem issue automática):
  0 tudo igual e conferido · 1 norma mudou ou artigo divergente · 2 falha parcial (não verificado ou sem referência).

Uso (Cloud Run Job, agendado pelo Cloud Scheduler no dia 1 de jan/abr/jul/out):
  python -m coletor.verificar_legislacao [--corpus caminho.json]
  SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY vêm do ambiente, como nos outros coletores.
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_mod
import json
import logging
import os
import random
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import requests

log = logging.getLogger(__name__)

CORPUS_PADRAO = Path(__file__).parent / "data" / "legislacao_corpus.json"
SAIDA_OK = 0
SAIDA_MUDOU = 1
SAIDA_FALHA_PARCIAL = 2

TIMEOUT_S = 30
TENTATIVAS = 3
USER_AGENT = "licitagym-verificador-legislacao/1.0"
TRANSITORIOS = {429, 500, 502, 503, 504}

_RE_SCRIPT_STYLE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_RE_TAG = re.compile(r"<[^>]+>")
_RE_ESPACOS = re.compile(r"\s+")
_RE_CHARSET = re.compile(rb"charset\s*=\s*[\"']?([A-Za-z0-9_-]+)", re.IGNORECASE)


class ErroDownload(Exception):
    """HTTP que não é 2xx depois das tentativas, ou resposta inutilizável."""


def _decodificar(conteudo: bytes) -> str:
    # O Planalto serve Windows-1252; o gov.br, UTF-8. Vale o charset declarado no HTML; sem ele, Windows-1252.
    m = _RE_CHARSET.search(conteudo[:4096])
    charset = m.group(1).decode("ascii").lower() if m else "cp1252"
    if charset in ("windows-1252", "iso-8859-1", "latin-1", "latin1"):
        charset = "cp1252"
    try:
        return conteudo.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return conteudo.decode("cp1252", errors="replace")


def colapsar(texto: str) -> str:
    return _RE_ESPACOS.sub(" ", texto).strip()


def normalizar_html(conteudo: bytes) -> str:
    """Texto visível do HTML: sem script/style, sem tags, entidades resolvidas e espaços colapsados."""
    texto = _RE_SCRIPT_STYLE.sub(" ", _decodificar(conteudo))
    texto = _RE_TAG.sub(" ", texto)
    return colapsar(html_mod.unescape(texto))


def sha256_texto(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def baixar_http(url: str, sessao: requests.Session | None = None, espera: Callable[[float], None] = time.sleep) -> bytes:
    """GET com timeout, retry limitado (backoff exponencial + jitter) e Retry-After em 429."""
    s = sessao or requests.Session()
    ultimo: Exception | None = None
    for tentativa in range(TENTATIVAS):
        try:
            r = s.get(url, timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
        except (requests.ConnectionError, requests.Timeout) as e:
            ultimo = e
        else:
            if 200 <= r.status_code < 300 and r.content:
                return r.content
            if r.status_code not in TRANSITORIOS:
                raise ErroDownload(f"HTTP {r.status_code} em {url}")
            ultimo = ErroDownload(f"HTTP {r.status_code} em {url}")
            if r.status_code == 429 and r.headers.get("Retry-After", "").isdigit():
                if tentativa < TENTATIVAS - 1:
                    espera(min(120.0, float(r.headers["Retry-After"])))
                continue
        if tentativa < TENTATIVAS - 1:
            espera(min(60.0, 2.0 * 2 ** tentativa) + random.uniform(0, 1))
    raise ultimo if ultimo else ErroDownload(f"sem resposta de {url}")


@dataclass
class ResultadoNorma:
    norma: str
    url: str
    status: str  # igual | mudou | sem_referencia | nao_verificado
    sha256_atual: str | None = None
    erro: str | None = None


@dataclass
class ResultadoArtigo:
    norma: str
    artigo: int
    url: str
    status: str  # confere | divergente | nao_verificado
    erro: str | None = None


@dataclass
class Relatorio:
    normas: list[ResultadoNorma] = field(default_factory=list)
    artigos: list[ResultadoArtigo] = field(default_factory=list)

    def codigo_saida(self) -> int:
        if any(n.status == "mudou" for n in self.normas) or any(a.status == "divergente" for a in self.artigos):
            return SAIDA_MUDOU
        if any(n.status in ("nao_verificado", "sem_referencia") for n in self.normas) or any(
            a.status == "nao_verificado" for a in self.artigos
        ):
            return SAIDA_FALHA_PARCIAL
        return SAIDA_OK


def ler_dispositivos(sb) -> list[dict]:
    """Único acesso ao banco: os artigos conferidos com o texto oficial."""
    return sb.selecionar(
        "norma_dispositivos",
        select="norma,artigo,texto,fonte_url",
        conferido_oficial="eq.true",
    )


def verificar(corpus: list[dict], dispositivos: list[dict], baixar: Callable[[str], bytes]) -> Relatorio:
    rel = Relatorio()
    textos: dict[str, str | Exception] = {}

    def texto_oficial(url: str) -> str | Exception:
        if url not in textos:
            try:
                textos[url] = normalizar_html(baixar(url))
            except (requests.RequestException, ErroDownload) as e:
                log.warning("legislacao: não verificado %s (%s)", url, e)
                textos[url] = e
        return textos[url]

    for c in corpus:
        url = c["url_oficial"]
        t = texto_oficial(url)
        if isinstance(t, Exception):
            rel.normas.append(ResultadoNorma(c["norma"], url, "nao_verificado", erro=str(t)))
            continue
        atual = sha256_texto(t)
        referencia = c.get("sha256_texto_normalizado")
        if referencia is None:
            status = "sem_referencia"
        else:
            status = "igual" if atual == referencia else "mudou"
        rel.normas.append(ResultadoNorma(c["norma"], url, status, sha256_atual=atual))

    for d in dispositivos:
        url = d.get("fonte_url") or ""
        t = texto_oficial(url) if url else ErroDownload("dispositivo sem fonte_url")
        if isinstance(t, Exception):
            rel.artigos.append(ResultadoArtigo(d["norma"], int(d["artigo"]), url, "nao_verificado", erro=str(t)))
            continue
        trecho = colapsar(d.get("texto") or "")
        status = "confere" if trecho and trecho in t else "divergente"
        rel.artigos.append(ResultadoArtigo(d["norma"], int(d["artigo"]), url, status))
    return rel


def _imprimir(rel: Relatorio) -> None:
    for n in rel.normas:
        print(json.dumps({"tipo": "norma", **n.__dict__}, ensure_ascii=False))
    for a in rel.artigos:
        if a.status != "confere":
            print(json.dumps({"tipo": "artigo", **a.__dict__}, ensure_ascii=False))
    resumo = {
        "tipo": "resumo",
        "normas": {s: sum(1 for n in rel.normas if n.status == s) for s in ("igual", "mudou", "sem_referencia", "nao_verificado")},
        "artigos": {s: sum(1 for a in rel.artigos if a.status == s) for s in ("confere", "divergente", "nao_verificado")},
        "codigo_saida": rel.codigo_saida(),
    }
    print(json.dumps(resumo, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    from coletor.destino import Supabase

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--corpus", default=str(CORPUS_PADRAO))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    url, chave = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not chave:
        log.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias")
        return SAIDA_FALHA_PARCIAL
    corpus = json.loads(Path(args.corpus).read_text(encoding="utf-8"))
    sessao = requests.Session()
    rel = verificar(corpus, ler_dispositivos(Supabase(url, chave, drenar_catmat=False)),
                    lambda u: baixar_http(u, sessao))
    _imprimir(rel)
    return rel.codigo_saida()


if __name__ == "__main__":
    sys.exit(main())

"""Verificador trimestral do corpus de legislação (spec 0044, K-5).

Para cada norma de `data/legislacao_corpus.json`, baixa o texto oficial, normaliza e compara o sha256 com o da última
conferência. Para os artigos de `public.norma_dispositivos` com `conferido_oficial = true`, confere se o texto gravado
ainda é trecho literal do texto oficial (mesma regra da migration 20261011100500: HTML do Planalto em Windows-1252,
comparação depois de colapsar espaços).

Só lê: o banco recebe um único `select` em `norma_dispositivos`; nada é gravado. O relatório vai para o log
(stdout) e o código de saída avisa o Cloud Run (decisão P-8 da spec: sem issue automática):
  0 tudo igual e conferido · 1 norma mudou ou artigo divergente · 2 falha parcial (não verificado ou sem referência)
  · 3 erro de execução (corpus ilegível ou banco inacessível: nada foi verificado).

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
from urllib.parse import urlsplit

import requests

log = logging.getLogger(__name__)

CORPUS_PADRAO = Path(__file__).parent / "data" / "legislacao_corpus.json"
SAIDA_OK = 0
SAIDA_MUDOU = 1
SAIDA_FALHA_PARCIAL = 2
SAIDA_ERRO = 3

TIMEOUT_S = 30
TENTATIVAS = 3
USER_AGENT = "licitagym-verificador-legislacao/1.0"
TRANSITORIOS = {429, 500, 502, 503, 504}
MAX_BYTES = 20 * 1024 * 1024  # a 14.133 no Planalto tem ~1,5 MB; acima disso a resposta não é a norma
PRAZO_TOTAL_S = 120  # por download, somando as leituras (o timeout do requests vale por leitura)

# Tags sem "<" nem ">" internos: linear mesmo com HTML quebrado (o corpo também é limitado a MAX_BYTES).
_RE_SCRIPT_STYLE = re.compile(r"<(script|style)\b[^<>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
_RE_TAG = re.compile(r"<[^<>]*>")
_RE_ESPACOS = re.compile(r"\s+")
_RE_CHARSET = re.compile(rb"charset\s*=\s*[\"']?([A-Za-z0-9_-]+)", re.IGNORECASE)


class ErroDownload(Exception):
    """HTTP que não é 2xx depois das tentativas, ou resposta inutilizável."""


def _decodificar(conteudo: bytes) -> str:
    # O Planalto serve Windows-1252; o gov.br, UTF-8. Vale o charset declarado no HTML; sem ele, Windows-1252.
    m = _RE_CHARSET.search(conteudo[:65536])
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


def url_permitida(url: str) -> bool:
    """Só https em domínio oficial (gov.br e subdomínios, como planalto.gov.br). A URL dos artigos vem do banco."""
    partes = urlsplit(url)
    host = (partes.hostname or "").lower()
    return partes.scheme == "https" and (host == "gov.br" or host.endswith(".gov.br"))


def sha256_texto(texto: str) -> str:
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


def baixar_http(url: str, sessao: requests.Session | None = None, espera: Callable[[float], None] = time.sleep) -> bytes:
    """GET com timeout, retry limitado (backoff exponencial + jitter) e Retry-After em 429."""
    s = sessao or requests.Session()
    ultimo: Exception | None = None
    for tentativa in range(TENTATIVAS):
        try:
            r = s.get(url, timeout=TIMEOUT_S, headers={"User-Agent": USER_AGENT, "Accept": "text/html"}, stream=True)
            corpo = _ler_limitado(r) if 200 <= r.status_code < 300 else b""
        except (requests.ConnectionError, requests.Timeout) as e:
            ultimo = e
        else:
            if 200 <= r.status_code < 300 and corpo:
                return corpo
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


def _ler_limitado(r) -> bytes:
    """Lê o corpo com teto de tamanho e prazo total; acima disso é erro, não texto truncado."""
    inicio = time.monotonic()
    partes: list[bytes] = []
    total = 0
    for pedaco in r.iter_content(chunk_size=65536):
        total += len(pedaco)
        if total > MAX_BYTES:
            raise ErroDownload(f"resposta maior que {MAX_BYTES} bytes")
        if time.monotonic() - inicio > PRAZO_TOTAL_S:
            raise ErroDownload(f"download passou de {PRAZO_TOTAL_S} s")
        partes.append(pedaco)
    return b"".join(partes)


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
            if not url_permitida(url):
                textos[url] = ErroDownload(f"URL fora dos domínios oficiais (https://*.gov.br): {url!r}")
                return textos[url]
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

    if not dispositivos:
        log.warning("legislacao: nenhum artigo com conferido_oficial = true veio do banco; nada a conferir")
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
        return SAIDA_ERRO
    return executar(args.corpus, Supabase(url, chave, drenar_catmat=False))


def executar(caminho_corpus: str, sb, baixar: Callable[[str], bytes] | None = None) -> int:
    """Lê corpus e banco; falha nessa leitura é erro de execução (3), nunca "mudou" (1)."""
    try:
        corpus = json.loads(Path(caminho_corpus).read_text(encoding="utf-8"))
        dispositivos = ler_dispositivos(sb)
    except (OSError, ValueError, RuntimeError, requests.RequestException) as e:
        # Só o tipo e a mensagem da exceção (o cliente não põe a chave nelas); nada foi verificado.
        log.error("legislacao: erro de execução, nada verificado: %s: %s", type(e).__name__, str(e)[:300])
        return SAIDA_ERRO
    sessao = requests.Session()
    rel = verificar(corpus, dispositivos, baixar or (lambda u: baixar_http(u, sessao)))
    _imprimir(rel)
    return rel.codigo_saida()


if __name__ == "__main__":
    sys.exit(main())

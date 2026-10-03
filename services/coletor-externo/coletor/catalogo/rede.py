"""HTTP educado: robots, intervalo por host, allowlist, SSRF e parada em 403/desafio.

Não contorna desafio. Não segue redirect sozinho: cada Location passa de novo pela validação.
"""
from __future__ import annotations

import ipaddress
import socket
import time
from dataclasses import dataclass, field
from urllib import robotparser
from urllib.parse import urljoin, urlsplit

import requests

# O mesmo UA de coletor.catalogos.Coletor. Conferido por teste.
UA = "LicitaGymBot/0.1 (catalogo de fabricantes; contato via site LicitaGym)"

_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_ULA = ipaddress.ip_network("fc00::/7")
_REDIRECTS = {301, 302, 303, 307, 308}
_LIMITE_BYTES = {"html": 2_000_000, "json": 1_500_000, "js": 600_000}
_INTERSTICIAL = (
    "just a moment...",
    "cf-browser-verification",
    "cf-challenge-running",
    "attention required! | cloudflare",
    "enable javascript and cookies to continue",
    "/cdn-cgi/challenge-platform/h/",
)


class DestinoRecusado(Exception):
    def __init__(self, motivo: str):
        self.motivo = motivo
        super().__init__(motivo)


@dataclass
class Resposta:
    url: str
    status: int = 0
    corpo: bytes = b""
    headers: dict = field(default_factory=dict)
    erro: str | None = None
    bloqueado: bool = False
    motivo_bloqueio: str | None = None
    url_final: str | None = None

    @property
    def status_code(self) -> int:
        return self.status

    @property
    def texto(self) -> str:
        return (self.corpo or b"").decode("utf-8", errors="replace")


class Relogio:
    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, segundos: float) -> None:
        time.sleep(segundos)


def host_na_allowlist(host: str, lista: list[str]) -> bool:
    host = (host or "").lower().rstrip(".")
    for item in lista:
        item = item.lower().rstrip(".")
        if item.startswith("*."):
            sufixo = item[1:]
            if host.endswith(sufixo) and host != item[2:]:
                return True
        elif host == item:
            return True
    return False


def _ip_recusado(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return _ip_recusado(ip.ipv4_mapped)
    if ip in _CGNAT or ip in _ULA:
        return True
    return bool(
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
    )


def resolver_sistema(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    saida: list[str] = []
    for info in infos:
        ip = info[4][0]
        if ip not in saida:
            saida.append(ip)
    return saida


def validar_destino(url: str, hosts: list[str], resolver) -> str:
    """Recusa esquema, porta, credencial, IP literal, host fora da allowlist e DNS não público.

    A recusa acontece antes do connect. Quem faz o HTTP resolve o nome de novo;
    um rebind nesse intervalo curto ainda cabe. O que dá para ver daqui falha fechado.
    """
    partes = urlsplit(url.strip())
    if partes.username or partes.password:
        raise DestinoRecusado("credencial_na_url")
    if partes.scheme != "https":
        raise DestinoRecusado("esquema")
    if partes.port not in (None, 443):
        raise DestinoRecusado("porta")
    host = partes.hostname
    if not host:
        raise DestinoRecusado("host")
    host = host.lower().rstrip(".")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise DestinoRecusado("ip_literal")
    if not host_na_allowlist(host, hosts):
        raise DestinoRecusado("fora_da_allowlist")
    try:
        enderecos = list(resolver(host))
    except Exception as exc:
        raise DestinoRecusado("dns_falhou") from exc
    if not enderecos:
        raise DestinoRecusado("dns_falhou")
    for endereco in enderecos:
        try:
            ip = ipaddress.ip_address(endereco)
        except ValueError as exc:
            raise DestinoRecusado("dns_falhou") from exc
        if _ip_recusado(ip):
            raise DestinoRecusado("dns_privado")
    return url


def eh_pagina_de_desafio(status: int, corpo: str) -> bool:
    """403, ou intersticial de desafio. Widget de formulário numa ficha grande não conta."""
    if status == 403:
        return True
    amostra = (corpo or "")[:12000].lower()
    if any(marca in amostra for marca in _INTERSTICIAL):
        return True
    curto = len(corpo or "") < 20000
    if curto and any(marca in amostra for marca in ("cf-turnstile", "g-recaptcha", "hcaptcha")):
        if "<h1" in amostra or "product" in amostra:
            return False
        return True
    return False


def _tipo_corpo(url: str, headers: dict) -> str:
    ctype = ""
    for chave, valor in (headers or {}).items():
        if chave.lower() == "content-type":
            ctype = valor.lower()
            break
    if "json" in ctype or url.endswith(".json"):
        return "json"
    if "javascript" in ctype or url.endswith(".js"):
        return "js"
    return "html"


class TransporteRequests:
    def __init__(self, sessao: requests.Session | None = None, timeout: float = 45):
        self.s = sessao or requests.Session()
        self.s.headers["User-Agent"] = UA
        self.timeout = timeout

    def abrir(self, url: str, max_bytes: int) -> tuple[int, dict, bytes]:
        self.s.cookies.clear()
        r = self.s.get(url, allow_redirects=False, timeout=self.timeout, stream=True)
        try:
            buf = bytearray()
            for pedaco in r.iter_content(65536):
                if not pedaco:
                    continue
                buf += pedaco
                if len(buf) > max_bytes:
                    break
            headers = {k: v for k, v in r.headers.items()}
            return r.status_code, headers, bytes(buf)
        finally:
            r.close()
            self.s.cookies.clear()


class HttpEducado:
    def __init__(self, hosts: list[str], *, intervalo: float = 2.5, relogio: Relogio | None = None,
                 transporte=None, resolver=None, limites: dict | None = None):
        self.hosts = list(hosts)
        self.intervalo = max(2.0, float(intervalo))
        self.relogio = relogio or Relogio()
        self.transporte = transporte or TransporteRequests()
        self.resolver = resolver or resolver_sistema
        self.limites = dict(_LIMITE_BYTES)
        if limites:
            self.limites.update(limites)
        self._ultimo: dict[str, float] = {}
        self._robots: dict[str, robotparser.RobotFileParser] = {}
        self._bloqueados: dict[str, str] = {}
        self.bytes = 0

    def bloquear(self, url: str, motivo: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        if host:
            self._bloqueados[host] = motivo

    def _esperar(self, host: str) -> None:
        agora = self.relogio.monotonic()
        ultimo = self._ultimo.get(host)
        if ultimo is not None:
            falta = self.intervalo - (agora - ultimo)
            if falta > 0:
                self.relogio.sleep(falta)
        self._ultimo[host] = self.relogio.monotonic()

    def _resposta_recusa(self, url: str, motivo: str) -> Resposta:
        return Resposta(url=url, status=0, erro=motivo, motivo_bloqueio=motivo)

    def get(self, url: str) -> Resposta:
        try:
            validar_destino(url, self.hosts, self.resolver)
        except DestinoRecusado as exc:
            return self._resposta_recusa(url, exc.motivo)
        host = urlsplit(url).hostname.lower()
        if host in self._bloqueados:
            return Resposta(url=url, status=0, erro="bloqueado", bloqueado=True,
                            motivo_bloqueio=self._bloqueados[host])
        atual = url
        for salto in range(4):
            try:
                validar_destino(atual, self.hosts, self.resolver)
            except DestinoRecusado as exc:
                return self._resposta_recusa(atual, exc.motivo)
            host_atual = urlsplit(atual).hostname.lower()
            if host_atual in self._bloqueados:
                return Resposta(url=atual, status=0, erro="bloqueado", bloqueado=True,
                                motivo_bloqueio=self._bloqueados[host_atual])
            permitido = self._permitido(atual)
            if permitido is False:
                return Resposta(url=atual, status=0, erro="robots", motivo_bloqueio="robots")
            if isinstance(permitido, Resposta):
                return permitido
            self._esperar(host_atual)
            try:
                status, headers, corpo = self.transporte.abrir(atual, max(self.limites.values()))
            except (requests.Timeout, TimeoutError):
                return Resposta(url=atual, status=0, erro="timeout")
            except requests.RequestException:
                return Resposta(url=atual, status=0, erro="conexao")
            self.bytes += len(corpo)
            if status in _REDIRECTS:
                if salto == 3:
                    return Resposta(url=atual, status=status, erro="redirects", headers=headers)
                loc = _cabecalho(headers, "location")
                if not loc:
                    return Resposta(url=atual, status=status, erro="redirect_sem_location", headers=headers)
                atual = urljoin(atual, loc.strip())
                continue
            tipo = _tipo_corpo(atual, headers)
            if len(corpo) > self.limites.get(tipo, self.limites["html"]):
                return Resposta(url=atual, status=status, corpo=b"", headers=headers, erro="limite_bytes",
                                url_final=atual)
            texto = corpo.decode("utf-8", errors="replace")
            if status == 403 or eh_pagina_de_desafio(status, texto):
                motivo = "403" if status == 403 else "desafio"
                self._bloqueados[host_atual] = motivo
                return Resposta(url=atual, status=status, corpo=corpo, headers=headers, bloqueado=True,
                                motivo_bloqueio=motivo, erro=motivo, url_final=atual)
            return Resposta(url=atual, status=status, corpo=corpo, headers=headers, url_final=atual)
        return Resposta(url=atual, status=0, erro="redirects")

    def _permitido(self, url: str):
        partes = urlsplit(url)
        if partes.path == "/robots.txt":
            return True
        origem = f"{partes.scheme}://{partes.netloc}"
        if origem not in self._robots:
            lido = self._buscar_robots(origem)
            if isinstance(lido, Resposta):
                return lido
        return self._robots[origem].can_fetch(UA, url)

    def _buscar_robots(self, origem: str):
        """200 vira regra. 404 (sem robots) permite. 3xx é seguido e revalidado. O resto não libera."""
        atual = origem + "/robots.txt"
        host = urlsplit(origem).hostname.lower()
        for salto in range(4):
            try:
                validar_destino(atual, self.hosts, self.resolver)
            except DestinoRecusado as exc:
                return self._resposta_recusa(atual, exc.motivo)
            self._esperar(urlsplit(atual).hostname.lower())
            try:
                status, headers, corpo = self.transporte.abrir(atual, self.limites["html"])
            except (requests.Timeout, TimeoutError):
                return Resposta(url=atual, status=0, erro="timeout")
            except requests.RequestException:
                return Resposta(url=atual, status=0, erro="conexao")
            self.bytes += len(corpo)
            if status in _REDIRECTS:
                if salto == 3:
                    return Resposta(url=atual, status=status, erro="redirects", headers=headers)
                loc = _cabecalho(headers, "location")
                if not loc:
                    return Resposta(url=atual, status=status, erro="redirect_sem_location", headers=headers)
                atual = urljoin(atual, loc.strip())
                continue
            texto = corpo.decode("utf-8", errors="replace")
            if status == 403 or eh_pagina_de_desafio(status, texto):
                motivo = "403" if status == 403 else "desafio"
                self._bloqueados[host] = motivo
                return Resposta(url=atual, status=status, bloqueado=True, motivo_bloqueio=motivo, erro=motivo)
            rp = robotparser.RobotFileParser()
            if status == 200:
                rp.parse(texto.splitlines())
            elif status == 404:
                rp.parse([])
            else:
                rp.parse(["User-agent: *", "Disallow: /"])
            self._robots[origem] = rp
            return None
        return Resposta(url=atual, status=0, erro="redirects")


def _cabecalho(headers: dict, nome: str) -> str | None:
    for chave, valor in headers.items():
        if chave.lower() == nome:
            return valor
    return None

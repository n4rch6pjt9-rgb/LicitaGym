"""Estimado × homologado e link da compra para a /precos (spec 0031, fase A).

Para cada compra da Pesquisa de Preço (public.precos_praticados_itens) com resultado nos últimos 24 meses, ainda não
consultada ou com atualização mais nova na fonte (public.precos_compras_pendentes_contratacao):

1. Itens da compra no Compras.gov, uma chamada por compra (sem paginação; conferido em 21/10/2026):
     GET https://dadosabertos.compras.gov.br/modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id
       ?tipo=idCompra&codigo={id_compra}
   Resposta vazia (200, resultado=[]) = a compra não está no PNCP (lei antiga ou sem publicação): grava a compra com
   encontrada=false e não grava itens.
2. Link do portal oficial no PNCP (decisão de 21/10: o link é o que o PNCP mostra):
     GET https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}
   Campo `linkSistemaOrigem`. Em 21/10, 25% das compras do recorte (todas dispensas) vinham sem ele: a api-precos
   monta o link a partir do id_compra; aqui só se grava o que o PNCP devolve (null quando não informa).

Regra de duplicata (spec 0031, Proposta 4): a API 2.1 devolve mais de uma linha por item (ex.: "Em andamento" com
estimado 0 e "Homologado" com o estimado real). Fica a linha com temResultado = true; no empate, a de
dataAtualizacaoPncp mais nova. Sem nenhuma com resultado, fica a mais nova. Estimado 0 ou ausente é NULL (ausente),
nunca zero.

Grava em public.precos_compras_contratacao (por compra) e public.precos_itens_contratacao (por item), por upsert
idempotente. Erro de uma compra (HTTP, JSON ilegível, envelope fora do contrato, gravação) conta em `falhas`, nada é
gravado para ela e a compra volta como pendente na próxima rodada; o resumo sai com sucesso=False (código 1 no Job).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import requests

from .compras_api import ErroApiCompras, corpo_resumido, erro_http
from .destino import Supabase, env
from .retry import espera_retry

log = logging.getLogger("coletor.compras_itens_contratacao")

BASE_COMPRAS = "https://dadosabertos.compras.gov.br"
ENDPOINT_ITENS = "/modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id"
BASE_PNCP = "https://pncp.gov.br/api/consulta/v1"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

# Recorte de 24 meses (decisão de 21/10): o enriquecimento só olha compras com data_resultado nesse período.
MESES_RECORTE = 24
# Compras por rodada (env PRECOS_CONTRATACAO_LIMITE): a primeira carga em 21/10 tinha 2.463 compras, 2 chamadas cada
# com delay >= 1 s (~3 a 6 s por compra medido ao vivo). 600 por rodada cabe em ~1 h de Job; a carga inicial termina
# em poucas rodadas (ou numa rodada manual com --limite maior).
LIMITE_PADRAO = 600

RE_ID_COMPRA = re.compile(r"^\d{17}$")
# Número de controle PNCP da compra: <CNPJ 14>-<1 dígito>-<sequencial 6>/<ano 4>
RE_NUMERO_CONTROLE = re.compile(r"^(\d{14})-\d-(\d{1,6})/(\d{4})$")


class EnvelopeInvalido(ErroApiCompras):
    """HTTP 200 com corpo fora do contrato (não é 'sem resultado')."""


def desde_recorte(hoje: date, meses: int = MESES_RECORTE) -> date:
    """Primeiro dia do recorte: o dia seguinte a (hoje − N meses), como a api-precos (periodoDe)."""
    total = hoje.year * 12 + (hoje.month - 1) - meses
    ano, mes = divmod(total, 12)
    mes += 1
    ultimo = (date(ano + (mes // 12), mes % 12 + 1, 1) - timedelta(days=1)).day
    return date(ano, mes, min(hoje.day, ultimo)) + timedelta(days=1)


def partes_numero_controle(numero: Any) -> tuple[str, int, int] | None:
    """(cnpj, ano, sequencial) do número de controle PNCP da compra; None se fora do formato."""
    if not isinstance(numero, str):
        return None
    m = RE_NUMERO_CONTROLE.match(numero.strip())
    if not m:
        return None
    return m.group(1), int(m.group(3)), int(m.group(2))


def _num_positivo(val: Any) -> float | None:
    """Valor monetário oficial: número > 0; 0, negativo, vazio ou não número é ausente (None)."""
    if val is None or isinstance(val, bool):
        return None
    try:
        n = float(val)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _int(val: Any) -> int | None:
    if val in (None, "") or isinstance(val, bool):
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _texto(val: Any) -> str | None:
    if not isinstance(val, str):
        return None
    s = val.strip()
    return s or None


def escolher_linhas(resultado: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Uma linha por numeroItemCompra: temResultado = true primeiro; no empate, dataAtualizacaoPncp mais nova."""
    escolhidas: dict[int, dict[str, Any]] = {}

    def chave(linha: dict[str, Any]) -> tuple[int, str]:
        return (1 if linha.get("temResultado") is True else 0, str(linha.get("dataAtualizacaoPncp") or ""))

    for linha in resultado:
        if not isinstance(linha, dict):
            raise EnvelopeInvalido("item da API 2.1 que não é objeto JSON")
        numero = _int(linha.get("numeroItemCompra"))
        if numero is None:
            raise EnvelopeInvalido("item da API 2.1 sem numeroItemCompra")
        atual = escolhidas.get(numero)
        if atual is None or chave(linha) > chave(atual):
            escolhidas[numero] = linha
    return escolhidas


def normalizar_item(id_compra: str, linha: dict[str, Any]) -> dict[str, Any]:
    """Linha escolhida da API 2.1 -> public.precos_itens_contratacao."""
    raw_str = json.dumps(linha, sort_keys=True, ensure_ascii=False)
    return {
        "id_compra": id_compra,
        "numero_item_compra": _int(linha.get("numeroItemCompra")),
        "valor_unitario_estimado": _num_positivo(linha.get("valorUnitarioEstimado")),
        "valor_unitario_resultado": _num_positivo(linha.get("valorUnitarioResultado")),
        "situacao_item": _texto(linha.get("situacaoCompraItemNome")),
        "tem_resultado": linha.get("temResultado") if isinstance(linha.get("temResultado"), bool) else None,
        "numero_controle_pncp": _texto(linha.get("numeroControlePNCPCompra")),
        "data_atualizacao_pncp": _instante_brasilia(linha.get("dataAtualizacaoPncp")),
        "raw": linha,
        "payload_hash": hashlib.sha256(raw_str.encode("utf-8")).hexdigest(),
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _instante_brasilia(val: Any) -> str | None:
    """dataAtualizacaoPncp vem sem fuso, no horário de Brasília (ex.: "2026-07-09T10:36:04"); grava com -03:00 para a
    coluna timestamptz não ler como UTC. Com fuso explícito, fica como veio."""
    s = _texto(val)
    if s is None:
        return None
    if re.search(r"(Z|[+-]\d{2}:?\d{2})$", s):
        return s
    return f"{s}-03:00"


def _link_https(val: Any) -> str | None:
    s = _texto(val)
    return s if s and s.lower().startswith("https://") else None


class ClienteContratacoes:
    """GET com delay >= 1 s, timeout explícito e até 3 tentativas (Retry-After em 429; backoff em 502/503/504 e erro de
    rede). 4xx permanente é erro sem retry, nunca lista vazia."""

    def __init__(self, delay: float = 1.0, timeout: int = 60, sessao: requests.Session | None = None):
        self.delay = max(1.0, delay)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def itens_da_compra(self, id_compra: str) -> list[dict[str, Any]]:
        if not RE_ID_COMPRA.match(id_compra or ""):
            raise ValueError(f"id_compra inválido: {id_compra!r} (esperado 17 dígitos)")
        contexto = f"Contratações 2.1 idCompra={id_compra}"
        corpo = self._get(f"{BASE_COMPRAS}{ENDPOINT_ITENS}", {"tipo": "idCompra", "codigo": id_compra}, contexto)
        if not isinstance(corpo, dict) or not isinstance(corpo.get("resultado"), list):
            raise EnvelopeInvalido(f"HTTP 200 em {contexto} sem lista 'resultado' no corpo")
        restantes = corpo.get("paginasRestantes")
        if isinstance(restantes, int) and not isinstance(restantes, bool) and restantes > 0:
            # A API não aceita paginação neste endpoint: resposta incompleta é erro, não "menos itens".
            raise EnvelopeInvalido(f"{contexto}: paginasRestantes={restantes}, resposta incompleta")
        return corpo["resultado"]

    def compra_pncp(self, cnpj: str, ano: int, sequencial: int) -> dict[str, Any]:
        contexto = f"PNCP compra {cnpj}/{ano}/{sequencial}"
        corpo = self._get(f"{BASE_PNCP}/orgaos/{cnpj}/compras/{ano}/{sequencial}", None, contexto)
        if not isinstance(corpo, dict):
            raise EnvelopeInvalido(f"HTTP 200 em {contexto} com corpo que não é objeto JSON")
        return corpo

    def _get(self, url: str, params: dict[str, Any] | None, contexto: str) -> Any:
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                log.warning("Falha de rede em %s tentativa %d: %s", contexto, tentativa, e)
                if tentativa == 3:
                    raise ErroApiCompras(f"rede esgotada em {contexto}: {e}") from None
                time.sleep(espera_retry(None, tentativa, base=2.0))
                continue
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError as e:
                    raise EnvelopeInvalido(f"HTTP 200 em {contexto} com corpo que não é JSON: {e}",
                                           status=200, corpo=corpo_resumido(r)) from None
            if r.status_code in (429, 502, 503, 504):
                if tentativa == 3:
                    raise ErroApiCompras(f"HTTP {r.status_code} esgotado em {contexto}", status=r.status_code)
                espera = espera_retry(r, tentativa, base=3.0)
                log.warning("HTTP %d em %s (tentativa %d), aguardando %.1fs...", r.status_code, contexto, tentativa,
                            espera)
                time.sleep(espera)
                continue
            raise erro_http(r, contexto)
        raise ErroApiCompras(f"Falha ao consultar {contexto} após retries")


def consultar_compra(cliente: ClienteContratacoes, id_compra: str, atualizacao: Any) -> tuple[dict[str, Any], list[dict]]:
    """(linha de precos_compras_contratacao, linhas de precos_itens_contratacao) de uma compra. Levanta em erro."""
    agora = datetime.now(timezone.utc).isoformat()
    resultado = cliente.itens_da_compra(id_compra)
    compra: dict[str, Any] = {
        "id_compra": id_compra,
        "encontrada": bool(resultado),
        "numero_controle_pncp": None,
        "orgao_entidade_cnpj": None,
        "ano_compra_pncp": None,
        "sequencial_compra_pncp": None,
        "link_sistema_origem": None,
        "data_hora_atualizacao_compra": atualizacao,
        "consultado_em": agora,
        "updated_at": agora,
        "raw": None,
    }
    if not resultado:
        return compra, []

    linhas = escolher_linhas(resultado)
    itens = [normalizar_item(id_compra, ln) for _, ln in sorted(linhas.items())]
    numeros = {i["numero_controle_pncp"] for i in itens if i["numero_controle_pncp"]}
    if len(numeros) != 1:
        raise EnvelopeInvalido(f"compra {id_compra}: {len(numeros)} números de controle PNCP nos itens (esperado 1)")
    numero = numeros.pop()
    partes = partes_numero_controle(numero)
    if partes is None:
        raise EnvelopeInvalido(f"compra {id_compra}: número de controle PNCP fora do formato: {numero!r}")
    cnpj, ano, seq = partes
    pncp = cliente.compra_pncp(cnpj, ano, seq)
    compra.update({
        "numero_controle_pncp": numero,
        "orgao_entidade_cnpj": cnpj,
        "ano_compra_pncp": ano,
        "sequencial_compra_pncp": seq,
        "link_sistema_origem": _link_https(pncp.get("linkSistemaOrigem")),
        "raw": {k: pncp.get(k) for k in ("numeroControlePNCP", "linkSistemaOrigem", "linkProcessoEletronico",
                                         "usuarioNome", "dataAtualizacao", "srp")},
    })
    return compra, itens


def coletar(
    cliente: ClienteContratacoes,
    sb: Supabase | None,
    pendentes: list[dict[str, Any]] | None = None,
    hoje: Callable[[], date] = lambda: datetime.now(timezone(timedelta(hours=-3))).date(),
    limite: int = LIMITE_PADRAO,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Consulta as compras pendentes do recorte de 24 meses e grava compra e itens. `pendentes` injetável para teste."""
    desde = desde_recorte(hoje())
    resumo: dict[str, Any] = {
        "desde": desde.isoformat(), "compras": 0, "encontradas": 0, "nao_encontradas": 0, "com_link": 0,
        "itens": 0, "itens_com_estimado": 0, "falhas": 0, "erros": [], "dry_run": dry_run,
    }
    if pendentes is None:
        if sb is None:
            raise ValueError("sem banco: informe as compras pendentes")
        pendentes = sb.rpc("precos_compras_pendentes_contratacao", {"p_desde": desde.isoformat(), "p_limite": limite})
    for p in pendentes:
        id_compra = str(p.get("id_compra") or "")
        resumo["compras"] += 1
        try:
            compra, itens = consultar_compra(cliente, id_compra, p.get("data_hora_atualizacao_compra"))
        except (ErroApiCompras, ValueError) as e:
            resumo["falhas"] += 1
            if len(resumo["erros"]) < 20:
                resumo["erros"].append(f"{id_compra}: {e}")
            log.error("Compra %s não enriquecida: %s", id_compra, e)
            continue
        resumo["encontradas" if compra["encontrada"] else "nao_encontradas"] += 1
        resumo["com_link"] += 1 if compra["link_sistema_origem"] else 0
        resumo["itens"] += len(itens)
        resumo["itens_com_estimado"] += sum(1 for i in itens if i["valor_unitario_estimado"] is not None)
        if dry_run or sb is None:
            continue
        try:
            # Itens antes da compra: se a gravação dos itens falhar, a compra não fica marcada como consultada.
            if itens:
                sb.upsert("precos_itens_contratacao", itens, conflito="id_compra,numero_item_compra")
            sb.upsert("precos_compras_contratacao", compra, conflito="id_compra")
        except Exception as e:  # noqa: BLE001 - qualquer falha de gravação conta como falha da compra
            resumo["falhas"] += 1
            if len(resumo["erros"]) < 20:
                resumo["erros"].append(f"{id_compra}: gravação: {e}")
            log.error("Gravação da compra %s falhou: %s", id_compra, e)
    resumo["sucesso"] = resumo["falhas"] == 0
    return resumo


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Estimado × homologado e link da compra para a /precos (spec 0031)")
    ap.add_argument("--limite", type=int, default=LIMITE_PADRAO, help="Teto de compras por rodada")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay mínimo em segundos entre requisições (mínimo 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="Consulta, mas não grava; mostra o resumo")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    res = coletar(ClienteContratacoes(delay=args.delay), sb, limite=args.limite, dry_run=args.dry_run)
    log.info("itens contratacao -> %s", json.dumps(res, ensure_ascii=False, default=str))
    return 0 if res["sucesso"] else 1


if __name__ == "__main__":
    sys.exit(main())

"""Medição da consulta do PNCP por data (spec 0029, CA-1). Só lê; não grava nada no banco.

Para cada endpoint (`/api/consulta/v1/contratacoes/publicacao` e `/atualizacao`) e cada modalidade, consulta um dia
inteiro e registra páginas, registros (o `totalRegistros` da API e o que veio de fato), tempo, respostas 429, erros e
quantos registros passam no filtro de escopo do coletor (`escopo.classificar` sobre `objetoCompra`). O resultado decide
a frequência e o orçamento da trilha do dia.

Regras do projeto:
  - `tamanhoPagina` vai a 50, o teto destes endpoints (docs/pncp/contract-matrix.md);
  - a paginação para pelo `totalPaginas` da API, nunca por página curta (#186);
  - espera `--delay` (>= 1 s) entre chamadas; 429 respeita Retry-After; 5xx e falha de rede tentam de novo com backoff;
  - erro persistente deixa a linha `completa = false`, nunca vira zero registros;
  - página vazia ou 204 antes do `totalPaginas`, envelope sem `totalPaginas` ou `recebidos` diferente do `totalRegistros`
    também deixam a linha incompleta (`divergencia` guarda a diferença);
  - o JSON é regravado a cada combinação endpoint × modalidade, então uma queda no meio não perde o que já foi medido.

Uso:
  python -m coletor.medir_consulta_pncp --saida medicao_resultado.json      # último dia útil completo (Brasília)
  python -m coletor.medir_consulta_pncp --data 20261015 --modalidades 6,8 --saida medicao_resultado.json

`*_resultado.json` já é ignorado pelo `.gitignore`: o relatório é dado de coleta e não vai para o repositório.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Callable

import requests

from coletor import escopo
from coletor.retry import backoff_s, retry_after_s

BASE = "https://pncp.gov.br/api/consulta/v1/contratacoes/"
ENDPOINTS = ("publicacao", "atualizacao")
# Domínio `codigoModalidadeContratacao` do manual de integração do PNCP (1 a 13 na versão usada em 10/2026; conferir
# no manual antes de confiar na cobertura: um código novo ficaria de fora sem erro).
MODALIDADES = tuple(range(1, 14))
TAMANHO_PAGINA = 50
TENTATIVAS = 5
TIMEOUT_S = 60
FUSO_BRASILIA = timezone(timedelta(hours=-3))


def ultimo_dia_util(agora: datetime | None = None) -> date:
    """Último dia útil (segunda a sexta) já encerrado no horário de Brasília. Feriado não é tratado."""
    hoje = (agora or datetime.now(timezone.utc)).astimezone(FUSO_BRASILIA).date()
    d = hoje - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _get(sessao, url: str, params: dict, dormir: Callable[[float], None], delay: float, conta: Counter):
    """Uma chamada com retentativas. Devolve (status, corpo) ou levanta RuntimeError com o motivo."""
    ultimo = ""
    for tentativa in range(TENTATIVAS):
        try:
            r = sessao.get(url, params=params, timeout=TIMEOUT_S)
        except requests.RequestException as e:  # conexão, timeout, resposta cortada (ChunkedEncodingError) etc.
            ultimo = f"rede: {type(e).__name__}"
            dormir(backoff_s(tentativa, 5.0))
            continue
        dormir(delay)
        if r.status_code == 204:
            return 204, None
        if r.status_code == 429:
            conta["http_429"] += 1
            ultimo = "HTTP 429"
            espera = retry_after_s(r)
            dormir(espera if espera is not None else backoff_s(tentativa, 5.0))
            continue
        if r.status_code >= 500:
            ultimo = f"HTTP {r.status_code}"
            dormir(backoff_s(tentativa, 5.0))
            continue
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        try:
            corpo = r.json()
        except ValueError as e:
            raise RuntimeError(f"JSON inválido: {e}") from e
        if not isinstance(corpo, dict):
            raise RuntimeError(f"esperava objeto, veio {type(corpo).__name__}")
        try:
            corpo["totalPaginas"] = int(corpo["totalPaginas"])
            corpo["totalRegistros"] = int(corpo["totalRegistros"])
        except (KeyError, TypeError, ValueError) as e:
            raise RuntimeError(f"envelope sem totalPaginas/totalRegistros numéricos ({type(e).__name__})") from e
        return 200, corpo
    raise RuntimeError(f"{ultimo} depois de {TENTATIVAS} tentativas")


def medir_um(sessao, dia: date, endpoint: str, modalidade: int, *, dormir, relogio, delay: float) -> dict:
    data = dia.strftime("%Y%m%d")
    conta: Counter = Counter()
    categorias: Counter = Counter()
    linha = {"endpoint": endpoint, "modalidade": modalidade, "paginas": 0, "registros_api": None, "recebidos": 0,
             "no_escopo": 0, "http_429": 0, "segundos": 0.0, "completa": True, "erros": []}
    inicio = relogio()
    pagina, total_paginas = 1, 1
    while pagina <= total_paginas:
        params = {"dataInicial": data, "dataFinal": data, "codigoModalidadeContratacao": modalidade,
                  "pagina": pagina, "tamanhoPagina": TAMANHO_PAGINA}
        try:
            status, corpo = _get(sessao, BASE + endpoint, params, dormir, delay, conta)
        except RuntimeError as e:
            linha["completa"] = False
            linha["erros"].append(f"página {pagina}: {e}")
            break
        linha["paginas"] += 1
        registros = (corpo or {}).get("data") or []
        if status == 204 or not registros:
            if pagina == 1:
                linha["registros_api"] = (corpo or {}).get("totalRegistros", 0)
                break
            # Vazio antes do fim anunciado pela API não é fim de dados (regra de paginação do PNCP).
            linha["completa"] = False
            linha["erros"].append(f"página {pagina}: vazia antes de totalPaginas={total_paginas}")
            break
        total_paginas = corpo["totalPaginas"]
        linha["registros_api"] = corpo["totalRegistros"]
        for c in registros:
            linha["recebidos"] += 1
            cat = escopo.classificar((c or {}).get("objetoCompra") or "")
            if cat:
                linha["no_escopo"] += 1
                categorias[cat] += 1
        pagina += 1
    if linha["completa"] and linha["recebidos"] != (linha["registros_api"] or 0):
        linha["completa"] = False
        linha["divergencia"] = linha["recebidos"] - (linha["registros_api"] or 0)
        linha["erros"].append(f"recebidos {linha['recebidos']} != totalRegistros {linha['registros_api']}")
    linha["http_429"] = conta["http_429"]
    linha["por_categoria"] = dict(categorias)
    linha["segundos"] = round(relogio() - inicio, 1)
    return linha


def _relatorio(dia: date, delay: float, medicoes: list[dict]) -> dict:
    resumo = {
        "chamadas": sum(x["paginas"] for x in medicoes),
        "recebidos": sum(x["recebidos"] for x in medicoes),
        "registros_api": sum(x["registros_api"] or 0 for x in medicoes),
        "no_escopo": sum(x["no_escopo"] for x in medicoes),
        "http_429": sum(x["http_429"] for x in medicoes),
        "segundos": round(sum(x["segundos"] for x in medicoes), 1),
        "incompletas": sum(1 for x in medicoes if not x["completa"]),
    }
    return {"data": dia.isoformat(), "delay_s": delay, "tamanho_pagina": TAMANHO_PAGINA, "resumo": resumo,
            "medicoes": medicoes}


def medir(sessao, dia: date, *, modalidades=MODALIDADES, endpoints=ENDPOINTS, dormir=time.sleep,
          relogio=time.monotonic, delay: float = 1.0, ao_medir: Callable[[dict], None] | None = None) -> dict:
    """Mede cada endpoint × modalidade. `ao_medir` recebe o relatório parcial depois de cada combinação."""
    medicoes: list[dict] = []
    for ep in endpoints:
        for mod in modalidades:
            linha = medir_um(sessao, dia, ep, mod, dormir=dormir, relogio=relogio, delay=delay)
            medicoes.append(linha)
            print(f"[medir] {ep} mod {mod}: {linha['paginas']} pág, {linha['recebidos']} reg, {linha['http_429']} 429"
                  f"{'' if linha['completa'] else ', INCOMPLETA: ' + '; '.join(linha['erros'])}", file=sys.stderr)
            if ao_medir:
                ao_medir(_relatorio(dia, delay, list(medicoes)))
    return _relatorio(dia, delay, medicoes)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Mede a consulta do PNCP por data (spec 0029, CA-1). Não grava.")
    ap.add_argument("--data", help="YYYYMMDD; padrão: último dia útil completo em Brasília")
    ap.add_argument("--modalidades", help="lista separada por vírgula; padrão: 1 a 13")
    ap.add_argument("--endpoints", default=",".join(ENDPOINTS))
    ap.add_argument("--delay", type=float, default=1.0, help="segundos entre chamadas (>= 1)")
    ap.add_argument("--saida", required=True, help="arquivo JSON com o relatório")
    a = ap.parse_args(argv)
    if a.delay < 1:
        raise SystemExit("--delay precisa ser >= 1 (respeito ao PNCP).")
    try:
        dia = datetime.strptime(a.data, "%Y%m%d").date() if a.data else ultimo_dia_util()
    except ValueError:
        raise SystemExit("--data no formato YYYYMMDD (ex.: 20261015)") from None
    modalidades = [int(x) for x in a.modalidades.split(",")] if a.modalidades else list(MODALIDADES)
    endpoints = [x.strip() for x in a.endpoints.split(",") if x.strip()]
    if any(e not in ENDPOINTS for e in endpoints):
        raise SystemExit(f"endpoint desconhecido; use {', '.join(ENDPOINTS)}")
    sessao = requests.Session()
    sessao.headers["User-Agent"] = "LicitaGym-Coletor/1.0 (pesquisa de licitações públicas)"

    def gravar(rel: dict) -> None:
        with open(a.saida, "w", encoding="utf-8") as f:
            json.dump(rel, f, ensure_ascii=False, indent=2)

    rel = medir(sessao, dia, modalidades=modalidades, endpoints=endpoints, delay=a.delay, ao_medir=gravar)
    gravar(rel)
    r = rel["resumo"]
    print(f"{rel['data']}: {r['chamadas']} chamadas, {r['recebidos']} registros, {r['no_escopo']} no escopo, "
          f"{r['http_429']} 429, {r['segundos']} s, {r['incompletas']} incompletas")
    for x in rel["medicoes"]:
        print(f"  {x['endpoint']:<12} mod {x['modalidade']:>2}: {x['paginas']:>4} pág, {x['recebidos']:>6} reg, "
              f"{x['no_escopo']:>4} escopo, {x['segundos']:>7} s{'' if x['completa'] else '  INCOMPLETA'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

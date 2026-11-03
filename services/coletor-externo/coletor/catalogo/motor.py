"""Fila, dedup por id/URL, paginação, retry e checkpoint.

Uma coleta com falha no meio fica `parcial` ou `bloqueada`. Isso nunca vira `completa`.
5xx e timeout não encerram a paginação: a página continua pendente para a retomada.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import requests

from ..retry import espera_retry
from .canonico import chave_url
from .adaptadores.base import Ctx
from .rede import Resposta

_BRT = timezone(timedelta(hours=-3))
_RETRY_ERRO = {"timeout", "conexao"}


@dataclass
class Limites:
    max_requisicoes: int = 4000
    max_produtos: int = 4000
    max_bytes: int = 80_000_000


def agora_brt() -> datetime:
    return datetime.now(_BRT)


def estado_novo(fornecedor: str) -> dict:
    return {
        "versao": 1,
        "fornecedor": fornecedor,
        "cursores": {},
        "urls_listagem_feitas": [],
        "urls_detalhe_feitas": [],
        "fila_detalhe": [],
        "produtos": [],
        "progresso": {
            "declarado": None,
            "declarado_por_entrada": {},
            "observados": 0,
            "unicos": 0,
            "novos_por_pagina": [],
            "falhas": [],
            "fim": [],
        },
        "status": "em_andamento",
        "motivo": None,
        "bytes": 0,
        "requisicoes": 0,
    }


def coletar(adaptador, cfg: dict, cliente, *, marca: str, fornecedor: str, limites: Limites | None = None,
            dormir=None, agora=None, estado: dict | None = None, ao_salvar=None) -> dict:
    limites = limites or Limites()
    dormir = dormir or (lambda _s: None)
    agora = agora or agora_brt
    estado = estado or estado_novo(fornecedor)
    if estado.get("versao") != 1:
        estado["status"] = "parcial"
        estado["motivo"] = "checkpoint_versao"
        return estado
    if estado.get("status") == "bloqueada":
        return estado
    if estado.get("status") == "completa":
        return estado
    estado["status"] = "em_andamento"
    estado["motivo"] = None
    ctx = Ctx(coletado_em=_iso(agora), marca=marca, fornecedor=fornecedor, cfg=cfg)
    for entrada in adaptador.entradas(cfg):
        estado["cursores"].setdefault(entrada, {
            "proxima": 1, "fim": False, "sem_novo": 0, "primeiro_anterior": None,
            "declarado": None, "motivo_fim": None,
        })
    _listagens(adaptador, cfg, cliente, estado, limites, dormir, ctx, ao_salvar)
    if estado["status"] not in {"bloqueada", "parcial"} or _parcial_permite_detalhe(estado):
        _detalhes(adaptador, cliente, estado, limites, dormir, ctx, ao_salvar)
    _fechar(estado)
    if ao_salvar:
        ao_salvar(estado)
    return estado


def _parcial_permite_detalhe(estado: dict) -> bool:
    """Falha de uma ficha não impede as outras. Falha de listagem ou bloqueio, sim."""
    if estado["status"] == "bloqueada":
        return False
    if estado["status"] != "parcial":
        return True
    return bool(estado["fila_detalhe"]) and estado.get("motivo") not in {
        "robots", "limite_requisicoes", "limite_bytes", "checkpoint_versao",
    }


def _listagens(adaptador, cfg, cliente, estado, limites, dormir, ctx, ao_salvar) -> None:
    while estado["status"] == "em_andamento":
        abertas = [e for e, c in estado["cursores"].items() if not c["fim"]]
        if not abertas:
            break
        entrada = abertas[0]
        cur = estado["cursores"][entrada]
        url = adaptador.url_pagina(entrada, cur["proxima"])
        if not url:
            _fechar_cursor(estado, entrada, "sem_proxima")
            continue
        if url in estado["urls_listagem_feitas"]:
            cur["proxima"] += 1
            continue
        if estado["requisicoes"] >= limites.max_requisicoes:
            _marcar(estado, "parcial", "limite_requisicoes")
            break
        resp = _obter(cliente, url, dormir, estado, limites)
        if resp.bloqueado:
            _marcar(estado, "bloqueada", resp.motivo_bloqueio or "bloqueado")
            break
        if resp.erro == "limite_requisicoes":
            _marcar(estado, "parcial", "limite_requisicoes")
            break
        if estado["bytes"] > limites.max_bytes:
            _marcar(estado, "parcial", "limite_bytes")
            break
        if resp.erro == "robots":
            _marcar(estado, "parcial", "robots")
            break
        if _transitorio(resp):
            _falha(estado, url, resp)
            _marcar(estado, "parcial", f"http_{resp.status or resp.erro}")
            break
        if resp.status == 404 and adaptador.http_404_e_fim:
            estado["urls_listagem_feitas"].append(url)
            estado["progresso"]["novos_por_pagina"].append(0)
            _fechar_cursor(estado, entrada, "http_404")
            _salvar(estado, ao_salvar)
            continue
        if resp.status == 404 or not (200 <= resp.status < 300):
            _falha(estado, url, resp)
            _marcar(estado, "parcial", f"http_{resp.status or resp.erro or 'erro'}")
            break
        pagina = adaptador.listar(resp, entrada, ctx)
        estado["urls_listagem_feitas"].append(url)
        if pagina.declarado and not cur["declarado"]:
            cur["declarado"] = pagina.declarado
            estado["progresso"]["declarado_por_entrada"][entrada] = pagina.declarado
        itens = pagina.itens
        estado["progresso"]["observados"] += len(itens)
        if not itens:
            estado["progresso"]["novos_por_pagina"].append(0)
            _fechar_cursor(estado, entrada, "pagina_vazia")
            _salvar(estado, ao_salvar)
            continue
        primeiro = itens[0].id_externo or chave_url(itens[0].url)
        if cur["primeiro_anterior"] and primeiro == cur["primeiro_anterior"]:
            estado["progresso"]["novos_por_pagina"].append(0)
            _fechar_cursor(estado, entrada, "primeiro_item_repetido")
            _salvar(estado, ao_salvar)
            continue
        novos = 0
        for item in itens:
            if _ja_visto(estado, item):
                _juntar_fonte(estado, item, entrada)
                continue
            if len(estado["produtos"]) + len(estado["fila_detalhe"]) >= limites.max_produtos:
                _marcar(estado, "parcial", "limite_produtos")
                break
            _enfileirar(estado, item, entrada, adaptador, cfg)
            novos += 1
        estado["progresso"]["novos_por_pagina"].append(novos)
        if estado["status"] != "em_andamento":
            break
        if novos == 0:
            cur["sem_novo"] += 1
            if cur["sem_novo"] >= 2:
                _fechar_cursor(estado, entrada, "sem_item_novo")
        else:
            cur["sem_novo"] = 0
        cur["primeiro_anterior"] = primeiro
        cur["proxima"] += 1
        teto = _teto(adaptador, cur, pagina)
        if not cur["fim"] and cur["proxima"] > teto:
            _fechar_cursor(estado, entrada, "teto_paginas")
        _salvar(estado, ao_salvar)


def _detalhes(adaptador, cliente, estado, limites, dormir, ctx, ao_salvar) -> None:
    feitas = set(estado["urls_detalhe_feitas"])
    for item in list(estado["fila_detalhe"]):
        if estado["status"] == "bloqueada":
            break
        if item["url"] in feitas:
            continue
        if len(estado["produtos"]) >= limites.max_produtos:
            _marcar(estado, "parcial", "limite_produtos")
            break
        if estado["requisicoes"] >= limites.max_requisicoes:
            _marcar(estado, "parcial", "limite_requisicoes")
            break
        resp = _obter(cliente, item["url"], dormir, estado, limites)
        if resp.bloqueado:
            _marcar(estado, "bloqueada", resp.motivo_bloqueio or "bloqueado")
            _guardar_parcial(estado, item)
            break
        if resp.erro == "limite_requisicoes" or estado["bytes"] > limites.max_bytes:
            _marcar(estado, "parcial", "limite_bytes" if estado["bytes"] > limites.max_bytes else "limite_requisicoes")
            _guardar_parcial(estado, item)
            break
        if _transitorio(resp) or resp.erro == "robots" or not (200 <= resp.status < 300):
            _falha(estado, item["url"], resp)
            _marcar(estado, "parcial", f"http_{resp.status or resp.erro or 'erro'}")
            _guardar_parcial(estado, item)
            continue
        produto = adaptador.detalhar(resp, item, ctx)
        feitas.add(item["url"])
        estado["urls_detalhe_feitas"].append(item["url"])
        if produto is None:
            _salvar(estado, ao_salvar)
            continue
        produto["fontes"] = list(dict.fromkeys(item.get("fontes") or produto.get("fontes") or []))
        if not _fundir_id(estado, produto):
            estado["produtos"].append(produto)
        if ctx.cfg.get("json_alternate"):
            url_json = adaptador.url_json(resp, item)
            if url_json:
                estado.setdefault("fila_json", []).append({
                    "url": url_json, "id_externo": produto.get("id_externo"),
                })
        _salvar(estado, ao_salvar)
    estado["fila_detalhe"] = [i for i in estado["fila_detalhe"] if i["url"] not in feitas]
    _jsons(adaptador, cliente, estado, limites, dormir, ctx, ao_salvar)


def _jsons(adaptador, cliente, estado, limites, dormir, ctx, ao_salvar) -> None:
    if not ctx.cfg.get("json_alternate"):
        return
    for item in list(estado.get("fila_json") or []):
        if item.get("feito"):
            continue
        if estado["status"] not in {"em_andamento", "completa"}:
            break
        resp = _obter(cliente, item["url"], dormir, estado, limites)
        item["feito"] = True
        if resp.bloqueado:
            _marcar(estado, "bloqueada", resp.motivo_bloqueio or "bloqueado")
            break
        if not (200 <= resp.status < 300):
            _falha(estado, item["url"], resp)
            _marcar(estado, "parcial", f"http_{resp.status or resp.erro or 'erro'}")
            continue
        for produto in estado["produtos"]:
            if produto.get("id_externo") == item.get("id_externo"):
                adaptador.aplicar_json(produto, resp, ctx)
                break
        _salvar(estado, ao_salvar)


def _obter(cliente, url: str, dormir, estado: dict, limites: Limites) -> Resposta:
    ultimo = Resposta(url=url, status=0, erro="conexao")
    for tentativa in range(1, 4):
        if estado["requisicoes"] >= limites.max_requisicoes:
            return Resposta(url=url, status=0, erro="limite_requisicoes")
        estado["requisicoes"] += 1
        try:
            resp = cliente.get(url)
        except (requests.Timeout, TimeoutError):
            resp = Resposta(url=url, status=0, erro="timeout")
        except requests.RequestException:
            resp = Resposta(url=url, status=0, erro="conexao")
        ultimo = resp
        estado["bytes"] += len(resp.corpo or b"")
        if not (_transitorio(resp)):
            return resp
        if tentativa == 3:
            if resp.status == 429:
                cliente.bloquear(url, "429_persistente")
                resp.bloqueado = True
                resp.motivo_bloqueio = "429_persistente"
                resp.erro = "429_persistente"
            return resp
        dormir(espera_retry(resp if resp.status else None, tentativa, 1.0))
    return ultimo


def _transitorio(resp: Resposta) -> bool:
    if resp.bloqueado:
        return False
    if resp.erro in _RETRY_ERRO:
        return True
    return resp.status == 429 or resp.status >= 500


def _enfileirar(estado, item, entrada, adaptador, cfg) -> None:
    chave = item.id_externo or chave_url(item.url)
    registro = {
        "chave": chave, "url": item.url, "id_externo": item.id_externo,
        "id_externo_tipo": item.id_externo_tipo, "fontes": [entrada],
        "nome": item.nome, "fonte": entrada, "produto_parcial": item.produto,
    }
    if item.produto is not None and not adaptador.quer_detalhe(cfg):
        item.produto["fontes"] = [entrada]
        estado["produtos"].append(item.produto)
        return
    estado["fila_detalhe"].append(registro)


def _ja_visto(estado, item) -> bool:
    chave = item.id_externo or chave_url(item.url)
    if any(f.get("chave") == chave for f in estado["fila_detalhe"]):
        return True
    for produto in estado["produtos"]:
        if produto.get("id_externo") == item.id_externo and item.id_externo:
            return True
        if chave_url(produto.get("url_canonica") or "") == chave_url(item.url):
            if item.id_externo and produto.get("id_externo") not in (None, item.id_externo):
                continue
            return True
    return False


def _juntar_fonte(estado, item, entrada: str) -> None:
    chave = item.id_externo or chave_url(item.url)
    for pendente in estado["fila_detalhe"]:
        if pendente["chave"] == chave and entrada not in pendente["fontes"]:
            pendente["fontes"].append(entrada)
    for produto in estado["produtos"]:
        mesmo_id = item.id_externo and produto.get("id_externo") == item.id_externo
        mesma_url = chave_url(produto.get("url_canonica") or "") == chave_url(item.url)
        if (mesmo_id or mesma_url) and entrada not in produto["fontes"]:
            produto["fontes"].append(entrada)


def _fundir_id(estado, produto: dict) -> bool:
    for existente in estado["produtos"]:
        if existente.get("id_externo") == produto.get("id_externo") and existente.get("id_externo_tipo") == produto.get("id_externo_tipo"):
            for fonte in produto.get("fontes") or []:
                if fonte not in existente["fontes"]:
                    existente["fontes"].append(fonte)
            return True
    return False


def _guardar_parcial(estado, item) -> None:
    if item.get("produto_parcial") and not any(p.get("id_externo") == item.get("id_externo") and item.get("id_externo") for p in estado["produtos"]):
        item["produto_parcial"]["fontes"] = list(item.get("fontes") or [])
        estado["produtos"].append(item["produto_parcial"])


def _teto(adaptador, cur, pagina) -> int:
    tamanho = pagina.tamanho_pagina or adaptador.tamanho_pagina or 0
    declarado = cur.get("declarado")
    if declarado and tamanho:
        return math.ceil(declarado / tamanho) + 1
    return adaptador.teto_sem_declarado


def _fechar_cursor(estado, entrada: str, motivo: str) -> None:
    cur = estado["cursores"][entrada]
    cur["fim"] = True
    cur["motivo_fim"] = motivo
    if motivo not in estado["progresso"]["fim"]:
        estado["progresso"]["fim"].append(motivo)


def _falha(estado, url: str, resp: Resposta) -> None:
    estado["progresso"]["falhas"].append({
        "url": url, "status": resp.status, "erro": resp.erro,
    })


def _marcar(estado, status: str, motivo: str) -> None:
    if estado["status"] == "bloqueada":
        return
    if estado["status"] == "parcial" and status != "bloqueada":
        return
    estado["status"] = status
    estado["motivo"] = motivo


def _fechar(estado: dict) -> None:
    estado["progresso"]["unicos"] = len(estado["produtos"])
    declarados = [v for v in estado["progresso"]["declarado_por_entrada"].values() if isinstance(v, int)]
    estado["progresso"]["declarado"] = sum(declarados) if declarados else None
    if estado["status"] == "em_andamento":
        estado["status"] = "completa"
        fins = [c.get("motivo_fim") for c in estado["cursores"].values() if c.get("motivo_fim")]
        estado["motivo"] = ",".join(fins) if fins else None


def _salvar(estado, ao_salvar) -> None:
    if ao_salvar:
        ao_salvar(estado)


def _iso(agora) -> str:
    valor = agora()
    if isinstance(valor, str):
        return valor
    return valor.isoformat()

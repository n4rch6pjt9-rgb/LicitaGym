"""Embrulha sitemap/índice + extrair_ficha para quem não tem adaptador próprio (LION, TOTAL HEALTH, FLEX)."""
from __future__ import annotations

import re
from urllib.parse import urljoin

from ...catalogos import extrair_ficha
from ..atributos import montar_atributo
from ..canonico import chave_url, url_canonica
from ..contrato import Bloco, campo, novo_produto, oferta
from ..familia import familia_de
from ..htmlutil import sem_comentario
from ..rede import Resposta
from .base import AdaptadorBase, Ctx, ItemLista, PaginaLista

_CAMPOS = (
    ("carga_maxima_kg", "Carga máxima"),
    ("carga_inicial_kg", "Carga inicial"),
    ("peso_placa_kg", "Peso da placa"),
    ("peso_equipamento_kg", "Peso do equipamento"),
    ("comprimento_cm", "Comprimento"),
    ("largura_cm", "Largura"),
    ("altura_cm", "Altura"),
)


class Generico(AdaptadorBase):
    nome = "generico"
    versao = "1"
    tamanho_pagina = 0
    teto_sem_declarado = 1

    def url_pagina(self, entrada: str, numero: int) -> str | None:
        return entrada if numero == 1 else None

    def listar(self, resp: Resposta, entrada: str, ctx: Ctx) -> PaginaLista:
        padrao = re.compile(ctx.cfg["produtos"]["padrao_url"])
        texto = resp.texto
        if "<loc>" in texto:
            brutos = re.findall(r"<loc>([^<]+)</loc>", texto)
        else:
            brutos = [urljoin(entrada, u) for u in re.findall(r'href="([^"#]+)"', texto)]
            brutos += [urljoin(entrada, "/" + u) for u in re.findall(
                r'["\'(/](produto/[a-z0-9-]+(?:/[a-z0-9-]+)?)', texto,
            )]
        vistos: set[str] = set()
        itens: list[ItemLista] = []
        for bruto in brutos:
            if not padrao.search(bruto):
                continue
            canon = url_canonica(bruto)
            if canon in vistos or canon.startswith("javascript"):
                continue
            vistos.add(canon)
            itens.append(ItemLista(url=canon, fonte=entrada))
        return PaginaLista(itens=itens, declarado=len(itens) or None, tamanho_pagina=len(itens) or None)

    def detalhar(self, resp: Resposta, item: dict, ctx: Ctx) -> dict | None:
        ficha = extrair_ficha(resp.texto, item["url"], ctx.marca)
        if ctx.cfg.get("produtos", {}).get("exige_codigo") and not ficha.get("codigo"):
            return None
        bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, self.parser, ctx.coletado_em)
        nome = ficha.get("nome") or ficha.get("titulo")
        if not nome:
            return None
        ev = bloco.ev("pagina", "extrair_ficha", nome)
        produto = novo_produto(
            fornecedor=ctx.fornecedor, fontes=list(item.get("fontes") or [item.get("fonte") or ""]),
            id_externo_tipo="url_validada", id_externo=chave_url(item["url"]),
            url_canonica=url_canonica(item["url"]), url_validada=True, url_motivo=None, bloco=bloco,
        )
        produto["fontes"] = [f for f in produto["fontes"] if f]
        produto["nome"] = campo(nome, ev)
        if ficha.get("linha"):
            produto["linhas"].append({"nome": ficha["linha"], "origem": "pagina", "ev": ev})
        for cat in ficha.get("categorias") or []:
            produto["categorias"].append({"nome": cat, "id_externo": None, "origem": "pagina", "ev": ev})
        familia, metodo = familia_de(list(ficha.get("categorias") or []), nome)
        if familia == "outro" and ficha.get("familia_equipamento"):
            familia, metodo = familia_de([], nome)
        produto["familia"], produto["familia_metodo"] = familia, metodo
        if ficha.get("codigo") or ficha.get("linha"):
            produto["modelos"].append({
                "codigo_fabricante": ficha.get("codigo"), "nome_modelo": None, "referencia": None,
                "ev": ev, "configuracoes": [],
            })
        for chave, rotulo in _CAMPOS:
            if ficha.get(chave) is None:
                continue
            produto["atributos"].append(montar_atributo(
                rotulo=rotulo, valor_original=str(ficha[chave]), familia=familia,
                secao="especificacoes_tecnicas", ev=ev,
            ))
        if ficha.get("descricao"):
            produto["textos"].append({"tipo": "descricao", "texto": ficha["descricao"], "ev": ev})
        marca = ctx.marca
        if marca and marca.lower() in sem_comentario(resp.texto).lower():
            produto["marca_declarada"] = campo(marca, ev)
        cta = _cta(resp.texto)
        if cta:
            produto["oferta"] = oferta(status="sob_consulta", ev=ev, cta=cta)
        else:
            produto["oferta"] = oferta(status="ausente", ev=ev)
        return produto


def _cta(html: str) -> str | None:
    limpo = sem_comentario(html)
    m = re.search(r"(?i)>\s*((?:adicionar ao orçamento|quero negociar|pedir orçamento))\s*<", limpo)
    return m.group(1) if m else None

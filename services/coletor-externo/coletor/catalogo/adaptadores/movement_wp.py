"""Movement: listagem `?pg=N` (fim = página 200 vazia) e ficha em tabela."""
from __future__ import annotations

import json
import re

from ..atributos import montar_atributo, norm_rotulo
from ..canonico import url_canonica
from ..contrato import Bloco, acrescentar_imagem, campo, fundir_bloco, novo_produto, oferta
from ..familia import familia_de
from ..htmlutil import sem_comentario, uma_linha
from ..rede import Resposta
from .base import AdaptadorBase, Ctx, ItemLista, PaginaLista

_ITEM = re.compile(
    r'(?s)<div class="catalog__item" data-product-id="(\d+)"[^>]*>(.*?)(?=<div class="catalog__item"|<div class="links">|$)',
)
_FAIXA_KMH = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(?:a|até|ate|–|—|-)\s*(\d+(?:[.,]\d+)?)\s*km\s*/?\s*h", re.I,
)
_HP = re.compile(r"(\d+(?:[.,]\d+)?)\s*hp", re.I)
_COR = {"opcoes de cor do chassi", "chassi", "cores pintura", "cor do chassi", "colunas"}
_VOLT = {"tensao", "voltagem"}
_ESTOFADO = {"cores estofamento", "cor do estofado"}


def _num(token: str):
    s = token.strip().replace(",", ".")
    valor = float(s)
    if abs(valor - round(valor)) < 1e-9:
        return int(round(valor))
    return valor


class Movement(AdaptadorBase):
    nome = "movement_wp"
    versao = "1"
    http_404_e_fim = False
    tamanho_pagina = 12

    def url_pagina(self, entrada: str, numero: int) -> str | None:
        base = entrada.split("?", 1)[0]
        if not base.endswith("/"):
            base += "/"
        if numero <= 1:
            return base
        return f"{base}?pg={numero}"

    def listar(self, resp: Resposta, entrada: str, ctx: Ctx) -> PaginaLista:
        html = resp.texto
        m = re.search(r'results--counter">\s*\[(\d+)\]', html)
        declarado = int(m.group(1)) if m else None
        vistos: set[str] = set()
        itens: list[ItemLista] = []
        for achou in _ITEM.finditer(html):
            pid = achou.group(1)
            if pid in vistos:
                continue
            link = re.search(r'href="(https://www\.movement\.com\.br/produto/[^"#?]+)', achou.group(2))
            if not link:
                continue
            vistos.add(pid)
            itens.append(ItemLista(
                url=url_canonica(link.group(1)), fonte=entrada,
                id_externo=pid, id_externo_tipo="wp_post_id",
            ))
        return PaginaLista(itens=itens, declarado=declarado, tamanho_pagina=self.tamanho_pagina)

    def detalhar(self, resp: Resposta, item: dict, ctx: Ctx) -> dict | None:
        html = resp.texto
        pid = item.get("id_externo") or _post_id(html)
        if not pid:
            return None
        bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, self.parser, ctx.coletado_em)
        nome_m = re.search(r'(?s)class="product__right__name"[^>]*>(.*?)</p>', html)
        nome = uma_linha(nome_m.group(1)) if nome_m else (item.get("nome") or "")
        if not nome:
            return None
        produto = novo_produto(
            fornecedor="movement", fontes=list(item.get("fontes") or [item.get("fonte") or ""]),
            id_externo_tipo="wp_post_id", id_externo=str(pid),
            url_canonica=url_canonica(item.get("url") or resp.url), url_validada=True, url_motivo=None,
            bloco=bloco,
        )
        produto["fontes"] = [f for f in produto["fontes"] if f]
        ev_nome = bloco.ev("nome", "p.product__right__name", nome)
        produto["nome"] = campo(nome, ev_nome)
        marca = _marca(html)
        if marca:
            ev = bloco.ev("marca", "og:site_name", marca)
            produto["marca_declarada"] = campo(marca, ev)
        categorias = _categorias(html)
        for cat in categorias:
            ev = bloco.ev("categoria", "BreadcrumbList", cat)
            produto["categorias"].append({"nome": cat, "id_externo": None, "origem": "breadcrumb", "ev": ev})
        ref = _referencia(html)
        linhas_tabela = _tabela(html)
        familia, metodo = familia_de(categorias + [v for r, v in linhas_tabela if norm_rotulo(r) == "segmento"], nome)
        produto["familia"], produto["familia_metodo"] = familia, metodo
        configs = []
        ev_modelo = ev_nome
        nome_modelo = None
        for rotulo, valor in linhas_tabela:
            ev = bloco.ev("especificacoes_tecnicas", "div.product__left__especs table tr", f"{rotulo} | {valor}")
            produto["atributos"].append(montar_atributo(
                rotulo=rotulo, valor_original=valor, familia=familia, secao="especificacoes_tecnicas", ev=ev,
            ))
            chave = norm_rotulo(rotulo)
            if chave == "linha" and valor:
                produto["linhas"].append({"nome": valor, "origem": "tabela", "ev": ev})
            elif chave == "modelo" and valor:
                nome_modelo = valor
                ev_modelo = ev
            elif chave == "garantia" and valor:
                produto["garantia"].append({"texto": valor, "nivel": "produto", "ev": ev})
            tipo_cfg = _tipo_config(chave)
            if tipo_cfg and valor:
                configs.append({
                    "tipo": tipo_cfg, "rotulo_original": rotulo, "valor_original": valor, "ev": ev,
                })
        if nome_modelo or ref or configs:
            produto["modelos"].append({
                "codigo_fabricante": None, "nome_modelo": nome_modelo, "referencia": ref,
                "ev": ev_modelo, "configuracoes": configs,
            })
        self._textos(produto, html, bloco)
        self._divergencias(produto, bloco)
        for i, src in enumerate(_imagens(html)):
            ev = bloco.ev("imagem", "img.product__left__gallery__image", src)
            acrescentar_imagem(produto, src, "principal" if i == 0 else "galeria", ev)
        for doc in _documentos(html):
            ev = bloco.ev("documento", "div.product__right__downloads a", doc["url"])
            produto["documentos"].append({**doc, "ev": ev})
        cta = _cta(html)
        if cta:
            ev = bloco.ev("oferta", "button.buy-btn", cta)
            produto["oferta"] = oferta(status="sob_consulta", ev=ev, cta=cta)
        else:
            ev = bloco.ev("oferta", "button.buy-btn", "sem preço visível")
            produto["oferta"] = oferta(status="ausente", ev=ev)
        return produto

    def _textos(self, produto: dict, html: str, bloco: Bloco) -> None:
        m = re.search(
            r'(?s)<div class="product__left__desc__content">(.*?)<div class="product__left__desc__right">', html,
        )
        if not m:
            return
        for paragrafo in re.findall(r"(?s)<p[^>]*>(.*?)</p>", m.group(1)):
            texto = uma_linha(paragrafo)
            if not texto:
                continue
            tipo = "diferenciais_linha" if _eh_marketing_linha(texto) else "descricao"
            ev = bloco.ev(tipo, "div.product__left__desc__content", texto)
            produto["textos"].append({"tipo": tipo, "texto": texto, "ev": ev})

    def _divergencias(self, produto: dict, bloco: Bloco) -> None:
        descricoes = [t for t in produto["textos"] if t["tipo"] == "descricao"]
        motor = next((a for a in produto["atributos"] if a.get("chave") == "motor"), None)
        for texto in descricoes:
            achou = _HP.search(texto["texto"])
            if not achou or not motor:
                continue
            token = achou.group(0)
            tabela = str(motor.get("valor_original") or "")
            if token.lower().replace(",", ".") in tabela.lower().replace(",", "."):
                continue
            produto["divergencias"].append({
                "chave": "motor", "secao_a": "descricao", "valor_a": token, "ev_a": texto["ev"],
                "secao_b": "especificacoes_tecnicas", "valor_b": tabela, "ev_b": motor["ev"],
            })
            break
        vel = next((a for a in produto["atributos"] if a.get("chave") == "velocidade_kmh"), None)
        if not vel or not isinstance(vel.get("valor"), dict):
            return
        for texto in descricoes:
            for a, b in _FAIXA_KMH.findall(texto["texto"]):
                faixa = {"min": _num(a), "max": _num(b)}
                if faixa != vel["valor"]:
                    produto["divergencias"].append({
                        "chave": "velocidade_kmh", "secao_a": "descricao", "valor_a": faixa, "ev_a": texto["ev"],
                        "secao_b": "especificacoes_tecnicas", "valor_b": vel["valor"], "ev_b": vel["ev"],
                    })
                    return

    def url_json(self, resp: Resposta, item: dict) -> str | None:
        link = ""
        for chave, valor in (resp.headers or {}).items():
            if chave.lower() == "link":
                link = valor
                break
        m = re.search(r"<([^>]+)>\s*;\s*rel=\"alternate\"", link)
        if m and "/wp-json/" in m.group(1) and "/product/" in m.group(1):
            return m.group(1)
        return None

    def aplicar_json(self, produto: dict, resp: Resposta, ctx: Ctx) -> dict:
        try:
            data = json.loads(resp.texto)
        except ValueError:
            return produto
        bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, self.parser, ctx.coletado_em)
        gmt = data.get("modified_gmt")
        bloco.ev("json_alternate", "modified_gmt", str(gmt or ""))
        novos = []
        for cid in data.get("product_cat") or []:
            sid = str(cid)
            if any(c.get("id_externo") == sid for c in produto["categorias"]):
                continue
            novos.append((sid, bloco.ev("json_alternate", "product_cat", sid)))
        mapa = fundir_bloco(produto, bloco)
        if isinstance(gmt, str) and gmt:
            produto["modificado_na_origem"] = gmt if gmt.endswith("Z") or "+" in gmt else gmt + "Z"
        for sid, ev in novos:
            produto["categorias"].append({
                "nome": None, "id_externo": sid, "origem": "json_alternate", "ev": mapa[ev],
            })
        return produto


def _post_id(html: str) -> str | None:
    m = re.search(r"[?&]p=(\d+)", html)
    return m.group(1) if m else None


def _marca(html: str) -> str | None:
    m = re.search(r'property="og:site_name"[^>]*content="([^"]+)"', html) or re.search(
        r'content="([^"]+)"[^>]*property="og:site_name"', html,
    )
    if not m:
        return None
    return m.group(1).strip() or None


def _categorias(html: str) -> list[str]:
    melhor: list[str] = []
    for bruto in re.findall(r'(?s)<script type="application/ld\+json"[^>]*>(.*?)</script>', html):
        try:
            data = json.loads(bruto)
        except ValueError:
            continue
        grafos = data.get("@graph") if isinstance(data, dict) else None
        candidatos = grafos if isinstance(grafos, list) else [data]
        for g in candidatos:
            if not isinstance(g, dict) or g.get("@type") != "BreadcrumbList":
                continue
            nomes = []
            for el in g.get("itemListElement") or []:
                item = el.get("item")
                nomes.append((item.get("name") if isinstance(item, dict) else None) or el.get("name"))
            nomes = [n for n in nomes if n]
            if len(nomes) > len(melhor):
                melhor = nomes
    if len(melhor) >= 2:
        return melhor[1:-1]
    return []


def _referencia(html: str) -> str | None:
    m = re.search(r'(?s)class="product__right__ref"[^>]*>(.*?)</p>', html)
    if not m:
        return None
    texto = re.sub(r"(?i)^ref\.\s*:\s*", "", uma_linha(m.group(1))).strip()
    return texto or None


def _tabela(html: str) -> list[tuple[str, str]]:
    m = re.search(r'(?s)<div class="product__left__especs".*?<table[^>]*>(.*?)</table>', html)
    if not m:
        return []
    pares = []
    for linha in re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", m.group(1)):
        celulas = [uma_linha(c) for c in re.findall(r"(?s)<t[dh][^>]*>(.*?)</t[dh]>", linha)]
        if len(celulas) >= 2 and celulas[0]:
            pares.append((celulas[0], celulas[1]))
    return pares


def _tipo_config(rotulo_norm: str) -> str | None:
    if rotulo_norm in _COR:
        return "cor_estrutura"
    if rotulo_norm in _VOLT:
        return "voltagem"
    if rotulo_norm in _ESTOFADO:
        return "cor_estofado"
    return None


def _eh_marketing_linha(texto: str) -> bool:
    t = texto.lower()
    return t.startswith("a linha ") or "as esteiras " in t or t.startswith("cada esteira da linha")


def _imagens(html: str) -> list[str]:
    return re.findall(r'<img[^>]*product__left__gallery__image[^>]*src="([^"]+)"', html)


def _documentos(html: str) -> list[dict]:
    m = re.search(r'(?s)<div class="product__right__downloads"[^>]*>(.*?)</div>\s*</div>', html)
    trecho = m.group(1) if m else ""
    if not trecho:
        m = re.search(r'(?s)product__right__downloads__list(.*)$', html)
        trecho = m.group(1)[:4000] if m else ""
    saida = []
    vistos = set()
    for url in re.findall(r'href="([^"]+\.pdf)"', trecho, re.I):
        if url in vistos:
            continue
        vistos.add(url)
        nome = url.rsplit("/", 1)[-1].lower()
        if "catalogo" in nome or "catálogo" in nome:
            saida.append({"url": url, "tipo": "catalogo", "nivel": "fornecedor"})
        else:
            saida.append({"url": url, "tipo": "manual", "nivel": "produto"})
    return saida


def _cta(html: str) -> str | None:
    limpo = sem_comentario(html)
    m = re.search(r'(?s)class="[^"]*buy-btn[^"]*"[^>]*>(.*?)</button>', limpo)
    if not m:
        return None
    texto = uma_linha(m.group(1))
    return texto or None

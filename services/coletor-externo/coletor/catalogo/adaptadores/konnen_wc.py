"""Konnen (WooCommerce): listagem `/page/N/` até 404 e ficha com COD + aba de descrição."""
from __future__ import annotations

import re
from html import unescape

from ..atributos import montar_atributo
from ..canonico import url_canonica
from ..contrato import Bloco, acrescentar_imagem, campo, novo_produto, oferta
from ..familia import familia_de
from ..htmlutil import sem_comentario, uma_linha
from ..rede import Resposta
from .base import AdaptadorBase, Ctx, ItemLista, PaginaLista

_CARD = re.compile(
    r'<a href="(https://www\.konnenfitness\.com\.br/produto/[^"#?]+/?)"[^>]*>\s*<div class="productline">',
    re.I,
)
_FAIXA_KMH = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(?:a|até|ate|–|—|-)\s*(\d+(?:[.,]\d+)?)\s*km\s*/?\s*h", re.I,
)
_PULAR_ROTULO = {"informações", "informacoes", "descrição", "descricao", "fale com um consultor"}


def _num(token: str):
    s = token.strip().replace(",", ".")
    valor = float(s)
    if abs(valor - round(valor)) < 1e-9:
        return int(round(valor))
    return valor


class Konnen(AdaptadorBase):
    nome = "konnen_wc"
    versao = "1"
    http_404_e_fim = True
    tamanho_pagina = 12
    teto_sem_declarado = 50

    def url_pagina(self, entrada: str, numero: int) -> str | None:
        base = entrada.split("?", 1)[0]
        base = re.sub(r"page/\d+/?$", "", base)
        if not base.endswith("/"):
            base += "/"
        if numero <= 1:
            return base
        return f"{base}page/{numero}/"

    def listar(self, resp: Resposta, entrada: str, ctx: Ctx) -> PaginaLista:
        if resp.status == 404:
            return PaginaLista(itens=[], declarado=None, tamanho_pagina=self.tamanho_pagina)
        vistos: set[str] = set()
        itens: list[ItemLista] = []
        html = resp.texto
        for achou in _CARD.finditer(html):
            url = url_canonica(achou.group(1))
            if url in vistos:
                continue
            vistos.add(url)
            trecho = html[achou.start():achou.start() + 1800]
            h3 = re.search(r"(?s)<h3[^>]*>(.*?)</h3>", trecho)
            nome = uma_linha(h3.group(1)) if h3 else None
            itens.append(ItemLista(url=url, fonte=entrada, nome=nome))
        return PaginaLista(itens=itens, declarado=None, tamanho_pagina=self.tamanho_pagina)

    def detalhar(self, resp: Resposta, item: dict, ctx: Ctx) -> dict | None:
        html = resp.texto
        pid = _post_id(html)
        if not pid:
            return None
        principal = html.split('class="related products"', 1)[0]
        bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, self.parser, ctx.coletado_em)
        h1_m = re.search(r"(?s)<h1[^>]*>(.*?)</h1>", principal)
        nome = uma_linha(h1_m.group(1)) if h1_m else (item.get("nome") or "")
        if not nome:
            return None
        produto = novo_produto(
            fornecedor="konnen", fontes=list(item.get("fontes") or [item.get("fonte") or ""]),
            id_externo_tipo="wp_post_id", id_externo=str(pid),
            url_canonica=url_canonica(item.get("url") or resp.url), url_validada=True, url_motivo=None,
            bloco=bloco,
        )
        produto["fontes"] = [f for f in produto["fontes"] if f]
        ev_nome = bloco.ev("nome", "h1", nome)
        produto["nome"] = campo(nome, ev_nome)
        if re.search(r"(?i)\bkonnen\b", principal):
            ev = bloco.ev("marca", "title", "Konnen")
            produto["marca_declarada"] = campo("Konnen", ev)
        declaracao = _declaracao(principal)
        if declaracao:
            ev = bloco.ev("declaracao_fabricante", "descricao", declaracao)
            produto["declaracao_fabricante"] = campo(declaracao, ev)
        categorias = _categorias(principal)
        for cat in categorias:
            ev = bloco.ev("categoria", "span.posted_in", cat)
            produto["categorias"].append({"nome": cat, "id_externo": None, "origem": "pagina", "ev": ev})
            if cat.lower().startswith("linha "):
                produto["linhas"].append({"nome": cat.split(" ", 1)[1].strip(), "origem": "pagina", "ev": ev})
        familia, metodo = familia_de(categorias, nome)
        produto["familia"], produto["familia_metodo"] = familia, metodo
        codigo = _codigo(principal)
        ev_cod = bloco.ev("modelo", "div.woocommerce-product-details__short-description", f"COD: {codigo or ''}")
        produto["modelos"].append({
            "codigo_fabricante": codigo, "nome_modelo": None, "referencia": None, "ev": ev_cod,
            "configuracoes": [],
        })
        for rotulo, valor in _pares_aba(html):
            if rotulo is None:
                ev = bloco.ev("especificacoes_tecnicas", "#tab-description", valor)
                produto["atributos"].append({
                    "chave": None, "rotulo_original": valor, "valor_original": valor, "valor": valor,
                    "unidade": None, "aplica_a": None, "secao": "especificacoes_tecnicas", "ev": ev,
                })
                continue
            ev = bloco.ev("especificacoes_tecnicas", "#tab-description strong", f"{rotulo}: {valor}")
            produto["atributos"].append(montar_atributo(
                rotulo=rotulo, valor_original=valor, familia=familia, secao="especificacoes_tecnicas", ev=ev,
            ))
            if rotulo.lower().rstrip(":") in {"voltagem", "tensão", "tensao"}:
                produto["modelos"][0]["configuracoes"].append({
                    "tipo": "voltagem", "rotulo_original": rotulo, "valor_original": valor, "ev": ev,
                })
        marketing = _marketing(principal)
        if marketing:
            ev = bloco.ev("marketing", "div.infosp", marketing[:300])
            produto["textos"].append({"tipo": "marketing", "texto": marketing, "ev": ev})
            self._divergencia_velocidade(produto, marketing, ev)
        cta = _cta(principal)
        if cta:
            ev = bloco.ev("oferta", "a.btn-primary", cta)
            produto["oferta"] = oferta(status="sob_consulta", ev=ev, cta=cta)
        else:
            ev = bloco.ev("oferta", "p.price", "sem preço")
            produto["oferta"] = oferta(status="ausente", ev=ev)
        for i, src in enumerate(_imagens(principal)):
            ev = bloco.ev("imagem", "data-large_image", src)
            acrescentar_imagem(produto, src, "principal" if i == 0 else "galeria", ev)
        return produto

    def _divergencia_velocidade(self, produto: dict, marketing: str, ev: str) -> None:
        vel = next((a for a in produto["atributos"] if a.get("chave") == "velocidade_kmh"), None)
        if not vel or not isinstance(vel.get("valor"), dict):
            return
        for a, b in _FAIXA_KMH.findall(marketing):
            faixa = {"min": _num(a), "max": _num(b)}
            if faixa.get("max") != vel["valor"].get("max"):
                produto["divergencias"].append({
                    "chave": "velocidade_kmh", "secao_a": "marketing", "valor_a": faixa, "ev_a": ev,
                    "secao_b": "especificacoes_tecnicas", "valor_b": vel["valor"], "ev_b": vel["ev"],
                })
                return


def _post_id(html: str) -> str | None:
    m = re.search(r"postid-(\d+)", html) or re.search(r"[?&]p=(\d+)", html)
    return m.group(1) if m else None


def _codigo(html: str) -> str | None:
    m = re.search(r"COD:\s*([A-Za-z0-9][A-Za-z0-9._-]*)", html)
    return m.group(1) if m else None


def _categorias(html: str) -> list[str]:
    m = re.search(r'(?s)<span class="posted_in">(.*?)</span>', html)
    if not m:
        return []
    return [uma_linha(n) for n in re.findall(r"(?s)<a[^>]*>(.*?)</a>", m.group(1)) if uma_linha(n)]


def _declaracao(html: str) -> str | None:
    m = re.search(r"Konnen by Impulse", html, re.I)
    return m.group(0) if m else None


def _pares_aba(html: str) -> list[tuple[str | None, str]]:
    m = re.search(r'(?s)id="tab-description"[^>]*>(.*?)(?:<section class="related|$)', html)
    if not m:
        return []
    frag = m.group(1)
    frag = re.sub(r"(?is)<strong>(.*?)</strong>", lambda x: "\n§L§" + uma_linha(x.group(1)) + "§\n", frag)
    frag = re.sub(r"(?i)<br\s*/?>", "\n", frag)
    frag = re.sub(r"(?i)</p>", "\n", frag)
    texto = uma_linha_preservando(frag)
    atual: list[str] | None = None
    pares: list[tuple[str | None, str]] = []
    for linha in texto:
        if linha.startswith("§L§"):
            if atual and atual[1]:
                pares.append((atual[0], atual[1]))
            rotulo = linha[len("§L§"):]
            if rotulo.endswith("§"):
                rotulo = rotulo[:-1]
            rotulo = rotulo.rstrip(":").strip()
            atual = [rotulo, ""]
            continue
        if not linha or linha.lower() in _PULAR_ROTULO:
            continue
        if atual is not None and not atual[1]:
            atual[1] = linha
        elif atual is not None and atual[1].endswith(","):
            atual[1] = (atual[1] + " " + linha).strip()
        else:
            if atual and atual[1]:
                pares.append((atual[0], atual[1]))
            atual = None
            pares.append((None, linha))
    if atual and atual[1]:
        pares.append((atual[0], atual[1]))
    return [(r, v) for r, v in pares if r is None or r.lower().rstrip(":") not in _PULAR_ROTULO]


def uma_linha_preservando(fragmento: str) -> list[str]:
    fragmento = re.sub(r"(?s)<!--.*?-->", " ", fragmento)
    fragmento = re.sub(r"<[^>]+>", " ", fragmento)
    fragmento = unescape(fragmento)
    return [re.sub(r"[ \t]+", " ", x).strip() for x in fragmento.splitlines() if x.strip()]


def _marketing(principal: str) -> str:
    # O texto de vitrine fica antes da aba. A aba entra só como especificação.
    corte = principal.split('id="tab-description"', 1)[0]
    m = re.search(r"(?s)<div class=\"[^\"]*infosp[^\"]*\".*?</div>\s*</div>", corte)
    trecho = m.group(0) if m else corte
    texto = uma_linha(trecho)
    if "km/h" in texto.lower() or "km/h" in texto:
        return texto
    # fallback: parágrafo que cita velocidade
    for p in re.findall(r"(?s)<p[^>]*>(.*?)</p>", corte):
        t = uma_linha(p)
        if re.search(r"km\s*/?\s*h", t, re.I):
            return t
    return ""


def _cta(html: str) -> str | None:
    """O botão da ficha é 'Adicionar ao orçamento'; o card da listagem diz 'Pedir orçamento'."""
    limpo = sem_comentario(html)
    limpo = re.split(r'class="related products"', limpo, maxsplit=1)[0]
    for frase in ("Adicionar ao orçamento", "Pedir orçamento", "Quero negociar"):
        if frase in limpo:
            return frase
    return None


def _imagens(principal: str) -> list[str]:
    galeria = principal.split('class="related products"', 1)[0]
    return re.findall(r'data-large_image="([^"]+)"', galeria)

"""Macsport: o catálogo inteiro está no payload RSC `produtosFiltrados` (dois esquemas de id)."""
from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter

from ..atributos import montar_atributo
from ..canonico import url_canonica
from ..contrato import Bloco, acrescentar_imagem, campo, fundir_bloco, novo_produto, oferta
from ..familia import familia_de
from ..htmlutil import sem_comentario, uma_linha
from ..rede import Resposta
from .base import Ctx, ItemLista, PaginaLista, AdaptadorBase

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_CARGA_NOME = re.compile(r"\(\s*a partir de\s*(\d+(?:[.,]\d+)?)\s*kg\s*\)", re.I)
_CODIGO = re.compile(r"Código:\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


def _slug(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")


def url_derivada(obj: dict) -> str:
    return "https://macsport.com.br/produto/" + _slug(obj.get("linha") or "") + "/" + _slug(obj.get("nome") or "")


def _extrair_array(html: str) -> list[dict]:
    marca = "self.__next_f.push("
    inicio = html.find(marca)
    if inicio < 0:
        return []
    arr, _ = json.JSONDecoder().raw_decode(html, inicio + len(marca))
    if not isinstance(arr, list) or len(arr) < 2 or not isinstance(arr[1], str):
        return []
    texto = arr[1]
    chave = texto.find('"produtosFiltrados":')
    if chave < 0:
        return []
    colchete = texto.find("[", chave)
    if colchete < 0:
        return []
    depth = 0
    dentro = False
    escape = False
    fim = None
    for i, ch in enumerate(texto[colchete:], colchete):
        if dentro:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                dentro = False
            continue
        if ch == '"':
            dentro = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                fim = i + 1
                break
    if fim is None:
        return []
    dados = json.loads(texto[colchete:fim])
    return dados if isinstance(dados, list) else []


def _pares_descricao(descricao: str) -> list[tuple[str, str]]:
    partes = re.split(r"(?<=\.)\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕ0-9])", (descricao or "").strip())
    pares = []
    for parte in partes:
        if ":" not in parte:
            continue
        rotulo, valor = parte.split(":", 1)
        rotulo, valor = rotulo.strip(), valor.strip().rstrip(".").strip()
        if rotulo and valor:
            pares.append((rotulo, valor))
    return pares


def _tipo_id(ident: str) -> str:
    return "uuid_payload" if _UUID.match(ident or "") else "id_payload"


class Macsport(AdaptadorBase):
    nome = "macsport_rsc"
    versao = "1"
    tamanho_pagina = 0
    teto_sem_declarado = 1

    def quer_detalhe(self, cfg: dict) -> bool:
        return bool(cfg.get("validar_detalhe", True))

    def url_pagina(self, entrada: str, numero: int) -> str | None:
        return entrada if numero == 1 else None

    def listar(self, resp: Resposta, entrada: str, ctx: Ctx) -> PaginaLista:
        objetos = _extrair_array(resp.texto)
        caminhos = [url_derivada(obj) for obj in objetos]
        repetidos = {caminho for caminho, n in Counter(caminhos).items() if n > 1}
        itens = []
        for obj in objetos:
            if obj.get("oculto") is True:
                continue
            ident = str(obj.get("id") or "")
            if not ident:
                continue
            url = url_canonica(url_derivada(obj))
            bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, self.parser, ctx.coletado_em)
            produto = self._produto(obj, url, entrada, bloco, url in repetidos)
            itens.append(ItemLista(url=url, fonte=entrada, id_externo=ident,
                                   id_externo_tipo=produto["id_externo_tipo"], produto=produto,
                                   nome=obj.get("nome")))
        return PaginaLista(itens=itens, declarado=len(itens), tamanho_pagina=len(itens) or None)

    def _produto(self, obj: dict, url: str, entrada: str, bloco: Bloco, compartilhada: bool) -> dict:
        ident = str(obj["id"])
        motivo = "url_compartilhada" if compartilhada else "derivada_nao_validada"
        produto = novo_produto(
            fornecedor="macsport", fontes=[entrada], id_externo_tipo=_tipo_id(ident), id_externo=ident,
            url_canonica=url, url_validada=False, url_motivo=motivo, bloco=bloco,
        )
        nome = (obj.get("nome") or obj.get("title") or "").strip()
        ev_nome = bloco.ev("nome", "produtosFiltrados.nome", nome)
        produto["nome"] = campo(nome, ev_nome)
        ev_marca = bloco.ev("marca", "payload", "Macsport")
        produto["marca_declarada"] = campo("Macsport", ev_marca)
        categoria = (obj.get("categoria") or "").strip()
        sub = (obj.get("category") or "").strip()
        nomes_cat = []
        if categoria:
            ev = bloco.ev("categoria", "produtosFiltrados.categoria", categoria)
            produto["categorias"].append({"nome": categoria, "id_externo": None, "origem": "payload", "ev": ev})
            nomes_cat.append(categoria)
        if sub and sub != categoria:
            ev = bloco.ev("categoria", "produtosFiltrados.category", sub)
            produto["categorias"].append({"nome": sub, "id_externo": None, "origem": "payload", "ev": ev})
            nomes_cat.append(sub)
        linha = (obj.get("linha") or "").strip()
        if linha:
            ev = bloco.ev("linha", "produtosFiltrados.linha", linha)
            produto["linhas"].append({"nome": linha, "origem": "payload", "ev": ev})
        familia, metodo = familia_de(nomes_cat, nome)
        produto["familia"], produto["familia_metodo"] = familia, metodo
        codigo = (obj.get("codigo") or "").strip() or None
        ev_cod = bloco.ev("modelo", "produtosFiltrados.codigo", codigo or "")
        produto["modelos"].append({
            "codigo_fabricante": codigo, "nome_modelo": None, "referencia": None, "ev": ev_cod,
            "configuracoes": [],
        })
        descricao = (obj.get("descricao") or "").strip()
        if descricao:
            ev_desc = bloco.ev("descricao", "produtosFiltrados.descricao", descricao[:300])
            produto["textos"].append({"tipo": "descricao", "texto": descricao, "ev": ev_desc})
            for rotulo, valor in _pares_descricao(descricao):
                ev = bloco.ev("especificacoes_tecnicas", "produtosFiltrados.descricao", f"{rotulo}: {valor}")
                produto["atributos"].append(montar_atributo(
                    rotulo=rotulo, valor_original=valor, familia=familia, secao="especificacoes_tecnicas", ev=ev,
                ))
        beneficios = (obj.get("beneficios") or "").strip()
        if beneficios:
            ev = bloco.ev("beneficios", "produtosFiltrados.beneficios", beneficios)
            produto["textos"].append({"tipo": "beneficios", "texto": beneficios, "ev": ev})
        self._divergencia_carga_nome(produto, nome, bloco)
        for papel, campo_img in (("principal", "imagem_url"), ("principal", "imageUrl"), ("uso", "como_usar_img")):
            url_img = (obj.get(campo_img) or "").strip()
            if url_img in {"", "#"}:
                continue
            ev = bloco.ev("imagem", f"produtosFiltrados.{campo_img}", url_img)
            acrescentar_imagem(produto, url_img, papel, ev)
        pdf = (obj.get("pdf_url") or "").strip()
        if pdf and pdf not in {"#"}:
            ev = bloco.ev("documento", "produtosFiltrados.pdf_url", pdf)
            produto["documentos"].append({"url": pdf, "tipo": "manual", "nivel": "produto", "ev": ev})
        # O payload não tem preço nem o botão de orçamento; o CTA entra no detalhe.
        ev_oferta = bloco.ev("oferta", "produtosFiltrados", "sem campo de preço")
        produto["oferta"] = oferta(status="ausente", ev=ev_oferta)
        return produto

    def _divergencia_carga_nome(self, produto: dict, nome: str, bloco: Bloco) -> None:
        achou = _CARGA_NOME.search(nome or "")
        if not achou:
            return
        do_nome = float(achou.group(1).replace(",", "."))
        if abs(do_nome - round(do_nome)) < 1e-9:
            do_nome = int(round(do_nome))
        ficha = next((a for a in produto["atributos"] if a.get("chave") == "carga_maxima_kg"), None)
        if not ficha or ficha.get("valor") == do_nome:
            return
        ev = bloco.ev("nome", "produtosFiltrados.nome", achou.group(0))
        produto["atributos"].append({
            "chave": "carga_maxima_kg", "rotulo_original": "nome", "valor_original": achou.group(0),
            "valor": do_nome, "unidade": "kg", "aplica_a": ["musculacao"], "secao": "nome", "ev": ev,
        })
        produto["divergencias"].append({
            "chave": "carga_maxima_kg", "secao_a": "nome", "valor_a": do_nome, "ev_a": ev,
            "secao_b": "especificacoes_tecnicas", "valor_b": ficha.get("valor"), "ev_b": ficha.get("ev"),
        })

    def detalhar(self, resp: Resposta, item: dict, ctx: Ctx) -> dict | None:
        base = item.get("produto_parcial") or item.get("produto")
        if not base:
            return None
        return aplicar_detalhe(base, resp, self.parser, ctx.coletado_em)


def aplicar_detalhe(produto: dict, resp: Resposta, parser: str, coletado_em: str) -> dict:
    """Confere h1 + Código, lê o CTA e guarda a garantia institucional fora dos atributos."""
    bloco = Bloco(resp.url_final or resp.url, resp.status, resp.corpo, parser, coletado_em)
    html = sem_comentario(resp.texto)
    h1_m = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", resp.texto)
    h1 = uma_linha(h1_m.group(1)) if h1_m else ""
    cod_m = _CODIGO.search(html)
    codigo_pagina = cod_m.group(1) if cod_m else None
    codigo_payload = (produto.get("modelos") or [{}])[0].get("codigo_fabricante")
    nome = (produto.get("nome") or {}).get("valor") or ""
    confere = bool(h1) and h1 == re.sub(r"\s+", " ", nome).strip() and codigo_pagina == codigo_payload
    if produto.get("url_motivo") == "url_compartilhada":
        produto["url_validada"] = False
    elif confere:
        produto["url_validada"] = True
        produto["url_motivo"] = None
    else:
        produto["url_validada"] = False
        produto["url_motivo"] = "detalhe_divergente"
    ev_oferta = None
    if "ADICIONAR AO ORÇAMENTO" in html:
        ev_oferta = bloco.ev("oferta", "button", "ADICIONAR AO ORÇAMENTO")
    garantia = _garantia_institucional(resp.texto)
    ev_gar = bloco.ev("garantia", "Certificado de Garantia", garantia) if garantia else None
    mapa = fundir_bloco(produto, bloco)
    if ev_oferta:
        produto["oferta"] = oferta(status="sob_consulta", ev=mapa[ev_oferta], cta="ADICIONAR AO ORÇAMENTO")
    if ev_gar:
        produto["garantia"].append({"texto": garantia, "nivel": "fornecedor", "ev": mapa[ev_gar]})
    return produto


def _garantia_institucional(html: str) -> str | None:
    m = re.search(r"(?is)Certificado.{0,80}Garantia.*?<ul[^>]*>(.*?)</ul>", html)
    if not m:
        return None
    itens = [uma_linha(li) for li in re.findall(r"(?is)<li[^>]*>(.*?)</li>", m.group(1))]
    texto = " ".join(i for i in itens if i)
    baixo = texto.lower()
    if "5 anos" in baixo and "estrutura" in baixo and "estofados" in baixo:
        return texto
    return None

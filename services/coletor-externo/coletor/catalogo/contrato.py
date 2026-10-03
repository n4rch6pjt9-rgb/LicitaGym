"""Contrato ProdutoColetado/1 e validação: campo com valor aponta para evidência existente."""
from __future__ import annotations

import re

from ..destino import sha256
from .canonico import url_arquivo

CONTRATO = "ProdutoColetado/1"
FAMILIAS = frozenset({"musculacao", "cardio", "acessorio", "outro"})
TIPOS_ID = frozenset({"uuid_payload", "id_payload", "wp_post_id", "url_validada"})
STATUS_PRECO = frozenset({"publicado", "sob_consulta", "ausente"})
_EV = re.compile(r"^e\d+$")


class ContratoError(ValueError):
    """Produto que não cumpre o contrato. Não é dado de licitação inventado: é recusa de gravar a ficha."""


class Bloco:
    """Evidências de uma resposta HTTP. O trecho fica em no máximo 300 caracteres."""

    def __init__(self, url: str, status: int, corpo: bytes, parser: str, coletado_em: str):
        self.url = url
        self.status = status
        self.parser = parser
        self.coletado_em = coletado_em
        self.sha = sha256(corpo or b"")
        self.evidencias: dict[str, dict] = {}
        self._n = 0

    def ev(self, secao: str, seletor: str, trecho: str) -> str:
        self._n += 1
        chave = f"e{self._n}"
        texto = re.sub(r"\s+", " ", trecho or "").strip()[:300]
        self.evidencias[chave] = {
            "url": self.url,
            "secao": secao,
            "seletor": seletor,
            "trecho": texto,
            "coletado_em": self.coletado_em,
            "http_status": self.status,
            "corpo_sha256": self.sha,
            "parser": self.parser,
        }
        return chave


def campo(valor, ev: str | None) -> dict | None:
    if valor is None:
        return None
    return {"valor": valor, "ev": ev}


def novo_produto(*, fornecedor: str, fontes: list[str], id_externo_tipo: str, id_externo: str,
                 url_canonica: str, url_validada: bool, url_motivo: str | None, bloco: Bloco) -> dict:
    return {
        "contrato": CONTRATO,
        "fornecedor": fornecedor,
        "fontes": list(fontes),
        "id_externo_tipo": id_externo_tipo,
        "id_externo": str(id_externo),
        "url_canonica": url_canonica,
        "url_validada": url_validada,
        "url_motivo": url_motivo,
        "nome": None,
        "marca_declarada": None,
        "declaracao_fabricante": None,
        "categorias": [],
        "linhas": [],
        "modelos": [],
        "familia": "outro",
        "familia_metodo": None,
        "atributos": [],
        "textos": [],
        "imagens": [],
        "documentos": [],
        "oferta": None,
        "garantia": [],
        "modificado_na_origem": None,
        "evidencias": bloco.evidencias,
        "divergencias": [],
    }


def fundir_bloco(produto: dict, bloco: Bloco) -> dict[str, str]:
    """Copia as evidências do bloco para o produto, sem reutilizar o número de outra página."""
    usados = []
    for chave in produto.get("evidencias") or {}:
        if chave.startswith("e") and chave[1:].isdigit():
            usados.append(int(chave[1:]))
    base = max(usados or [0])
    mapa: dict[str, str] = {}
    produto.setdefault("evidencias", {})
    for i, (chave, valor) in enumerate(list(bloco.evidencias.items()), start=1):
        nova = f"e{base + i}"
        mapa[chave] = nova
        produto["evidencias"][nova] = valor
    return mapa


def acrescentar_imagem(produto: dict, url: str | None, papel: str, ev: str) -> None:
    if not url or url.strip() in {"", "#"}:
        return
    arquivo = url_arquivo(url)
    if any(url_arquivo(img["url"]) == arquivo for img in produto["imagens"]):
        return
    if len(produto["imagens"]) >= 2:
        return
    if produto["imagens"] and papel == "principal":
        papel = "galeria"
    produto["imagens"].append({"url": url, "papel": papel, "variante": "original", "ev": ev})


def oferta(*, status: str, ev: str, cta: str | None = None, preco=None, moeda: str | None = None) -> dict:
    if status != "publicado":
        preco = None
        moeda = None
    return {"preco": preco, "moeda": moeda, "status_preco": status, "cta_texto": cta, "ev": ev}


def validar(produto: dict) -> None:
    if not isinstance(produto, dict) or produto.get("contrato") != CONTRATO:
        raise ContratoError("contrato ausente ou diferente de ProdutoColetado/1")
    evidencias = produto.get("evidencias") or {}
    if not isinstance(evidencias, dict) or not evidencias:
        raise ContratoError("evidencias vazias")
    if produto.get("familia") not in FAMILIAS:
        raise ContratoError(f"familia inválida: {produto.get('familia')}")
    if produto.get("id_externo_tipo") not in TIPOS_ID:
        raise ContratoError(f"id_externo_tipo inválido: {produto.get('id_externo_tipo')}")
    if not isinstance(produto.get("id_externo"), str) or not produto["id_externo"]:
        raise ContratoError("id_externo precisa ser texto")
    if not isinstance(produto.get("url_validada"), bool):
        raise ContratoError("url_validada precisa ser bool")
    fontes = produto.get("fontes")
    if not isinstance(fontes, list) or not fontes:
        raise ContratoError("fontes vazio")
    nome = produto.get("nome")
    if not isinstance(nome, dict) or not nome.get("valor"):
        raise ContratoError("nome ausente")
    imagens = produto.get("imagens") or []
    if len(imagens) > 2:
        raise ContratoError("mais de 2 imagens")
    oferta_ = produto.get("oferta")
    if not isinstance(oferta_, dict):
        raise ContratoError("oferta ausente")
    status = oferta_.get("status_preco")
    if status not in STATUS_PRECO:
        raise ContratoError(f"status_preco inválido: {status}")
    if status != "publicado" and oferta_.get("preco") is not None:
        raise ContratoError("preco preenchido sem status publicado")
    if status == "publicado" and not isinstance(oferta_.get("preco"), (int, float)):
        raise ContratoError("preco publicado sem número")
    if status == "sob_consulta" and not oferta_.get("cta_texto"):
        raise ContratoError("sob_consulta sem o texto do CTA")
    _andar(produto, evidencias, "produto")
    for i, div in enumerate(produto.get("divergencias") or []):
        for lado in ("ev_a", "ev_b"):
            ev = div.get(lado)
            if ev not in evidencias:
                raise ContratoError(f"divergencias[{i}].{lado} não aponta para evidência ({ev})")


def _andar(obj, evidencias: dict, caminho: str) -> None:
    if isinstance(obj, dict):
        if caminho == "produto.evidencias":
            return
        if "valor" in obj and obj.get("valor") is not None and obj.get("ev") not in evidencias:
            raise ContratoError(f"{caminho}.valor sem evidência ({obj.get('ev')})")
        elif "ev" in obj and obj.get("ev") not in evidencias:
            raise ContratoError(f"{caminho}.ev não aponta para evidência ({obj.get('ev')})")
        for chave, valor in obj.items():
            if chave == "evidencias":
                continue
            _andar(valor, evidencias, f"{caminho}.{chave}")
    elif isinstance(obj, list):
        for i, valor in enumerate(obj):
            _andar(valor, evidencias, f"{caminho}[{i}]")

"""Interface dos adaptadores de catálogo."""
from __future__ import annotations

from dataclasses import dataclass, field

from ..rede import Resposta


@dataclass
class ItemLista:
    url: str
    fonte: str
    id_externo: str | None = None
    id_externo_tipo: str | None = None
    produto: dict | None = None
    nome: str | None = None


@dataclass
class PaginaLista:
    itens: list[ItemLista] = field(default_factory=list)
    declarado: int | None = None
    tamanho_pagina: int | None = None


@dataclass
class Ctx:
    coletado_em: str
    marca: str
    fornecedor: str
    cfg: dict


class AdaptadorBase:
    nome = "base"
    versao = "1"
    http_404_e_fim = False
    tamanho_pagina = 12
    teto_sem_declarado = 50

    @property
    def parser(self) -> str:
        return f"{self.nome}@{self.versao}"

    def entradas(self, cfg: dict) -> list[str]:
        return list(cfg.get("entradas") or [])

    def url_pagina(self, entrada: str, numero: int) -> str | None:
        return entrada if numero == 1 else None

    def listar(self, resp: Resposta, entrada: str, ctx: Ctx) -> PaginaLista:
        raise NotImplementedError

    def detalhar(self, resp: Resposta, item: dict, ctx: Ctx) -> dict | None:
        raise NotImplementedError

    def quer_detalhe(self, cfg: dict) -> bool:
        return True

    def url_json(self, resp: Resposta, item: dict) -> str | None:
        return None

    def aplicar_json(self, produto: dict, resp: Resposta, ctx: Ctx) -> dict:
        return produto

"""Código CATMAT do item do PNCP para a classificação (pncp.avaliar, código antes do texto).

O PNCP manda em cada item `catalogo` ({id, nome}) e `catalogoCodigoItem`. Só o catálogo 1 ("Catálogo do
Compras.gov.br") usa CATMAT (material) / CATSER (serviço); o catálogo 2 ("Outros") traz o código próprio do órgão.
Em 03/10/2026, 233 dos 239 itens com código no banco eram do catálogo Outros (ex.: licitação 92, "BOLAS DE BASQUETE"
com 230525, que no CATMAT é CESTO) e CATSER divide o espaço numérico do CATMAT. Por isso o código só vale com
catálogo 1 e item de material ('M').

Regra (categoria_por_codigo):
  - código CATMAT válido e presente no mapa (RPC catmat_itens_mapa): o código decide. PDM no catálogo efetivo da
    empresa (RPC catalogo_catmat_pdms_efetivos) -> "catmat"; PDM fora -> None (o código diz que é outro produto,
    o texto não reabre);
  - sem código CATMAT válido, ou código fora do mapa (19 dos 41 PDMs do catálogo não têm itens nas tabelas CATMAT
    em 03/10/2026): não decide, quem chama usa o texto (escopo.classificar), como antes.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from .compras_pdms import carregar_pdms_efetivos

log = logging.getLogger("coletor.catmat_codigo")

RPC_ITENS_MAPA = "catmat_itens_mapa"
# catalogo.id do PNCP: 1 = Catálogo do Compras.gov.br (CATMAT/CATSER), 2 = Outros (código do órgão)
CATALOGO_COMPRAS_GOV = 1
_CODIGO = re.compile(r"\d{1,15}")


class MapaCatmatIndisponivel(RuntimeError):
    """Uma das RPCs do mapa falhou ou respondeu fora do contrato."""


@dataclass(frozen=True)
class MapaCatmat:
    """item CATMAT -> PDM (todos os itens conhecidos) e os PDMs do catálogo efetivo da empresa."""
    item_pdm: Mapping[int, int] = field(default_factory=dict)
    pdms_catalogo: frozenset[int] = frozenset()


def _inteiro(v) -> int | None:
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    return int(s) if _CODIGO.fullmatch(s) else None


def catalogo_id(it: dict) -> int | None:
    """catalogo.id do item: do PNCP (it["catalogo"]["id"]) ou de licitacao_itens (catalogoId / catalogo_id)."""
    cat = it.get("catalogo")
    if isinstance(cat, dict) and cat.get("id") is not None:
        return _inteiro(cat.get("id"))
    for chave in ("catalogoId", "catalogo_id"):
        if it.get(chave) is not None:
            return _inteiro(it.get(chave))
    return None


def codigo_catmat(it: dict, material_ou_servico: str | None) -> int | None:
    """Código CATMAT do item, ou None: só catálogo 1 (Compras.gov.br), material ('M') e número de até 15 dígitos."""
    if catalogo_id(it) != CATALOGO_COMPRAS_GOV or material_ou_servico != "M":
        return None
    return _inteiro(it.get("catalogoCodigoItem", it.get("catalogo_codigo_item")))


def categoria_por_codigo(it: dict, mapa: MapaCatmat | None,
                         material_ou_servico: str | None) -> tuple[bool, str | None]:
    """(decidido, categoria). decidido=False: o código não decide e quem chama usa o texto."""
    if mapa is None:
        return False, None
    codigo = codigo_catmat(it, material_ou_servico)
    if codigo is None:
        return False, None
    pdm = mapa.item_pdm.get(codigo)
    if pdm is None:
        return False, None
    return True, ("catmat" if pdm in mapa.pdms_catalogo else None)


def carregar_mapa_catmat(sb) -> MapaCatmat:
    """Lê as duas RPCs (GET paginado em rpc/catmat_itens_mapa; as duas são STABLE e só service_role executa)."""
    try:
        linhas = sb.selecionar(f"rpc/{RPC_ITENS_MAPA}", select="codigo_item,codigo_pdm", order="codigo_item.asc")
    except Exception as e:
        raise MapaCatmatIndisponivel(f"RPC {RPC_ITENS_MAPA} falhou: {e}") from e
    if not isinstance(linhas, list):
        raise MapaCatmatIndisponivel(f"RPC {RPC_ITENS_MAPA} respondeu {type(linhas).__name__}, esperado lista")
    item_pdm: dict[int, int] = {}
    for ln in linhas:
        item, pdm = (_inteiro(ln.get("codigo_item")), _inteiro(ln.get("codigo_pdm"))) if isinstance(ln, dict) else (None, None)
        if item is None or pdm is None:
            raise MapaCatmatIndisponivel(f"RPC {RPC_ITENS_MAPA}: linha inválida: {ln!r}")
        item_pdm.setdefault(item, pdm)
    try:
        pdms = frozenset(carregar_pdms_efetivos(sb))
    except Exception as e:
        raise MapaCatmatIndisponivel(str(e)) from e
    log.info("Mapa CATMAT: %d itens, %d PDMs no catálogo efetivo", len(item_pdm), len(pdms))
    return MapaCatmat(item_pdm=item_pdm, pdms_catalogo=pdms)


def carregar_mapa_catmat_ou_texto(sb) -> MapaCatmat | None:
    """Para os coletores: sem o mapa (RPC fora do ar), a classificação fica só pelo texto, como antes do código."""
    if sb is None:
        log.info("Sem Supabase (dry-run): classificação só pelo texto, sem código CATMAT")
        return None
    try:
        return carregar_mapa_catmat(sb)
    except MapaCatmatIndisponivel as e:
        log.warning("Mapa CATMAT indisponível, classificação só pelo texto: %s", str(e)[:200])
        return None

"""Código CATMAT do item do PNCP para a classificação (pncp.avaliar, código antes do texto).

O PNCP manda em cada item `catalogo` ({id, nome}) e `catalogoCodigoItem`. Só o catálogo 1 ("Catálogo do
Compras.gov.br") usa CATMAT (material) / CATSER (serviço); o catálogo 2 ("Outros") traz o código próprio do órgão.
Em 03/10/2026, 233 dos 239 itens com código no banco eram do catálogo Outros (ex.: licitação 92, "BOLAS DE BASQUETE"
com 230525, que no CATMAT é CESTO) e CATSER divide o espaço numérico do CATMAT. Por isso o código só vale com
catálogo 1 e item de material ('M').

Regra (categoria_por_codigo), a mesma de licitacoes_ids_por_catmat(p_somente_catalogo => true):
  - item incluído avulso no catálogo (catalogo_empresa_catmat nivel 'item', incluido): "catmat", mesmo com o PDM
    fora do catálogo efetivo e mesmo sem o item nas tabelas CATMAT;
  - código CATMAT válido e presente no mapa (RPC catmat_itens_mapa): o código decide. Item excluído no catálogo
    (nivel 'item', incluido = false) -> None, mesmo com o PDM incluído; PDM no catálogo efetivo da empresa
    (RPC catalogo_catmat_pdms_efetivos) -> "catmat"; PDM fora -> None (o código diz que é outro produto, o texto
    não reabre);
  - sem código CATMAT válido, ou código fora do mapa (19 dos 41 PDMs do catálogo não têm itens nas tabelas CATMAT
    em 03/10/2026): não decide, quem chama usa o texto (escopo.classificar), como antes.

Carga do mapa (carregar_mapa_catmat_se_houver_banco): sem banco nenhum -> None (só texto). Com banco, o mapa é
obrigatório: falha levanta MapaCatmatIndisponivel e o coletor/reclassificador aborta ANTES de gravar (erro de
infraestrutura não pode mudar a classificação em silêncio). O dry-run lê o mapa como a execução real, por um
cliente só leitura (LeituraMapaCatmat), para prever as mesmas transições.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from .compras_pdms import RPC_PDMS_EFETIVOS, carregar_pdms_efetivos

log = logging.getLogger("coletor.catmat_codigo")

RPC_ITENS_MAPA = "catmat_itens_mapa"
TABELA_CATALOGO = "catalogo_empresa_catmat"
# catalogo.id do PNCP: 1 = Catálogo do Compras.gov.br (CATMAT/CATSER), 2 = Outros (código do órgão)
CATALOGO_COMPRAS_GOV = 1
_CODIGO = re.compile(r"\d{1,15}")


class MapaCatmatIndisponivel(RuntimeError):
    """Uma das RPCs do mapa falhou ou respondeu fora do contrato."""


class LeituraMapaCatmat:
    """Cliente só leitura para carregar o mapa no dry-run: passa selecionar (GET) e a RPC STABLE do catálogo
    efetivo; qualquer outra chamada (upsert, atualizar, outra RPC...) levanta PermissionError."""

    RPCS_PERMITIDAS = frozenset({RPC_PDMS_EFETIVOS})

    def __init__(self, sb):
        self._sb = sb

    def selecionar(self, tabela: str, **filtros):
        return self._sb.selecionar(tabela, **filtros)

    def rpc(self, funcao: str, params: dict):
        if funcao not in self.RPCS_PERMITIDAS:
            raise PermissionError(f"dry-run: rpc {funcao} bloqueada (cliente somente leitura do mapa CATMAT)")
        return self._sb.rpc(funcao, params)

    def __getattr__(self, nome):
        raise PermissionError(f"dry-run: {nome} bloqueado (cliente somente leitura do mapa CATMAT)")


@dataclass(frozen=True)
class MapaCatmat:
    """item CATMAT -> PDM (todos os itens conhecidos), os PDMs do catálogo efetivo da empresa e as regras do
    catálogo no nível de item: avulsos incluídos (item -> PDM) e itens excluídos de um PDM herdado."""
    item_pdm: Mapping[int, int] = field(default_factory=dict)
    pdms_catalogo: frozenset[int] = frozenset()
    itens_avulsos: Mapping[int, int] = field(default_factory=dict)
    itens_excluidos: frozenset[int] = frozenset()


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
    if codigo in mapa.itens_avulsos:  # incluído avulso: vale mesmo com o PDM fora e sem o item no mapa
        return True, "catmat"
    pdm = mapa.item_pdm.get(codigo)
    if pdm is None:
        return False, None
    if codigo in mapa.itens_excluidos:  # excluído do PDM herdado: o código decide que não é do catálogo
        return True, None
    return True, ("catmat" if pdm in mapa.pdms_catalogo else None)


def _regras_de_item(sb) -> tuple[dict[int, int], frozenset[int]]:
    """(avulsos item -> PDM, excluídos) de catalogo_empresa_catmat nivel 'item' (GET pelo cliente do coletor)."""
    try:
        linhas = sb.selecionar(TABELA_CATALOGO, select="codigo_item,codigo_pdm,incluido", nivel="eq.item",
                               order="codigo_item.asc")
    except Exception as e:
        raise MapaCatmatIndisponivel(f"{TABELA_CATALOGO} (nível item) falhou: {e}") from e
    if not isinstance(linhas, list):
        raise MapaCatmatIndisponivel(f"{TABELA_CATALOGO} respondeu {type(linhas).__name__}, esperado lista")
    avulsos: dict[int, int] = {}
    excluidos: set[int] = set()
    for ln in linhas:
        ok = isinstance(ln, dict) and isinstance(ln.get("incluido"), bool)
        item, pdm = (_inteiro(ln.get("codigo_item")), _inteiro(ln.get("codigo_pdm"))) if ok else (None, None)
        if item is None or pdm is None:
            raise MapaCatmatIndisponivel(f"{TABELA_CATALOGO}: regra de item inválida: {ln!r}")
        if ln["incluido"]:
            avulsos[item] = pdm
        else:
            excluidos.add(item)
    return avulsos, frozenset(excluidos)


def carregar_mapa_catmat(sb) -> MapaCatmat:
    """Lê as duas RPCs (GET paginado em rpc/catmat_itens_mapa; as duas são STABLE e só service_role executa) e as
    regras de item do catálogo (GET em catalogo_empresa_catmat). Qualquer falha -> MapaCatmatIndisponivel."""
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
    avulsos, excluidos = _regras_de_item(sb)
    log.info("Mapa CATMAT: %d itens, %d PDMs no catálogo efetivo, %d itens avulsos, %d itens excluídos",
             len(item_pdm), len(pdms), len(avulsos), len(excluidos))
    return MapaCatmat(item_pdm=item_pdm, pdms_catalogo=pdms, itens_avulsos=avulsos, itens_excluidos=excluidos)


def carregar_mapa_catmat_se_houver_banco(sb) -> MapaCatmat | None:
    """Para o coletor e o reclassificador. sb None (sem banco nenhum): None, classificação só pelo texto.
    Com banco: o mapa é obrigatório; falha levanta MapaCatmatIndisponivel (quem chama aborta antes de gravar)."""
    if sb is None:
        log.warning("Sem Supabase: classificação só pelo texto, sem código CATMAT")
        return None
    return carregar_mapa_catmat(sb)

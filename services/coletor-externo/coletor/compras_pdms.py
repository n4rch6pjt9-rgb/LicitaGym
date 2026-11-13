"""PDMs efetivos e itens avulsos do catálogo da empresa para os coletores Compras.gov.

- PDMs efetivos: RPC catalogo_catmat_pdms_efetivos (regra de PDM, classe ou grupo incluída).
- Itens avulsos: regras de nível item incluídas cujo PDM não é efetivo (ex.: um item de piso sintético marcado sem
  incluir o PDM 10779 inteiro). A Pesquisa de Preço consulta esses itens um a um (tipo=codigoItemCatalogo); item de
  PDM efetivo já vem na consulta do PDM e não é repetido.

Sem fallback: se a RPC falhar ou responder fora do contrato, levanta CatalogoPdmsIndisponivel e a coleta
falha (nada de cair nos PDMs fixos e terminar com sucesso parcial). Lista vazia é resposta válida:
catálogo sem PDM incluído, nenhuma consulta é feita, e quem chama registra isso explicitamente.
"""
from __future__ import annotations

import logging

log = logging.getLogger("coletor.compras_pdms")

RPC_PDMS_EFETIVOS = "catalogo_catmat_pdms_efetivos"
TABELA_CATALOGO = "catalogo_empresa_catmat"


class CatalogoPdmsIndisponivel(RuntimeError):
    """A RPC de PDMs efetivos falhou ou respondeu fora do contrato."""


def carregar_pdms_efetivos(sb) -> list[int]:
    """Códigos PDM efetivos, na ordem da RPC e sem repetição. [] = catálogo vazio (válido)."""
    try:
        resposta = sb.rpc(RPC_PDMS_EFETIVOS, {})
    except Exception as e:  # rede, HTTP >= 300, JSON inválido
        raise CatalogoPdmsIndisponivel(f"RPC {RPC_PDMS_EFETIVOS} falhou: {e}") from e
    if not isinstance(resposta, list):
        raise CatalogoPdmsIndisponivel(
            f"RPC {RPC_PDMS_EFETIVOS} respondeu {type(resposta).__name__}, esperado lista")
    pdms: list[int] = []
    for linha in resposta:
        codigo = linha.get("codigo_pdm") if isinstance(linha, dict) else None
        if isinstance(codigo, bool) or codigo in (None, ""):
            raise CatalogoPdmsIndisponivel(f"RPC {RPC_PDMS_EFETIVOS}: linha sem codigo_pdm válido: {linha!r}")
        try:
            valor = int(codigo)
        except (TypeError, ValueError) as e:
            raise CatalogoPdmsIndisponivel(f"RPC {RPC_PDMS_EFETIVOS}: codigo_pdm inválido: {codigo!r}") from e
        if valor <= 0:
            raise CatalogoPdmsIndisponivel(f"RPC {RPC_PDMS_EFETIVOS}: codigo_pdm inválido: {codigo!r}")
        if valor not in pdms:
            pdms.append(valor)
    if pdms:
        log.info("Carregados %d PDMs efetivos do catálogo da empresa", len(pdms))
    else:
        log.warning("Catálogo de PDMs efetivos vazio: nenhuma consulta de PDM será feita")
    return pdms


def carregar_itens_avulsos(sb, pdms_efetivos: list[int]) -> list[int]:
    """Itens incluídos no catálogo (nível item) fora dos PDMs efetivos, em ordem crescente e sem repetição.

    Mesma regra de erro dos PDMs: leitura que falha ou linha fora do contrato levanta CatalogoPdmsIndisponivel.
    [] = nenhum item avulso (válido).
    """
    try:
        linhas = sb.selecionar(TABELA_CATALOGO, select="id,codigo_item,codigo_pdm", nivel="eq.item",
                               incluido="is.true")
    except Exception as e:  # rede, HTTP >= 300, JSON inválido
        raise CatalogoPdmsIndisponivel(f"leitura dos itens de {TABELA_CATALOGO} falhou: {e}") from e
    if not isinstance(linhas, list):
        raise CatalogoPdmsIndisponivel(
            f"leitura dos itens de {TABELA_CATALOGO} respondeu {type(linhas).__name__}, esperado lista")
    efetivos = set(pdms_efetivos)
    itens: set[int] = set()
    for linha in linhas:
        codigo = linha.get("codigo_item") if isinstance(linha, dict) else None
        if isinstance(codigo, bool) or not isinstance(codigo, int) or codigo <= 0:
            raise CatalogoPdmsIndisponivel(f"{TABELA_CATALOGO}: regra de item sem codigo_item válido: {linha!r}")
        if linha.get("codigo_pdm") in efetivos:
            continue
        itens.add(codigo)
    if itens:
        log.info("Carregados %d itens avulsos do catálogo da empresa (fora dos PDMs efetivos)", len(itens))
    return sorted(itens)

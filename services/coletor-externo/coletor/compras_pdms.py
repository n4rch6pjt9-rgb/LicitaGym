"""PDMs efetivos do catálogo da empresa (RPC catalogo_catmat_pdms_efetivos) para os coletores Compras.gov.

Sem fallback: se a RPC falhar ou responder fora do contrato, levanta CatalogoPdmsIndisponivel e a coleta
falha (nada de cair nos PDMs fixos e terminar com sucesso parcial). Lista vazia é resposta válida:
catálogo sem PDM incluído, nenhuma consulta é feita, e quem chama registra isso explicitamente.
"""
from __future__ import annotations

import logging

log = logging.getLogger("coletor.compras_pdms")

RPC_PDMS_EFETIVOS = "catalogo_catmat_pdms_efetivos"


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

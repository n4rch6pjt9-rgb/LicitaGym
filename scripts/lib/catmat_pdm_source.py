"""Fonte de PDMs e validação de envelope para coletores CATMAT E5/E6.

E5/E6 são consultados por codigoPdm. A lista de PDMs vem exclusivamente dos
resultados oficiais já coletados (E3, depois E4). Não há lista fixa nem seed de
curadoria como substituto: sem fonte oficial legível, a coleta falha.
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

E3_RESULT_FILES = (
    Path("collector_pdm_material_resultado.json"),
    Path("scripts/collector_pdm_material_resultado.json"),
)
E4_RESULT_FILES = (
    Path("collector_item_material_resultado.json"),
    Path("scripts/collector_item_material_resultado.json"),
)


class PdmSourceError(RuntimeError):
    """Nenhuma fonte oficial de PDMs disponível ou fonte ilegível."""


class InvalidEnvelopeError(ValueError):
    """Resposta HTTP 200 sem envelope `resultado` em formato de lista."""


def extract_resultado(resp: Any, context: str) -> List[Dict[str, Any]]:
    """Devolve `resultado` somente se for lista; qualquer outro formato é erro."""
    if not isinstance(resp, dict):
        raise InvalidEnvelopeError(f"{context}: resposta não é objeto JSON ({type(resp).__name__})")
    resultado = resp.get("resultado")
    if not isinstance(resultado, list):
        raise InvalidEnvelopeError(
            f"{context}: envelope sem lista 'resultado' (chaves: {sorted(resp.keys())})"
        )
    return resultado


def _pdms_from_file(path: Path, codigo_grupo: int) -> List[int]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise PdmSourceError(f"Fonte de PDMs ilegível: {path}: {e}") from e

    if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
        raise PdmSourceError(f"Fonte de PDMs sem objeto 'data': {path}")
    registros = data["data"].get(f"grupo_{codigo_grupo}")
    if registros is None:
        raise PdmSourceError(f"Fonte de PDMs sem chave grupo_{codigo_grupo}: {path}")
    if not isinstance(registros, list):
        raise PdmSourceError(f"grupo_{codigo_grupo} não é lista em {path}")

    return sorted({int(r["codigoPdm"]) for r in registros if isinstance(r, dict) and r.get("codigoPdm")})


def load_pdms_from_results(
    codigo_grupo: int,
    e3_files: Iterable[Path] = E3_RESULT_FILES,
    e4_files: Iterable[Path] = E4_RESULT_FILES,
) -> List[int]:
    """PDMs do grupo a partir do primeiro resultado E3 existente; senão E4.

    Lista vazia é resultado válido (a fonte oficial não tem PDMs para o grupo).
    Ausência de qualquer arquivo ou arquivo corrompido levanta PdmSourceError.
    """
    for source, files in (("E3", e3_files), ("E4", e4_files)):
        for path in files:
            if path.exists():
                pdms = _pdms_from_file(path, codigo_grupo)
                logger.info("PDMs G%s: %d de %s (%s)", codigo_grupo, len(pdms), source, path)
                return pdms
    raise PdmSourceError(
        f"Nenhum resultado E3/E4 encontrado para G{codigo_grupo}; rode os coletores E3/E4 antes de E5/E6."
    )


def resolve_pdms(
    codigo_grupo: int,
    codigo_pdm: Optional[int] = None,
    pdms: Optional[List[int]] = None,
) -> List[int]:
    if codigo_pdm is not None:
        return [codigo_pdm]
    if pdms is not None:
        return list(pdms)
    return load_pdms_from_results(codigo_grupo)

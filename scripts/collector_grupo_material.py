#!/usr/bin/env python3
"""
Collector: Endpoint 1 — consultarGrupoMaterial
Golden rule: apenas grupos 72 e 78
"""

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from scripts.lib.http_client import clamp_compras_gov_page_size
from scripts.lib.http_fetch import fetch_json, HttpFetchError
from scripts.lib.paginacao import acao_pagina
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-material/1_consultarGrupoMaterial"
TIMEOUT = 30
GRUPOS_PERMITIDOS = [72, 78]

def fetch_grupos(pagina: int = 1, tamanho_pagina: int = 100, max_retries: int = 3) -> Dict[str, Any]:
    """Consulta Grupos de Material com retry exponencial."""
    tamanho_pagina = clamp_compras_gov_page_size(tamanho_pagina)
    url = f"{BASE_URL}{ENDPOINT}?pagina={pagina}&tamanhoPagina={tamanho_pagina}"
    return fetch_json(
        url,
        timeout=TIMEOUT,
        max_retries=max_retries,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
    )

def collect_grupos(
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> List[Dict]:
    """Coleta todos os grupos (apenas 72, 78 da golden rule)."""
    logger.info("Coletando Grupos de Material...")

    if sync_manager is None:
        sync_manager = SyncStateManager("1_consultarGrupoMaterial")

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(resume=should_resume)

    todos_grupos: List[Dict] = []
    if should_resume and state.last_page > 0:
        # Reconstitute prior records on resume
        if isinstance(state.cursor, dict) and "grupos" in state.cursor:
            todos_grupos = list(state.cursor["grupos"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                todos_grupos = list(acc)
            else:
                # Try loading from collector_grupo_material_resultado.json
                out_path = Path("collector_grupo_material_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict) and isinstance(data.get("resultado"), list):
                            todos_grupos = list(data["resultado"])
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir de {out_path}: {e}")

        logger.info(f"Reconstituídos {len(todos_grupos)} registro(s) de execuções anteriores")

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    pages_coletadas = 0
    tamanho = clamp_compras_gov_page_size(100)
    vistos: set[str] = set()
    lidos = 0

    while True:
        try:
            resp = fetch_grupos(pagina=pagina, tamanho_pagina=tamanho)
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                cursor={"grupos": todos_grupos},
            )
            sync_manager.save_accumulated_data(todos_grupos)
            raise

        registros = resp.get("resultado") if isinstance(resp, dict) else None
        parar, incluir = acao_pagina(
            registros, resp if isinstance(resp, dict) else {},
            tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
        )
        if not incluir:
            break
        if not registros:
            logger.info("Fim da paginação")
            break
        lidos += len(registros)

        filtrados = 0
        for reg in registros:
            codigo_grupo = reg.get("codigoGrupo")
            if codigo_grupo in GRUPOS_PERMITIDOS:
                todos_grupos.append(reg)
                filtrados += 1

        pages_coletadas += 1
        logger.info(f"Página {pagina}: {len(registros)} registros ({filtrados} grupos fitness)")
        sync_manager.record_page_success(
            page=pagina,
            records_in_page=filtrados,
            cursor={"grupos": todos_grupos},
        )
        sync_manager.save_accumulated_data(todos_grupos)

        if parar:
            break
        if max_pages and pages_coletadas >= max_pages:
            logger.warning(f"Limite de {max_pages} página(s) atingido sem o total confirmar o fim")
            break

        pagina += 1

    total_records = len(todos_grupos)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    return todos_grupos

def main():
    try:
        grupos = collect_grupos()

        resultado = {
            "endpoint": "1_consultarGrupoMaterial",
            "total_coletados": len(grupos),
            "grupos_permitidos": GRUPOS_PERMITIDOS,
            "resultado": grupos,
        }

        output_file = "collector_grupo_material_resultado.json"
        with open(output_file, "w") as f:
            json.dump(resultado, f, indent=2)

        logger.info(f"\n✓ {len(grupos)} grupos coletados → {output_file}")

        por_grupo = {}
        for g in grupos:
            cg = g.get("codigoGrupo")
            por_grupo[cg] = por_grupo.get(cg, 0) + 1

        for cg in sorted(por_grupo.keys()):
            logger.info(f"  G{cg}: {por_grupo[cg]} registro(s)")

        return 0

    except Exception as e:
        logger.error(f"Falha: {e}")
        return 1

if __name__ == "__main__":
    exit(main())

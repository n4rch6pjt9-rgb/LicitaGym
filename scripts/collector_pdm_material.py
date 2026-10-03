#!/usr/bin/env python3
"""
Collector: Endpoint 3 — consultarPdmMaterial
Golden rule: apenas classes 7220 (G72) e 7830 (G78)
Coleta PDMs (Produtos Descritivos Básicos) por grupo e classe.
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
ENDPOINT = "/modulo-material/3_consultarPdmMaterial"
TIMEOUT = 30

# Golden rule
CLASSES_PERMITIDAS = {72: 7220, 78: 7830}

def fetch_pdms(
    codigo_grupo: Optional[int] = None,
    codigo_classe: Optional[int] = None,
    codigo_pdm: Optional[int] = None,
    status_pdm: Optional[bool] = None,
    pagina: int = 1,
    tamanho_pagina: int = 100
) -> Dict[str, Any]:
    """Consulta PDMs (Produtos Descritivos Básicos)"""
    tamanho_pagina = clamp_compras_gov_page_size(tamanho_pagina)
    url = f"{BASE_URL}{ENDPOINT}"

    params = {
        "pagina": pagina,
        "tamanhoPagina": tamanho_pagina,
    }

    if codigo_grupo is not None:
        params["codigoGrupo"] = codigo_grupo
    if codigo_classe is not None:
        params["codigoClasse"] = codigo_classe
    if codigo_pdm is not None:
        params["codigoPdm"] = codigo_pdm
    if status_pdm is not None:
        params["statusPdm"] = "true" if status_pdm else "false"

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="resultado",
    )

def collect_pdms_por_grupo_classe(
    codigo_grupo: int,
    codigo_classe: int,
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> List[Dict]:
    """Coleta todos PDMs de um grupo/classe específico com suporte a checkpoint e resume."""
    logger.info(f"\nColetando PDMs: G{codigo_grupo} classe {codigo_classe}...")

    if sync_manager is None:
        endpoint_key = f"3_consultarPdmMaterial_G{codigo_grupo}_C{codigo_classe}"
        sync_manager = SyncStateManager(endpoint_key)

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(
        resume=should_resume,
        metadata={"grupo": codigo_grupo, "classe": codigo_classe},
    )

    todos_pdms: List[Dict] = []
    if should_resume and state.last_page > 0:
        if isinstance(state.cursor, dict) and "pdms" in state.cursor:
            todos_pdms = list(state.cursor["pdms"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                todos_pdms = list(acc)
            else:
                out_path = Path("collector_pdm_material_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        key = f"grupo_{codigo_grupo}"
                        if isinstance(data, dict) and isinstance(data.get("data", {}).get(key), list):
                            todos_pdms = list(data["data"][key])
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir PDMs de {out_path}: {e}")

        logger.info(f"Reconstituídos {len(todos_pdms)} PDM(s) de execuções anteriores")

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    pages_coletadas = 0
    tamanho = clamp_compras_gov_page_size(100)
    vistos: set[str] = set()
    lidos = 0

    while True:
        try:
            resp = fetch_pdms(
                codigo_grupo=codigo_grupo,
                codigo_classe=codigo_classe,
                pagina=pagina,
                tamanho_pagina=tamanho
            )
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                error_details={"grupo": codigo_grupo, "classe": codigo_classe},
                cursor={"pdms": todos_pdms},
            )
            sync_manager.save_accumulated_data(todos_pdms)
            raise

        pdms = resp.get("resultado") if isinstance(resp, dict) else None
        parar, incluir = acao_pagina(
            pdms, resp if isinstance(resp, dict) else {},
            tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
        )
        if incluir and pdms:
            lidos += len(pdms)
            logger.info(f"  Página {pagina}: {len(pdms)} PDMs")
            todos_pdms.extend(pdms)
            pages_coletadas += 1
            sync_manager.record_page_success(
                page=pagina,
                records_in_page=len(pdms),
                cursor={"pdms": todos_pdms},
            )
            sync_manager.save_accumulated_data(todos_pdms)
        if not incluir or parar:
            break
        if max_pages and pages_coletadas >= max_pages:
            logger.warning("teto de %s páginas atingido sem o total confirmar o fim", max_pages)
            break

        pagina += 1

    total_records = len(todos_pdms)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    logger.info(f"  Total: {len(todos_pdms)} PDMs")
    return todos_pdms

def main():
    logger.info("=== COLLECTOR: Endpoint 3 — PDM Material ===")
    logger.info("Golden rule: apenas 7220 (G72) e 7830 (G78)\n")

    try:
        resultado = {}

        for grupo, classe in CLASSES_PERMITIDAS.items():
            key = f"grupo_{grupo}"
            pdms = collect_pdms_por_grupo_classe(grupo, classe)
            resultado[key] = pdms

        # Salva
        output = {
            "endpoint": "3_consultarPdmMaterial",
            "golden_rule": "apenas 7220 (G72) e 7830 (G78)",
            "data": resultado,
            "resumo": {
                "total_grupo_72": len(resultado.get("grupo_72", [])),
                "total_grupo_78": len(resultado.get("grupo_78", [])),
            }
        }

        with open("collector_pdm_material_resultado.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Salvo: collector_pdm_material_resultado.json")
        logger.info(f"  G72: {output['resumo']['total_grupo_72']} PDMs")
        logger.info(f"  G78: {output['resumo']['total_grupo_78']} PDMs")
        return 0
    except Exception as e:
        logger.error(f"Falha na coleta de PDMs: {e}")
        return 1

if __name__ == "__main__":
    exit(main())

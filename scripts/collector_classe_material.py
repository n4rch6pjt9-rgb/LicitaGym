#!/usr/bin/env python3
"""
Collector: Endpoint 2 — consultarClasseMaterial
Golden rule: apenas classes 7220 (G72) e 7830 (G78)
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
ENDPOINT = "/modulo-material/2_consultarClasseMaterial"
TIMEOUT = 30

# Golden rule: apenas estas classes
CLASSES_PERMITIDAS = {72: 7220, 78: 7830}

def fetch_classes(
    codigo_grupo: Optional[int] = None,
    codigo_classe: Optional[int] = None,
    status_classe: Optional[bool] = None,
    pagina: int = 1,
    tamanho_pagina: int = 100
) -> Dict[str, Any]:
    """Consulta classes de material"""
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
    if status_classe is not None:
        params["statusClasse"] = "true" if status_classe else "false"

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="resultado",
    )

def collect_classes(
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> Dict[str, List[Dict]]:
    """Coleta classes com suporte a checkpoint e resume."""
    if sync_manager is None:
        sync_manager = SyncStateManager("2_consultarClasseMaterial")

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(resume=should_resume)

    completed_keys: List[str] = []
    resultado: Dict[str, List[Dict]] = {}
    if should_resume:
        # Resume previously fetched classes if available
        if isinstance(state.cursor, dict):
            completed_keys = state.cursor.get("completed_keys", [])
            resultado = state.cursor.get("resultado", {})
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, dict):
                resultado = acc.get("resultado", {})
                completed_keys = acc.get("completed_keys", list(resultado.keys()))
            else:
                out_path = Path("collector_classe_material_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict) and isinstance(data.get("data"), dict):
                            resultado = dict(data["data"])
                            completed_keys = list(resultado.keys())
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir classes de {out_path}: {e}")

    total_records = sum(len(v) for v in resultado.values())

    for idx, (grupo, classe) in enumerate(CLASSES_PERMITIDAS.items(), 1):
        key = f"grupo_{grupo}"
        if should_resume and key in completed_keys:
            logger.info(f"G{grupo} classe {classe} já coletada no checkpoint anterior, pulando.")
            continue

        logger.info(f"G{grupo} classe {classe}...")
        classes: List[Dict] = []
        pagina = 1
        tamanho = clamp_compras_gov_page_size(100)
        vistos: set[str] = set()
        lidos = 0
        while True:
            try:
                resp = fetch_classes(codigo_grupo=grupo, codigo_classe=classe, pagina=pagina, tamanho_pagina=tamanho)
            except Exception as e:
                sync_manager.record_partial_failure(
                    e,
                    page=idx,
                    error_details={"grupo": grupo, "classe": classe},
                    cursor={"completed_keys": completed_keys, "resultado": resultado},
                )
                sync_manager.save_accumulated_data({"completed_keys": completed_keys, "resultado": resultado})
                raise
            lote = resp.get("resultado") if isinstance(resp, dict) else None
            parar, incluir = acao_pagina(
                lote, resp if isinstance(resp, dict) else {},
                tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
            )
            if incluir and lote:
                lidos += len(lote)
                classes.extend(lote)
            if not incluir or parar:
                break
            pagina += 1
        resultado[key] = classes
        completed_keys.append(key)
        total_records += len(classes)
        logger.info(f"  {len(classes)} record(s)")

        sync_manager.record_page_success(
            page=idx,
            records_in_page=len(classes),
            cursor={"completed_keys": completed_keys, "resultado": resultado},
        )
        sync_manager.save_accumulated_data({"completed_keys": completed_keys, "resultado": resultado})

    sync_manager.record_completed(total_records=total_records)
    return resultado

def main():
    logger.info("=== COLLECTOR: Endpoint 2 — Classe Material ===")
    logger.info("Golden rule: apenas 7220 (G72) e 7830 (G78)\n")

    try:
        resultado = collect_classes()

        # Salva
        output = {
            "endpoint": "2_consultarClasseMaterial",
            "golden_rule": "apenas 7220 (G72) e 7830 (G78)",
            "data": resultado
        }

        with open("collector_classe_material_resultado.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Salvo: collector_classe_material_resultado.json")
        return 0
    except Exception as e:
        logger.error(f"Falha na coleta de classes: {e}")
        return 1

if __name__ == "__main__":
    exit(main())

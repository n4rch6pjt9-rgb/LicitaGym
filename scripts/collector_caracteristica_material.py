#!/usr/bin/env python3
"""
Collector: Endpoint 7 — consultarMaterialCaracteristicas
Golden rule: apenas classes 7220 (G72) e 7830 (G78)
Coleta Características com retry exponencial para rate-limiting.
"""

import json
import logging
from pathlib import Path
import time
from typing import Any, Dict, List, Optional
from scripts.lib.http_client import clamp_compras_gov_page_size
from scripts.lib.http_fetch import fetch_json, HttpFetchError
from scripts.lib.paginacao import acao_pagina
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-material/7_consultarMaterialCaracteristicas"
TIMEOUT = 30

CLASSES_PERMITIDAS = {72: 7220, 78: 7830}

def fetch_caracteristicas(
    codigo_item: int,
    codigo_caracteristica: Optional[int] = None,
    pagina: int = 1,
    tamanho_pagina: int = 100,
    max_retries: int = 3
) -> Dict[str, Any]:
    """Consulta Características por Item (golden rule: E7 ignora grupo/classe)."""
    tamanho_pagina = clamp_compras_gov_page_size(tamanho_pagina)
    url = f"{BASE_URL}{ENDPOINT}"

    params = {
        "pagina": pagina,
        "tamanhoPagina": tamanho_pagina,
        "codigoItem": codigo_item,  # OBRIGATÓRIO: endpoint 7 não filtra por grupo/classe
    }

    if codigo_caracteristica is not None:
        params["codigoCaracteristica"] = codigo_caracteristica

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        max_retries=max_retries,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="resultado",
    )

def collect_caracteristicas_por_item(
    codigo_item: int,
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> List[Dict]:
    """Coleta todas características de um item específico com suporte a checkpoint e resume."""
    if sync_manager is None:
        endpoint_key = f"7_consultarMaterialCaracteristicas_item_{codigo_item}"
        sync_manager = SyncStateManager(endpoint_key)

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(
        resume=should_resume,
        metadata={"codigo_item": codigo_item},
    )

    todas_caracteristicas: List[Dict] = []
    if should_resume and state.last_page > 0:
        if isinstance(state.cursor, dict) and "caracteristicas" in state.cursor:
            todas_caracteristicas = list(state.cursor["caracteristicas"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                todas_caracteristicas = list(acc)
            else:
                out_path = Path("collector_caracteristica_material_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        key = f"item_{codigo_item}"
                        if isinstance(data, dict) and isinstance(data.get("data", {}).get(key), list):
                            todas_caracteristicas = list(data["data"][key])
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir caracteristicas de {out_path}: {e}")

        logger.info(f"Reconstituídas {len(todas_caracteristicas)} característica(s) de execuções anteriores")

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    pages_coletadas = 0
    tamanho = clamp_compras_gov_page_size(100)
    vistos: set[str] = set()
    lidos = 0

    while True:
        try:
            resp = fetch_caracteristicas(
                codigo_item=codigo_item,
                pagina=pagina,
                tamanho_pagina=tamanho
            )
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                error_details={"codigo_item": codigo_item},
                cursor={"caracteristicas": todas_caracteristicas},
            )
            sync_manager.save_accumulated_data(todas_caracteristicas)
            raise

        caracteristicas = resp.get("resultado") if isinstance(resp, dict) else None
        parar, incluir = acao_pagina(
            caracteristicas, resp if isinstance(resp, dict) else {},
            tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
        )
        if not incluir:
            break
        if not caracteristicas:
            logger.info(f"  Página {pagina}: vazio")
            break
        lidos += len(caracteristicas)

        logger.info(f"  Página {pagina}: {len(caracteristicas)} características")
        todas_caracteristicas.extend(caracteristicas)
        pages_coletadas += 1
        sync_manager.record_page_success(
            page=pagina,
            records_in_page=len(caracteristicas),
            cursor={"caracteristicas": todas_caracteristicas},
        )
        sync_manager.save_accumulated_data(todas_caracteristicas)

        if parar:
            break
        if max_pages and pages_coletadas >= max_pages:
            logger.warning("teto de %s páginas atingido sem o total confirmar o fim", max_pages)
            break

        pagina += 1
        time.sleep(0.5)

    total_records = len(todas_caracteristicas)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    logger.info(f"  Total: {len(todas_caracteristicas)} características (item {codigo_item})")
    return todas_caracteristicas

def main():
    logger.info("=== COLLECTOR: Endpoint 7 — Característica Material ===")
    logger.info("Golden rule: E7 filtra por Item (codigoItem obrigatório)\n")

    # Carrega items reais de E4
    items_reais = []
    try:
        with open("collector_item_material_resultado.json", encoding="utf-8") as f:
            items_data = json.load(f)

        for grupo_key in ["grupo_72", "grupo_78"]:
            items_reais.extend([item["codigoItem"] for item in items_data["data"].get(grupo_key, [])])

        logger.info(f"Total items carregados: {len(items_reais)}")

    except FileNotFoundError:
        logger.warning("E4 não encontrado. Usando sample (item 374066).")
        items_reais = [374066]

    main_sync = SyncStateManager("7_consultarMaterialCaracteristicas")
    should_resume = is_sync_resume_enabled()
    state = main_sync.start_run(resume=should_resume)

    completed_items = []
    resultado = {}
    if should_resume:
        if isinstance(state.cursor, dict):
            completed_items = state.cursor.get("completed_items", [])
            resultado = state.cursor.get("resultado", {})
        else:
            acc = main_sync.load_accumulated_data()
            if isinstance(acc, dict):
                resultado = acc.get("resultado", {})
                completed_items = acc.get("completed_items", [int(k.replace("item_", "")) for k in resultado.keys() if k.startswith("item_")])
            else:
                out_path = Path("collector_caracteristica_material_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict) and isinstance(data.get("data"), dict):
                            resultado = dict(data["data"])
                            completed_items = [int(k.replace("item_", "")) for k in resultado.keys() if k.startswith("item_")]
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir características de {out_path}: {e}")

    try:
        for i, codigo_item in enumerate(items_reais, 1):
            if should_resume and codigo_item in completed_items:
                logger.info(f"Item {codigo_item} já coletado anteriormente, pulando.")
                continue

            if i % 100 == 0:
                logger.info(f"  [{i}/{len(items_reais)}] processado...")

            try:
                caracteristicas = collect_caracteristicas_por_item(codigo_item, max_pages=None)
            except Exception as e:
                main_sync.record_partial_failure(
                    e,
                    page=i,
                    error_details={"codigo_item": codigo_item},
                    cursor={"completed_items": completed_items, "resultado": resultado},
                )
                main_sync.save_accumulated_data({"completed_items": completed_items, "resultado": resultado})
                raise

            resultado[f"item_{codigo_item}"] = caracteristicas
            completed_items.append(codigo_item)
            main_sync.record_page_success(
                page=i,
                records_in_page=len(caracteristicas),
                cursor={"completed_items": completed_items, "resultado": resultado},
            )
            main_sync.save_accumulated_data({"completed_items": completed_items, "resultado": resultado})

        main_sync.record_completed(total_records=sum(len(v) for v in resultado.values()))

        output = {
            "endpoint": "7_consultarMaterialCaracteristicas",
            "golden_rule": "E7 filtra por codigoItem (não grupo/classe)",
            "data": resultado,
            "resumo": {
                "total_items": len(items_reais),
                "total_caracteristicas_coletadas": sum(len(v) for v in resultado.values())
            }
        }

        with open("collector_caracteristica_material_resultado.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Salvo: collector_caracteristica_material_resultado.json")
        logger.info(f"  Items: {output['resumo']['total_items']}")
        logger.info(f"  Características: {output['resumo']['total_caracteristicas_coletadas']}")
        return 0

    except Exception as e:
        logger.error(f"Falha na coleta de características: {e}")
        return 1

if __name__ == "__main__":
    exit(main())

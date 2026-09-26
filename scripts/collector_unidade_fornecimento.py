#!/usr/bin/env python3
"""
Collector: Endpoint 6 — consultarMaterialUnidadeFornecimento
Golden rule: apenas classes 7220 (G72) e 7830 (G78)
Coleta Unidades de Fornecimento com retry exponencial para rate-limiting.
"""

import json
import logging
from pathlib import Path
import time
from typing import Any, Dict, List, Optional
from scripts.lib.catmat_pdm_source import extract_resultado, resolve_pdms
from scripts.lib.http_fetch import fetch_json, HttpFetchError
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-material/6_consultarMaterialUnidadeFornecimento"
TIMEOUT = 30

CLASSES_PERMITIDAS = {72: 7220, 78: 7830}

def fetch_unidades(
    codigo_grupo: Optional[int] = None,
    codigo_classe: Optional[int] = None,
    codigo_pdm: Optional[int] = None,
    codigo_item: Optional[int] = None,
    codigo_unidade: Optional[int] = None,
    pagina: int = 1,
    tamanho_pagina: int = 500,
    max_retries: int = 3
) -> Dict[str, Any]:
    """Consulta Unidades de Fornecimento com retry exponencial.
    Conforme schema Compras.gov (schemas-consultas.md §1.6), E6 aceita codigoPdm.
    """
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
    if codigo_item is not None:
        params["codigoItem"] = codigo_item
    if codigo_unidade is not None:
        params["codigoUnidade"] = codigo_unidade

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        max_retries=max_retries,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
    )

def collect_unidades_por_pdm(
    codigo_pdm: int,
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> List[Dict]:
    """Coleta unidades de fornecimento associadas a um PDM específico."""
    logger.info(f"  Coletando unidades para PDM {codigo_pdm}...")
    if sync_manager is None:
        endpoint_key = f"6_consultarMaterialUnidadeFornecimento_pdm_{codigo_pdm}"
        sync_manager = SyncStateManager(endpoint_key)

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(
        resume=should_resume,
        metadata={"codigo_pdm": codigo_pdm},
    )

    todas_unidades: List[Dict] = []
    if should_resume and state.last_page > 0:
        if isinstance(state.cursor, dict) and "unidades" in state.cursor:
            todas_unidades = list(state.cursor["unidades"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                todas_unidades = list(acc)

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    pages_coletadas = 0

    while True:
        try:
            resp = fetch_unidades(
                codigo_pdm=codigo_pdm,
                pagina=pagina,
                tamanho_pagina=500,
            )
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                error_details={"codigo_pdm": codigo_pdm},
                cursor={"unidades": todas_unidades},
            )
            sync_manager.save_accumulated_data(todas_unidades)
            raise

        unidades = extract_resultado(resp, f"E6 pdm={codigo_pdm} pagina={pagina}")
        if not unidades:
            break

        todas_unidades.extend(unidades)
        pages_coletadas += 1
        sync_manager.record_page_success(
            page=pagina,
            records_in_page=len(unidades),
            cursor={"unidades": todas_unidades},
        )
        sync_manager.save_accumulated_data(todas_unidades)

        if max_pages and pages_coletadas >= max_pages:
            break

        if resp.get("paginasRestantes", 0) == 0:
            break

        pagina += 1
        time.sleep(0.5)

    total_records = len(todas_unidades)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    return todas_unidades


def collect_unidades_por_grupo_classe(
    codigo_grupo: int,
    codigo_classe: int,
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
    codigo_pdm: Optional[int] = None,
    pdms: Optional[List[int]] = None,
    use_pdm_iteration: Optional[bool] = None,
) -> List[Dict]:
    """Coleta unidades de fornecimento de um grupo/classe específico.
    Se use_pdm_iteration=True ou (use_pdm_iteration is None e sync_manager is None e codigo_pdm/pdms fornecidos ou encontrados),
    itera por PDM conforme padrão Compras.gov Dados Abertos (schemas-consultas.md §1.6).
    Se sync_manager for explicitamente passado sem codigo_pdm/pdms, opera em modo endpoint direto grupo/classe com esse sync_manager.
    """
    logger.info(f"\nColetando Unidades Fornecimento: G{codigo_grupo} classe {codigo_classe}...")

    # Se sync_manager foi fornecido explicitamente sem PDMs, manter modo clássico grupo/classe usando o sync_manager
    should_iterate_pdm = use_pdm_iteration
    if should_iterate_pdm is None:
        if sync_manager is not None and codigo_pdm is None and pdms is None:
            should_iterate_pdm = False
        else:
            should_iterate_pdm = True

    if should_iterate_pdm:
        lista_pdms = resolve_pdms(codigo_grupo, codigo_pdm=codigo_pdm, pdms=pdms)
        logger.info(f"Iterando {len(lista_pdms)} PDM(s) para G{codigo_grupo}/C{codigo_classe}...")
        todas: List[Dict] = []
        for pdm in lista_pdms:
            unis = collect_unidades_por_pdm(pdm, max_pages=max_pages, resume=resume, sync_manager=sync_manager if len(lista_pdms) == 1 else None)
            todas.extend(unis)
        return todas

    if sync_manager is None:
        endpoint_key = f"6_consultarMaterialUnidadeFornecimento_G{codigo_grupo}_C{codigo_classe}"
        sync_manager = SyncStateManager(endpoint_key)

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(
        resume=should_resume,
        metadata={"grupo": codigo_grupo, "classe": codigo_classe},
    )

    todas_unidades: List[Dict] = []
    if should_resume and state.last_page > 0:
        if isinstance(state.cursor, dict) and "unidades" in state.cursor:
            todas_unidades = list(state.cursor["unidades"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                todas_unidades = list(acc)
            else:
                out_path = Path("collector_unidade_fornecimento_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        key = f"grupo_{codigo_grupo}"
                        if isinstance(data, dict) and isinstance(data.get("data", {}).get(key), list):
                            todas_unidades = list(data["data"][key])
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir unidades de {out_path}: {e}")

        logger.info(f"Reconstituídas {len(todas_unidades)} unidade(s) de execuções anteriores")

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    pages_coletadas = 0

    while True:
        try:
            resp = fetch_unidades(
                codigo_grupo=codigo_grupo,
                codigo_classe=codigo_classe,
                pagina=pagina,
                tamanho_pagina=500
            )
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                error_details={"grupo": codigo_grupo, "classe": codigo_classe},
                cursor={"unidades": todas_unidades},
            )
            sync_manager.save_accumulated_data(todas_unidades)
            raise

        unidades = extract_resultado(resp, f"E6 G{codigo_grupo}/C{codigo_classe} pagina={pagina}")

        if not unidades:
            logger.info(f"  Página {pagina}: vazio")
            break

        logger.info(f"  Página {pagina}: {len(unidades)} unidades")
        todas_unidades.extend(unidades)
        pages_coletadas += 1
        sync_manager.record_page_success(
            page=pagina,
            records_in_page=len(unidades),
            cursor={"unidades": todas_unidades},
        )
        sync_manager.save_accumulated_data(todas_unidades)

        if max_pages and pages_coletadas >= max_pages:
            break

        if resp.get("paginasRestantes", 0) == 0:
            break

        pagina += 1
        time.sleep(0.5)

    total_records = len(todas_unidades)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    logger.info(f"  Total: {len(todas_unidades)} unidades")
    return todas_unidades

def main():
    logger.info("=== COLLECTOR: Endpoint 6 — Unidade Fornecimento ===")
    logger.info("Golden rule: apenas 7220 (G72) e 7830 (G78)\n")

    try:
        resultado = {}

        for grupo, classe in CLASSES_PERMITIDAS.items():
            key = f"grupo_{grupo}"
            unidades = collect_unidades_por_grupo_classe(grupo, classe)
            resultado[key] = unidades

        output = {
            "endpoint": "6_consultarMaterialUnidadeFornecimento",
            "golden_rule": "apenas 7220 (G72) e 7830 (G78)",
            "data": resultado,
            "resumo": {
                "total_grupo_72": len(resultado.get("grupo_72", [])),
                "total_grupo_78": len(resultado.get("grupo_78", [])),
            }
        }

        with open("collector_unidade_fornecimento_resultado.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Salvo: collector_unidade_fornecimento_resultado.json")
        logger.info(f"  G72: {output['resumo']['total_grupo_72']} unidades")
        logger.info(f"  G78: {output['resumo']['total_grupo_78']} unidades")
        return 0
    except Exception as e:
        logger.error(f"Falha na coleta de unidades: {e}")
        return 1

if __name__ == "__main__":
    exit(main())

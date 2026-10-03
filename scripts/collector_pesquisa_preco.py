#!/usr/bin/env python3
"""
Collector: Pesquisa de Preço — consultarMaterial + consultarMaterialDetalhe
Golden rule: apenas materiais de G72/G78
Coleta preços + fornecedores para items fitness no mercado.
"""

import json
import logging
from pathlib import Path
import sys
import time
from typing import Any, Dict, List, Optional
from scripts.lib.http_client import clamp_compras_gov_page_size
from scripts.lib.http_fetch import fetch_json, HttpFetchError
from scripts.lib.paginacao import acao_pagina
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT_MATERIAL = "/modulo-pesquisa-preco/1_consultarMaterial"
ENDPOINT_DETALHE = "/modulo-pesquisa-preco/2_consultarMaterialDetalhe"
TIMEOUT = 30

# Carrega items E4 para filtrar por codigoItem
ITEMS_E4 = []

def load_items_e4():
    """Carrega items reais do collector E4"""
    global ITEMS_E4
    try:
        with open("collector_item_material_resultado.json", encoding="utf-8") as f:
            data = json.load(f)
        for grupo_key in ["grupo_72", "grupo_78"]:
            ITEMS_E4.extend([item["codigoItem"] for item in data["data"].get(grupo_key, [])])
        logger.info(f"Carregados {len(ITEMS_E4)} items de E4")
    except Exception as e:
        logger.error(f"Erro ao carregar E4: {e}")

def fetch_material(codigo_item: Optional[int] = None, pagina: int = 1, tamanho_pagina: int = 100) -> Dict[str, Any]:
    """Consulta Material em Pesquisa de Preço"""
    url = f"{BASE_URL}{ENDPOINT_MATERIAL}"
    params = {"pagina": pagina, "tamanhoPagina": clamp_compras_gov_page_size(tamanho_pagina)}

    if codigo_item:
        params["codigoItem"] = codigo_item

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="resultado",
    )

def fetch_detalhe(codigo_material: int) -> Dict[str, Any]:
    """Consulta Detalhe (preços + fornecedores)"""
    url = f"{BASE_URL}{ENDPOINT_DETALHE}?codigoMaterial={codigo_material}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="resultado",
    )

def _paginar_materiais(codigo_item: int) -> List[Dict]:
    """Pesquisa de preço não traz total em toda resposta: segue até página vazia ou total confirmado."""
    materiais: List[Dict] = []
    pagina = 1
    tamanho = clamp_compras_gov_page_size(100)
    vistos: set[str] = set()
    lidos = 0
    while True:
        resp = fetch_material(codigo_item=codigo_item, pagina=pagina, tamanho_pagina=tamanho)
        lote = resp.get("resultado") if isinstance(resp, dict) else None
        parar, incluir = acao_pagina(
            lote, resp if isinstance(resp, dict) else {},
            tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
        )
        if incluir and lote:
            lidos += len(lote)
            materiais.extend(lote)
        if not incluir or parar:
            return materiais
        pagina += 1


def collect_pesquisa_preco(
    items_e4: Optional[List[int]] = None,
    max_items: Optional[int] = 100,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> Dict[str, Any]:
    """Coleta materiais e detalhes de pesquisa de preço com suporte a checkpoint e resume."""
    if sync_manager is None:
        sync_manager = SyncStateManager("pesquisa_preco_consultarMaterial")

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(resume=should_resume)

    if items_e4 is None:
        items_e4 = ITEMS_E4

    items_to_process = items_e4[:max_items] if max_items is not None else items_e4

    completed_items: List[int] = []
    materiais_encontrados: List[Dict] = []
    detalhes_todos: List[Dict] = []

    if should_resume:
        if isinstance(state.cursor, dict):
            completed_items = list(state.cursor.get("completed_items", []))
            materiais_encontrados = list(state.cursor.get("materiais_encontrados", []))
            detalhes_todos = list(state.cursor.get("detalhes_todos", []))
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, dict):
                completed_items = list(acc.get("completed_items", []))
                materiais_encontrados = list(acc.get("materiais_encontrados", []))
                detalhes_todos = list(acc.get("detalhes_todos", []))
            else:
                out_path = Path("collector_pesquisa_preco_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict):
                            materiais_encontrados = list(data.get("materiais", []))
                            detalhes_todos = list(data.get("detalhes", []))
                            completed_items = list({m["codigoItem"] for m in materiais_encontrados if "codigoItem" in m})
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir pesquisa de preço de {out_path}: {e}")

        logger.info(f"Reconstituídos {len(completed_items)} item(s), {len(materiais_encontrados)} materiais, {len(detalhes_todos)} detalhes de execuções anteriores")

    total_items = len(items_to_process)
    for i, codigo_item in enumerate(items_to_process, 1):
        if should_resume and codigo_item in completed_items:
            logger.info(f"Item {codigo_item} já processado anteriormente, pulando.")
            continue

        if i % 20 == 0:
            logger.info(f"[{i}/{total_items}] processando item {codigo_item}...")

        try:
            materiais = _paginar_materiais(codigo_item)
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=i,
                error_details={"codigo_item": codigo_item},
                cursor={
                    "completed_items": completed_items,
                    "materiais_encontrados": materiais_encontrados,
                    "detalhes_todos": detalhes_todos,
                },
            )
            sync_manager.save_accumulated_data({
                "completed_items": completed_items,
                "materiais_encontrados": materiais_encontrados,
                "detalhes_todos": detalhes_todos,
            })
            raise

        novos_detalhes_count = 0

        if materiais:
            materiais_encontrados.extend(materiais)

            for material in materiais:
                codigo_material = material.get("codigoMaterial")
                if codigo_material:
                    try:
                        detalhe = fetch_detalhe(codigo_material)
                    except Exception as e:
                        sync_manager.record_partial_failure(
                            e,
                            page=i,
                            error_details={"codigo_item": codigo_item, "codigo_material": codigo_material},
                            cursor={
                                "completed_items": completed_items,
                                "materiais_encontrados": materiais_encontrados,
                                "detalhes_todos": detalhes_todos,
                            },
                        )
                        sync_manager.save_accumulated_data({
                            "completed_items": completed_items,
                            "materiais_encontrados": materiais_encontrados,
                            "detalhes_todos": detalhes_todos,
                        })
                        raise

                    detalhes = detalhe.get("resultado", [])
                    if detalhes:
                        detalhes_todos.extend(detalhes)
                        novos_detalhes_count += len(detalhes)

        completed_items.append(codigo_item)
        sync_manager.record_page_success(
            page=i,
            records_in_page=novos_detalhes_count,
            cursor={
                "completed_items": completed_items,
                "materiais_encontrados": materiais_encontrados,
                "detalhes_todos": detalhes_todos,
            },
        )
        sync_manager.save_accumulated_data({
            "completed_items": completed_items,
            "materiais_encontrados": materiais_encontrados,
            "detalhes_todos": detalhes_todos,
        })
        time.sleep(0.2)

    total_records = len(detalhes_todos)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    return {
        "materiais": materiais_encontrados,
        "detalhes": detalhes_todos,
        "items_processados": len(completed_items),
    }

def main():
    logger.info("=== COLLECTOR: Pesquisa de Preço — Material + Detalhe ===")
    logger.info("Golden rule: apenas items G72/G78\n")

    load_items_e4()

    try:
        resultado = collect_pesquisa_preco(max_items=100)
    except Exception as e:
        logger.error(f"Erro durante coleta de Pesquisa de Preço: {e}")
        sys.exit(1)

    materiais_encontrados = resultado["materiais"]
    detalhes_todos = resultado["detalhes"]

    output = {
        "endpoint": "pesquisa-preco (consultarMaterial + consultarMaterialDetalhe)",
        "golden_rule": "apenas G72/G78 items",
        "resumo": {
            "items_pesquisados": resultado["items_processados"],
            "materiais_encontrados": len(materiais_encontrados),
            "detalhes_preco_encontrados": len(detalhes_todos),
        },
        "materiais": materiais_encontrados,
        "detalhes": detalhes_todos
    }

    with open("collector_pesquisa_preco_resultado.json", "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    logger.info(f"\n✓ Salvo: collector_pesquisa_preco_resultado.json")
    logger.info(f"  Materiais: {output['resumo']['materiais_encontrados']}")
    logger.info(f"  Detalhes: {output['resumo']['detalhes_preco_encontrados']}")

if __name__ == "__main__":
    main()

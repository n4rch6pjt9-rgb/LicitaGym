#!/usr/bin/env python3
"""
Collector: PNCP /v1/contratacoes/publicacao
Fase 3: Coleta contratações com items G72/G78 fitness
PARÂMETROS (via schemas-consultas-pncp.md):
- pagina: obrigatório
- tamanhoPagina: máximo 50 (não 500!)
- dataInicial/dataFinal: YYYYMMDD (obrigatório)
- codigoModalidadeContratacao: 6 (licitações)
"""

import json
import logging
from pathlib import Path
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
from scripts.lib.http_fetch import fetch_json, HttpFetchError
from scripts.lib.paginacao import acao_pagina
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled
from scripts.lib.payload_hash import compute_payload_hash

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

BASE_URL = "https://pncp.gov.br/api/consulta/v1"
ENDPOINT = "/contratacoes/publicacao"
TIMEOUT = 30

ITEMS_E4 = {}

def load_items_e4():
    try:
        with open("collector_item_material_resultado.json", encoding="utf-8") as f:
            data = json.load(f)
        for grupo_key in ["grupo_72", "grupo_78"]:
            for item in data["data"].get(grupo_key, []):
                ITEMS_E4[item["codigoItem"]] = item.get("nomeItem", "")
        logger.info(f"✓ {len(ITEMS_E4)} items carregados de E4")
    except Exception as e:
        logger.error(f"✗ Erro ao carregar E4: {e}")

def fetch_contratacoes(pagina: int, data_inicial: str, data_final: str) -> Dict[str, Any]:
    """GET /v1/contratacoes/publicacao com parâmetros corretos"""
    url = f"{BASE_URL}{ENDPOINT}"

    params = {
        "pagina": pagina,
        "tamanhoPagina": 50,  # teto da API de contratações/publicacao (10–50), dentro do máximo 100
        "dataInicial": data_inicial,  # YYYYMMDD
        "dataFinal": data_final,      # YYYYMMDD
        "codigoModalidadeContratacao": 6,  # Licitações
    }

    query_str = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{url}?{query_str}"

    return fetch_json(
        url,
        timeout=TIMEOUT,
        user_agent="LicitaGym/Collector",
        raise_for_status=True,
        legacy_empty_envelope_key="data",
    )

def compute_hash(obj: Dict[str, Any]) -> str:
    """Stable SHA-256 hash of payload."""
    return compute_payload_hash(obj)

def collect_contratacoes(
    data_inicio_str: str,
    data_fim_str: str,
    max_pages: Optional[int] = None,
    resume: Optional[bool] = None,
    sync_manager: Optional[SyncStateManager] = None,
) -> List[Dict]:
    """Coleta contratações PNCP com suporte a checkpoint e resume."""
    if sync_manager is None:
        sync_manager = SyncStateManager("pncp_contratacoes_publicacao")

    should_resume = is_sync_resume_enabled() if resume is None else resume
    state = sync_manager.start_run(
        resume=should_resume,
        metadata={"data_inicio": data_inicio_str, "data_fim": data_fim_str},
    )

    precos_encontrados: List[Dict] = []
    if should_resume and state.last_page > 0:
        if isinstance(state.cursor, dict) and "precos_encontrados" in state.cursor:
            precos_encontrados = list(state.cursor["precos_encontrados"])
        else:
            acc = sync_manager.load_accumulated_data()
            if isinstance(acc, list):
                precos_encontrados = list(acc)
            else:
                out_path = Path("collector_pncp_contratacoes_resultado.json")
                if out_path.exists():
                    try:
                        with open(out_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        if isinstance(data, dict) and isinstance(data.get("dados"), list):
                            precos_encontrados = list(data["dados"])
                    except Exception as e:
                        logger.warning(f"Não foi possível reconstituir contratações de {out_path}: {e}")

        logger.info(f"Reconstituídos {len(precos_encontrados)} preço(s) de execuções anteriores")

    pagina = (state.last_page + 1) if (should_resume and state.last_page > 0) else 1
    vistos: set[str] = set()
    lidos = 0
    tamanho = 50

    while True:
        if max_pages is not None and pagina > max_pages:
            logger.warning("teto de %s páginas atingido sem o total confirmar o fim", max_pages)
            break
        logger.info(f"[Página {pagina}]")
        try:
            resp = fetch_contratacoes(pagina, data_inicio_str, data_fim_str)
        except Exception as e:
            sync_manager.record_partial_failure(
                e,
                page=pagina,
                error_details={"data_inicio": data_inicio_str, "data_fim": data_fim_str},
                cursor={"precos_encontrados": precos_encontrados},
            )
            sync_manager.save_accumulated_data(precos_encontrados)
            raise

        contratacoes = resp.get("data") if isinstance(resp, dict) else None
        parar, incluir = acao_pagina(
            contratacoes, resp if isinstance(resp, dict) else {},
            tamanho=tamanho, pagina=pagina, vistos=vistos, logger=logger, ja_lidos=lidos,
        )
        if not incluir:
            break
        if not contratacoes:
            logger.info("✓ Fim da paginação (vazio)")
            break

        lidos += len(contratacoes)
        logger.info(f"  {len(contratacoes)} contratações")
        novos_precos = 0

        for contrato in contratacoes:
            items_contrato = contrato.get("itens", [])
            numero_licitacao = contrato.get("numero", "")
            modalidade = contrato.get("modalidade", "")
            data_pub = contrato.get("dataPublicacao", "")

            for item in items_contrato:
                codigo_item = item.get("codigoItemCatalogo")

                if codigo_item and codigo_item in ITEMS_E4:
                    fornecedores = item.get("fornecedores", [])

                    for fornecedor in fornecedores:
                        preco = fornecedor.get("preco")
                        if preco and preco > 0:
                            preco_rec = {
                                "codigo_item_catalogo": codigo_item,
                                "ni_fornecedor": fornecedor.get("ni", ""),
                                "nome_fornecedor": fornecedor.get("nome", ""),
                                "preco_unitario": preco,
                                "quantidade_contratada": item.get("quantidade", 1),
                                "numero_licitacao": numero_licitacao,
                                "modalidade_licitacao": modalidade,
                                "data_publicacao": data_pub,
                                "payload_hash": compute_hash({
                                    "codigo_item": codigo_item,
                                    "ni_fornecedor": fornecedor.get("ni", ""),
                                    "preco": preco,
                                    "numero_licitacao": numero_licitacao,
                                })
                            }
                            precos_encontrados.append(preco_rec)
                            novos_precos += 1

        sync_manager.record_page_success(
            page=pagina,
            records_in_page=novos_precos,
            cursor={"precos_encontrados": precos_encontrados},
        )
        sync_manager.save_accumulated_data(precos_encontrados)

        if parar:
            break

        pagina += 1

    total_records = len(precos_encontrados)
    sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})
    return precos_encontrados

def main():
    logger.info("=== COLLECTOR: PNCP Contratações (Fase 3) ===\n")

    load_items_e4()

    # Período: últimos 90 dias
    data_fim = datetime.now()
    data_inicio = data_fim - timedelta(days=90)

    data_inicio_str = data_inicio.strftime("%Y%m%d")
    data_fim_str = data_fim.strftime("%Y%m%d")

    logger.info(f"Período: {data_inicio_str} a {data_fim_str}")
    logger.info(f"Modalidade: 6 (licitações)")
    logger.info(f"TamanhoPagina: 50 (máximo)\n")

    try:
        precos_encontrados = collect_contratacoes(data_inicio_str, data_fim_str)

        output = {
            "endpoint": "/v1/contratacoes/publicacao",
            "periodo": f"{data_inicio_str} a {data_fim_str}",
            "parametros": {
                "tamanhoPagina": 50,
                "codigoModalidadeContratacao": 6,
            },
            "golden_rule": "items G72/G78 fitness",
            "resumo": {
                "total_contratacoes_processadas": len(precos_encontrados),
                "precos_encontrados": len(precos_encontrados),
                "fornecedores_unicos": len(set(p["ni_fornecedor"] for p in precos_encontrados if p.get("ni_fornecedor"))),
            },
            "dados": precos_encontrados
        }

        with open("collector_pncp_contratacoes_resultado.json", "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        logger.info(f"\n✓ Salvo: collector_pncp_contratacoes_resultado.json")
        logger.info(f"  Preços: {output['resumo']['precos_encontrados']}")
        logger.info(f"  Fornecedores: {output['resumo']['fornecedores_unicos']}")
        return 0
    except Exception as e:
        logger.error(f"Falha na coleta de contratações PNCP: {e}")
        return 1

if __name__ == "__main__":
    main()

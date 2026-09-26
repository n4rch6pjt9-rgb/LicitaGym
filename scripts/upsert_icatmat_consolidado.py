#!/usr/bin/env python3
"""
Upsert Consolidado: E1-E7 Endpoints CATMAT
Carrega JSONs coletados → insere em tabelas icatmat_ com FKs respeitadas.

Ordem: E1 → E2 → E3 → E4 → E5/E6/E7 (paralelo satélites)
"""

import os
import sys
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone
from scripts.lib.payload_hash import compute_payload_hash

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

# SEC-P1-01: Load Supabase credentials strictly from environment
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")

supabase = None
if not SUPABASE_URL or not SUPABASE_KEY:
    logger.warning("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY não configurados no ambiente.")
else:
    try:
        from supabase import create_client
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except ImportError:
        logger.warning("supabase-py não instalado. Use: pip install supabase")
        supabase = None

# Diretórios de entrada
COLLECTORS_DIR = Path(__file__).parent.parent / "scripts"
RESULTS_PATTERNS = {
    "E1": "*grupo_material_resultado.json",
    "E2": "*classe_material_resultado.json",
    "E3": "*pdm_material_resultado.json",
    "E4": "*item_material_resultado.json",
    "E5": "*natureza_despesa_resultado.json",
    "E6": "*unidade_fornecimento_resultado.json",
    "E7": "*caracteristica_material_resultado.json",
}

def compute_hash(obj: Dict[str, Any]) -> str:
    """Stable SHA-256 hash of payload."""
    return compute_payload_hash(obj)

class ResultadoLoadError(RuntimeError):
    """Arquivo de resultado ausente, ilegível ou em formato desconhecido."""


class UpsertError(RuntimeError):
    """Falha de persistência no Supabase."""


def load_resultado(endpoint: str, base_dir: Optional[Path] = None) -> List[Dict[str, Any]]:
    """Carrega resultado JSON de collector, desempacotando envelopes e dicionários aninhados.

    Resolve CATMAT-P1-002: desempacota envelope 'resultado' ou chaves aninhadas em 'data'
    (ex: data.grupo_72, data.grupo_78 ou data.item_374066).

    Lista vazia só é devolvida quando o arquivo existe e o envelope contém lista vazia.
    Arquivo ausente, JSON inválido ou envelope desconhecido levantam ResultadoLoadError.
    """
    pattern = RESULTS_PATTERNS.get(endpoint)
    if not pattern:
        raise ResultadoLoadError(f"Endpoint desconhecido: {endpoint}")

    search_dirs = [base_dir] if base_dir else [Path("."), COLLECTORS_DIR]
    files: List[Path] = []
    for d in search_dirs:
        if d and d.exists():
            matched = sorted(d.glob(pattern))
            if matched:
                files.extend(matched)
                break

    if not files:
        raise ResultadoLoadError(f"{endpoint}: nenhum arquivo encontrado ({pattern})")

    filepath = files[0]
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ResultadoLoadError(f"{endpoint}: erro ao ler {filepath.name}: {e}") from e

    records: Optional[List[Dict[str, Any]]] = None
    if isinstance(data, list):
        records = data
    elif isinstance(data, dict):
        if isinstance(data.get("resultado"), list):
            records = data["resultado"]
        elif "data" in data:
            val = data["data"]
            if isinstance(val, list):
                records = val
            elif isinstance(val, dict) and all(isinstance(v, list) for v in val.values()):
                # Agrupamentos como {"grupo_72": [...], "grupo_78": [...]} ou {"item_374066": [...]}
                records = [r for sub_list in val.values() for r in sub_list]
        elif isinstance(data.get("registros"), list):
            records = data["registros"]

    if records is None:
        raise ResultadoLoadError(f"{endpoint}: envelope desconhecido em {filepath.name}")

    logger.info(f"{endpoint}: carregado {len(records)} registros de {filepath.name}")
    return records

# Mapping of table to primary natural unique key for on_conflict resolution
TABLE_ON_CONFLICT: Dict[str, str] = {
    "icatmat_grupo_material": "codigo_grupo",
    "icatmat_classe_material": "codigo_grupo,codigo_classe",
    "icatmat_pdm_material": "codigo_grupo,codigo_classe,codigo_pdm",
    "icatmat_item_material": "codigo_grupo,codigo_classe,codigo_pdm,codigo_item",
    "icatmat_natureza_despesa": "codigo_grupo,codigo_classe,codigo_item,codigo_natureza",
    "icatmat_unidade_fornecimento": "codigo_grupo,codigo_classe,codigo_item,codigo_unidade",
    # UNIQUE NULLS NOT DISTINCT (20260922110000): NULL em codigo_valor_caracteristica é chave válida.
    "icatmat_caracteristica_material": "codigo_item,codigo_caracteristica,codigo_valor_caracteristica",
}

# Canonical natural keys aligned to Compras.gov Dados Abertos specs & prod tables
CANONICAL_NATURAL_KEYS: Dict[str, str] = {
    "icatmat_grupo_material": "codigo_grupo",
    "icatmat_classe_material": "codigo_grupo,codigo_classe",
    "icatmat_pdm_material": "codigo_grupo,codigo_classe,codigo_pdm",
    "icatmat_item_material": "codigo_grupo,codigo_classe,codigo_pdm,codigo_item",
    "icatmat_natureza_despesa": "codigo_pdm,codigo_natureza",
    "icatmat_unidade_fornecimento": "codigo_pdm,sigla_unidade,codigo_unidade",
    "icatmat_caracteristica_material": "codigo_item,codigo_caracteristica,codigo_valor_caracteristica",
}

def upsert_table(table: str, records: List[Dict[str, Any]], on_conflict: Optional[str] = None) -> int:
    """Upsert records em tabela com on_conflict explícito. Retorna count upsertado.

    Zero registros de entrada devolve 0; falha de persistência levanta UpsertError.
    """
    if not records:
        return 0
    if not supabase:
        raise UpsertError(f"{table}: cliente Supabase não configurado")

    conflict_target = on_conflict or TABLE_ON_CONFLICT.get(table)
    if not conflict_target:
        raise UpsertError(f"{table}: on_conflict não definido")
    try:
        result = supabase.table(table).upsert(records, on_conflict=conflict_target).execute()
    except Exception as e:
        raise UpsertError(f"{table}: erro upsert (on_conflict={conflict_target}): {e}") from e
    count = len(result.data) if hasattr(result, 'data') else len(records)
    logger.info(f"{table}: {count} registros upsertados (on_conflict={conflict_target})")
    return count

def enrich_e1(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E1: adiciona payload_hash, timestamp."""
    enriched = []
    for r in records:
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "nome_grupo": r.get("nomeGrupo"),
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e2(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E2: adiciona payload_hash, FK."""
    enriched = []
    for r in records:
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "nome_classe": r.get("nomeClasse"),
            "status_classe": r.get("statusClasse", True),
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e3(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E3."""
    enriched = []
    for r in records:
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "codigo_pdm": r.get("codigoPdm"),
            "nome_pdm": r.get("nomePdm"),
            "status_pdm": r.get("statusPdm", True),
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e4(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E4."""
    enriched = []
    for r in records:
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "codigo_pdm": r.get("codigoPdm"),
            "codigo_item": r.get("codigoItem"),
            "descricao_item": r.get("descricaoItem"),
            "tipo_item": r.get("tipoItem"),
            "status_item": r.get("statusItem", True),
            "valor_unitario": r.get("valorUnitario"),
            "unidade_padrao": r.get("unidadePadrao"),
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e5(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E5: mapeia campos de DmMaterialNaturezaDespesaDTO ou formato icatmat."""
    enriched = []
    for r in records:
        codigo_natureza = r.get("codigoNatureza") if r.get("codigoNatureza") is not None else r.get("codigoNaturezaDespesa")
        descricao_natureza = r.get("descricaoNatureza") or r.get("nomeNaturezaDespesa") or r.get("nomeNatureza")
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "codigo_pdm": r.get("codigoPdm"),
            "codigo_item": r.get("codigoItem"),
            "codigo_natureza": codigo_natureza,
            "descricao_natureza": descricao_natureza,
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e6(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E6: mapeia campos de DmMaterialUnidadeFornecimentoDTO ou formato icatmat."""
    enriched = []
    for r in records:
        codigo_unidade = r.get("codigoUnidade") if r.get("codigoUnidade") is not None else r.get("numeroSequencialUnidadeFornecimento")
        descricao_unidade = r.get("descricaoUnidade") or r.get("descricaoUnidadeFornecimento") or r.get("nomeUnidadeFornecimento") or r.get("nomeUnidade")
        sigla_unidade = r.get("siglaUnidade") or r.get("siglaUnidadeFornecimento")
        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "codigo_pdm": r.get("codigoPdm"),
            "codigo_item": r.get("codigoItem"),
            "codigo_unidade": codigo_unidade,
            "descricao_unidade": descricao_unidade,
            "sigla_unidade": sigla_unidade,
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def enrich_e7(records: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Enrich E7: mapeia campos de DmMaterialCaracteristicasDTO.

    CATMAT-P0-004 e CATMAT-P1-001: codigo_valor_caracteristica pode ser NULL na fonte
    oficial e continua NULL aqui. Nenhum sentinel é gravado; a identidade usa
    UNIQUE NULLS NOT DISTINCT. String só de espaços não identifica valor e vira NULL.
    """
    enriched = []
    for r in records:
        raw_val_cod = r.get("codigoValorCaracteristica") if r.get("codigoValorCaracteristica") is not None else r.get("codigo_valor_caracteristica")
        val_cod = None if raw_val_cod is None else (str(raw_val_cod).strip() or None)

        nome_val = r.get("nomeValorCaracteristica") or r.get("nome_valor_caracteristica") or r.get("descricaoValorCaracteristica")

        enriched.append({
            "codigo_grupo": r.get("codigoGrupo"),
            "codigo_classe": r.get("codigoClasse"),
            "codigo_pdm": r.get("codigoPdm"),
            "codigo_item": r.get("codigoItem"),
            "codigo_caracteristica": r.get("codigoCaracteristica"),
            "nome_caracteristica": r.get("nomeCaracteristica"),
            "descricao_caracteristica": r.get("descricaoCaracteristica"),
            "tipo_caracteristica": r.get("tipoCaracteristica"),
            "codigo_valor_caracteristica": val_cod,
            "nome_valor_caracteristica": nome_val,
            "data_hora_atualizacao": r.get("dataHoraAtualizacao"),
            "payload_hash": compute_hash(r),
            "sync_timestamp": datetime.now(timezone.utc).isoformat(),
        })
    return enriched

def main():
    print("\n" + "="*70)
    print("UPSERT CONSOLIDADO E1-E7 CATMAT")
    print("="*70 + "\n")

    if not supabase:
        logger.error(
            "Supabase não conectado. Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY "
            "(ou SUPABASE_KEY) e instale supabase-py (pip install supabase)."
        )
        return 1

    try:
        counts = _run_all()
    except (ResultadoLoadError, UpsertError) as e:
        logger.error(f"Upsert consolidado interrompido: {e}")
        return 1

    e1_count, e2_count, e3_count, e4_count, e5_count, e6_count, e7_count = counts
    total = sum(counts)
    print("\n" + "="*70)
    print(f"RESUMO: {total} registros upsertados")
    print("  E1: " + str(e1_count).ljust(6) + "E5: " + str(e5_count))
    print("  E2: " + str(e2_count).ljust(6) + "E6: " + str(e6_count))
    print("  E3: " + str(e3_count).ljust(6) + "E7: " + str(e7_count))
    print("  E4: " + str(e4_count))
    print("="*70 + "\n")

    return 0


def _run_all() -> tuple:
    # E1
    print("[1/7] E1: Grupo Material")
    e1_raw = load_resultado("E1")
    e1_enriched = enrich_e1(e1_raw)
    e1_count = upsert_table("icatmat_grupo_material", e1_enriched)

    # E2
    print("[2/7] E2: Classe Material")
    e2_raw = load_resultado("E2")
    e2_enriched = enrich_e2(e2_raw)
    e2_count = upsert_table("icatmat_classe_material", e2_enriched)

    # E3
    print("[3/7] E3: PDM Material")
    e3_raw = load_resultado("E3")
    e3_enriched = enrich_e3(e3_raw)
    e3_count = upsert_table("icatmat_pdm_material", e3_enriched)

    # E4
    print("[4/7] E4: Item Material")
    e4_raw = load_resultado("E4")
    e4_enriched = enrich_e4(e4_raw)
    e4_count = upsert_table("icatmat_item_material", e4_enriched)

    # E5-E7 (paralelo logicamente, sequencial aqui)
    print("[5/7] E5: Natureza Despesa")
    e5_raw = load_resultado("E5")
    e5_enriched = enrich_e5(e5_raw)
    e5_count = upsert_table("icatmat_natureza_despesa", e5_enriched)

    print("[6/7] E6: Unidade Fornecimento")
    e6_raw = load_resultado("E6")
    e6_enriched = enrich_e6(e6_raw)
    e6_count = upsert_table("icatmat_unidade_fornecimento", e6_enriched)

    print("[7/7] E7: Característica Material")
    e7_raw = load_resultado("E7")
    e7_enriched = enrich_e7(e7_raw)
    e7_count = upsert_table("icatmat_caracteristica_material", e7_enriched)

    return (e1_count, e2_count, e3_count, e4_count, e5_count, e6_count, e7_count)

if __name__ == "__main__":
    exit(main())

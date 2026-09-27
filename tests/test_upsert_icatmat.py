"""Tests for upsert_icatmat_consolidado.py and upsert_icatmat_remoto.py.

Verifies:
- SEC-P1-01: refuse to run without SUPABASE_URL / key in environment.
- On_conflict: ensures explicit on_conflict is provided for each table.
- Enrich functions compute 64-character SHA-256 hashes.
"""

import os
import sys
import json
import pytest
from unittest.mock import patch, MagicMock

import scripts.upsert_icatmat_consolidado as consolidado
from scripts.upsert_icatmat_consolidado import (
    TABLE_ON_CONFLICT,
    upsert_table,
    enrich_e1,
    enrich_e2,
    enrich_e3,
    enrich_e4,
    enrich_e5,
    enrich_e6,
    enrich_e7,
)


def test_sec_p1_01_no_hardcoded_jwt_in_source():
    """Verify that no literal JWT string exists in upsert_icatmat_consolidado.py."""
    with open("scripts/upsert_icatmat_consolidado.py", "r", encoding="utf-8") as f:
        content = f.read()
    assert "eyJhbGciOi" not in content
    assert "dummy" not in content


def test_consolidado_refuses_to_run_without_supabase_client(monkeypatch):
    """When supabase client is None (missing env vars or library), main() returns 1."""
    monkeypatch.setattr(consolidado, "supabase", None)
    exit_code = consolidado.main()
    assert exit_code == 1


def test_table_on_conflict_mapping_completeness():
    """Verify on_conflict definitions match table unique constraints E1-E7."""
    expected = {
        "icatmat_grupo_material": "codigo_grupo",
        "icatmat_classe_material": "codigo_grupo,codigo_classe",
        "icatmat_pdm_material": "codigo_grupo,codigo_classe,codigo_pdm",
        "icatmat_item_material": "codigo_grupo,codigo_classe,codigo_pdm,codigo_item",
        "icatmat_natureza_despesa": "codigo_grupo,codigo_classe,codigo_item,codigo_natureza",
        "icatmat_unidade_fornecimento": "codigo_grupo,codigo_classe,codigo_item,codigo_unidade",
        "icatmat_caracteristica_material": "codigo_item,codigo_caracteristica,codigo_valor_caracteristica",
    }
    for table, conflict_cols in expected.items():
        assert TABLE_ON_CONFLICT.get(table) == conflict_cols


MIGRATION_E7 = "supabase/migrations/20260922110000_icatmat_additive_alignment.sql"


def test_e7_on_conflict_matches_nulls_not_distinct_constraint():
    with open(MIGRATION_E7, "r", encoding="utf-8") as f:
        sql = f.read()
    cols = TABLE_ON_CONFLICT["icatmat_caracteristica_material"].replace(",", ", ")
    assert f"UNIQUE NULLS NOT DISTINCT ({cols})" in sql
    assert "DEFAULT '0'" not in sql
    assert "DROP CONSTRAINT IF EXISTS unique_caracteristica;" in sql


def test_upsert_table_passes_on_conflict_to_supabase(monkeypatch):
    """Mock Supabase client and check on_conflict keyword argument."""
    mock_supabase = MagicMock()
    mock_table_query = MagicMock()
    mock_upsert_query = MagicMock()

    mock_supabase.table.return_value = mock_table_query
    mock_table_query.upsert.return_value = mock_upsert_query
    mock_upsert_query.execute.return_value = MagicMock(data=[{"id": 1}])

    monkeypatch.setattr(consolidado, "supabase", mock_supabase)

    records = [{"codigo_grupo": 78, "nome_grupo": "FITNESS", "payload_hash": "abc"}]
    count = upsert_table("icatmat_grupo_material", records)

    assert count == 1
    mock_supabase.table.assert_called_with("icatmat_grupo_material")
    mock_table_query.upsert.assert_called_once_with(records, on_conflict="codigo_grupo")


def test_upsert_table_custom_on_conflict(monkeypatch):
    """Allow overriding on_conflict parameter."""
    mock_supabase = MagicMock()
    mock_table_query = MagicMock()
    mock_upsert_query = MagicMock()

    mock_supabase.table.return_value = mock_table_query
    mock_table_query.upsert.return_value = mock_upsert_query
    mock_upsert_query.execute.return_value = MagicMock(data=[{"id": 1}])

    monkeypatch.setattr(consolidado, "supabase", mock_supabase)

    records = [{"codigo_grupo": 78, "payload_hash": "abc"}]
    count = upsert_table("icatmat_grupo_material", records, on_conflict="payload_hash")

    assert count == 1
    mock_table_query.upsert.assert_called_once_with(records, on_conflict="payload_hash")


def test_enrich_functions_produce_sha256_hash():
    """Verify that enrich functions output 64-char hex SHA-256 hashes."""
    e1_records = [{"codigoGrupo": 78, "nomeGrupo": "Desportos", "dataHoraAtualizacao": "2026-09-20"}]
    res_e1 = enrich_e1(e1_records)
    assert len(res_e1) == 1
    assert len(res_e1[0]["payload_hash"]) == 64
    assert res_e1[0]["codigo_grupo"] == 78

    e4_records = [{
        "codigoGrupo": 78,
        "codigoClasse": 7830,
        "codigoPdm": 123,
        "codigoItem": 456,
        "descricaoItem": "Halter 10kg",
        "dataHoraAtualizacao": "2026-09-20",
    }]
    res_e4 = enrich_e4(e4_records)
    assert len(res_e4) == 1
    assert len(res_e4[0]["payload_hash"]) == 64
    assert res_e4[0]["codigo_item"] == 456


def test_upsert_remoto_includes_on_conflict_query_param():
    """Test upsert_icatmat_remoto.upsert_batch sends on_conflict in URL query."""
    import scripts.upsert_icatmat_remoto as remoto

    mock_records = [{"codigo_grupo": 78, "codigo_item": 1234}]

    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = MagicMock()
        mock_resp.status = 201
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        count = remoto.upsert_batch(
            mock_records,
            batch_size=1,
            supabase_url="https://test.supabase.co",
            service_role_key="test-service-key",
        )

        assert count == 1
        assert mock_urlopen.called
        req = mock_urlopen.call_args[0][0]
        assert "on_conflict=codigo_item,codigo_grupo" in req.full_url or "on_conflict=codigo_item%2Ccodigo_grupo" in req.full_url
        assert req.headers.get("Prefer") == "resolution=merge-duplicates"
        assert req.headers.get("Authorization") == "Bearer test-service-key"
        assert req.headers.get("Apikey") == "test-service-key"


def test_upsert_remoto_refuses_without_credentials():
    """upsert_batch returns 0 if no credentials provided or in env."""
    import scripts.upsert_icatmat_remoto as remoto
    count = remoto.upsert_batch(
        [{"codigo_item": 123}],
        supabase_url="",
        service_role_key="",
    )
    assert count == 0


def test_upsert_remoto_main_returns_1_without_env(monkeypatch):
    """remoto.main() returns 1 if SUPABASE_URL / key are missing."""
    import scripts.upsert_icatmat_remoto as remoto
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    monkeypatch.setattr(remoto, "SUPABASE_URL", None)
    monkeypatch.setattr(remoto, "SERVICE_ROLE_KEY", None)

    code = remoto.main()
    assert code == 1


def test_load_resultado_unwraps_dictionary_and_envelope(tmp_path):
    """CATMAT-P1-002: load_resultado unwrap 'resultado' array and 'data' dicts without AttributeError."""
    # Teste 1: data com dict agrupado por grupo (ex: E4 item_material)
    e4_file = tmp_path / "collector_item_material_resultado.json"
    e4_content = {
        "endpoint": "4_consultarItemMaterial",
        "data": {
            "grupo_72": [{"codigoItem": 1, "descricaoItem": "Item 1"}],
            "grupo_78": [{"codigoItem": 2, "descricaoItem": "Item 2"}],
        }
    }
    with open(e4_file, "w", encoding="utf-8") as f:
        json.dump(e4_content, f)

    records_e4 = consolidado.load_resultado("E4", base_dir=tmp_path)
    assert len(records_e4) == 2
    assert records_e4[0]["codigoItem"] == 1
    assert records_e4[1]["codigoItem"] == 2

    # Teste 2: data com envelope 'resultado' direto (ex: E1 grupo_material)
    e1_file = tmp_path / "collector_grupo_material_resultado.json"
    e1_content = {
        "resultado": [
            {"codigoGrupo": 72, "nomeGrupo": "G72"},
            {"codigoGrupo": 78, "nomeGrupo": "G78"},
        ]
    }
    with open(e1_file, "w", encoding="utf-8") as f:
        json.dump(e1_content, f)

    records_e1 = consolidado.load_resultado("E1", base_dir=tmp_path)
    assert len(records_e1) == 2
    assert records_e1[0]["codigoGrupo"] == 72


def _e7_records():
    return [
        {"codigoGrupo": 78, "codigoClasse": 7830, "codigoPdm": 2640, "codigoItem": 374066,
         "codigoCaracteristica": 10, "codigoValorCaracteristica": "123", "nomeValorCaracteristica": "PRETO"},
        {"codigoGrupo": 78, "codigoClasse": 7830, "codigoPdm": 2640, "codigoItem": 374066,
         "codigoCaracteristica": 10, "codigoValorCaracteristica": "456", "nomeValorCaracteristica": "BRANCO"},
        {"codigoGrupo": 78, "codigoClasse": 7830, "codigoPdm": 2640, "codigoItem": 374066,
         "codigoCaracteristica": 20, "codigoValorCaracteristica": None, "nomeValorCaracteristica": "ACO"},
    ]


class FakeUniqueTable:
    """Emula ON CONFLICT sobre UNIQUE NULLS NOT DISTINCT: None é um valor de chave comparável."""

    def __init__(self, conflict_cols):
        self.cols = conflict_cols.split(",")
        self.rows = {}

    def upsert(self, records):
        for r in records:
            self.rows[tuple(r[c] for c in self.cols)] = dict(r)


def test_e7_reprocessing_with_null_is_idempotent_and_keeps_multivalue():
    table = FakeUniqueTable(TABLE_ON_CONFLICT["icatmat_caracteristica_material"])
    table.upsert(enrich_e7(_e7_records()))
    first = {k: v["payload_hash"] for k, v in table.rows.items()}
    table.upsert(enrich_e7(_e7_records()))

    assert len(table.rows) == 3
    assert {k: v["payload_hash"] for k, v in table.rows.items()} == first
    assert (374066, 20, None) in table.rows
    assert table.rows[(374066, 20, None)]["codigo_valor_caracteristica"] is None
    assert {(374066, 10, "123"), (374066, 10, "456")} <= set(table.rows)


def test_enrich_e7_has_no_sentinel_parameter():
    import inspect
    assert list(inspect.signature(enrich_e7).parameters) == ["records"]
    with open("scripts/upsert_icatmat_consolidado.py", "r", encoding="utf-8") as f:
        assert "null_sentinel" not in f.read()


def test_enrich_e7_preserves_null():
    """CATMAT-P0-004 & CATMAT-P1-001: NULL continua NULL; nenhum sentinel é gravado."""
    records = [
        {
            "codigoGrupo": 78,
            "codigoClasse": 7830,
            "codigoPdm": 2640,
            "codigoItem": 374066,
            "codigoCaracteristica": 10,
            "nomeCaracteristica": "COR",
            "codigoValorCaracteristica": "123",
            "nomeValorCaracteristica": "PRETO",
        },
        {
            "codigoGrupo": 78,
            "codigoClasse": 7830,
            "codigoPdm": 2640,
            "codigoItem": 374066,
            "codigoCaracteristica": 20,
            "nomeCaracteristica": "MATERIAL",
            "codigoValorCaracteristica": None,  # Nulo explícito
            "nomeValorCaracteristica": "ACO",
        },
        {
            "codigoGrupo": 78,
            "codigoClasse": 7830,
            "codigoPdm": 2640,
            "codigoItem": 374066,
            "codigoCaracteristica": 30,
            "nomeCaracteristica": "PESO",
            "codigoValorCaracteristica": "   ",  # Vazio
            "nomeValorCaracteristica": "10KG",
        },
    ]

    enriched = enrich_e7(records)
    assert len(enriched) == 3
    assert enriched[0]["codigo_valor_caracteristica"] == "123"
    assert enriched[0]["nome_valor_caracteristica"] == "PRETO"
    assert enriched[1]["codigo_valor_caracteristica"] is None
    assert enriched[1]["nome_valor_caracteristica"] == "ACO"
    assert enriched[2]["codigo_valor_caracteristica"] is None
    assert enriched[2]["nome_valor_caracteristica"] == "10KG"
    assert all(e["codigo_valor_caracteristica"] not in ("0", "", "N/A", "NULL") for e in enriched)


def test_load_resultado_missing_file_raises(tmp_path):
    with pytest.raises(consolidado.ResultadoLoadError):
        consolidado.load_resultado("E7", base_dir=tmp_path)


def test_load_resultado_invalid_json_raises(tmp_path):
    (tmp_path / "collector_caracteristica_material_resultado.json").write_text("{broken", encoding="utf-8")
    with pytest.raises(consolidado.ResultadoLoadError):
        consolidado.load_resultado("E7", base_dir=tmp_path)


def test_load_resultado_unknown_envelope_raises(tmp_path):
    (tmp_path / "collector_caracteristica_material_resultado.json").write_text(
        json.dumps({"erro": "timeout"}), encoding="utf-8"
    )
    with pytest.raises(consolidado.ResultadoLoadError):
        consolidado.load_resultado("E7", base_dir=tmp_path)


def test_load_resultado_valid_empty_returns_empty(tmp_path):
    (tmp_path / "collector_caracteristica_material_resultado.json").write_text(
        json.dumps({"resultado": []}), encoding="utf-8"
    )
    assert consolidado.load_resultado("E7", base_dir=tmp_path) == []


def test_upsert_table_error_raises_instead_of_zero(monkeypatch):
    mock_supabase = MagicMock()
    mock_supabase.table.return_value.upsert.return_value.execute.side_effect = RuntimeError("503")
    monkeypatch.setattr(consolidado, "supabase", mock_supabase)
    with pytest.raises(consolidado.UpsertError):
        upsert_table("icatmat_caracteristica_material", [{"codigo_item": 1}])


def test_upsert_table_empty_input_returns_zero_without_call(monkeypatch):
    mock_supabase = MagicMock()
    monkeypatch.setattr(consolidado, "supabase", mock_supabase)
    assert upsert_table("icatmat_caracteristica_material", []) == 0
    assert not mock_supabase.table.called


def test_main_returns_1_when_resultado_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(consolidado, "supabase", MagicMock())
    monkeypatch.setattr(consolidado, "COLLECTORS_DIR", tmp_path)
    monkeypatch.chdir(tmp_path)
    assert consolidado.main() == 1


def test_enrich_e5_e6_flexible_field_mapping():
    """CATMAT-P0-003: enrich_e5 and enrich_e6 support official DmMaterial DTO field names."""
    e5_records = [
        {
            "codigoPdm": 2640,
            "codigoNaturezaDespesa": "339030",
            "nomeNaturezaDespesa": "CONSUMO",
        }
    ]
    e5_res = enrich_e5(e5_records)
    assert len(e5_res) == 1
    assert e5_res[0]["codigo_pdm"] == 2640
    assert e5_res[0]["codigo_natureza"] == "339030"
    assert e5_res[0]["descricao_natureza"] == "CONSUMO"

    e6_records = [
        {
            "codigoPdm": 2640,
            "siglaUnidadeFornecimento": "UN",
            "nomeUnidadeFornecimento": "UNIDADE",
            "numeroSequencialUnidadeFornecimento": 1,
        }
    ]
    e6_res = enrich_e6(e6_records)
    assert len(e6_res) == 1
    assert e6_res[0]["codigo_pdm"] == 2640
    assert e6_res[0]["sigla_unidade"] == "UN"
    assert e6_res[0]["codigo_unidade"] == 1
    assert e6_res[0]["descricao_unidade"] == "UNIDADE"

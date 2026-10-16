"""O gerador de seed escreve SQL. Texto do YAML entra só por dollar-quoting; número recusa string."""
from pathlib import Path

import pytest

from scripts.gerar_seed_catalogo_tarefas import CatalogoInvalido, gerar, inteiro, ler_textos, lit, validar

ROOT = Path(__file__).resolve().parents[1]


def test_lit_isola_aspas_e_troca_a_tag_se_ela_aparece_no_texto():
    assert lit(None) == "null"
    assert lit(True) == "true"
    assert lit(3) == "3"
    assert lit("a'; drop table t;--") == "$t$a'; drop table t;--$t$"
    assert lit("tem $t$ no meio") == "$tx$tem $t$ no meio$tx$"


def test_inteiro_recusa_texto():
    with pytest.raises(CatalogoInvalido):
        inteiro("1); delete from public.tarefas_catalogo;--")
    with pytest.raises(CatalogoInvalido):
        inteiro(True)
    assert inteiro(17) == "17"


def test_gerar_coloca_titulo_hostil_dentro_do_dollar_quote():
    cat = {
        "norma": "LEI_14133_2021",
        "fases": [{
            "codigo": "F01", "ordem": 1, "macro": "certame", "nome": "Divulgação",
            "artigos": [1], "descricao": "fase",
        }],
        "eventos": [{
            "codigo": "EV", "fase": "F01", "nome": "evento", "descricao": "d",
            "origem": "orgao", "fonte_dado": "PNCP",
        }],
        "transicoes": [{"de": "F01", "para": "F01", "evento": "EV", "artigo": 1}],
        "tarefas": [{
            "codigo": "14133-F01-T01", "fase": "F01", "titulo": "t'); delete from public.tarefas_catalogo;--",
            "descricao": "d", "natureza": "obrigacao", "ator": "fornecedor",
            "prazo": {"unidade": "imediato"}, "base_legal": [[1, None, "fundamento"]],
        }],
    }
    textos = {1: {"texto": "artigo", "recorte": None, "fonte": "https://exemplo.test/lei", "obs": None}}
    validar(cat, textos)
    sql = gerar(cat, textos)
    assert "$t$t'); delete from public.tarefas_catalogo;--$t$" in sql
    assert "values (t');" not in sql


def test_artigo_em_texto_nao_entra_no_sql():
    cat = {
        "norma": "LEI_14133_2021",
        "fases": [{
            "codigo": "F01", "ordem": 1, "macro": "certame", "nome": "Divulgação",
            "artigos": [1], "descricao": "fase",
        }],
        "eventos": [{
            "codigo": "EV", "fase": "F01", "nome": "evento", "descricao": "d",
            "origem": "orgao", "fonte_dado": "PNCP",
        }],
        "transicoes": [{"de": "F01", "para": "F01", "evento": "EV", "artigo": 1}],
        "tarefas": [{
            "codigo": "14133-F01-T01", "fase": "F01", "titulo": "titulo",
            "descricao": "d", "natureza": "obrigacao", "ator": "fornecedor",
            "prazo": {"unidade": "imediato"},
            "base_legal": [["1); delete from public.tarefas_catalogo;--", None, "fundamento"]],
        }],
    }
    textos = {1: {"texto": "artigo", "recorte": None, "fonte": "https://exemplo.test/lei", "obs": None}}
    with pytest.raises(CatalogoInvalido, match="art. 1"):
        validar(cat, textos)


def test_saida_do_catalogo_atual_nao_muda():
    yaml = pytest.importorskip("yaml")
    cat = yaml.safe_load((ROOT / "data/catalogo_tarefas_14133.yaml").read_text(encoding="utf-8"))
    textos = ler_textos(ROOT / "data/lei14133_textos")
    validar(cat, textos)
    gerado = gerar(cat, textos)
    atual = (ROOT / "supabase/migrations/20260927100100_seed_catalogo_tarefas_14133.sql").read_text(encoding="utf-8")
    assert gerado == atual

"""Regulamento das compras PNCP a partir do amparoLegal do detalhe (spec 0020). Offline: HTTP e Supabase mockados."""
from unittest.mock import MagicMock

import pytest

from coletor import backfill_regulamento_pncp as B
from coletor import pncp as P
from test_pncp import COMPRA, _pncp

AMPARO = {"codigo": 1, "nome": "Lei 14.133/2021, Art. 28, I",
          "descricao": "pregão: modalidade de licitação obrigatória para aquisição de bens e serviços comuns"}
DETALHE = {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026, "modalidadeNome": "Pregão - Eletrônico",
           "amparoLegal": AMPARO}

# Mesmos casos do supabase/tests/regulamento_amparo_check.sql (CA-1 / CA-6: espelho igual à função SQL)
CASOS = [
    ("Lei 14.133/2021, Art. 28, I", "LEI_14133"),
    ("Lei 14.133/2021, Art. 75, II", "LEI_14133"),
    ("Lei 14.981/2024, Art. 2º", "LEI_14981"),
    ("Lei 13.303/2016, Art. 29, II", "LEI_13303"),
    ("MP 1.221/2024, Art. 2º", "OUTRO"),
    ("Lei 114.133/2099", "OUTRO"),
    ("", None),
    ("   ", None),
    ("\n\t", None),
    (None, None),
]


@pytest.mark.parametrize("nome,esperado", CASOS)
def test_regulamento_do_amparo(nome, esperado):
    assert P.regulamento_do_amparo(nome) == esperado


# --- CA-4: identificação --------------------------------------------------------------------

def test_identificacao_traz_amparo_legal():
    p = _pncp([COMPRA]); p.compra.return_value = DETALHE
    assert P.identificacao(p, COMPRA)["amparo_legal"] == AMPARO


@pytest.mark.parametrize("det", [
    {k: v for k, v in DETALHE.items() if k != "amparoLegal"},
    dict(DETALHE, amparoLegal=None),
    dict(DETALHE, amparoLegal={"codigo": 1, "nome": None}),
    dict(DETALHE, amparoLegal={"codigo": 1, "nome": "  "}),
    dict(DETALHE, amparoLegal="Lei 14.133/2021"),
])
def test_identificacao_sem_amparo_omite_a_chave(det):
    p = _pncp([COMPRA]); p.compra.return_value = det
    assert "amparo_legal" not in P.identificacao(p, COMPRA)


def test_amparo_legal_guardado_como_veio():
    """Valor original sem aparar nem filtrar campos; o regulamento é derivado de uma cópia aparada."""
    bruto = {"codigo": 1, "nome": "  Lei 14.133/2021, Art. 28, I ", "descricao": None, "extra": "x"}
    p = _pncp([COMPRA]); p.compra.return_value = dict(DETALHE, amparoLegal=bruto)
    assert P.identificacao(p, COMPRA)["amparo_legal"] == bruto
    assert P.regulamento_do_amparo(bruto["nome"]) == "LEI_14133"


@pytest.mark.parametrize("det", [None, [], "texto", 0])
def test_amparo_legal_detalhe_tolera_detalhe_que_nao_e_objeto(det):
    assert P.amparo_legal_detalhe(det) is None


# --- CA-5: backfill -------------------------------------------------------------------------

def _sb(linhas):
    sb = MagicMock()
    sb.selecionar.return_value = linhas
    return sb


LINHAS = [
    {"id": 1, "codigo_externo": "01409580000138-1-002061/2025"},
    {"id": 2, "codigo_externo": "11111111000111-1-000001/2025"},
    {"id": 3, "codigo_externo": "nao-e-codigo"},
    {"id": 4, "codigo_externo": "22222222000122-1-000002/2025"},
]


def _pncp_backfill():
    p = MagicMock()

    def compra(c):
        if c["orgao_cnpj"] == "01409580000138":
            return DETALHE
        if c["orgao_cnpj"] == "11111111000111":
            raise RuntimeError("PNCP detalhe: 504 timeout")
        return {k: v for k, v in DETALHE.items() if k != "amparoLegal"}
    p.compra.side_effect = compra
    return p


def test_backfill_dry_run_nao_grava_e_conta_por_regulamento():
    sb = _sb(LINHAS)
    r = B.backfill(_pncp_backfill(), sb)
    sb.atualizar.assert_not_called()
    assert r["lidas"] == 4 and r["com_amparo"] == 1 and r["sem_amparo"] == 1
    assert r["falha_consulta"] == 1 and r["codigo_invalido"] == 1 and r["gravadas"] == 0
    assert r["por_regulamento"] == {"LEI_14133": 1}
    filtros = sb.selecionar.call_args.kwargs
    assert filtros["fonte"] == "eq.pncp" and filtros["amparo_legal"] == "is.null"


def test_backfill_apply_grava_so_amparo_legal():
    sb = _sb(LINHAS)
    r = B.backfill(_pncp_backfill(), sb, aplicar=True)
    assert r["gravadas"] == 1
    sb.atualizar.assert_called_once_with("licitacoes_externas", 1, {"amparo_legal": AMPARO})


def test_backfill_exige_delay_de_ao_menos_1s(monkeypatch):
    monkeypatch.setenv("DELAY_SEGUNDOS", "0.5")
    monkeypatch.setenv("SUPABASE_URL", "http://x")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "teste")
    with pytest.raises(SystemExit):
        B.main([])

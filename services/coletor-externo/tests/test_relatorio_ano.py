"""Relatório anual: números em padrão brasileiro e linhas do BI a partir do bruto (fixture real SFIEC PE000652022)."""
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from coletor import paradigma as P
from coletor import relatorio_ano as R

FX = json.loads((Path(__file__).parent / "fixtures" / "sfiec_pe000652022.json").read_text(encoding="utf-8"))


def test_numeros_padrao_brasileiro():
    assert R.br(4674.5) == "4674,50" and R.br(1013305) == "1013305,00" and R.br(None) == ""
    assert R.br_qtd(3.0) == "3" and R.br_qtd(2.5) == "2,500"


def test_linhas_bi_do_bruto():
    bruto = {"listagem": {"nAnoFinalizacao": 2022, "dVlEstimado": 723570.83, "dVlNegociado": 367508.5},
             "detalhe": {**FX["detalhe"], "nCdModulo": 18}, "itens": FX["itens"], "categoria": "forte",
             "lances": FX["lances"]}
    linhas, cnpjs, extra = R.linhas_bi([bruto], None, 2022)
    venc = [l for l in linhas if l.get("vencedor")]
    assert extra["alertas"] == []
    assert {l["codigo"] for l in venc} == {"AI0300075", "AI0300062"}         # balança fora do escopo; rack revogado
    v = next(l for l in venc if l["codigo"] == "AI0300075")
    assert v["valor_unit_brl"] == 8200 and v["valor_total_brl"] == 8200 and v["valor_ref_unit_brl"] == "18195,00"
    assert round(v["_var"], 2) == -54.93
    assert v["valor_estimado_processo_brl"] == "723570,83" and v["familia_equipamento"] == "equipamentos_fitness.musculacao"
    assert len(set(cnpjs)) >= 5                                                # participantes de todos os itens


def test_desconto_e_acrescimo_em_porcentagem_sem_sinal():
    import csv, io, os, tempfile
    assert R.pct(-54.9312) == "54,93%" and R.pct(12.5) == "12,50%" and R.pct(None) == ""
    linhas = [{"item": 1, "_var": -54.93}, {"item": 2, "_var": 8.44}, {"item": 3, "_var": None},
              {"item": 4, "desconto_vs_ref_pct": "-20,87"},                      # CSV antigo com sinal
              {"item": 5, "desconto_vs_ref_pct": "30,00%", "acrescimo_vs_ref_pct": ""}]  # CSV novo relido
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.csv")
        R.escrever_csv(linhas, p)
        rows = list(csv.DictReader(open(p, encoding="utf-8-sig"), delimiter=";"))
    got = [(r["desconto_vs_ref_pct"], r["acrescimo_vs_ref_pct"]) for r in rows]
    assert got == [("54,93%", ""), ("", "8,44%"), ("", ""), ("20,87%", ""), ("30,00%", "")]
    assert not any("-" in x for g in got for x in g)


def _portal():
    portal = MagicMock()
    portal.fonte = P.FONTES["sfiec"]
    portal.detalhes.return_value = None
    portal.itens.return_value = []
    return portal


def test_coletar_ano_envelope_invalido_nao_vira_fim(tmp_path):
    """relatorio_ano não interpreta envelope: usa paginar_intervalo, que levanta."""
    portal = _portal()
    portal.listar_encerrados.return_value = {"mensagem": "indisponível"}
    with pytest.raises(RuntimeError, match="sem lista reconhecida"):
        R.coletar_ano(portal, 2024, ["academia"], None, tmp_path)


def test_coletar_ano_pagina_curta_sem_total_segue_ate_vazia(tmp_path):
    portal = _portal()
    faixas_est = []
    faixas_comum = []

    def encerrados(texto, ano, de, ate):
        faixas_est.append(ate - de + 1)
        if de == 1:
            return [{"nCdOrigem": 1, "nCdModulo": 18, "nAnoFinalizacao": ano}]
        if de == 2:
            return [{"nCdOrigem": 2, "nCdModulo": 18, "nAnoFinalizacao": ano}]
        return []

    def listar(texto, de, ate):
        faixas_comum.append(ate - de + 1)
        if de == 1:
            return [{"nCdOrigem": 9, "nCdModulo": 18, "sDsSituacao": "Homologado"}]
        return []

    portal.listar_encerrados.side_effect = encerrados
    portal.listar.side_effect = listar
    portal.detalhes.return_value = {"tDtHomologacao": "/Date(1700000000000)/", "sDsSituacao": "Homologado",
                                    "nCdProcesso": 9, "sDsObjeto": "fora"}
    brutos = R.coletar_ano(portal, 2023, ["academia"], None, tmp_path)
    assert faixas_est == [100, 100, 100]
    assert faixas_comum == [100, 100]
    assert all(n <= 100 for n in faixas_est + faixas_comum)
    origens = {(b["listagem"].get("nCdOrigem"), b["listagem"].get("_origem")) for b in brutos}
    assert (1, "mural_estatistico") in origens and (2, "mural_estatistico") in origens


def test_coletar_ano_para_quando_o_total_confirma(tmp_path):
    portal = _portal()
    chamadas = []

    def encerrados(texto, ano, de, ate):
        chamadas.append(("est", de, ate))
        return {"resultado": [{"nCdOrigem": 3, "nCdModulo": 18, "nAnoFinalizacao": ano}], "totalRegistros": 1}

    def listar(texto, de, ate):
        chamadas.append(("comum", de, ate))
        return {"resultado": [], "totalRegistros": 0}

    portal.listar_encerrados.side_effect = encerrados
    portal.listar.side_effect = listar
    R.coletar_ano(portal, 2024, ["academia"], None, tmp_path)
    assert chamadas == [("est", 1, 100), ("comum", 1, 100)]
    assert all(ate - de + 1 <= 100 for _, de, ate in chamadas)


def test_coletar_ano_teto_opcional_avisa_e_padrao_nao_corta(tmp_path, caplog):
    portal = _portal()

    def encerrados(texto, ano, de, ate):
        assert ate - de + 1 <= 100
        if de == 1:
            return [{"nCdOrigem": de, "nCdModulo": 18, "nAnoFinalizacao": ano}]
        return []

    portal.listar_encerrados.side_effect = encerrados
    portal.listar.return_value = []
    with caplog.at_level("WARNING"):
        R.coletar_ano(portal, 2024, ["academia"], None, tmp_path, max_por_termo=1)
    assert any("teto opcional" in r.message for r in caplog.records)


def test_cli_delay_padrao_e_pelo_menos_um(monkeypatch, tmp_path):
    visto = {}

    def falso_portal(fonte, delay=1.5, **k):
        visto["delay"] = delay
        m = MagicMock()
        m.produtos_escopo.return_value = {}
        m.fonte = fonte
        return m

    monkeypatch.setattr(R, "PortalParadigma", falso_portal)
    monkeypatch.setattr(R, "coletar_ano", lambda *a, **k: [])
    monkeypatch.setattr(R, "linhas_bi", lambda *a, **k: ([], [], {"alertas": []}))
    monkeypatch.setattr(R, "enriquecer", lambda *a, **k: None)
    monkeypatch.setattr(R, "escrever_csv", lambda *a, **k: None)
    assert R.main(["--fonte", "fiesc", "--ano", "2024", "--saida", str(tmp_path / "x.csv"),
                   "--cache", str(tmp_path / "cache")]) == 0
    assert visto["delay"] >= 1

    # valor abaixo de 1 s sobe no construtor real
    portal = P.PortalParadigma(P.FONTES["fiesc"], delay=0.6, sessao=MagicMock())
    assert portal.delay >= 1

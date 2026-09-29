"""Relatório anual: números em padrão brasileiro e linhas do BI a partir do bruto (fixture real SFIEC PE000652022)."""
import json
from pathlib import Path

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

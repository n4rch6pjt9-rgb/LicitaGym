"""Workflow coletor-sistema-s.yml: visibilidade e fim controlado (12/11/2026).

Medido em 12/11/2026: sesc_senac_rs cancelado nos 14 jobs (60 min, sem uma linha de log depois do catálogo; o
progresso saía em print() com buffer e se perdia no cancelamento) e linhas de coleta_externa_run abertas até o dia
seguinte, porque o Actions matava o step no limite do job sem folga para o coletor fechar o registro."""
import re
from pathlib import Path

COLETOR = Path(__file__).resolve().parents[1]
WORKFLOW = COLETOR.parents[1] / ".github" / "workflows" / "coletor-sistema-s.yml"
WORKFLOW_PNCP = COLETOR.parents[1] / ".github" / "workflows" / "coletor-pncp.yml"


def _texto(caminho=WORKFLOW):
    return caminho.read_text(encoding="utf-8")


def test_saida_sem_buffer_nos_dois_coletores():
    for caminho in (WORKFLOW, WORKFLOW_PNCP):
        assert re.search(r'PYTHONUNBUFFERED:\s*"1"', _texto(caminho)), caminho.name


def test_coleta_termina_antes_do_limite_do_job_para_fechar_o_registro():
    texto = _texto()
    job = int(re.search(r"coletar:.*?timeout-minutes:\s*(\d+)", texto, re.S).group(1))
    m = re.search(r'timeout --kill-after=(\d+)m "\$\{LIMITE_ETAPA:-(\d+)m\}" python3 -m coletor\.paradigma', texto)
    assert m, "a coleta tem de rodar sob timeout interno (SIGTERM fecha o registro como falha)"
    assert int(m.group(2)) + int(m.group(1)) < job


def test_sesc_senac_rs_fora_do_lote_agendado_mas_disponivel_a_mao():
    texto = _texto()
    todas = re.search(r"todas\|\"\"\)\s*\n\s*FONTES='(\[[^']*\])'", texto).group(1)
    assert "sesc_senac_rs" not in todas
    assert re.search(r"\|sesc_senac_rs\|", texto), "continua aceita no disparo manual"

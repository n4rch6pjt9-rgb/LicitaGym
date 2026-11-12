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
    m = re.search(
        r'timeout --kill-after=(\d+)m "\$\{LIMITE_ETAPA:-(\d+)m\}" python3 -m coletor\.paradigma',
        texto,
    )
    assert m, (
        "a coleta tem de rodar sob timeout interno (SIGTERM fecha o registro como falha)"
    )
    assert int(m.group(2)) + int(m.group(1)) < job
    # Regressão (revisor, 12/11/2026): o fieb leva de 54 a 60 min (runs de 03 a 12/11). Limite menor cortaria a
    # maioria das execuções que hoje concluem e congelaria a saúde dele.
    assert int(m.group(2)) >= 60


def test_sesc_senac_rs_fora_do_lote_agendado_mas_disponivel_a_mao():
    texto = _texto()
    todas = re.search(r"todas\|\"\"\)\s*\n\s*FONTES='(\[[^']*\])'", texto).group(1)
    assert "sesc_senac_rs" not in todas
    assert re.search(r"\|sesc_senac_rs\|", texto), "continua aceita no disparo manual"


def _blocos_run(texto):
    """Conteúdo de cada `run: |`: as linhas seguintes mais indentadas que a própria chave."""
    blocos, linhas = [], texto.splitlines()
    for i, linha in enumerate(linhas):
        if linha.rstrip().endswith("run: |"):
            recuo = len(linha) - len(linha.lstrip())
            corpo = []
            for seguinte in linhas[i + 1 :]:
                if seguinte.strip() and len(seguinte) - len(seguinte.lstrip()) <= recuo:
                    break
                corpo.append(seguinte)
            blocos.append("\n".join(corpo))
    return blocos


def test_disparo_manual_aceita_lista_de_processos_validada():
    """12/11/2026: teste da camada 3 (detalhe e documentos só do que já está no banco) precisa disparar o coletor para
    uma lista de processos. A lista entra por variável de ambiente (nunca interpolada no script), cada ID é validado e
    só vale com uma fonte."""
    texto = _texto()
    assert re.search(r"^\s{6}processos:\s*$", texto, re.M), (
        "entrada processos no workflow_dispatch"
    )
    assert "PROCESSOS: ${{ github.event.inputs.processos || '' }}" in texto
    for bloco in _blocos_run(texto):
        assert "${{ github.event.inputs.processos" not in bloco, (
            "a entrada não entra direto no script"
        )
    assert "set -f" in texto, "glob desligado antes do laço"
    assert re.search(r"\^\[1-9\]\[0-9\]\*\(/\[1-9\]\[0-9\]\*\)\?\$", texto), (
        "cada processo validado como ID ou ID/MODULO"
    )
    assert 'ARGS+=(--processo "${p}")' in texto
    assert re.search(r'"\$\{FONTE\}" = "todas"', texto), (
        "lista de processos exige uma fonte só"
    )


def test_coleta_recebe_o_visitante_dos_secrets():
    """12/11/2026: sem VISITANTE_* no ambiente, os 71 documentos do teste da FIEB ficaram pendentes."""
    coleta = _texto().split("- name: Coleta", 1)[1]
    for nome in ("CNPJ", "CPF", "NOME", "RAZAO_SOCIAL", "EMAIL", "TELEFONE", "UF", "CONTATO", "CONSENTIMENTO_LGPD"):
        assert f"VISITANTE_{nome}: ${{{{ secrets.VISITANTE_{nome} }}}}" in coleta, nome

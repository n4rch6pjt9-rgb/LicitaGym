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


def _grupo(texto, variavel):
    return re.search(rf"^\s*{variavel}='([^']*)'", texto, re.M).group(1)


def test_k8_grupos_por_tamanho_e_grandes_em_camadas():
    """Spec 0064, K-8 (substitui a regra de 12/11/2026 que tirava o sesc_senac_rs do lote): pequenas num job, em
    sequência, cada uma com orçamento; médias um job cada; fieb e sesc_senac_rs com descoberta no lote diário e carga
    a cada 2 h com 60 min. fiemg, fiergs e fiemt ficam fora do lote (bloqueio do host)."""
    import json  # noqa: PLC0415

    texto = _texto()
    pequenas = json.loads(_grupo(texto, "PEQUENAS"))
    assert set(pequenas["fontes"].split()) == {"sescdn", "findes", "sescrj", "fiems", "sfiec", "sescsp", "sestsenat"}
    assert pequenas["etapa"] == "completa" and pequenas["orcamento"]
    limite = int(pequenas["limite"].rstrip("m"))
    assert int(pequenas["orcamento"]) < limite and (limite + 1) * len(pequenas["fontes"].split()) < 75
    medias = json.loads(f"[{_grupo(texto, 'MEDIAS')}]")
    assert sorted(g["fontes"] for g in medias) == ["fiesc", "firjan", "sescba"]
    assert all(g["etapa"] == "completa" and g["orcamento"] == "60" for g in medias)
    desc = json.loads(f"[{_grupo(texto, 'GRANDES_DESC')}]")
    carga = json.loads(f"[{_grupo(texto, 'GRANDES_CARGA')}]")
    assert sorted(g["fontes"] for g in desc) == sorted(g["fontes"] for g in carga) == ["fieb", "sesc_senac_rs"]
    assert all(g["etapa"] == "descoberta" for g in desc)
    assert all(g["etapa"] == "carga" and g["orcamento"] == "60" for g in carga)
    assert all(int(g["orcamento"] or 0) + 1 < int(g["limite"].rstrip("m")) < 75
               for g in [pequenas, *medias, *desc, *carga])
    assert re.search(r'cron:\s*"30 9 \* \* \*"', texto) and re.search(r'cron:\s*"15 \*/2 \* \* \*"', texto)
    assert re.search(r'"\$\{AGENDA\}" = "15 \*/2 \* \* \*"', texto), "a agenda de 2 h roda só a carga das grandes"
    todas = " ".join([pequenas["fontes"], *(g["fontes"] for g in medias + desc)])
    for bloqueada in ("fiemg", "fiergs", "fiemt"):
        assert bloqueada not in todas
    assert re.search(r"\|fiergs\|", texto) and re.search(r"\|fiemt\|", texto), "continuam aceitas no disparo manual"
    assert "uses:" not in texto


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
    for nome in ("CNPJ", "CPF", "NOME", "RAZAO_SOCIAL", "EMAIL", "TELEFONE", "CONTATO", "HASH_CHAVE"):
        assert f"VISITANTE_{nome}: ${{{{ secrets.VISITANTE_{nome} }}}}" in coleta, nome


def test_consentimento_e_uf_vem_de_variavel_e_nao_de_secret():
    """12/11/2026, run 43324762704: o secret VISITANTE_CONSENTIMENTO_LGPD=1 fez o Actions esconder todo "1" do log
    (datas e contadores viraram ***), e a UF esconderia a sigla em todo lugar. Nenhum dos dois é dado sensível."""
    coleta = _texto().split("- name: Coleta", 1)[1]
    for nome in ("UF", "CONSENTIMENTO_LGPD"):
        assert f"VISITANTE_{nome}: ${{{{ vars.VISITANTE_{nome} }}}}" in coleta, nome
        assert f"secrets.VISITANTE_{nome}" not in coleta, nome


def test_cpf_so_com_digitos_tambem_e_mascarado_no_log():
    coleta = _texto().split("- name: Coleta", 1)[1]
    assert 'echo "::add-mask::${VISITANTE_CPF//[!0-9]/}"' in coleta

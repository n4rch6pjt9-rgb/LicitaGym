"""Workflow coletor-pncp.yml (#357): uma etapa por job, cada uma com o seu timeout.

Em 15/10 o modo `todos` num job só passou de 300 min (leads 3h43, monitorar cortado, recoleta sem rodar).
A lógica de shell fica em ci/coletor-pncp.sh para ter teste; o YAML só monta a matriz e chama o script."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

COLETOR = Path(__file__).resolve().parents[1]
SCRIPT = COLETOR / "ci" / "coletor-pncp.sh"
WORKFLOW = COLETOR.parents[1] / ".github" / "workflows" / "coletor-pncp.yml"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash ausente")


def _sh(*args, **env):
    base = {k: v for k, v in os.environ.items() if k not in ("ORIGEM", "DRY_RUN", "RAPIDO", "PYTHON")}
    return subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True, env={**base, **env},
                          timeout=30)


@pytest.mark.parametrize("modo, etapas", [
    ("todos", ["leads", "monitorar", "recoleta"]),
    ("leads", ["leads"]), ("monitorar", ["monitorar"]), ("historico", ["historico"]), ("recoleta", ["recoleta"]),
])
def test_etapas_por_modo(modo, etapas):
    r = _sh("etapas", modo)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == etapas


@pytest.mark.parametrize("modo", ["", "tudo", 'leads"]', "leads,monitorar"])
def test_modo_desconhecido_sai_com_2_sem_json(modo):
    r = _sh("etapas", modo)
    assert r.returncode == 2 and r.stdout == ""


def _rodar(etapa, **env):
    r = _sh("rodar", etapa, PYTHON="echo", **env)   # PYTHON=echo: imprime a linha de comando em vez de coletar
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1].split()


def test_rodar_leads_rapido_dry_run():
    assert _rodar("leads", ORIGEM="manual", RAPIDO="true", DRY_RUN="true") == [
        "-m", "coletor.pncp", "--termos-padrao", "--origem", "manual", "--dry-run"]


def test_rodar_leads_completo_do_cron():
    assert _rodar("leads", ORIGEM="cron") == ["-m", "coletor.pncp", "--origem", "cron"]


def test_rodar_monitorar_e_historico():
    assert _rodar("monitorar", ORIGEM="cron", RAPIDO="true") == [
        "-m", "coletor.pncp", "--modo", "monitorar", "--termos-padrao", "--origem", "cron"]
    assert _rodar("historico", ORIGEM="cron") == ["-m", "coletor.pncp", "--modo", "historico", "--origem", "cron"]


def test_rodar_recoleta_ignora_rapido():
    assert _rodar("recoleta", ORIGEM="cron", RAPIDO="true") == [
        "-m", "coletor.pncp", "--recoletar-atualizadas", "--limite-recoleta", "200", "--origem", "cron"]


def test_rodar_propaga_o_codigo_de_saida_do_coletor():
    assert _sh("rodar", "leads", PYTHON="false", ORIGEM="cron").returncode == 1


def test_rodar_sem_origem_ou_etapa_invalida_falha():
    assert _sh("rodar", "leads", PYTHON="echo").returncode != 0
    assert _sh("rodar", "todos", PYTHON="echo", ORIGEM="cron").returncode == 2
    assert _sh().returncode == 2


def test_dry_run_so_com_true_minusculo():
    assert "--dry-run" not in _rodar("leads", ORIGEM="cron", DRY_RUN="True")


def test_etapa_que_passa_do_limite_sai_com_124(tmp_path):
    """Falha comum (124), não cancelamento do job: as etapas seguintes da matriz continuam."""
    lento = tmp_path / "python-lento"
    lento.write_text("#!/usr/bin/env bash\nsleep 20\n", encoding="utf-8", newline="\n")
    lento.chmod(0o755)
    r = _sh("rodar", "leads", PYTHON=lento.as_posix(), ORIGEM="cron", LIMITE_ETAPA="1s")
    assert r.returncode == 124, r.stderr


def test_workflow_uma_etapa_por_job_em_sequencia():
    wf = WORKFLOW.read_text(encoding="utf-8")
    assert not re.search(r"^\s*-?\s*uses:", wf, re.M), "sem actions de terceiros"
    assert "fromJSON(needs.plano.outputs.etapas)" in wf
    assert "max-parallel: 1" in wf          # uma etapa por vez: o PNCP já derruba conexões com um job só
    assert "fail-fast: false" in wf         # etapa que falha não cancela as outras
    assert "ci/coletor-pncp.sh etapas" in wf and "ci/coletor-pncp.sh rodar" in wf
    timeouts = [int(t) for t in re.findall(r"timeout-minutes:\s*(\d+)", wf)]
    assert timeouts and max(timeouts) <= 360    # teto de um job no runner do GitHub
    limite = int(re.search(r'LIMITE_ETAPA:-(\d+)m', SCRIPT.read_text(encoding="utf-8")).group(1))
    assert limite + 5 <= max(timeouts)          # a coleta para sozinha (falha) antes de o job ser cancelado
    assert "x-access-token:${GH_TOKEN}@" not in wf   # token só no cabeçalho do fetch, fora do .git/config

"""Workflow coletor-precos.yml (spec 0009 + spec 0031): uma etapa por job em sequência.

Segue a mesma estrutura de ci/coletor-pncp.sh e .github/workflows/coletor-pncp.yml:
  1. catalogo     -> python -m coletor.compras_precos --modo catalogo
  2. detalhe      -> python -m coletor.compras_precos --modo detalhe
  3. contratacao  -> python -m coletor.compras_itens_contratacao (API PNCP de contratações/itens)"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

COLETOR = Path(__file__).resolve().parents[1]
SCRIPT = COLETOR / "ci" / "coletor-precos.sh"
WORKFLOW = COLETOR.parents[1] / ".github" / "workflows" / "coletor-precos.yml"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash ausente")


def _sh(*args, **env):
    base = {
        k: v
        for k, v in os.environ.items()
        if k not in ("DRY_RUN", "LIMITE", "DELAY_SEGUNDOS", "PYTHON", "LIMITE_ETAPA")
    }
    return subprocess.run(
        [BASH, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env={**base, **env},
        timeout=30,
    )


@pytest.mark.parametrize("modo, etapas", [
    ("todos", ["catalogo", "detalhe", "contratacao"]),
    ("catalogo", ["catalogo"]),
    ("detalhe", ["detalhe"]),
    ("contratacao", ["contratacao"]),
])
def test_etapas_por_modo(modo, etapas):
    r = _sh("etapas", modo)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == etapas


@pytest.mark.parametrize("modo", ["", "tudo", "leads", 'catalogo"]', "catalogo,detalhe"])
def test_modo_desconhecido_sai_com_2_sem_json(modo):
    r = _sh("etapas", modo)
    assert r.returncode == 2 and r.stdout == ""


def _rodar(etapa, **env):
    r = _sh("rodar", etapa, PYTHON="echo", **env)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip().splitlines()[-1].split()


def test_rodar_catalogo_padrao_e_dry_run_com_limite():
    assert _rodar("catalogo") == [
        "-m", "coletor.compras_precos", "--modo", "catalogo", "--delay", "1.5",
    ]
    assert _rodar("catalogo", DRY_RUN="true", LIMITE="50", DELAY_SEGUNDOS="2.0") == [
        "-m", "coletor.compras_precos", "--modo", "catalogo", "--delay", "2.0", "--dry-run", "--limite", "50",
    ]


def test_rodar_detalhe():
    assert _rodar("detalhe") == [
        "-m", "coletor.compras_precos", "--modo", "detalhe", "--delay", "1.5",
    ]
    assert _rodar("detalhe", DRY_RUN="true", LIMITE="10") == [
        "-m", "coletor.compras_precos", "--modo", "detalhe", "--delay", "1.5", "--dry-run", "--limite", "10",
    ]


def test_rodar_contratacao_pncp():
    assert _rodar("contratacao") == [
        "-m", "coletor.compras_itens_contratacao", "--delay", "1.5",
    ]
    assert _rodar("contratacao", DRY_RUN="true", LIMITE="25") == [
        "-m", "coletor.compras_itens_contratacao", "--delay", "1.5", "--dry-run", "--limite", "25",
    ]


def test_rodar_propaga_o_codigo_de_saida_do_coletor():
    assert _sh("rodar", "catalogo", PYTHON="false").returncode == 1


def test_rodar_etapa_invalida_falha():
    assert _sh("rodar", "todos", PYTHON="echo").returncode == 2
    assert _sh("rodar", "invalida", PYTHON="echo").returncode == 2
    assert _sh().returncode == 2


def test_dry_run_so_com_true_minusculo():
    assert "--dry-run" not in _rodar("catalogo", DRY_RUN="True")


def test_etapa_que_passa_do_limite_sai_com_124(tmp_path):
    """Falha comum (124), não cancelamento do job: as etapas seguintes da matriz continuam."""
    lento = tmp_path / "python-lento"
    lento.write_text("#!/usr/bin/env bash\nsleep 20\n", encoding="utf-8", newline="\n")
    lento.chmod(0o755)
    r = _sh("rodar", "catalogo", PYTHON=lento.as_posix(), LIMITE_ETAPA="1s")
    assert r.returncode == 124, r.stderr


def test_workflow_uma_etapa_por_job_em_sequencia():
    wf = WORKFLOW.read_text(encoding="utf-8")
    assert not re.search(r"^\s*-?\s*uses:", wf, re.M), "sem actions de terceiros"
    assert "fromJSON(needs.plano.outputs.etapas)" in wf
    assert "max-parallel: 1" in wf
    assert "fail-fast: false" in wf
    assert "ci/coletor-precos.sh etapas" in wf and "ci/coletor-precos.sh rodar" in wf
    timeouts = [int(t) for t in re.findall(r"timeout-minutes:\s*(\d+)", wf)]
    assert timeouts and max(timeouts) <= 360
    limite = int(re.search(r"LIMITE_ETAPA:-(\d+)m", SCRIPT.read_text(encoding="utf-8")).group(1))
    assert limite + 5 <= max(timeouts)
    assert "x-access-token:${GH_TOKEN}@" not in wf

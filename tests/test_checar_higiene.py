"""Testes de scripts/ci/checar-higiene.sh (pre-commit e CI) num repositório git descartável."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

RAIZ_REPO = Path(__file__).resolve().parents[1]
SCRIPT = RAIZ_REPO / "scripts" / "ci" / "checar-higiene.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash não disponível")


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "teste@example.com")
    _git(tmp_path, "config", "user.name", "teste")
    ci = tmp_path / "scripts" / "ci"
    ci.mkdir(parents=True)
    shutil.copy(SCRIPT, ci / "checar-higiene.sh")
    (ci / "raiz-permitida.txt").write_text("scripts\ndocs\ntests\nREADME.md\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("ok\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


def _escrever(repo: Path, caminho: str, texto: str = "conteudo\n") -> None:
    alvo = repo / caminho
    alvo.parent.mkdir(parents=True, exist_ok=True)
    alvo.write_text(texto, encoding="utf-8")


def _checar_staged(repo: Path) -> subprocess.CompletedProcess:
    _git(repo, "add", "-A")
    diff = subprocess.run(
        ["git", "-c", "core.quotePath=false", "diff", "--cached", "--name-status", "--diff-filter=ACMR"],
        cwd=repo, check=True, capture_output=True, text=True,
    ).stdout
    return subprocess.run(
        [BASH, "scripts/ci/checar-higiene.sh", "-"],
        cwd=repo, input=diff, capture_output=True, text=True, env={**os.environ, "HIGIENE_STAGED": "1"},
    )


def test_arquivo_normal_passa(repo):
    _escrever(repo, "scripts/coletor.py", "print('ok')\n")
    r = _checar_staged(repo)
    assert r.returncode == 0, r.stdout
    assert "higiene: ok" in r.stdout


def test_marcador_de_conflito_bloqueia(repo):
    _escrever(repo, "scripts/ia.py", "a = 1\n<<<<<<< HEAD\nb = 2\n=======\nb = 3\n>>>>>>> outro\n")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "marcador de conflito em scripts/ia.py:2" in r.stdout


def test_separador_sozinho_em_markdown_nao_bloqueia(repo):
    _escrever(repo, "docs/guia.md", "Título\n=======\n\ntexto\n")
    assert _checar_staged(repo).returncode == 0


def test_separador_sozinho_em_codigo_bloqueia(repo):
    _escrever(repo, "scripts/x.py", "a = 1\n=======\n")
    assert _checar_staged(repo).returncode == 1


@pytest.mark.parametrize("caminho", [
    "scripts/run.log",
    "docs/sessao.har",
    "docs/pacote.zip",
    "scripts/collector_grupo_material_resultado.json",
    "scripts/.env",
    "scripts/.env.local",
    "docs/precos.csv",
])
def test_arquivo_proibido_bloqueia(repo, caminho):
    _escrever(repo, caminho)
    r = _checar_staged(repo)
    assert r.returncode == 1, r.stdout
    assert caminho in r.stdout


@pytest.mark.parametrize("caminho", ["scripts/.env.example", "tests/fixtures/precos.csv"])
def test_excecoes_permitidas(repo, caminho):
    _escrever(repo, caminho)
    assert _checar_staged(repo).returncode == 0


def test_item_novo_na_raiz_bloqueia(repo):
    _escrever(repo, "cluster_precos.py", "x = 1\n")
    _escrever(repo, "collector_lib/a.py", "x = 1\n")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "novo item na raiz: cluster_precos.py" in r.stdout
    assert "novo item na raiz: collector_lib" in r.stdout


def test_alterar_arquivo_existente_na_raiz_passa(repo):
    _escrever(repo, "README.md", "mudou\n")
    assert _checar_staged(repo).returncode == 0


def test_renomear_para_a_raiz_bloqueia(repo):
    _escrever(repo, "scripts/util.py", "x = 1\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "util")
    _git(repo, "mv", "scripts/util.py", "util.py")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "novo item na raiz: util.py" in r.stdout

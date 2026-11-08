"""Casos do scripts/ci/guard-migrations.sh: nome, versão repetida e ordem em relação à base.

Cada caso monta um repositório git descartável (base = main, HEAD = branch do PR) e roda o script de verdade.
Regressão do #469 x #470: as duas migrations com a versão 20261108130000 entraram na main e a integração
Supabase recusou a segunda (schema_migrations_pkey).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ci" / "guard-migrations.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(
    BASH is None or shutil.which("git") is None, reason="precisa de bash e git"
)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, timeout=30
    )


def _migration(repo: Path, nome: str, sql: str = "select 1;\n") -> None:
    caminho = repo / "supabase" / "migrations" / nome
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(sql, encoding="utf-8")


def _repo(tmp_path: Path, base: list[str]) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "teste@example.invalid")
    _git(repo, "config", "user.name", "teste")
    _git(repo, "config", "core.autocrlf", "false")
    for nome in base:
        _migration(repo, nome)
    (repo / "README").write_text("base\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "switch", "-q", "-c", "pr")
    return repo


def _rodar(repo: Path, novas: list[str]) -> subprocess.CompletedProcess[str]:
    for nome in novas:
        _migration(repo, nome)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "pr")
    return subprocess.run(
        [BASH, str(SCRIPT), "main"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )


BASE = ["202609180002_antiga.sql", "20261108120000_sessao_mensagens_global.sql"]


def test_versao_nova_depois_da_base_passa(tmp_path: Path) -> None:
    r = _rodar(_repo(tmp_path, BASE), ["20261108140000_nova.sql"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "ordem OK" in r.stdout


def test_versao_repetida_falha(tmp_path: Path) -> None:
    base = BASE + ["20261108130000_sessao_chat_cron_retencao.sql"]
    r = _rodar(
        _repo(tmp_path, base),
        ["20261108130000_licitacoes_externas_remove_policies_drift.sql"],
    )
    assert r.returncode == 1
    assert "versão 20261108130000 repetida" in r.stdout


def test_versao_anterior_a_ultima_da_base_falha(tmp_path: Path) -> None:
    r = _rodar(_repo(tmp_path, BASE), ["20261102152445_pca_estado_operacional.sql"])
    assert r.returncode == 1
    assert "não é maior que a última da base (20261108120000)" in r.stdout


def test_versao_igual_a_ultima_da_base_falha(tmp_path: Path) -> None:
    r = _rodar(_repo(tmp_path, BASE), ["20261108120000_outra.sql"])
    assert r.returncode == 1
    assert "repetida" in r.stdout and "não é maior" in r.stdout


def test_duas_novas_com_mesma_versao_no_pr_falham(tmp_path: Path) -> None:
    r = _rodar(_repo(tmp_path, BASE), ["20261108150000_a.sql", "20261108150000_b.sql"])
    assert r.returncode == 1
    falhas = [
        linha
        for linha in r.stdout.splitlines()
        if linha.startswith("FALHA") and "repetida" in linha
    ]
    assert len(falhas) == 2


def test_versao_de_12_digitos_na_base_vale_como_00(tmp_path: Path) -> None:
    r = _rodar(
        _repo(tmp_path, ["202611081500_antiga.sql"]), ["20261108145959_nova.sql"]
    )
    assert r.returncode == 1
    assert "(20261108150000)" in r.stdout


def test_nome_fora_do_padrao_continua_falhando(tmp_path: Path) -> None:
    r = _rodar(_repo(tmp_path, BASE), ["20261108140000_Nome-Errado.sql"])
    assert r.returncode == 1
    assert "nome fora do padrão" in r.stdout


def test_sem_migration_nova_passa(tmp_path: Path) -> None:
    repo = _repo(tmp_path, BASE)
    (repo / "README").write_text("mudou\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "pr")
    r = subprocess.run(
        [BASH, str(SCRIPT), "main"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert r.returncode == 0
    assert "nenhuma migration nova" in r.stdout

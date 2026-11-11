"""Testes de scripts/ci/checar-higiene.sh (pre-commit e CI) num repositório git descartável."""

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

RAIZ_REPO = Path(__file__).resolve().parents[1]
SCRIPT = RAIZ_REPO / "scripts" / "ci" / "checar-higiene.sh"
BASH = shutil.which("bash")

pytestmark = pytest.mark.skipif(BASH is None, reason="bash não disponível")

# Montados em partes para o próprio arquivo de teste não parecer segredo nem conflito.
JWT_FALSO = "eyJ" + "a" * 20 + "." + "b" * 20 + ".assinatura"
CONFLITO = "<" * 7 + " HEAD\n"


# Dentro de um hook do git (pre-commit) GIT_DIR/GIT_INDEX_FILE apontam para o repo real; o repo do teste é outro.
ENV_LIMPO = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


@dataclass
class Saida:
    returncode: int
    stdout: str


def _git(repo: Path, *args: str) -> bytes:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, env=ENV_LIMPO).stdout


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "teste@example.com")
    _git(tmp_path, "config", "user.name", "teste")
    _git(tmp_path, "config", "core.autocrlf", "false")
    ci = tmp_path / "scripts" / "ci"
    ci.mkdir(parents=True)
    shutil.copy(SCRIPT, ci / "checar-higiene.sh")
    (ci / "raiz-permitida.txt").write_text("scripts\ndocs\ntests\nREADME.md\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("ok\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-q", "-m", "base")
    return tmp_path


def _escrever(repo: Path, caminho: str, texto: str | bytes = "conteudo\n") -> None:
    alvo = repo / caminho
    alvo.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(texto, bytes):
        alvo.write_bytes(texto)
    else:
        alvo.write_text(texto, encoding="utf-8")


def _rodar(repo: Path, entrada: bytes, **env: str) -> Saida:
    r = subprocess.run(
        [BASH, "scripts/ci/checar-higiene.sh", "-"],
        cwd=repo, input=entrada, capture_output=True, env={**ENV_LIMPO, **env},
    )
    return Saida(r.returncode, r.stdout.decode("utf-8", "replace"))


def _checar_staged(repo: Path) -> Saida:
    """Modo pre-commit: lê o índice."""
    _git(repo, "add", "-A")
    diff = _git(repo, "diff", "--cached", "--name-status", "-z", "--diff-filter=ACMR")
    return _rodar(repo, diff, HIGIENE_STAGED="1")


def _commitar(repo: Path, msg: str = "c") -> None:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", msg)


def _checar_ci(repo: Path, base: str = "HEAD~1") -> Saida:
    """Modo CI: diff da base até HEAD, conteúdo lido de HEAD (não do disco)."""
    diff = _git(repo, "diff", "--name-status", "-z", "--diff-filter=ACMR", base, "HEAD")
    return _rodar(repo, diff)


def _checar_ci_commits(repo: Path, base: str) -> Saida:
    """Modo CI, cada commit do PR: só o tipo do arquivo adicionado."""
    log = _git(repo, "log", "--format=", "--name-status", "-z", "--diff-filter=AR", f"{base}..HEAD")
    return _rodar(repo, log, HIGIENE_SO_TIPO="1")


# --- básico ---------------------------------------------------------------------------------------------------

def test_arquivo_normal_passa(repo):
    _escrever(repo, "scripts/coletor.py", "print('ok')\n")
    r = _checar_staged(repo)
    assert r.returncode == 0, r.stdout
    assert "higiene: ok" in r.stdout


# --- conflito de merge ----------------------------------------------------------------------------------------

def test_marcador_de_conflito_bloqueia(repo):
    _escrever(repo, "scripts/ia.py", "a = 1\n" + CONFLITO + "b = 2\n=======\nb = 3\n>>>>>>> outro\n")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "marcador de conflito em scripts/ia.py:2" in r.stdout


def test_marcador_em_arquivo_modificado_bloqueia(repo):
    _escrever(repo, "scripts/a.py", "x = 1\n")
    _commitar(repo)
    _escrever(repo, "scripts/a.py", "x = 1\n" + CONFLITO)
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "marcador de conflito em scripts/a.py:2" in r.stdout


@pytest.mark.parametrize("caminho", ["docs/guia.md", "docs/guia.mdx", ".cursor/regra.mdc", "docs/notas.txt"])
def test_separador_sozinho_em_texto_nao_bloqueia(repo, caminho):
    (repo / "scripts/ci/raiz-permitida.txt").write_text("scripts\ndocs\n.cursor\nREADME.md\n", encoding="utf-8")
    _escrever(repo, caminho, "Título\n=======\n\ntexto\n")
    assert _checar_staged(repo).returncode == 0


def test_separador_sozinho_em_codigo_bloqueia(repo):
    _escrever(repo, "scripts/x.py", "a = 1\n=======\n")
    assert _checar_staged(repo).returncode == 1


def test_separador_com_crlf_bloqueia(repo):
    _escrever(repo, "scripts/x.py", b"a = 1\r\n=======\r\n")
    assert _checar_staged(repo).returncode == 1


def test_binario_nao_e_lido_como_conflito(repo):
    _escrever(repo, "docs/imagem.bin", b"\x00\x01\x02" + CONFLITO.encode())
    assert _checar_staged(repo).returncode == 0


def test_caminho_com_espaco_e_acento(repo):
    _escrever(repo, "docs/pasta com espaço/ação.py", "x = 1\n" + CONFLITO)
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "marcador de conflito em docs/pasta com espaço/ação.py:2" in r.stdout


# --- segredo no conteúdo --------------------------------------------------------------------------------------

@pytest.mark.parametrize("texto", [
    f'token = "{JWT_FALSO}"\n',
    "chave = 'sbp_" + "0123456789abcdef" * 2 + "'\n",
    "-----BEGIN " + "PRIVATE KEY-----\nabc\n",
    '{"type": "service_' + 'account", "project_id": "x"}\n',
])
def test_segredo_no_conteudo_bloqueia(repo, texto):
    _escrever(repo, "scripts/config.py", texto)
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "possível segredo em scripts/config.py:1" in r.stdout


# --- tipos proibidos ------------------------------------------------------------------------------------------

@pytest.mark.parametrize("caminho", [
    "scripts/run.log",
    "docs/sessao.har",
    "docs/sessao.HAR",
    "docs/sessao.har.gz",
    "docs/pacote.zip",
    "docs/pacote.Zip",
    "docs/pacote.tar.gz",
    "docs/pacote.7z",
    "docs/pacote.rar",
    "docs/chave.pem",
    "docs/chave.key",
    "docs/cert.p12",
    "docs/local.sqlite3",
    "scripts/collector_grupo_material_resultado.json",
    "scripts/.env",
    "scripts/.Env",
    "scripts/.env.local",
    "scripts/prod.env",
    "scripts/.envrc",
    "docs/precos.csv",
    "docs/precos.CSV",
])
def test_arquivo_proibido_bloqueia(repo, caminho):
    _escrever(repo, caminho)
    r = _checar_staged(repo)
    assert r.returncode == 1, r.stdout
    assert caminho in r.stdout


@pytest.mark.parametrize("caminho", ["scripts/.env.example", "tests/fixtures/precos.csv", "tests/x/fixtures/a.csv"])
def test_excecoes_permitidas(repo, caminho):
    _escrever(repo, caminho)
    assert _checar_staged(repo).returncode == 0


def test_renomear_para_tipo_proibido_bloqueia(repo):
    _escrever(repo, "scripts/a.txt", "x\n")
    _commitar(repo)
    _git(repo, "mv", "scripts/a.txt", "scripts/a.log")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "scripts/a.log" in r.stdout


# --- raiz -----------------------------------------------------------------------------------------------------

def test_item_novo_na_raiz_bloqueia(repo):
    _escrever(repo, "cluster_precos.py", "x = 1\n")
    _escrever(repo, "collector_lib/a.py", "x = 1\n")
    _escrever(repo, "collector_lib/b.py", "x = 1\n")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "novo item na raiz: cluster_precos.py" in r.stdout
    assert r.stdout.count("novo item na raiz: collector_lib") == 1


def test_alterar_arquivo_existente_na_raiz_passa(repo):
    _escrever(repo, "README.md", "mudou\n")
    assert _checar_staged(repo).returncode == 0


def test_renomear_para_a_raiz_bloqueia(repo):
    _escrever(repo, "scripts/util.py", "x = 1\n")
    _commitar(repo)
    _git(repo, "mv", "scripts/util.py", "util.py")
    r = _checar_staged(repo)
    assert r.returncode == 1
    assert "novo item na raiz: util.py" in r.stdout


def test_lista_da_raiz_vem_do_indice_no_pre_commit(repo):
    _escrever(repo, "pyproject.toml", "[x]\n")
    _git(repo, "add", "pyproject.toml")
    # Lista editada no disco mas fora do índice: o pre-commit não pode aceitar (a CI reprovaria).
    (repo / "scripts/ci/raiz-permitida.txt").write_text("scripts\ndocs\ntests\nREADME.md\npyproject.toml\n", "utf-8")
    diff = _git(repo, "diff", "--cached", "--name-status", "-z", "--diff-filter=ACMR")
    r = _rodar(repo, diff, HIGIENE_STAGED="1")
    assert r.returncode == 1
    assert "novo item na raiz: pyproject.toml" in r.stdout


# --- modo CI --------------------------------------------------------------------------------------------------

def test_ci_le_o_conteudo_do_commit_e_nao_do_disco(repo):
    _escrever(repo, "scripts/a.py", "x = 1\n" + CONFLITO)
    _commitar(repo)
    _escrever(repo, "scripts/a.py", "x = 1\n")  # disco corrigido, commit ainda quebrado
    r = _checar_ci(repo)
    assert r.returncode == 1
    assert "marcador de conflito em scripts/a.py:2" in r.stdout


def test_ci_passa_em_pr_limpo(repo):
    _escrever(repo, "scripts/a.py", "x = 1\n")
    _commitar(repo)
    assert _checar_ci(repo).returncode == 0


def test_ci_pega_arquivo_proibido_adicionado_e_apagado_em_commits_do_pr(repo):
    base = _git(repo, "rev-parse", "HEAD").decode().strip()
    _escrever(repo, "docs/sessao.har", "cookie\n")
    _commitar(repo, "adiciona")
    (repo / "docs/sessao.har").unlink()
    _commitar(repo, "apaga")
    assert _checar_ci(repo, base).returncode == 0  # o estado final está limpo...
    r = _checar_ci_commits(repo, base)  # ...mas o histórico do PR não
    assert r.returncode == 1
    assert "docs/sessao.har" in r.stdout

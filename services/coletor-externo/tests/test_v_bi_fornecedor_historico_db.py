"""Teste real contra a view v_bi_fornecedor_historico no PostgreSQL local com as migrations aplicadas."""
import shutil
import subprocess
from pathlib import Path
import pytest


def test_v_bi_fornecedor_historico_dedup_real():
    """Valida a view v_bi_fornecedor_historico contra banco PostgreSQL local:
    1. Deduplicação federal PNCP + Compras.gov (link_sistema_origem -> 99999999900012026): 1 venda / 1 certame.
    2. Sistema S / Paradigma (3 certames com mesmo nCdProcesso e CNPJ: 2 tenants + 1 mesmo tenant outro módulo): 3 vendas / 3 certames.
    """
    if shutil.which("psql") is None:
        pytest.skip("sem Postgres local; prova é o psql")

    # Resolve o caminho de bi_fornecedor_historico_view_check.sql relativo a este arquivo de teste
    # services/coletor-externo/tests/test_v_bi_fornecedor_historico_db.py
    # .parent = tests
    # .parent.parent = coletor-externo
    # .parent.parent.parent = services
    # .parent.parent.parent.parent = workspace (raiz do repo)
    repo_root = Path(__file__).resolve().parent.parent.parent.parent
    check_script = repo_root / "supabase" / "tests" / "bi_fornecedor_historico_view_check.sql"

    if not check_script.exists():
        pytest.skip(f"Arquivo {check_script} não encontrado")

    # Verifica se o banco local de testes responde antes de tentar rodar
    probe = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "test_licitagym", "-c", "SELECT 1;"],
                           capture_output=True, text=True)
    if probe.returncode != 0:
        pytest.skip("sem Postgres local; prova é o psql")

    cmd = ["sudo", "-u", "postgres", "psql", "-d", "test_licitagym", "-v", "ON_ERROR_STOP=1", "-f", str(check_script)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    saida = (res.stdout or "") + (res.stderr or "")
    assert res.returncode == 0, f"Falha na execução de {check_script}:\n{saida}"
    assert "CASO 1: total_vendas_homologadas = 1, total_certames = 1" in saida
    assert "CASO 2: total_vendas_homologadas = 3, total_certames = 3" in saida
    assert "SUCESSO: Todos os testes reais contra v_bi_fornecedor_historico passaram com louvor!" in saida

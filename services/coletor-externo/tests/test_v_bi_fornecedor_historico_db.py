"""Teste real contra a view v_bi_fornecedor_historico no PostgreSQL local com as migrations aplicadas."""
import os
import shutil
import subprocess
import pytest


@pytest.mark.skipif(shutil.which("psql") is None, reason="psql não disponível no ambiente")
def test_v_bi_fornecedor_historico_dedup_real():
    """Valida a view v_bi_fornecedor_historico contra banco PostgreSQL local:
    1. Deduplicação federal PNCP + Compras.gov (link_sistema_origem -> 16021105900032024): 1 venda / 1 certame.
    2. Sistema S / Paradigma (3 certames com mesmo nCdProcesso e CNPJ: 2 tenants + 1 mesmo tenant outro módulo): 3 vendas / 3 certames.
    """
    check_script = "/workspace/supabase/tests/bi_fornecedor_historico_view_check.sql"
    if not os.path.exists(check_script):
        pytest.skip(f"Arquivo {check_script} não encontrado")

    cmd = ["sudo", "-u", "postgres", "psql", "-d", "test_licitagym", "-v", "ON_ERROR_STOP=1", "-f", check_script]
    res = subprocess.run(cmd, capture_output=True, text=True)
    saida = (res.stdout or "") + (res.stderr or "")
    assert res.returncode == 0, f"Falha na execução de {check_script}:\n{saida}"
    assert "CASO 1: total_vendas_homologadas = 1, total_certames = 1" in saida
    assert "CASO 2: total_vendas_homologadas = 3, total_certames = 3" in saida
    assert "SUCESSO: Todos os testes reais contra v_bi_fornecedor_historico passaram com louvor!" in saida

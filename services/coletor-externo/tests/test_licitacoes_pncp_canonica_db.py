"""Teste real da view licitacoes_pncp_canonica (compra PNCP republicada) no PostgreSQL local com as migrations aplicadas."""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
FIXTURES = REPO_ROOT / "supabase" / "tests" / "licitacoes_pncp_canonica_fixtures_check.sql"
CHECK = REPO_ROOT / "supabase" / "tests" / "licitacoes_pncp_canonica_check.sql"


def _psql(script: Path) -> subprocess.CompletedProcess:
    if shutil.which("psql") is None:
        pytest.skip("sem Postgres local; prova é o psql")
    if not script.exists():
        pytest.skip(f"Arquivo {script} não encontrado")
    probe = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "test_licitagym", "-c", "SELECT 1;"],
                           capture_output=True, text=True)
    if probe.returncode != 0:
        pytest.skip("sem Postgres local; prova é o psql")
    return subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "test_licitagym", "-v", "ON_ERROR_STOP=1",
                           "-f", str(script)], capture_output=True, text=True)


def test_licitacoes_pncp_canonica_fixtures_real():
    """Casos sintéticos (begin/rollback): cada critério de desempate decide sozinho, chave NULL e não PNCP
    ficam canônicas, e o BI (v_bi_resultados_itens, v_bi_orgaos_match, v_bi_fornecedor_historico,
    oportunidades_borracha) conta a compra republicada uma vez."""
    res = _psql(FIXTURES)
    saida = (res.stdout or "") + (res.stderr or "")
    assert res.returncode == 0, f"Falha na execução de {FIXTURES}:\n{saida}"
    assert ('CASO canônicas: {"A1": "A2", "A2": "A2", "B1": "B1", "B2": "B1", "C1": "C2", "C2": "C2", '
            '"D1": "D2", "D2": "D2", "D3": "D2", "E1": "E2", "E2": "E2", "F1": "F1", "F2": "F1", '
            '"H1": "H2", "H2": "H2", "N1": "N1", "N2": "N2", "S1": "S1", "S2": "S2"}') in saida
    assert "CASO H v_bi_resultados_itens: 1 linha(s), valor 18000" in saida
    assert "CASO H v_bi_fornecedor_historico: total_vendas_homologadas = 1, total_certames = 1" in saida
    assert "SUCESSO: licitacoes_pncp_canonica_fixtures_check" in saida


def test_licitacoes_pncp_canonica_check_real():
    """Verificação só leitura (a mesma que roda em produção): grants, security_invoker e invariantes."""
    res = _psql(CHECK)
    saida = (res.stdout or "") + (res.stderr or "")
    assert res.returncode == 0, f"Falha na execução de {CHECK}:\n{saida}"
    assert "licitacoes_pncp_canonica_check:" in saida and " 0 falhas" in saida

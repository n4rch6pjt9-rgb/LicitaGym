import pytest

from coletor import pncp, pncp_cloud_run
from coletor.escopo import TERMOS_ESCOPO_COMPLETO


@pytest.mark.parametrize("idx,total,esperado", [("0", "4", "1/4"), ("3", "4", "4/4"), ("0", "1", "1/1")])
def test_lote_da_task(idx, total, esperado):
    assert pncp_cloud_run.lote_da_task({"CLOUD_RUN_TASK_INDEX": idx, "CLOUD_RUN_TASK_COUNT": total}) == esperado


def test_lote_da_task_sem_cloud_run_roda_tudo():
    assert pncp_cloud_run.lote_da_task({}) == "1/1"


@pytest.mark.parametrize("idx,total", [("4", "4"), ("-1", "4"), ("0", "0"), ("x", "4")])
def test_lote_da_task_invalido(idx, total):
    with pytest.raises(ValueError):
        pncp_cloud_run.lote_da_task({"CLOUD_RUN_TASK_INDEX": idx, "CLOUD_RUN_TASK_COUNT": total})


def test_quatro_tasks_cobrem_os_termos_sem_repetir():
    fatias = [pncp.fatiar_lote(list(TERMOS_ESCOPO_COMPLETO),
                               pncp_cloud_run.lote_da_task({"CLOUD_RUN_TASK_INDEX": str(i), "CLOUD_RUN_TASK_COUNT": "4"}))
              for i in range(4)]
    assert [t for f in fatias for t in f] == list(TERMOS_ESCOPO_COMPLETO)
    assert all(fatias)


def test_main_repassa_lote_e_argumentos(monkeypatch):
    chamado = {}
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "2")
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "4")
    monkeypatch.setattr(pncp, "main", lambda argv: chamado.setdefault("argv", argv) and 0)
    assert pncp_cloud_run.main(["--modo", "monitorar"]) == 0
    assert chamado["argv"] == ["--lote", "3/4", "--modo", "monitorar"]


def _sem_rodar(monkeypatch):
    """Falha o teste se o wrapper chegar a chamar o coletor."""
    monkeypatch.setattr(pncp, "main", lambda argv: pytest.fail(f"não devia rodar: {argv}"))


@pytest.mark.parametrize("argv", [["--lote", "1/4"], ["--lote=1/4"], ["--lot", "1/4"], ["--lot=2/4"]])
def test_main_recusa_lote_explicito_e_abreviado(monkeypatch, argv):
    _sem_rodar(monkeypatch)
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "0")
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "4")
    with pytest.raises(SystemExit, match="--lote vem de"):
        pncp_cloud_run.main(argv)


@pytest.mark.parametrize("argv", [["--baixar-pendentes"], ["--baixar-p"], ["--corrigir-processos"], ["--corrigir"],
                                  ["--dry-run", "--baixar-pend"]])
def test_main_recusa_modos_da_tabela_inteira_com_varias_tasks(monkeypatch, argv):
    _sem_rodar(monkeypatch)
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "1")
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "4")
    with pytest.raises(SystemExit, match="não divide em lotes"):
        pncp_cloud_run.main(argv)


@pytest.mark.parametrize("argv", [["--baixar-pendentes"], ["--corrigir-processos"]])
def test_main_aceita_modos_da_tabela_inteira_com_uma_task(monkeypatch, argv):
    chamado = {}
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "0")
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "1")
    monkeypatch.setattr(pncp, "main", lambda a: chamado.setdefault("argv", a) and 0)
    assert pncp_cloud_run.main(argv) == 0
    assert chamado["argv"] == ["--lote", "1/1", *argv]


def test_main_argumento_invalido_para_antes_de_rodar(monkeypatch):
    _sem_rodar(monkeypatch)
    with pytest.raises(SystemExit):
        pncp_cloud_run.main(["--opcao-que-nao-existe"])

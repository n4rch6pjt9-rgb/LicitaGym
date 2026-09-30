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


def test_main_recusa_lote_explicito():
    with pytest.raises(SystemExit):
        pncp_cloud_run.main(["--lote", "1/4"])


def test_main_recusa_pendentes_com_varias_tasks(monkeypatch):
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "4")
    with pytest.raises(SystemExit):
        pncp_cloud_run.main(["--baixar-pendentes"])

from coletor.modelos import decompor_modelo


def test_lion_pro():
    assert decompor_modelo("LION", "08450 Tríceps Paralelo PRO") == {
        "linha": "PRO", "codigo": "08450", "nome": "Tríceps Paralelo"}


def test_movement_edge():
    d = decompor_modelo("MOVIMENT", "Cadeira Tríceps Edge")
    assert d["linha"] == "EDGE" and d["codigo"] is None and d["nome"] == "Cadeira Tríceps"


def test_total_health_rx():
    d = decompor_modelo("TOTAL HEALTH", "505BRX - Triceps Press Machine")
    assert d == {"linha": "RX", "codigo": "505BRX", "nome": "Triceps Press Machine"}
    assert decompor_modelo("TOTAL HEALTH", "608RRF - Leg Extension Machine")["linha"] == "RRF"


def test_vazio():
    assert decompor_modelo("LION", "") == {"linha": None, "codigo": None, "nome": None}


def test_ruido_e_medida_nao_viram_codigo():
    assert decompor_modelo("GEARS", "ANILHA 10KG GEARS") == {"linha": None, "codigo": None, "nome": "ANILHA 10KG"}
    assert decompor_modelo("PENALTY", "UND")["nome"] is None
    assert decompor_modelo("SLADE", "PUXADOR -FATURAMENTO MINIMO 1200,00") == {"linha": None, "codigo": None, "nome": "PUXADOR"}
    assert decompor_modelo("MOVEMENT", "Rt-150") == {"linha": "RT", "codigo": "RT-150", "nome": None}
    assert decompor_modelo("MATRIX", "VERDA VSS71H")["linha"] == "VERSA"

"""aplicar_taxonomia: grava as colunas no_taxonomia/versao_taxonomia em licitacao_itens sem sobrescrever o coletor."""
from coletor.aplicar_taxonomia import calcular, montar_patch

TAX_APARELHO = {"versao": "v1", "no_taxonomia": "cadeira_flexora", "versao_taxonomia": "0.3", "plano": {}}
TAX_SEM_NO = {"versao": "v1", "plano": {}}


def test_licitacao_itens_sem_no_grava_colunas():
    p = montar_patch("licitacao_itens", {"id": 1, "no_taxonomia": None}, TAX_APARELHO)
    assert p == {"taxonomia": TAX_APARELHO, "no_taxonomia": "cadeira_flexora", "versao_taxonomia": "0.3"}


def test_nao_sobrescreve_no_do_coletor():
    p = montar_patch("licitacao_itens", {"id": 1, "no_taxonomia": "leg_press"}, TAX_APARELHO)
    assert p == {"taxonomia": TAX_APARELHO}


def test_sem_aparelho_so_jsonb():
    assert montar_patch("licitacao_itens", {"id": 1}, TAX_SEM_NO) == {"taxonomia": TAX_SEM_NO}


def test_contratacoes_itens_so_jsonb():
    # contratacoes_itens não tem as colunas no_taxonomia/versao_taxonomia
    assert montar_patch("contratacoes_itens", {"id": 1}, TAX_APARELHO) == {"taxonomia": TAX_APARELHO}


def test_calcular_real_alimenta_patch():
    tax = calcular("Leg press 45 graus")
    assert tax["no_taxonomia"] == "leg_press_45"
    p = montar_patch("licitacao_itens", {"id": 7, "no_taxonomia": None}, tax)
    assert p["taxonomia"] is tax
    assert p["no_taxonomia"] == "leg_press_45"
    assert p["versao_taxonomia"] == "0.3"

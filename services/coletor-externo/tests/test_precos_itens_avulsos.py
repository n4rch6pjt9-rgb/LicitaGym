"""Pesquisa de Preço por item: itens incluídos no catálogo fora dos PDMs efetivos, e rodada pontual --pdms/--itens."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from coletor import compras_pdms, compras_precos
from coletor import main as M

VAZIO = {"resultado": [], "totalRegistros": 0, "totalPaginas": 0, "paginasRestantes": 0}


def _sb(pdms, itens):
    sb = MagicMock()
    sb.rpc.return_value = [{"codigo_pdm": p} for p in pdms]
    sb.selecionar.return_value = itens
    return sb


def test_itens_avulsos_so_fora_dos_pdms_efetivos_sem_repeticao():
    sb = _sb([], [{"id": 1, "codigo_item": 614555, "codigo_pdm": 10779},
                  {"id": 2, "codigo_item": 94846, "codigo_pdm": 10779},
                  {"id": 3, "codigo_item": 357264, "codigo_pdm": 16190},   # PDM efetivo: já vem na consulta do PDM
                  {"id": 4, "codigo_item": 94846, "codigo_pdm": 10779},    # repetido
                  {"id": 5, "codigo_item": 150380, "codigo_pdm": None}])   # PDM desconhecido: consulta o item
    assert compras_pdms.carregar_itens_avulsos(sb, [16190]) == [94846, 150380, 614555]
    tabela = sb.selecionar.call_args.args[0]
    filtros = sb.selecionar.call_args.kwargs
    assert tabela == "catalogo_empresa_catmat"
    assert filtros["nivel"] == "eq.item" and filtros["incluido"] == "is.true"


@pytest.mark.parametrize("resposta", [RuntimeError("Supabase catalogo_empresa_catmat: 500"), {"x": 1},
                                      [{"codigo_item": None, "codigo_pdm": 1}], [{"codigo_item": "abc"}]])
def test_itens_avulsos_erro_de_leitura_ou_contrato_falha(resposta):
    sb = MagicMock()
    if isinstance(resposta, Exception):
        sb.selecionar.side_effect = resposta
    else:
        sb.selecionar.return_value = resposta
    with pytest.raises(compras_pdms.CatalogoPdmsIndisponivel):
        compras_pdms.carregar_itens_avulsos(sb, [])


def test_modo_catalogo_consulta_pdms_e_depois_itens_avulsos():
    cliente = MagicMock()
    cliente.consultar_material.return_value = VAZIO
    sb = _sb([2640], [{"id": 1, "codigo_item": 614555, "codigo_pdm": 10779}])

    res = compras_precos.coletar(cliente, sb)

    assert res["sucesso"] is True
    assert [c.args[:2] for c in cliente.consultar_material.call_args_list] == [
        ("codigoPdm", 2640), ("codigoItemCatalogo", 614555)]


def test_catalogo_so_com_itens_nao_e_catalogo_vazio():
    cliente = MagicMock()
    cliente.consultar_material.return_value = VAZIO
    sb = _sb([], [{"id": 1, "codigo_item": 150380, "codigo_pdm": 17574}])

    res = compras_precos.coletar(cliente, sb)

    assert res["sucesso"] is True
    assert [c.args[:2] for c in cliente.consultar_material.call_args_list] == [("codigoItemCatalogo", 150380)]


def test_falha_na_leitura_dos_itens_falha_a_coleta_sem_consultar():
    cliente = MagicMock()
    sb = _sb([2640], None)
    sb.selecionar.side_effect = RuntimeError("Supabase: 500")

    res = compras_precos.coletar(cliente, sb)

    assert res["sucesso"] is False and res["erros"] == 1
    cliente.consultar_material.assert_not_called()


def _main_com_coletar(monkeypatch):
    chamadas = []

    def coletar_precos(sb, dry_run, delay, pdms=None, itens=None):
        chamadas.append({"pdms": pdms, "itens": itens, "dry_run": dry_run})
        return True

    monkeypatch.setattr(M, "coletar_precos", coletar_precos)
    monkeypatch.setattr(M, "env", lambda nome, padrao=None, obrigatorio=False: padrao if padrao else "x")
    return chamadas


def test_main_rodada_pontual_como_o_gcloud_manda(monkeypatch):
    """gcloud run jobs execute --args="--coleta,precos,--pdms,6762,3672" chega como lista separada por vírgula."""
    chamadas = _main_com_coletar(monkeypatch)
    assert M.main("--coleta,precos,--pdms,6762,3672,--dry-run".split(",")) == 0
    assert chamadas == [{"pdms": [6762, 3672], "itens": None, "dry_run": True}]


def test_main_itens_pontuais(monkeypatch):
    chamadas = _main_com_coletar(monkeypatch)
    assert M.main(["--coleta", "precos", "--itens", "614555", "94846", "--dry-run"]) == 0
    assert chamadas == [{"pdms": None, "itens": [614555, 94846], "dry_run": True}]


def test_main_sem_recorte_e_modo_catalogo(monkeypatch):
    chamadas = _main_com_coletar(monkeypatch)
    assert M.main(["--coleta", "precos", "--dry-run"]) == 0
    assert chamadas == [{"pdms": None, "itens": None, "dry_run": True}]


@pytest.mark.parametrize("argv", [["--pdms", "6762"], ["--coleta", "sestsenat", "--itens", "1"],
                                  ["--coleta", "precos", "--pdms", "0"], ["--coleta", "precos", "--pdms", "abc"]])
def test_main_recorte_invalido_para_antes_de_rodar(monkeypatch, argv):
    chamadas = _main_com_coletar(monkeypatch)
    with pytest.raises(SystemExit) as exc:
        M.main(argv + ["--dry-run"])
    assert exc.value.code == 2
    assert chamadas == []

"""Regressão (14/10/2026): tabelas do catálogo CATMAT sem coluna `id` não podem receber `,id.asc` no order nem
keyset por id. Em produção, catmat_itens (PK codigo_item) devolvia 400 e o coletor PNCP abortava antes de gravar."""
from unittest.mock import MagicMock

import pytest

from coletor import destino as D


@pytest.mark.parametrize("tabela,pk", [("catmat_itens", "codigo_item"), ("catmat_pdms", "codigo_pdm"),
                                       ("catmat_item_pdm", "codigo_item"), ("catmat_grupos", "codigo_grupo")])
def test_tabelas_catmat_sem_id_mantem_o_order_do_chamador(tabela, pk):
    assert D._pk_tabela(tabela) == pk
    assert D._order_efetivo(f"{pk}.asc", D._pk_tabela(tabela)) == f"{pk}.asc"
    assert D._order_efetivo(None, D._pk_tabela(tabela)) == f"{pk}.asc"
    assert D._usar_keyset(tabela, f"{pk}.asc", False, None, f"{pk},descricao_item") == (False, "asc")


def test_selecionar_catmat_itens_nao_manda_id_no_order(monkeypatch):
    chamadas = []

    def get(url, params=None, headers=None, timeout=None):
        chamadas.append(dict(params))
        r = MagicMock(); r.status_code = 200; r.headers = {"Content-Range": "0-0/1"}
        r.json.return_value = [{"codigo_item": 94846, "descricao_item": "ESTEIRA"}] if len(chamadas) == 1 else []
        r.raise_for_status.return_value = None
        return r

    monkeypatch.setattr(D.requests, "get", get)
    sb = D.Supabase("https://x.supabase.co", "chave")
    linhas = sb.selecionar("catmat_itens", select="codigo_item,descricao_item", order="codigo_item.asc",
                           limit="100", offset="0", codigo_item="in.(94846)")
    assert linhas and linhas[0]["codigo_item"] == 94846
    assert chamadas[0]["order"] == "codigo_item.asc"
    assert "id" not in chamadas[0]


def test_tabela_com_id_continua_com_desempate_por_id():
    assert D._order_efetivo("data_fim.desc", D._pk_tabela("licitacoes_externas")) == "data_fim.desc,id.asc"

"""Correções do coletor ligadas ao resolvedor de marcas (migration 20261003030000_marcas_resolvedor_fornecedor).

CNPJ/CPF das fixtures são fictícios (11222333000181 tem dígitos verificadores válidos, mas é o exemplo clássico).
"""
from __future__ import annotations

from typing import Any

from coletor import compras_arp, compras_precos
from coletor.compras_precos import id_compra_de, normalizar_preco_praticado, texto_ou_nulo, tipo_ni


def _item_pp(**extra: Any) -> dict[str, Any]:
    base = {
        "idCompra": 9018106900012026,  # número JSON: UASG 090181 perdeu o zero à esquerda (16 dígitos)
        "idItemCompra": 123,
        "idCompraItem": "0901810690001202600001",
        "niFornecedor": "11222333000181",
        "nomeFornecedor": "EMPRESA FICTICIA LTDA",
        "marca": "  Penalty ",
        "codigoUasg": "090181",
        "quantidade": 2,
        "precoUnitario": 10.5,
        "dataResultado": "2026-09-30T00:00:00",
    }
    base.update(extra)
    return base


def test_id_compra_de_usa_prefixo_de_22_digitos():
    assert id_compra_de(_item_pp()) == "09018106900012026"


def test_id_compra_de_completa_com_zeros_sem_id_compra_item():
    assert id_compra_de(_item_pp(idCompraItem=None)) == "09018106900012026"
    assert id_compra_de(_item_pp(idCompra="12063306003572026", idCompraItem="")) == "12063306003572026"


def test_id_compra_de_avisa_divergencia(caplog):
    caplog.set_level("WARNING", logger="coletor.compras_precos")
    assert id_compra_de(_item_pp(idCompra=11111111111111111)) == "09018106900012026"
    assert "diverge" in caplog.text


def test_id_compra_de_sem_nada():
    assert id_compra_de({"idCompra": None, "idCompraItem": None}) is None


def test_normalizar_usa_id_compra_de_17_digitos():
    linha = normalizar_preco_praticado(_item_pp())
    assert linha["id_compra"] == "09018106900012026"
    assert linha["id_compra_item"] == "0901810690001202600001"


def test_texto_ou_nulo():
    assert texto_ou_nulo(None) is None
    assert texto_ou_nulo("") is None
    assert texto_ou_nulo("   ") is None
    assert texto_ou_nulo("0") is None
    assert texto_ou_nulo(0) is None
    assert texto_ou_nulo(" 0 ") is None
    assert texto_ou_nulo("10") == "10"
    assert texto_ou_nulo(" Penalty ") == "Penalty"


def test_normalizar_placeholders_viram_nulo():
    linha = normalizar_preco_praticado(_item_pp(niFornecedor="0", marca="0", codigoUasg=""))
    assert linha["ni_fornecedor"] is None
    assert linha["marca"] is None
    assert linha["codigo_uasg"] is None


def test_normalizar_marca_com_strip_e_fabricante_modelo_nulos():
    linha = normalizar_preco_praticado(_item_pp(fabricante="X", modelo="Y"))
    assert linha["marca"] == "Penalty"
    assert linha["fabricante"] is None
    assert linha["modelo"] is None


def test_tipo_ni():
    assert tipo_ni("11222333000181") == "cnpj"
    assert tipo_ni("12345678909") == "cpf"
    assert tipo_ni("ABC") == "outro"
    assert tipo_ni(None) is None
    assert tipo_ni("") is None


class _ClienteFalso:
    """Devolve páginas de tamanho controlado e registra o tamanho_pagina pedido."""

    def __init__(self, paginas: list[list[dict[str, Any]]], total: int):
        self.paginas = paginas
        self.total = total
        self.pedidos: list[tuple[int, int]] = []

    def consultar_material(self, tipo, codigo, pagina=1, tamanho_pagina=100):
        self.pedidos.append((pagina, tamanho_pagina))
        itens = self.paginas[pagina - 1] if pagina <= len(self.paginas) else []
        return {"resultado": itens, "totalRegistros": self.total}


def _pagina(n: int, inicio: int, ni: str = "11222333000181") -> list[dict[str, Any]]:
    return [_item_pp(idItemCompra=inicio + i, niFornecedor=ni) for i in range(n)]


def test_coletar_pede_500_e_para_na_pagina_certa():
    assert compras_precos.TAMANHO_PAGINA == 500
    cli = _ClienteFalso([_pagina(500, 0), _pagina(120, 500)], total=620)
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert cli.pedidos == [(1, 500), (2, 500)]
    assert res["total_coletados"] == 620


def test_coletar_nao_para_cedo_com_pagina_de_100():
    # antes: tamanho fixo 100 na condição de parada; com 500 por página, 100 itens não podem encerrar a coleta
    cli = _ClienteFalso([_pagina(500, 0), _pagina(500, 500), _pagina(1, 1000)], total=1001)
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert len(cli.pedidos) == 3
    assert res["total_coletados"] == 1001


def test_coletar_conta_cpf_no_resumo():
    itens = _pagina(3, 0) + _pagina(2, 10, ni="12345678909") + _pagina(1, 20, ni="0")
    cli = _ClienteFalso([itens], total=len(itens))
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert res["por_tipo_ni"] == {"cnpj": 3, "cpf": 2, "outro": 0, "sem_ni": 1}


def _item_arp(**extra: Any) -> dict[str, Any]:
    base = {
        "numeroAtaRegistroPreco": "00012/2026",
        "codigoUnidadeGerenciadora": 90181,
        "numeroItem": "1",
        "niFornecedor": "11222333000181",
        "marca": "QUALQUER",
        "fabricante": "QUALQUER",
        "modelo": "QUALQUER",
    }
    base.update(extra)
    return base


def test_arp_marca_fabricante_modelo_nulos():
    # niFornecedor do ARP compõe a chave desde o #142 (só dígitos; vazio descarta a linha): "0" fica como está aqui.
    linha = compras_arp.normalizar_ata_item(_item_arp())
    assert (linha["marca"], linha["fabricante"], linha["modelo"]) == (None, None, None)
    assert linha["ni_fornecedor"] == "11222333000181"


def test_arp_tamanho_pagina_constante():
    assert compras_arp.TAMANHO_PAGINA == 50

    class _Cli:
        def __init__(self):
            self.pedidos = []

        def consultar_itens_pdm(self, pdm, data_min, data_max, pagina=1, tamanho_pagina=50):
            self.pedidos.append(tamanho_pagina)
            n = 50 if pagina == 1 else 3
            return {"resultado": [_item_arp(numeroItem=str(pagina * 100 + i)) for i in range(n)], "totalRegistros": 53}

    cli = _Cli()
    res = compras_arp.coletar(cli, None, pdms=[2640], data_min="2026-01-01", data_max="2026-12-31", dry_run=True)
    assert cli.pedidos == [50, 50]
    assert res["total_coletados"] == 53

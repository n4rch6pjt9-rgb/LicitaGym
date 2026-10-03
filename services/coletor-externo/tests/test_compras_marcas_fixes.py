"""Correções do coletor ligadas ao resolvedor de marcas (migration 20261003200000_marcas_resolvedor_fornecedor).

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
    """Devolve páginas de tamanho controlado e registra (pagina, tamanho_pagina) pedidos.

    totais: campos extras da resposta (totalRegistros/totalPaginas); None = a resposta não traz o campo.
    """

    def __init__(self, paginas: list[list[dict[str, Any]]], total: int | None = None, total_paginas: int | None = None):
        self.paginas = paginas
        self.total = total
        self.total_paginas = total_paginas
        self.pedidos: list[tuple[int, int]] = []

    def consultar_material(self, tipo, codigo, pagina=1, tamanho_pagina=100):
        self.pedidos.append((pagina, tamanho_pagina))
        if len(self.pedidos) > 50:
            raise AssertionError("coleta não terminou (laço sem fim)")
        itens = self.paginas[pagina - 1] if pagina <= len(self.paginas) else []
        resp: dict[str, Any] = {"resultado": itens}
        if self.total is not None:
            resp["totalRegistros"] = self.total
        if self.total_paginas is not None:
            resp["totalPaginas"] = self.total_paginas
        return resp


def _pagina(n: int, inicio: int, ni: str = "11222333000181") -> list[dict[str, Any]]:
    return [_item_pp(idItemCompra=inicio + i, niFornecedor=ni) for i in range(n)]


class _SbFalso:
    def __init__(self):
        self.gravadas: list[dict[str, Any]] = []

    def upsert(self, tabela, linhas, conflito=None):
        self.gravadas.extend(linhas)


def test_tamanho_pagina_e_100():
    # Regra do projeto: coletores Python pedem no máximo 100 itens por página.
    assert compras_precos.TAMANHO_PAGINA == 100
    cli = _ClienteFalso([_pagina(100, 0), _pagina(20, 100)], total=120)
    compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert cli.pedidos == [(1, 100), (2, 100)]


def test_cliente_nunca_pede_mais_de_100(monkeypatch):
    cliente = compras_precos.ClienteComprasPrecos(delay=1.0)
    monkeypatch.setattr(compras_precos.time, "sleep", lambda s: None)
    capturado: dict[str, Any] = {}

    class _Resp:
        status_code = 200
        headers: dict[str, str] = {}

        def json(self):
            return {"resultado": [], "totalRegistros": 0}

    def _get(url, params=None, timeout=None):
        capturado.update(params)
        return _Resp()

    monkeypatch.setattr(cliente.s, "get", _get)
    cliente.consultar_material("codigoPdm", 2640, pagina=1, tamanho_pagina=500)
    assert capturado["tamanhoPagina"] == 100


def test_pagina_parcial_com_registros_restantes_continua():
    # Achado do review: página incompleta (API devolveu menos que o pedido) não pode encerrar a coleta.
    cli = _ClienteFalso([_pagina(60, 0), _pagina(100, 60), _pagina(41, 160)], total=201)
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert [p for p, _ in cli.pedidos] == [1, 2, 3]
    assert res["total_coletados"] == 201


def test_fim_por_total_registros_sem_pedir_pagina_extra():
    cli = _ClienteFalso([_pagina(100, 0), _pagina(100, 100)], total=200)
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert [p for p, _ in cli.pedidos] == [1, 2]
    assert res["total_coletados"] == 200


def test_fim_por_total_paginas():
    cli = _ClienteFalso([_pagina(100, 0), _pagina(30, 100), _pagina(100, 500)], total_paginas=2)
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert [p for p, _ in cli.pedidos] == [1, 2]
    assert res["total_coletados"] == 130


def test_sem_totais_para_na_pagina_vazia():
    cli = _ClienteFalso([_pagina(100, 0), _pagina(7, 100)])
    res = compras_precos.coletar(cli, None, pdms=[2640], dry_run=True)
    assert [p for p, _ in cli.pedidos] == [1, 2, 3]
    assert res["total_coletados"] == 107


def test_ultima_pagina_ignora_totais_invalidos():
    assert compras_precos.ultima_pagina({"totalRegistros": 0}, 1, 100) is False
    assert compras_precos.ultima_pagina({"totalRegistros": "x", "totalPaginas": None}, 1, 100) is False
    assert compras_precos.ultima_pagina({"totalRegistros": "150"}, 2, 150) is True
    assert compras_precos.ultima_pagina({"totalPaginas": 3}, 3, 10) is True


def test_limite_respeitado_antes_de_gravar():
    # Achado do review: --limite 30 não pode gravar a página inteira de 100.
    cli = _ClienteFalso([_pagina(100, 0), _pagina(100, 100)], total=200)
    sb = _SbFalso()
    res = compras_precos.coletar(cli, sb, pdms=[2640], limite=30)
    assert res["total_coletados"] == 30
    assert res["total_gravados"] == 30
    assert len(sb.gravadas) == 30
    assert [p for p, _ in cli.pedidos] == [1]


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

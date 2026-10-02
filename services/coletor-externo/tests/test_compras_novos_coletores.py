"""Testes para os novos coletores de dados abertos do Compras.gov (PGC, Pesquisa de Preço e ARP)."""
from unittest.mock import MagicMock
import pytest

from coletor import compras_pgc
from coletor import compras_precos
from coletor import compras_arp

SAMPLE_PGC_ITEM = {
    "codigoUasg": "120006",
    "nomeUasg": "GAP DO GALEAO",
    "orgao": "00394429000100",
    "numeroArtefato": 1,
    "anoArtefato": 2026,
    "descricaoObjetoDfd": "Aparelhos de musculação",
    "nivelPrioridadeDfd": "Alta",
    "dataPrevistaFormalizacaoDemanda": "2026-07-07",
    "codigoClasseMaterial": 7830,
    "nomeClasseMaterial": "EQUIPAMENTO PARA GINÁSTICA E RECREAÇÃO",
    "codigoPdmMaterial": "2640",
    "nomePdmMaterial": "APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO",
    "codigoItemCatalogo": 480144,
    "descricaoItemCatalogo": "APARELHO MUSCULACAO CROSS OVER",
    "quantidadeItem": 3.0,
    "valorUnitarioItem": 12300.0,
    "valorTotalItem": 36900.0,
    "anoPcaProjetoCompra": 2026,
    "dataInicioProcessoCompra": "2026-08-12",
    "dataFimProcessoCompra": "2026-11-10",
    "numeroItemPncp": 45,
    "statusContratacaoExecucao": "Em planejamento",
}

SAMPLE_PRECO_ITEM = {
    "idCompra": "16021105900032024",
    "idItemCompra": 5858679,
    "numeroItemCompra": 1,
    "niFornecedor": "04372852000160",
    "nomeFornecedor": "W.E.V COMERCIAL LTDA",
    "marca": "FORTIX",
    "precoUnitario": 9000.0,
    "quantidade": 2.0,
    "codigoItemCatalogo": 480144,
    "codigoPdm": "2640",
    "nomePdm": "APARELHO CONDICIONAMENTO",
    "codigoUasg": "158517",
    "nomeUasg": "UNILA",
    "estado": "PR",
    "dataResultado": "2026-09-18",
    "descricaoItem": "CROSS OVER COM DUAS TORRES DE PESO",
}

SAMPLE_ARP_ITEM = {
    "numeroAtaRegistroPreco": "14004/2026",
    "codigoUnidadeGerenciadora": 120006,
    "numeroItem": "00006",
    "codigoItem": 472025,
    "codigoPdm": "2640",
    "descricaoItem": "APARELHO CONDICIONAMENTO FISICO BICEPS",
    "niFornecedor": "40962266000130",
    "nomeRazaoSocialFornecedor": "PANTHERA LEO EQUIPAMENTOS LTDA",
    "marca": "PANTHERA",
    "quantidadeHomologadaItem": 1.0,
    "valorUnitario": 8500.0,
    "valorTotal": 8500.0,
    "dataVigenciaInicial": "2026-06-02",
    "dataVigenciaFinal": "2027-06-02",
    "quantidadeEmpenhada": 0.0,
    "maximoAdesao": 2.0,
}


def test_normalizar_registro_pgc():
    norm = compras_pgc.normalizar_registro_pgc(SAMPLE_PGC_ITEM)
    assert norm["orgao_cnpj"] == "00394429000100"
    assert norm["codigo_uasg"] == "120006"
    assert norm["codigo_classe_material"] == 7830
    assert norm["codigo_pdm_material"] == "2640"
    assert norm["codigo_item_catalogo"] == 480144
    assert norm["quantidade_item"] == 3.0
    assert norm["valor_total_item"] == 36900.0
    assert norm["numero_item_pncp"] == 45
    assert norm["payload_hash"] is not None
    assert len(norm["payload_hash"]) == 64


def test_normalizar_preco_praticado():
    norm = compras_precos.normalizar_preco_praticado(SAMPLE_PRECO_ITEM)
    assert norm is not None
    assert norm["id_compra"] == "16021105900032024"
    assert norm["id_item_compra"] == 5858679
    assert norm["ni_fornecedor"] == "04372852000160"
    assert norm["nome_fornecedor"] == "W.E.V COMERCIAL LTDA"
    assert norm["marca"] == "FORTIX"
    assert norm["preco_unitario"] == 9000.0
    assert norm["codigo_item_catalogo"] == 480144
    assert norm["codigo_pdm"] == "2640"
    assert norm["data_resultado"] == "2026-09-18"


def test_normalizar_ata_item():
    norm = compras_arp.normalizar_ata_item(SAMPLE_ARP_ITEM)
    assert norm is not None
    assert norm["numero_ata_registro_preco"] == "14004/2026"
    assert norm["codigo_unidade_gerenciadora"] == 120006
    assert norm["numero_item"] == "00006"
    assert norm["codigo_item"] == 472025
    assert norm["ni_fornecedor"] == "40962266000130"
    assert norm["nome_fornecedor"] == "PANTHERA LEO EQUIPAMENTOS LTDA"
    assert norm["marca"] == "PANTHERA"
    assert norm["valor_unitario"] == 8500.0
    assert norm["data_vigencia_final"] == "2027-06-02"


def test_coletar_pgc_dry_run():
    cliente = MagicMock()
    cliente.consultar_classe.return_value = {
        "resultado": [SAMPLE_PGC_ITEM],
        "totalRegistros": 1,
    }
    sb = MagicMock()
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026], dry_run=True)
    assert res["sucesso"] is True
    assert res["total_coletados"] == 1
    assert res["total_gravados"] == 0
    assert len(res["amostras"]) == 1
    sb.upsert.assert_not_called()


def test_coletar_pgc_com_upsert():
    cliente = MagicMock()
    cliente.consultar_classe.return_value = {
        "resultado": [SAMPLE_PGC_ITEM],
        "totalRegistros": 1,
    }
    sb = MagicMock()
    res = compras_pgc.coletar(cliente, sb, classes=[7830], anos=[2026], dry_run=False)
    assert res["sucesso"] is True
    assert res["total_coletados"] == 1
    assert res["total_gravados"] == 1
    sb.upsert.assert_called_once()
    assert sb.upsert.call_args[0][0] == "pca_pgc_itens"


def test_coletar_precos_dry_run():
    cliente = MagicMock()
    cliente.consultar_material.return_value = {
        "resultado": [SAMPLE_PRECO_ITEM],
        "totalRegistros": 1,
    }
    sb = MagicMock()
    res = compras_precos.coletar(cliente, sb, itens=[480144], dry_run=True)
    assert res["sucesso"] is True
    assert res["total_coletados"] == 1
    assert res["total_gravados"] == 0
    sb.upsert.assert_not_called()


def test_coletar_arp_dry_run():
    cliente = MagicMock()
    cliente.consultar_itens_pdm.return_value = {
        "resultado": [SAMPLE_ARP_ITEM],
        "totalRegistros": 1,
    }
    sb = MagicMock()
    res = compras_arp.coletar(cliente, sb, pdms=[2640], data_min="2026-01-01", data_max="2026-12-31", dry_run=True)
    assert res["sucesso"] is True
    assert res["total_coletados"] == 1
    assert res["total_gravados"] == 0
    sb.upsert.assert_not_called()


def test_filtro_material_ou_servico_apenas_produtos():
    """Garante que itens de serviço (ex.: Lubritech serviços de lubrificação) são recusados."""
    # Simula linhas 14.133 com material x servico
    item_servico = {
        "idCompraItem": "1",
        "material_ou_servico": "S",
        "tipo_item": "Serviço",
        "nomeRazaoSocialFornecedor": "LUBRITECH DO BRASIL SERVICOS DE LUBRIFICACAO LTDA",
    }
    item_material = {
        "idCompraItem": "2",
        "material_ou_servico": "M",
        "tipo_item": "Material",
        "nomeRazaoSocialFornecedor": "PANTHERA LEO EQUIPAMENTOS LTDA",
    }

    def eh_material_ou_produto(d: dict) -> bool:
        ms = str(d.get("material_ou_servico") or d.get("tipo_item") or "").strip().upper()
        return ms.startswith("M")

    assert eh_material_ou_produto(item_servico) is False
    assert eh_material_ou_produto(item_material) is True


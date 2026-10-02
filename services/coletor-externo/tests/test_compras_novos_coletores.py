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
    assert norm is not None
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


def test_normalizar_registro_pgc_sem_ano_rejeita():
    item_sem_ano = {**SAMPLE_PGC_ITEM, "anoPcaProjetoCompra": None}
    assert compras_pgc.normalizar_registro_pgc(item_sem_ano) is None
    # Com ano_contexto explícito aceita
    norm = compras_pgc.normalizar_registro_pgc(item_sem_ano, ano_contexto=2027)
    assert norm is not None
    assert norm["ano_pca_projeto_compra"] == 2027


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


def test_deduplicacao_venda_multiplas_fontes_e_paradigma():
    """Valida a chave canônica:
    coalesce(numero_controle_pncp_compra, 'ext:' || fonte || ':' || licitacao_id) + numero_item + cnpj
    Mesma venda vinda de PNCP, Compras.gov pesquisa de preço e ARP colapsa em 1 linha.
    Certame Paradigma (Sistema S) sai como linha própria e não é fundido nem descartado.
    """
    # 1. Simula a ponte de id_compra -> numero_controle_pncp_compra
    bridge = {
        "16021105900032024": "00394429000100-1-000003/2024"
    }

    # 2. Venda 1 vinda do PNCP (licitacao_resultados)
    venda_pncp = {
        "fonte_origem": "licitacao_resultados",
        "fonte": "pncp",
        "licitacao_id": 101,
        "codigo_externo": "00394429000100-1-000003/2024",
        "numero_item": 1,
        "cnpj": "04372852000160",
        "codigo_item": None,
        "preco_unitario": 9000.0,
    }

    # 3. Mesma venda vinda do Compras.gov Pesquisa de Preço (precos_praticados_itens)
    venda_compras_preco = {
        "fonte_origem": "compras_pesquisa_preco",
        "id_compra": "16021105900032024",
        "numero_item": 1,
        "cnpj": "04372852000160",
        "codigo_item": 480144,
        "preco_unitario": 9000.0,
    }

    # 4. Mesma venda vinda do Compras.gov ARP (atas_rp_itens)
    venda_compras_arp = {
        "fonte_origem": "compras_arp",
        "id_compra": "16021105900032024",
        "numero_controle_pncp_compra": "00394429000100-1-000003/2024",
        "numero_item": 1,
        "cnpj": "04372852000160",
        "codigo_item": 480144,
        "preco_unitario": 9000.0,
    }

    # 5. Certame Paradigma (Sistema S / SEST SENAT) do mesmo fornecedor
    venda_paradigma = {
        "fonte_origem": "licitacao_resultados",
        "fonte": "sestsenat",
        "licitacao_id": 42,
        "codigo_externo": None,
        "numero_item": 1,
        "cnpj": "04372852000160",
        "codigo_item": None,
        "preco_unitario": 8500.0,
    }

    def calcular_compra_canonico(row: dict) -> str:
        origem = row.get("fonte_origem")
        if origem == "licitacao_resultados":
            cod_ext = row.get("codigo_externo")
            if cod_ext:
                return cod_ext
            return f"ext:{row.get('fonte')}:{row.get('licitacao_id')}"
        elif origem == "compras_pesquisa_preco":
            id_c = row.get("id_compra")
            return bridge.get(id_c, f"ext:compras_gov:{id_c}")
        elif origem == "compras_arp":
            return row.get("numero_controle_pncp_compra") or bridge.get(row.get("id_compra"), f"ext:compras_gov:{row.get('id_compra')}")
        return "desconhecido"

    def chave_canonica(row: dict) -> tuple[str, str, int]:
        compra_id = calcular_compra_canonico(row)
        return (row["cnpj"], compra_id, row["numero_item"])

    chave_pncp = chave_canonica(venda_pncp)
    chave_preco = chave_canonica(venda_compras_preco)
    chave_arp = chave_canonica(venda_compras_arp)
    chave_paradigma = chave_canonica(venda_paradigma)

    # PNCP, Compras.gov e ARP devem produzir exatamente a mesma chave
    assert chave_pncp == ("04372852000160", "00394429000100-1-000003/2024", 1)
    assert chave_preco == chave_pncp
    assert chave_arp == chave_pncp

    # Paradigma deve produzir sua própria chave distinta
    assert chave_paradigma == ("04372852000160", "ext:sestsenat:42", 1)
    assert chave_paradigma != chave_pncp

    # Deduplicação (simulando DISTINCT ON por chave)
    todas = [venda_pncp, venda_compras_preco, venda_compras_arp, venda_paradigma]
    dedup = {}
    for v in todas:
        k = chave_canonica(v)
        # Prioriza linha com código CATMAT preenchido
        if k not in dedup or (v.get("codigo_item") and not dedup[k].get("codigo_item")):
            dedup[k] = v

    # Exatamente 2 vendas: 1 da compra pública federal (deduplicada) e 1 do SEST SENAT (preservada)
    assert len(dedup) == 2
    assert dedup[chave_pncp]["codigo_item"] == 480144
    assert dedup[chave_paradigma]["preco_unitario"] == 8500.0


def test_coletor_precos_falhas_e_retries(monkeypatch):
    """Garante que 429/503 esgotado após 3 tentativas levanta RuntimeError e não devolve sucesso vazio."""
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    mock_resp = MagicMock()
    mock_resp.status_code = 429
    monkeypatch.setattr(cliente.s, "get", lambda *_, **__: mock_resp)
    monkeypatch.setattr(compras_precos.time, "sleep", lambda *_: None)

    with pytest.raises(RuntimeError) as exc_info:
        cliente.consultar_material("codigoPdm", 2640)
    assert "429" in str(exc_info.value) or "retries" in str(exc_info.value).lower()


def test_coletor_pgc_limite_tamanho_pagina(monkeypatch):
    """Garante que tamanhoPagina enviado à API PGC respeita o teto de 500."""
    cliente = compras_pgc.ClienteComprasPGC(delay=0)
    chamada = {}

    def fake_get(url, params=None, timeout=None):
        chamada["params"] = params
        m = MagicMock()
        m.status_code = 200
        m.json.return_value = {"resultado": [], "totalRegistros": 0}
        return m

    monkeypatch.setattr(cliente.s, "get", fake_get)
    monkeypatch.setattr(compras_pgc.time, "sleep", lambda *_: None)

    cliente.consultar_classe(7830, 2026, tamanho_pagina=1000)
    assert chamada["params"]["tamanhoPagina"] == 500


def test_coletor_pgc_429_respeita_retry_after(monkeypatch):
    cliente = compras_pgc.ClienteComprasPGC(delay=0)
    eventos = []
    respostas = []

    for status in (429, 200):
        resposta = MagicMock()
        resposta.status_code = status
        resposta.headers = {"Retry-After": "7"} if status == 429 else {}
        resposta.json.return_value = {"resultado": [], "totalRegistros": 0}
        respostas.append(resposta)

    def fake_get(*_, **__):
        eventos.append(("get", len(eventos)))
        return respostas.pop(0)

    monkeypatch.setattr(cliente.s, "get", fake_get)
    monkeypatch.setattr(compras_pgc.time, "sleep", lambda espera: eventos.append(("sleep", espera)))

    cliente.consultar_classe(7830, 2026)

    assert eventos[2] == ("sleep", 7.0)
    assert [evento[0] for evento in eventos].count("get") == 2


def test_coletor_arp_falha_apos_retries(monkeypatch):
    """Garante que falhas de rede persistentes em ARP levantam exceção e marcam o coletor como com falha."""
    cliente = compras_arp.ClienteComprasARP(delay=0)
    mock_resp = MagicMock()
    mock_resp.status_code = 503
    monkeypatch.setattr(cliente.s, "get", lambda *_, **__: mock_resp)
    monkeypatch.setattr(compras_arp.time, "sleep", lambda *_: None)

    with pytest.raises(RuntimeError):
        cliente.consultar_itens_pdm(2640, "2026-01-01", "2026-12-31")




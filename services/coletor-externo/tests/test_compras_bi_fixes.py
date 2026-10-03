"""Correções dos coletores BI do Compras.gov (ARP e Pesquisa de Preço) achadas testando a API ao vivo em 02/10/2026.

Fixtures sintéticas: CNPJs fictícios (dígitos verificadores válidos), sem CPF, sem dados pessoais, sem Supabase.
Formato dos campos igual ao da API (ver /workspace/diffs/bi-comprasgov-fixes/live/*.json no relatório).
"""
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from coletor import compras_api, compras_arp, compras_precos

CNPJ_A = "11222333000181"
CNPJ_B = "22333444000181"
CNPJ_C = "33444555000181"

# Item de ARP com exatamente os campos de VwFtArpItemDTO (sem marca/fabricante/modelo/lote, como na fonte).
ARP_BASE = {
    "numeroAtaRegistroPreco": "00007/2026",
    "codigoUnidadeGerenciadora": "999001",
    "numeroCompra": "90001",
    "anoCompra": "2026",
    "codigoModalidadeCompra": "05",
    "nomeModalidadeCompra": "Pregão",
    "dataAssinatura": "2026-03-02T00:00:00",
    "dataVigenciaInicial": "2026-03-03",
    "dataVigenciaFinal": "2027-03-03",
    "numeroItem": "00004",
    "codigoItem": 900001,
    "descricaoItem": "ESTEIRA ELÉTRICA SINTÉTICA PARA TESTE",
    "tipoItem": "Material",
    "quantidadeHomologadaItem": 4.0,
    "classificacaoFornecedor": "001",
    "niFornecedor": CNPJ_A,
    "nomeRazaoSocialFornecedor": "FORNECEDOR FICTICIO A LTDA",
    "quantidadeHomologadaVencedor": 4,
    "valorUnitario": 15000.0,
    "valorTotal": 60000.0,
    "maximoAdesao": 0.0,
    "nomeUnidadeGerenciadora": "UNIDADE FICTICIA DE TESTE",
    "idCompra": "99900105900012026",
    "numeroControlePncpCompra": "33444555000181-1-000001/2026",
    "dataHoraInclusao": "2026-03-04T10:00:00",
    "dataHoraAtualizacao": "2026-03-04T10:00:00",
    "quantidadeEmpenhada": 0.0,
    "percentualMaiorDesconto": 0.0,
    "situacaoSicaf": "1",
    "dataHoraExclusao": None,
    "itemExcluido": False,
    "numeroControlePncpAta": "33444555000181-1-000001/2026-000001",
    "codigoPdm": 7115,
    "nomePdm": "ESTEIRA ELÉTRICA",
}

# Pesquisa de Preço: idCompra vem como NÚMERO (zero à esquerda perdido), idCompraItem como string de 22 dígitos.
PRECO_ZERO_ESQ = {
    "idCompra": 9990005900012026,  # UASG 099900 + mod 05 + 90001 + 2026 = "09990005900012026"; sem o zero: 16 dígitos
    "idItemCompra": 70000001,
    "numeroItemCompra": 3,
    "idCompraItem": "0999000590001202600003",  # idCompra (17) + item (5), string
    "niFornecedor": CNPJ_B,
    "nomeFornecedor": "FORNECEDOR FICTICIO B LTDA",
    "marca": "  MARCA TESTE  ",
    "precoUnitario": 7000.0,
    "quantidade": 1.0,
    "codigoItemCatalogo": 900001,
    "codigoPdm": "7115",
    "codigoUasg": "099900",
    "dataResultado": "2026-03-30",
    "dataHoraAtualizacaoItem": "2026-03-31T08:00:00",
}


def _resp(status, corpo=None, texto=None):
    r = MagicMock()
    r.status_code = status
    r.headers = {}
    if isinstance(corpo, Exception):
        r.json.side_effect = corpo
    else:
        r.json.return_value = corpo
    r.text = texto if texto is not None else ""
    return r


def _cliente(monkeypatch, modulo, cliente, respostas):
    fila = list(respostas)
    chamadas = []

    def fake_get(url, params=None, timeout=None):
        chamadas.append(params)
        return fila.pop(0)

    monkeypatch.setattr(cliente.s, "get", fake_get)
    monkeypatch.setattr(modulo.time, "sleep", lambda *_: None)
    return chamadas


# ---------------------------------------------------------------------------
# Bug 1: ARP não tem marca/fabricante/modelo
# ---------------------------------------------------------------------------
def test_arp_marca_fabricante_modelo_sempre_null_mesmo_se_aparecer_chave_estranha():
    norm = compras_arp.normalizar_ata_item({**ARP_BASE, "marca": "X", "fabricante": "Y", "modelo": "Z"})
    assert norm["marca"] is None and norm["fabricante"] is None and norm["modelo"] is None
    # As colunas continuam no payload (tabela e views as têm), explicitamente NULL.
    assert {"marca", "fabricante", "modelo"} <= set(norm)


# ---------------------------------------------------------------------------
# Bug 2: Pesquisa de Preço só traz marca
# ---------------------------------------------------------------------------
def test_precos_le_so_marca_real_e_nao_fabricante_modelo():
    norm = compras_precos.normalizar_preco_praticado({**PRECO_ZERO_ESQ, "fabricante": "Y", "modelo": "Z"})
    assert norm["marca"] == "MARCA TESTE"
    assert norm["fabricante"] is None and norm["modelo"] is None


def test_precos_marca_vazia_vira_null():
    assert compras_precos.normalizar_preco_praticado({**PRECO_ZERO_ESQ, "marca": "   "})["marca"] is None
    assert compras_precos.normalizar_preco_praticado({**PRECO_ZERO_ESQ, "marca": None})["marca"] is None


# ---------------------------------------------------------------------------
# Bug 3: 404 é erro (parâmetro obrigatório faltando), 200 vazio é vazio
# ---------------------------------------------------------------------------
CORPO_404 = '{ "statusCode": 404, "message": "Resource not found" }'  # corpo real observado ao vivo
VAZIO_200 = {"resultado": [], "totalRegistros": 0, "totalPaginas": 0, "paginasRestantes": 0}


@pytest.mark.parametrize("modulo,fabrica,chamar", [
    (compras_arp, lambda: compras_arp.ClienteComprasARP(delay=0),
     lambda c: c.consultar_itens_pdm(7115, "2026-01-01", "2026-06-30")),
    (compras_precos, lambda: compras_precos.ClienteComprasPrecos(delay=0),
     lambda c: c.consultar_material("codigoPdm", 7115)),
])
def test_404_levanta_erro_e_nao_vira_vazio(monkeypatch, modulo, fabrica, chamar):
    cliente = fabrica()
    chamadas = _cliente(monkeypatch, modulo, cliente, [_resp(404, texto=CORPO_404)])
    with pytest.raises(compras_api.ErroApiCompras, match="404") as exc:
        chamar(cliente)
    assert exc.value.status == 404
    assert "Resource not found" in str(exc.value)
    assert len(chamadas) == 1  # 404 não é repetido


@pytest.mark.parametrize("modulo,fabrica,chamar", [
    (compras_arp, lambda: compras_arp.ClienteComprasARP(delay=0),
     lambda c: c.consultar_itens_pdm(7115, "2026-01-01", "2026-06-30")),
    (compras_precos, lambda: compras_precos.ClienteComprasPrecos(delay=0),
     lambda c: c.consultar_material("codigoPdm", 7115)),
])
def test_200_vazio_retorna_vazio(monkeypatch, modulo, fabrica, chamar):
    cliente = fabrica()
    _cliente(monkeypatch, modulo, cliente, [_resp(200, VAZIO_200)])
    assert chamar(cliente) == VAZIO_200


@pytest.mark.parametrize("modulo,fabrica,chamar", [
    (compras_arp, lambda: compras_arp.ClienteComprasARP(delay=0),
     lambda c: c.consultar_itens_pdm(7115, "2026-01-01", "2026-06-30")),
    (compras_precos, lambda: compras_precos.ClienteComprasPrecos(delay=0),
     lambda c: c.consultar_material("codigoPdm", 7115)),
])
@pytest.mark.parametrize("resposta", [
    _resp(200, {"mensagem": "sem lista"}),
    _resp(200, ValueError("corpo não é JSON"), texto="<html>"),
    _resp(400, texto='{"message": "Erro ao efetuar a consulta"}'),
])
def test_200_sem_resultado_e_400_sao_erro(monkeypatch, modulo, fabrica, chamar, resposta):
    cliente = fabrica()
    chamadas = _cliente(monkeypatch, modulo, cliente, [resposta])
    with pytest.raises(compras_api.ErroApiCompras):
        chamar(cliente)
    assert len(chamadas) == 1  # 400 não é tratado como falha de rede (antes era repetido 3x)


@pytest.mark.parametrize("args", [
    (7115, None, "2026-06-30"),            # data mínima ausente (a API daria 404)
    (7115, "2026-01-01", ""),              # data máxima ausente
    (7115, "2026-06-30", "2026-01-01"),    # invertido (a API daria 0 registros sem erro)
    (7115, "2025-01-01", "2026-01-02"),    # > 365 dias (a API daria 400)
    (7115, "2026-02-30", "2026-06-30"),    # data inexistente
    (None, "2026-01-01", "2026-06-30"),    # PDM ausente
    (0, "2026-01-01", "2026-06-30"),
])
def test_arp_valida_obrigatorios_antes_da_chamada(monkeypatch, args):
    cliente = compras_arp.ClienteComprasARP(delay=0)
    chamadas = _cliente(monkeypatch, compras_arp, cliente, [])
    with pytest.raises(compras_api.ParametroInvalido):
        cliente.consultar_itens_pdm(*args)
    assert chamadas == []


@pytest.mark.parametrize("tipo,codigo", [("codigoPdm", None), ("codigoPdm", ""), ("pdm", 7115), (None, 7115),
                                         ("codigoItemCatalogo", -1), ("codigoPdm", "abc")])
def test_precos_valida_obrigatorios_antes_da_chamada(monkeypatch, tipo, codigo):
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    chamadas = _cliente(monkeypatch, compras_precos, cliente, [])
    with pytest.raises(compras_api.ParametroInvalido):
        cliente.consultar_material(tipo, codigo)
    assert chamadas == []


def test_arp_intervalo_de_365_dias_e_aceito(monkeypatch):
    cliente = compras_arp.ClienteComprasARP(delay=0)
    chamadas = _cliente(monkeypatch, compras_arp, cliente, [_resp(200, VAZIO_200)])
    cliente.consultar_itens_pdm(7115, "2028-01-01", "2028-12-31")  # ano bissexto: 365 dias de diferença
    assert chamadas[0]["dataVigenciaInicialMin"] == "2028-01-01"


def test_coletar_arp_404_marca_falha_sem_gravar(monkeypatch):
    cliente = compras_arp.ClienteComprasARP(delay=0)
    _cliente(monkeypatch, compras_arp, cliente, [_resp(404, texto=CORPO_404)])
    sb = MagicMock()
    res = compras_arp.coletar(cliente, sb, pdms=[7115], data_min="2026-01-01", data_max="2026-06-30")
    assert res["sucesso"] is False and res["erros"] == 1 and res["total_coletados"] == 0
    sb.upsert.assert_not_called()


def test_coletar_arp_200_vazio_e_sucesso(monkeypatch):
    cliente = compras_arp.ClienteComprasARP(delay=0)
    _cliente(monkeypatch, compras_arp, cliente, [_resp(200, VAZIO_200)])
    sb = MagicMock()
    res = compras_arp.coletar(cliente, sb, pdms=[7115], data_min="2026-01-01", data_max="2026-06-30")
    assert res["sucesso"] is True and res["erros"] == 0 and res["total_coletados"] == 0
    sb.upsert.assert_not_called()


def test_coletar_arp_intervalo_invalido_falha_antes_de_consultar():
    cliente = MagicMock()
    res = compras_arp.coletar(cliente, None, pdms=[7115], data_min="2026-06-30", data_max="2026-01-01", dry_run=True)
    assert res["sucesso"] is False and "anterior" in res["erro"]
    cliente.consultar_itens_pdm.assert_not_called()


def test_coletar_precos_404_marca_falha_sem_gravar(monkeypatch):
    cliente = compras_precos.ClienteComprasPrecos(delay=0)
    _cliente(monkeypatch, compras_precos, cliente, [_resp(404, texto=CORPO_404)])
    sb = MagicMock()
    res = compras_precos.coletar(cliente, sb, pdms=[7115])
    assert res["sucesso"] is False and res["erros"] == 1
    sb.upsert.assert_not_called()


def test_coletar_precos_limite_com_erro_nao_e_sucesso():
    cliente = MagicMock()
    cliente.consultar_material.side_effect = [compras_api.ErroApiCompras("HTTP 404"), {"resultado": [PRECO_ZERO_ESQ], "totalRegistros": 1}]
    res = compras_precos.coletar(cliente, None, pdms=[7113, 7115], limite=1, dry_run=True)
    assert res["total_coletados"] == 1 and res["erros"] == 1 and res["sucesso"] is False


# ---------------------------------------------------------------------------
# Bug 4: PDM 7115 (esteira elétrica) no padrão, 7113 mantido
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("modulo", [compras_arp, compras_precos])
def test_pdms_padrao_tem_7115_e_7113(modulo):
    assert 7115 in modulo.PDMS_PADRAO and 7113 in modulo.PDMS_PADRAO
    assert len(modulo.PDMS_PADRAO) == len(set(modulo.PDMS_PADRAO))


def test_precos_dry_run_sem_banco_consulta_7115():
    cliente = MagicMock()
    cliente.consultar_material.return_value = VAZIO_200
    compras_precos.coletar(cliente, None, dry_run=True)
    assert ("codigoPdm", 7115) in [c.args[:2] for c in cliente.consultar_material.call_args_list]


# ---------------------------------------------------------------------------
# Bug 5: chave da ARP = ata + UASG + lote + item + fornecedor
# ---------------------------------------------------------------------------
def test_arp_mesmo_item_fornecedores_distintos_nao_colidem():
    a = compras_arp.normalizar_ata_item(ARP_BASE)
    b = compras_arp.normalizar_ata_item({**ARP_BASE, "niFornecedor": CNPJ_B, "classificacaoFornecedor": "002",
                                         "nomeRazaoSocialFornecedor": "FORNECEDOR FICTICIO B LTDA", "valorUnitario": 15500.0})
    assert compras_arp.chave_arp(a) != compras_arp.chave_arp(b)
    linhas, removidos = compras_arp.deduplicar_por_chave([a, b])
    assert removidos == 0 and len(linhas) == 2


def test_arp_mesmo_item_em_lotes_distintos_nao_colidem():
    a = compras_arp.normalizar_ata_item(ARP_BASE)
    b = dict(a, numero_grupo=2)
    a = dict(a, numero_grupo=1)
    assert compras_arp.chave_arp(a) != compras_arp.chave_arp(b)
    assert len(compras_arp.deduplicar_por_chave([a, b])[0]) == 2


def test_arp_numero_grupo_null_porque_a_fonte_nao_traz_lote():
    norm = compras_arp.normalizar_ata_item(ARP_BASE)
    assert "numero_grupo" in norm and norm["numero_grupo"] is None


def test_arp_republicacao_mesma_chave_fica_a_mais_recente():
    antiga = compras_arp.normalizar_ata_item(ARP_BASE)
    nova = compras_arp.normalizar_ata_item({**ARP_BASE, "dataHoraInclusao": "2026-03-09T10:00:00",
                                            "dataHoraAtualizacao": "2026-03-09T10:00:00", "valorUnitario": 14900.0})
    linhas, removidos = compras_arp.deduplicar_por_chave([nova, antiga])
    assert removidos == 1 and linhas[0]["valor_unitario"] == 14900.0


def test_arp_ni_com_mascara_normalizado_e_sem_ni_descartado():
    com_mascara = compras_arp.normalizar_ata_item({**ARP_BASE, "niFornecedor": "11.222.333/0001-81"})
    assert com_mascara["ni_fornecedor"] == CNPJ_A
    assert compras_arp.normalizar_ata_item({**ARP_BASE, "niFornecedor": None}) is None
    assert compras_arp.normalizar_ata_item({**ARP_BASE, "niFornecedor": ""}) is None


def test_coletar_arp_upsert_usa_chave_nova_e_grava_os_dois_fornecedores():
    cliente = MagicMock()
    linhas = [ARP_BASE, {**ARP_BASE, "niFornecedor": CNPJ_B, "classificacaoFornecedor": "002"},
              {**ARP_BASE, "dataHoraAtualizacao": "2026-03-10T00:00:00"},  # republicação do fornecedor A
              {**ARP_BASE, "niFornecedor": None}]                             # sem fornecedor: descartado
    cliente.consultar_itens_pdm.return_value = {"resultado": linhas, "totalRegistros": 4}
    sb = MagicMock()
    res = compras_arp.coletar(cliente, sb, pdms=[7115], data_min="2026-01-01", data_max="2026-06-30")
    tabela, enviadas = sb.upsert.call_args.args
    assert tabela == "atas_rp_itens"
    assert sb.upsert.call_args.kwargs["conflito"] == (
        "numero_ata_registro_preco,codigo_unidade_gerenciadora,numero_grupo,numero_item,ni_fornecedor")
    assert sorted(l["ni_fornecedor"] for l in enviadas) == [CNPJ_A, CNPJ_B]
    assert res["duplicados_removidos"] == 1 and res["descartados"] == 1 and res["total_gravados"] == 2


def test_chave_do_coletor_bate_com_a_constraint_da_migration():
    raiz = Path(__file__).resolve().parents[3]
    sql = (raiz / "supabase/migrations/20261003020000_atas_rp_itens_chave_lote_fornecedor.sql").read_text()
    cols = ", ".join(compras_arp.CHAVE_ARP)
    assert f"unique nulls not distinct\n      ({cols})" in sql


# ---------------------------------------------------------------------------
# Bug 6: idCompra com zero à esquerda recuperado de idCompraItem
# ---------------------------------------------------------------------------
def test_precos_id_compra_recuperado_do_id_compra_item():
    norm = compras_precos.normalizar_preco_praticado(PRECO_ZERO_ESQ)
    assert norm["id_compra"] == "09990005900012026"
    assert isinstance(norm["id_compra"], str) and len(norm["id_compra"]) == 17
    assert norm["id_compra_item"] == "0999000590001202600003"
    assert norm["id_compra_item"].startswith(norm["id_compra"])


def test_precos_id_compra_sem_id_compra_item_completa_zeros():
    item = {k: v for k, v in PRECO_ZERO_ESQ.items() if k != "idCompraItem"}
    assert compras_precos.id_compra_de(item) == "09990005900012026"


def test_precos_id_compra_normal_17_digitos_inalterado():
    item = {**PRECO_ZERO_ESQ, "idCompra": 12345605900012026, "idCompraItem": "1234560590001202600003"}
    assert compras_precos.id_compra_de(item) == "12345605900012026"


def test_precos_dedup_mesma_chave_no_lote():
    a = compras_precos.normalizar_preco_praticado(PRECO_ZERO_ESQ)
    b = compras_precos.normalizar_preco_praticado({**PRECO_ZERO_ESQ, "dataHoraAtualizacaoItem": "2026-04-01T08:00:00",
                                                   "precoUnitario": 6900.0})
    linhas, removidos = compras_precos.deduplicar_por_chave([b, a])
    assert removidos == 1 and linhas[0]["preco_unitario"] == 6900.0

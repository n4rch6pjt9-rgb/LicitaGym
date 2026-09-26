"""Testes offline do coletor PNCP com respostas no formato real (compra de Carapicuíba, 24/09/2026)."""
from unittest.mock import MagicMock

from coletor import pncp as P

COMPRA = {
    "numero_controle_pncp": "44892693000140-1-000157/2026", "orgao_cnpj": "44892693000140", "ano": 2026,
    "numero_sequencial": 157, "orgao_nome": "MUNICIPIO DE CARAPICUIBA", "municipio_nome": "Carapicuíba", "uf": "SP",
    "title": "Pregão Eletrônico n° 41/2026",
    "description": " - Registro de preço para aquisição de borracha granulada para gramado sintético",
    "modalidade_licitacao_nome": "Pregão - Eletrônico", "situacao_nome": "Divulgada no PNCP",
    "data_publicacao_pncp": "2026-07-10T10:00:00", "valor_global": 300000.0,
}
ITENS = [
    {"numeroItem": 1, "descricao": "Borracha Granulada do tipo G3(0.68mm a 1.80mm) para gramado sintético.",
     "materialOuServicoNome": "Material", "quantidade": 50, "unidadeMedida": "TONELADA",
     "valorUnitarioEstimado": 3041.67, "valorTotal": 152083.5, "catalogoCodigoItem": None,
     "situacaoCompraItemNome": "Homologado", "temResultado": True},
    {"numeroItem": 2, "descricao": "Borracha Granulada do tipo G2 para gramado sintético.",
     "materialOuServicoNome": "Material", "quantidade": 40, "unidadeMedida": "TONELADA",
     "valorUnitarioEstimado": 3000, "valorTotal": 120000, "catalogoCodigoItem": None,
     "situacaoCompraItemNome": "Homologado", "temResultado": True},
]
RESULTADO = [{"sequencialResultado": 1, "nomeRazaoSocialFornecedor": "HG COMÉRCIO GESTÃO E SERVIÇOS LTDA",
              "niFornecedor": "12345678000199", "tipoPessoa": "PJ", "porteFornecedorNome": "Não Informado",
              "quantidadeHomologada": 50, "valorUnitarioHomologado": 2779.46, "valorTotalHomologado": 138973,
              "situacaoCompraItemResultadoNome": "Informado", "dataResultado": "2026-08-21"}]
ARQUIVOS = [{"sequencialDocumento": 1, "tipoDocumentoNome": "Edital", "statusAtivo": True,
             "titulo": "P.E. 41-2026 - R.P. para aquisicao de borracha granulada para gramado sintetico.pdf",
             "url": "https://pncp.gov.br/pncp-api/v1/orgaos/44892693000140/compras/2026/157/arquivos/1",
             "dataPublicacaoPncp": "2026-07-10T10:00:00"}]


def _pncp(compras):
    p = MagicMock()
    p.buscar.return_value = {"items": compras, "total": len(compras)}
    p.itens.return_value = ITENS
    p.resultados.return_value = RESULTADO
    p.arquivos.return_value = ARQUIVOS
    p.compra.return_value = {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026,
                             "modalidadeNome": "Pregão - Eletrônico"}
    return p


def test_avaliar_marca_borracha():
    cat, interesse, por_item = P.avaliar(COMPRA, ITENS)
    assert cat == "borracha" and interesse and por_item[1] == ("borracha", True)


def test_compra_de_decoracao_com_grama_fica_fora():
    cat, interesse, _ = P.avaliar({"description": "Aquisição de enfeites natalinos para a praça"},
                                  [{"numeroItem": 1, "descricao": "Grama sintética 2cm"}])
    assert cat is None and not interesse


def test_coleta_grava_compra_itens_vencedor_e_arquivos():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    r = P.coletar(_pncp([COMPRA, COMPRA]), sb, None, ["borracha granulada"], "todos", 1, 50,
                  com_resultados=True, baixar_arquivos=False, max_bytes=10**8, dry_run=False)
    assert r["encontradas"] == 1 and r["no_escopo"] == 1 and r["interesse_borracha"] == 1  # deduplicada
    tabelas = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}
    lic = tabelas["licitacoes_externas"]
    assert lic["codigo_externo"] == COMPRA["numero_controle_pncp"] and lic["interesse_borracha"] is True
    assert lic["categoria_escopo"] == "borracha" and lic["uf"] == "SP"
    assert len(tabelas["licitacao_itens"]) == 2 and tabelas["licitacao_itens"][0]["quantidade"] == 50
    res = tabelas["licitacao_resultados"][0]
    assert res["fornecedor_nome"].startswith("HG COM") and res["valor_unitario_homologado"] == 2779.46
    assert res["fornecedor_cnpj"] == "12345678000199" and "niFornecedor" not in res["raw"]
    assert tabelas["licitacao_documentos"][0]["raw"]["tipo_documento"] == "Edital"


def test_dry_run_nao_grava_e_fora_do_escopo_conta():
    fora = dict(COMPRA, numero_controle_pncp="x-1", description="Serviços de arbitragem esportiva")
    p = _pncp([COMPRA, fora])
    r = P.coletar(p, None, None, ["x"], "todos", 1, 50, True, False, 10**8, dry_run=True)
    assert (r["encontradas"], r["no_escopo"], r["interesse_borracha"], r["fora"], r["erros"]) == (2, 1, 1, 1, 0)


def test_pessoa_fisica_nao_tem_nome_nem_cpf_gravado():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else l
    p = _pncp([COMPRA])
    p.resultados.return_value = [dict(RESULTADO[0], tipoPessoa="PF", niFornecedor="12345678901",
                                      nomeRazaoSocialFornecedor="Fulano de Tal")]
    p.arquivos.return_value = []
    P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False)
    res = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacao_resultados"][0]
    assert res["fornecedor_nome"] is None and res["fornecedor_cnpj"] is None


from datetime import datetime, timezone


def _sb():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    return sb


def test_leads_grava_homologado_recente_com_data_e_prioridade():
    sb = _sb()
    agora = datetime(2026, 9, 24, tzinfo=timezone.utc)          # resultado em 21/08 -> 34 dias
    r = P.coletar(_pncp([COMPRA]), sb, None, ["x"], "encerradas", 1, 50, False, False, 10**8, False,
                  modo="leads", dias=120, agora=agora)
    assert r["gravadas"] == 1 and r["sem_resultado_recente"] == 0
    lic = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]
    assert lic["prioridade"] == "leads" and lic["data_homologacao"].startswith("2026-08-21")


def test_leads_descarta_homologacao_antiga():
    sb = _sb()
    agora = datetime(2027, 3, 1, tzinfo=timezone.utc)           # 21/08/2026 -> ~190 dias
    r = P.coletar(_pncp([dict(COMPRA, data_publicacao_pncp="2026-12-01T00:00:00")]), sb, None, ["x"],
                  "encerradas", 1, 50, False, False, 10**8, False, modo="leads", dias=120, agora=agora)
    assert r["gravadas"] == 0 and r["sem_resultado_recente"] == 1
    assert not sb.upsert.called


def test_leads_para_de_paginar_quando_editais_ficam_antigos():
    p = _pncp([dict(COMPRA, data_publicacao_pncp="2025-01-01T00:00:00")] * 50)
    agora = datetime(2026, 9, 24, tzinfo=timezone.utc)
    r = P.coletar(p, None, None, ["x"], "encerradas", 20, 50, False, False, 10**8, True,
                  modo="leads", dias=120, margem_publicacao=240, agora=agora)
    assert p.buscar.call_count == 1 and r["encontradas"] == 0 and not p.itens.called


def test_monitorar_usa_dois_status_e_grava_sem_resultado():
    sb = _sb()
    p = _pncp([COMPRA])
    p.resultados.return_value = []
    r = P.coletar(p, sb, None, ["x"], ["recebendo_proposta", "em_julgamento"], 1, 50, False, False, 10**8,
                  False, modo="monitorar")
    assert p.buscar.call_count == 2 and r["gravadas"] == 1
    lic = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]
    assert lic["prioridade"] == "monitorar" and "data_homologacao" not in lic


def test_historico_nao_sobrescreve_prioridade():
    sb = _sb()
    P.coletar(_pncp([COMPRA]), sb, None, ["x"], "encerradas", 1, 50, True, False, 10**8, False, modo="historico")
    lic = {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]
    assert "prioridade" not in lic


def test_instabilidade_do_pncp_vai_para_segunda_passada():
    p = _pncp([COMPRA])
    p.itens.side_effect = [RuntimeError("503 do PNCP"), ITENS]     # falha na 1ª, funciona na 2ª
    r = P.coletar(p, None, None, ["x"], "todos", 1, 50, True, False, 10**8, True, pausa_segunda_passada=0)
    assert p.itens.call_count == 2 and r["no_escopo"] == 1 and r["erros"] == 0


def test_falha_persistente_conta_como_erro():
    p = _pncp([COMPRA])
    p.itens.side_effect = RuntimeError("503 do PNCP")
    r = P.coletar(p, None, None, ["x"], "todos", 1, 50, True, False, 10**8, True, pausa_segunda_passada=0)
    assert r["erros"] == 1 and r["no_escopo"] == 0


def test_retry_do_cliente_em_503(monkeypatch):
    import requests
    cli = P.PNCP(delay=0, tentativas=3)
    monkeypatch.setattr(P.time, "sleep", lambda s: None)
    respostas = [MagicMock(status_code=503), MagicMock(status_code=200, headers={"content-type": "application/json"})]
    respostas[1].json.return_value = [{"ok": 1}]
    sess = MagicMock()
    sess.get.side_effect = respostas
    cli._local.s = sess
    assert cli._get("/x") == [{"ok": 1}] and sess.get.call_count == 2


def test_chave_invalida_para_imediatamente():
    sb = MagicMock()
    sb.upsert.side_effect = RuntimeError('Supabase licitacoes_externas: 401 {"message":"Invalid API key"}')
    p = _pncp([COMPRA, dict(COMPRA, numero_controle_pncp="y-2")])
    try:
        P.coletar(p, sb, None, ["x"], "todos", 1, 50, False, False, 10**8, False, workers=1)
        assert False, "deveria ter parado"
    except SystemExit as e:
        assert "401" in str(e)
    assert sb.upsert.call_count == 1


def test_numero_processo_e_o_processo_administrativo_nao_o_codigo_pncp():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    P.coletar(_pncp([COMPRA]), sb, None, ["borracha granulada"], "todos", 1, 50,
              com_resultados=True, baixar_arquivos=False, max_bytes=10**8, dry_run=False)
    lic = next(c.args[1] for c in sb.upsert.call_args_list if c.args[0] == "licitacoes_externas")
    assert lic["codigo_externo"] == "44892693000140-1-000157/2026"
    assert lic["numero_processo"] == "3789/2026"            # processo administrativo do órgão
    assert lic["numero_edital"] == "Pregão - Eletrônico nº 41/2026"


def test_sem_detalhe_nao_inventa_processo():
    p = _pncp([COMPRA]); p.compra.side_effect = RuntimeError("503")
    assert P.identificacao(p, COMPRA) == {"numero_processo": None, "numero_edital": COMPRA["title"]}

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
    assert "niFornecedor" not in res["raw"] and "nomeRazaoSocialFornecedor" not in res["raw"]


from datetime import datetime, timezone


def _sb():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    return sb


ABERTA = dict(COMPRA, numero_controle_pncp="44892693000140-1-000200/2026", numero_sequencial=200,
              data_inicio_vigencia="2026-09-25T08:00", data_fim_vigencia="2026-10-13T09:30", tem_resultado=False)
ITENS_ABERTOS = [dict(it, situacaoCompraItemNome="Em andamento", temResultado=False) for it in ITENS]
AGORA = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)


def _pncp_aberto(compras):
    p = _pncp(compras)
    p.itens.return_value = ITENS_ABERTOS
    p.resultados.return_value = []
    return p


def _lic(sb):
    return {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]


def test_modos_buscam_status_da_nova_semantica():
    assert P.MODOS["leads"]["status"] == "recebendo_proposta"
    assert P.MODOS["monitorar"]["status"] == "em_julgamento"
    assert P.MODOS["historico"]["status"] == "encerradas"


def test_leads_grava_compra_recebendo_proposta_como_lead():
    sb = _sb()
    r = P.coletar(_pncp_aberto([ABERTA]), sb, None, ["x"], P.MODOS["leads"]["status"], 1, 50, True, False,
                  10**8, False, modo="leads", agora=AGORA)
    lic = _lic(sb)
    assert r["gravadas"] == 1 and r["prioridade_leads"] == 1
    assert lic["prioridade"] == "leads" and "data_homologacao" not in lic


def test_homologada_na_busca_de_leads_vira_historico():
    """Ruído do filtro do PNCP: a compra homologada nunca é gravada como lead."""
    sb = _sb()
    r = P.coletar(_pncp([dict(COMPRA, tem_resultado=True)]), sb, None, ["x"], "recebendo_proposta", 1, 50,
                  True, False, 10**8, False, modo="leads", agora=AGORA)
    lic = _lic(sb)
    assert lic["prioridade"] == "historico" and lic["data_homologacao"].startswith("2026-08-21")
    assert r["prioridade_historico"] == 1 and r["prioridade_diferente_do_modo"] == 1


def test_monitorar_busca_em_julgamento_e_grava_monitorar():
    sb = _sb()
    julg = dict(ABERTA, data_fim_vigencia="2026-09-20T09:30")
    p = _pncp_aberto([julg])
    r = P.coletar(p, sb, None, ["x"], P.MODOS["monitorar"]["status"], 1, 50, True, False, 10**8,
                  False, modo="monitorar", agora=AGORA)
    assert p.buscar.call_count == 1 and p.buscar.call_args.args[1] == "em_julgamento"
    lic = _lic(sb)
    assert r["gravadas"] == 1 and lic["prioridade"] == "monitorar" and "data_homologacao" not in lic


def test_historico_grava_prioridade_historico():
    sb = _sb()
    P.coletar(_pncp([COMPRA]), sb, None, ["x"], "encerradas", 1, 50, True, False, 10**8, False,
              modo="historico", agora=AGORA)
    assert _lic(sb)["prioridade"] == "historico"


def test_compra_encerrada_rebaixa_lead_ja_gravado():
    """Regra antiga ("histórico não rebaixa um lead") saiu: o estado derivado vence."""
    sb = _FakeSbIdempotente()
    P.coletar(_pncp_aberto([ABERTA]), sb, None, ["x"], "recebendo_proposta", 1, 50, True, False, 10**8, False,
              modo="leads", agora=AGORA)
    (lic,) = sb.tabelas["licitacoes_externas"].values()
    assert lic["prioridade"] == "leads"
    P.coletar(_pncp([dict(ABERTA, tem_resultado=True)]), sb, None, ["x"], "encerradas", 1, 50, True, False,
              10**8, False, modo="historico", agora=AGORA)
    (lic,) = sb.tabelas["licitacoes_externas"].values()
    assert lic["prioridade"] == "historico"


def test_prioridade_indeterminada_nao_sobrescreve():
    sb = _sb()
    sem_prazo = dict(COMPRA, tem_resultado=False)             # sem data_fim_vigencia, busca status=todos
    r = P.coletar(_pncp_aberto([sem_prazo]), sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False,
                  agora=AGORA)
    assert "prioridade" not in _lic(sb) and r["prioridade_indeterminada"] == 1


def test_main_leads_busca_recebendo_proposta_e_ignora_dias_obsoleto(monkeypatch):
    visto = {}

    def fake_coletar(pncp, sb, arm, termos, status, paginas, *a, **kw):
        visto.update(status=status, paginas=paginas, **kw)
        return {}

    monkeypatch.setattr(P, "coletar", fake_coletar)
    assert P.main(["--dry-run", "--dias", "60", "--termos", "x"]) == 0
    assert visto["status"] == "recebendo_proposta" and visto["modo"] == "leads"
    assert "dias" not in visto and "margem_publicacao" not in visto


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
    try:
        P.identificacao(p, COMPRA)
        assert False, "falha de consulta não pode virar processo NULL"
    except P.ConsultaFalhou as e:
        assert "503" in str(e)


def test_detalhe_valido_sem_processo_e_none():
    p = _pncp([COMPRA]); p.compra.return_value = {"numeroCompra": "41", "anoCompra": 2026}
    assert P.identificacao(p, COMPRA)["numero_processo"] is None


def test_coleta_com_detalhe_falho_nao_sobrescreve_identificacao():
    sb = _sb()
    p = _pncp([COMPRA]); p.compra.side_effect = RuntimeError("timeout")
    r = P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False)
    lic = next(c.args[1] for c in sb.upsert.call_args_list if c.args[0] == "licitacoes_externas")
    assert "numero_processo" not in lic and "numero_edital" not in lic
    assert r["gravadas"] == 1 and r["falha_detalhe"] == 1


class _FakeSbCorrigir:
    def __init__(self, linhas):
        self.linhas, self.atualizacoes = linhas, []

    def selecionar(self, tabela, **kw):
        return self.linhas

    def atualizar(self, tabela, id_, dados):
        self.atualizacoes.append((id_, dados))


def test_corrigir_processos_distingue_encontrado_sem_processo_e_falha():
    linhas = [
        {"id": 1, "codigo_externo": "44892693000140-1-000157/2026", "numero_edital": "PE 41/2026"},
        {"id": 2, "codigo_externo": "44892693000140-1-000158/2026", "numero_edital": "PE 42/2026"},
        {"id": 3, "codigo_externo": "44892693000140-1-000159/2026", "numero_edital": "PE 43/2026"},
    ]
    respostas = {
        157: {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026},
        158: {"numeroCompra": "42", "anoCompra": 2026},
        159: RuntimeError("429 do PNCP"),
    }
    p = MagicMock()

    def compra(c):
        v = respostas[c["numero_sequencial"]]
        if isinstance(v, Exception):
            raise v
        return v

    p.compra.side_effect = compra
    sb = _FakeSbCorrigir(linhas)
    r = P.corrigir_processos(p, sb)
    assert r == {"lidas": 3, "corrigidas": 1, "sem_processo": 1, "falha_consulta": 1}
    assert [i for i, _ in sb.atualizacoes] == [1, 2]
    assert sb.atualizacoes[1][1]["numero_processo"] is None


class _FakeSbIdempotente:
    """Emula upsert do PostgREST: identidade = colunas de on_conflict."""

    def __init__(self):
        self.tabelas, self._seq = {}, 0

    def upsert(self, tabela, linhas, conflito):
        unico = isinstance(linhas, dict)
        linhas = [linhas] if unico else linhas
        cols = conflito.split(",")
        store = self.tabelas.setdefault(tabela, {})
        out = []
        for ln in linhas:
            chave = tuple(ln[c] for c in cols)
            atual = store.get(chave)
            if atual is None:
                self._seq += 1
                atual = {"id": self._seq, "status_processamento": "pendente"}
            atual.update(ln)
            store[chave] = atual
            out.append(dict(atual))
        return out

    def atualizar(self, *a, **k):
        pass


def test_reprocessar_mesma_compra_nao_duplica():
    sb = _FakeSbIdempotente()
    for _ in range(2):
        P.coletar(_pncp([COMPRA]), sb, None, ["borracha granulada"], "todos", 1, 50,
                  com_resultados=True, baixar_arquivos=False, max_bytes=10**8, dry_run=False)
    contagem = {t: len(v) for t, v in sb.tabelas.items()}
    assert contagem == {"licitacoes_externas": 1, "licitacao_itens": 2,
                        "licitacao_resultados": 2, "licitacao_documentos": 1}


def _cliente(monkeypatch, respostas, tentativas=3):
    cli = P.PNCP(delay=0, tentativas=tentativas)
    esperas = []
    monkeypatch.setattr(P.time, "sleep", lambda s: esperas.append(s))
    sess = MagicMock()
    sess.get.side_effect = respostas
    cli._local.s = sess
    return cli, sess, esperas


def _resp(status, json_body=None, ctype="application/json", headers=None, json_exc=None):
    r = MagicMock(status_code=status, headers={"content-type": ctype, **(headers or {})})
    if json_exc:
        r.json.side_effect = json_exc
    else:
        r.json.return_value = json_body
    return r


def test_cliente_timeout_esgotado_levanta(monkeypatch):
    import requests
    cli, sess, _ = _cliente(monkeypatch, requests.Timeout("lento"))
    try:
        cli._get("/x")
        assert False
    except requests.Timeout:
        assert sess.get.call_count == 3


def test_cliente_5xx_esgotado_levanta(monkeypatch):
    import requests
    cli, sess, _ = _cliente(monkeypatch, [_resp(502), _resp(503), _resp(504)])
    try:
        cli._get("/x")
        assert False
    except requests.HTTPError as e:
        assert "504" in str(e) and sess.get.call_count == 3


def test_cliente_429_respeita_retry_after(monkeypatch):
    cli, _, esperas = _cliente(monkeypatch, [_resp(429, headers={"Retry-After": "7"}), _resp(200, [{"ok": 1}])])
    assert cli._get("/x") == [{"ok": 1}]
    assert 7.0 in esperas


def test_cliente_json_invalido_levanta(monkeypatch):
    cli, _, _ = _cliente(monkeypatch, [_resp(200, json_exc=ValueError("Expecting value"))])
    try:
        cli._get("/x")
        assert False
    except P.RespostaInvalida as e:
        assert "JSON inválido" in str(e)


def test_cliente_html_com_200_levanta(monkeypatch):
    cli, _, _ = _cliente(monkeypatch, [_resp(200, ctype="text/html")])
    try:
        cli.arquivos(COMPRA)
        assert False
    except P.RespostaInvalida:
        pass


def test_cliente_204_e_lista_vazia_valida(monkeypatch):
    cli, _, _ = _cliente(monkeypatch, [_resp(204)])
    assert cli.arquivos(COMPRA) == []


def test_detalhe_nao_objeto_levanta(monkeypatch):
    cli, _, _ = _cliente(monkeypatch, [_resp(204)])
    try:
        cli.compra(COMPRA)
        assert False
    except P.RespostaInvalida:
        pass

def test_compra_usa_consulta_v1_e_nao_pncp_v1(monkeypatch):
    """Detalhe da compra: /api/consulta/v1; itens/arquivos permanecem em /api/pncp/v1."""
    cli = P.PNCP(delay=0, tentativas=1)
    monkeypatch.setattr(P.time, "sleep", lambda s: None)
    visto = {}

    def fake_get(caminho, **params):
        visto["caminho"] = caminho
        return {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026}

    cli._get = fake_get
    assert cli.compra(COMPRA)["processo"] == "3789/2026"
    assert visto["caminho"] == (
        f"/api/consulta/v1/orgaos/{COMPRA['orgao_cnpj']}/compras/{COMPRA['ano']}/{COMPRA['numero_sequencial']}"
    )
    assert "/api/pncp/v1/" not in visto["caminho"]
    assert P.PNCP.base_compra(COMPRA).startswith("/api/pncp/v1/")
    assert P.PNCP.detalhe_compra(COMPRA).startswith("/api/consulta/v1/")


def test_compra_levanta_erro_se_json_status_3xx_com_message(monkeypatch):
    cli = P.PNCP(delay=0, tentativas=1)
    monkeypatch.setattr(P.time, "sleep", lambda s: None)
    cli._get = lambda *a, **k: {"status": 301, "message": "Moved Permanently", "path": "/api/pncp/v1/..."}
    try:
        cli.compra(COMPRA)
        assert False, "deveria falhar"
    except RuntimeError as e:
        assert "301" in str(e) and "Moved Permanently" in str(e)


def test_busca_rejeita_envelope_sem_items(monkeypatch):
    cli = P.PNCP(delay=0, tentativas=1)
    cli._get = lambda *a, **k: {"total": 0}
    try:
        cli.buscar("equipamentos")
        assert False, "envelope sem items não é uma busca vazia válida"
    except P.RespostaInvalida:
        pass


def test_itens_rejeita_pagina_repetida():
    cli = P.PNCP(delay=0, tentativas=1)
    pagina = [{"numeroItem": i} for i in range(100)]
    cli._lista = MagicMock(side_effect=[pagina, list(pagina)])
    try:
        cli.itens(COMPRA)
        assert False, "página repetida não deve causar loop de paginação"
    except P.RespostaInvalida as e:
        assert "página repetida" in str(e)
        assert "página 2" in str(e)
    assert cli._lista.call_count == 2

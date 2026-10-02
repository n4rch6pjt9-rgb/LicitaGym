"""Prioridade pelo estado da compra (decisão do owner, 29/09/2026) e backfill em dry-run.

leads = recebendo proposta | monitorar = em julgamento | historico = encerrada/homologada/com resultado.
Payloads no formato real do PNCP (consultados em 29/09/2026)."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from coletor import backfill_prioridade_pncp as B
from coletor import pncp as P

AGORA = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)

# Caso real: Polícia Militar da Bahia, piso emborrachado. Item da busca (status=encerradas) e detalhe
# (/api/consulta/v1/orgaos/33457634000127/compras/2026/896): situação continua "Divulgada no PNCP",
# mas há resultado (item 1920375 homologado, dataResultado 2026-09-04).
PMBA_BUSCA = {
    "numero_controle_pncp": "33457634000127-1-000896/2026", "orgao_cnpj": "33457634000127", "ano": "2026",
    "numero_sequencial": "896", "description": "piso emborrachado", "situacao_id": "1",
    "situacao_nome": "Divulgada no PNCP", "data_publicacao_pncp": "2026-09-04T13:28:46.419629",
    "data_inicio_vigencia": "2026-09-11T13:30", "data_fim_vigencia": "2026-09-11T15:30",
    "cancelado": False, "valor_global": None, "tem_resultado": True,
}
PMBA_DETALHE = {
    "numeroControlePNCP": "33457634000127-1-000896/2026", "situacaoCompraId": 1,
    "situacaoCompraNome": "Divulgada no PNCP", "existeResultado": True, "valorTotalHomologado": 15760.03,
    "dataAberturaProposta": "2026-09-11T13:30:00", "dataEncerramentoProposta": "2026-09-11T15:30:00",
}
# Linha como o coletor antigo gravou (modo leads = homologada nos últimos 120 dias).
PMBA_LINHA = {
    "id": 1, "codigo_externo": "33457634000127-1-000896/2026", "prioridade": "leads",
    "situacao": "Divulgada no PNCP", "data_homologacao": "2026-09-04T00:00:00+00:00",
    "data_fim": "2026-09-11T15:30:00+00:00", "raw": PMBA_BUSCA,
}
ABERTA = {"numero_controle_pncp": "33781055000135-1-001683/2026", "situacao_nome": "Divulgada no PNCP",
          "tem_resultado": False, "cancelado": False,
          "data_inicio_vigencia": "2026-09-29T08:00", "data_fim_vigencia": "2026-10-13T09:30"}
EM_JULGAMENTO = dict(ABERTA, numero_controle_pncp="13239751000107-1-000021/2026",
                     data_inicio_vigencia="2026-09-10T00:00", data_fim_vigencia="2026-09-15T00:00")


# --- função pura --------------------------------------------------------------------------------

def test_caso_real_pmba_homologada_e_historico_em_qualquer_formato():
    assert P.prioridade_da_compra(PMBA_BUSCA, agora=AGORA) == "historico"
    assert P.prioridade_da_compra(PMBA_DETALHE, agora=AGORA) == "historico"
    assert P.prioridade_da_compra(PMBA_LINHA, agora=AGORA) == "historico"
    # só o resultado consultado (dataResultado 2026-09-04) já basta
    sem_flag = dict(PMBA_BUSCA, tem_resultado=False)
    assert P.prioridade_da_compra(sem_flag, True, agora=AGORA) == "historico"
    # mesmo que a busca tenha vindo com status=recebendo_proposta (filtro do PNCP é ruidoso)
    assert P.prioridade_da_compra(PMBA_BUSCA, agora=AGORA, status_busca="recebendo_proposta") == "historico"


def test_so_data_homologacao_gravada_basta_para_historico():
    assert P.prioridade_da_compra({"data_homologacao": "2026-09-04T00:00:00+00:00",
                                   "data_fim": "2026-12-01T00:00:00+00:00"}, agora=AGORA) == "historico"


def test_recebendo_proposta_e_lead():
    assert P.prioridade_da_compra(ABERTA, agora=AGORA) == "leads"
    assert P.prioridade_da_compra(ABERTA, False, agora=AGORA, status_busca="em_julgamento") == "leads"
    p, motivo = P.motivo_prioridade(ABERTA, agora=AGORA)
    assert (p, motivo) == ("leads", "recebendo proposta")


def test_em_julgamento_e_monitorar():
    assert P.prioridade_da_compra(EM_JULGAMENTO, agora=AGORA) == "monitorar"
    assert P.prioridade_da_compra(EM_JULGAMENTO, False, agora=AGORA, status_busca="recebendo_proposta") == "monitorar"


def test_prazo_de_proposta_sem_fuso_e_horario_de_brasilia():
    fim_hoje = dict(ABERTA, data_fim_vigencia="2026-09-29T10:00")      # 10:00 BRT = 13:00 UTC
    assert P.prioridade_da_compra(fim_hoje, agora=datetime(2026, 9, 29, 12, 30, tzinfo=timezone.utc)) == "leads"
    assert P.prioridade_da_compra(fim_hoje, agora=datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc)) == "monitorar"


def test_linha_gravada_usa_prazo_do_raw_antes_do_data_fim_gravado_como_utc():
    # o coletor grava data_fim_vigencia "09:30" (Brasília) como "09:30+00:00" (= 06:30 BRT);
    # às 07:00 BRT o certame ainda recebe proposta até 09:30 BRT: é lead, não monitorar
    linha = {"id": 9, "codigo_externo": ABERTA["numero_controle_pncp"], "prioridade": "leads",
             "situacao": "Divulgada no PNCP", "data_homologacao": None,
             "data_fim": "2026-10-13T09:30:00+00:00", "raw": ABERTA}
    as_07_brt = datetime(2026, 10, 13, 10, 0, tzinfo=timezone.utc)
    assert P.motivo_prioridade(linha, agora=as_07_brt) == ("leads", "recebendo proposta")
    as_10_brt = datetime(2026, 10, 13, 13, 0, tzinfo=timezone.utc)
    assert P.prioridade_da_compra(linha, agora=as_10_brt) == "monitorar"
    # sem raw, o data_fim gravado continua valendo como último recurso
    assert P.prioridade_da_compra(dict(linha, raw={}), agora=as_07_brt) == "monitorar"


@pytest.mark.parametrize("situacao", ["Revogada", "Anulada", "Cancelada", "Deserta", "Fracassada", "Encerrada"])
def test_situacao_encerrada_e_historico_mesmo_com_prazo_aberto(situacao):
    assert P.prioridade_da_compra(dict(ABERTA, situacao_nome=situacao), agora=AGORA) == "historico"


def test_cancelado_e_valor_homologado_sao_historico():
    assert P.prioridade_da_compra(dict(ABERTA, cancelado=True), agora=AGORA) == "historico"
    assert P.prioridade_da_compra({"situacaoCompraNome": "Divulgada no PNCP", "valorTotalHomologado": 10.0,
                                   "dataEncerramentoProposta": "2026-12-01T00:00:00"}, agora=AGORA) == "historico"


def test_suspensa_e_monitorar():
    assert P.prioridade_da_compra(dict(ABERTA, situacao_nome="Suspensa"), agora=AGORA) == "monitorar"


def test_itens_decidem_quando_a_compra_nao_diz():
    homologado = [{"numeroItem": 1, "situacaoCompraItemNome": "Homologado", "temResultado": True},
                  {"numeroItem": 2, "situacaoCompraItemNome": "Em andamento", "temResultado": False}]
    desertos = [{"situacao": "Deserto", "tem_resultado": False}, {"situacao": "Fracassado", "tem_resultado": False}]
    andamento = [{"situacaoCompraItemNome": "Em andamento", "temResultado": False}]
    assert P.prioridade_da_compra(EM_JULGAMENTO, agora=AGORA, itens=homologado) == "historico"
    assert P.prioridade_da_compra(EM_JULGAMENTO, agora=AGORA, itens=desertos) == "historico"
    assert P.prioridade_da_compra(EM_JULGAMENTO, agora=AGORA, itens=andamento) == "monitorar"


def test_sem_prazo_usa_status_da_busca_e_senao_indeterminado():
    # ex.: inexigibilidade 76282656000106-1-000794/2026 (busca encerradas, sem datas, sem resultado)
    sem_prazo = {"situacao_nome": "Divulgada no PNCP", "tem_resultado": False, "data_fim_vigencia": None}
    assert P.prioridade_da_compra(sem_prazo, agora=AGORA, status_busca="encerradas") == "historico"
    assert P.prioridade_da_compra(sem_prazo, agora=AGORA, status_busca="recebendo_proposta") == "leads"
    assert P.prioridade_da_compra(sem_prazo, agora=AGORA, status_busca="todos") is None
    assert P.prioridade_da_compra(sem_prazo, agora=AGORA) is None


def test_rebaixa_lead_antigo_homologado():
    """Linha antiga: prioridade=leads porque foi homologada. O estado derivado vence."""
    assert PMBA_LINHA["prioridade"] == "leads"
    assert P.prioridade_da_compra(PMBA_LINHA, agora=AGORA) == "historico"


def test_funcao_e_pura_nao_altera_entrada():
    import copy
    antes = copy.deepcopy(PMBA_LINHA)
    P.motivo_prioridade(PMBA_LINHA, agora=AGORA, itens=[{"situacao": "Homologado"}])
    assert PMBA_LINHA == antes


# --- backfill -----------------------------------------------------------------------------------

class _SbSomenteLeitura:
    def __init__(self, linhas):
        self.linhas, self.selecoes, self.atualizacoes = linhas, [], []

    def selecionar(self, tabela, **filtros):
        self.selecoes.append((tabela, filtros))
        return [dict(ln) for ln in self.linhas]

    def atualizar(self, tabela, id_, campos):
        self.atualizacoes.append((tabela, id_, campos))

    def upsert(self, *a, **k):
        raise AssertionError("backfill não faz upsert")


def _linhas():
    return [
        PMBA_LINHA,                                                                 # leads -> historico
        {"id": 2, "codigo_externo": ABERTA["numero_controle_pncp"], "prioridade": "monitorar",
         "situacao": "Divulgada no PNCP", "data_homologacao": None, "data_fim": "2026-10-13T12:30:00+00:00",
         "raw": ABERTA},                                                            # monitorar -> leads
        {"id": 3, "codigo_externo": EM_JULGAMENTO["numero_controle_pncp"], "prioridade": "monitorar",
         "situacao": "Divulgada no PNCP", "data_homologacao": None, "data_fim": "2026-09-15T03:00:00+00:00",
         "raw": EM_JULGAMENTO},                                                     # sem mudança
        {"id": 4, "codigo_externo": "21425374000129-1-000003/2026", "prioridade": None, "situacao": "Anulada",
         "data_homologacao": None, "data_fim": None, "raw": {}},                    # NULL -> historico
        {"id": 5, "codigo_externo": "76282656000106-1-000794/2026", "prioridade": None,
         "situacao": "Divulgada no PNCP", "data_homologacao": None, "data_fim": None,
         "raw": {"tem_resultado": False}, "licitacao_itens": [{"situacao": "Em andamento", "tem_resultado": False}]},
        {"id": 6, "codigo_externo": "11111111000111-1-000010/2026", "prioridade": "monitorar",
         "situacao": "Divulgada no PNCP", "data_homologacao": None, "data_fim": "2026-09-01T12:00:00+00:00",
         "raw": {}, "licitacao_itens": [{"situacao": "Deserto", "tem_resultado": False}]},  # monitorar -> historico
    ]


def test_backfill_dry_run_conta_transicoes_e_nao_grava():
    sb = _SbSomenteLeitura(_linhas())
    r = B.backfill(sb, agora=AGORA)
    assert sb.atualizacoes == []
    assert r["transicoes"] == {"leads->historico": 1, "monitorar->leads": 1, "NULL->historico": 1,
                               "monitorar->historico": 1}
    assert (r["lidas"], r["mudariam"], r["sem_mudanca"], r["indeterminadas"], r["gravadas"]) == (6, 4, 1, 1, 0)
    assert r["amostra"]["leads->historico"][0][:2] == (1, "33457634000127-1-000896/2026")
    tabela, filtros = sb.selecoes[0]
    assert tabela == "licitacoes_externas" and filtros["fonte"] == "eq.pncp"


def test_backfill_dry_run_com_consulta_pncp_so_le():
    sb = _SbSomenteLeitura(_linhas())
    pncp = MagicMock()
    # a compra em julgamento (#3) foi homologada depois da coleta; o PNCP só responde GET

    def compra(c):
        if c["numero_sequencial"] == 21:
            return dict(PMBA_DETALHE, numeroControlePNCP=c["numero_controle_pncp"])
        if c["numero_sequencial"] == 1683:
            return {"situacaoCompraNome": "Divulgada no PNCP", "existeResultado": False,
                    "dataEncerramentoProposta": "2026-10-13T09:30:00"}
        raise RuntimeError("503 do PNCP")
    pncp.compra.side_effect = compra
    r = B.backfill(sb, pncp, agora=AGORA, consultar_pncp=True)
    assert sb.atualizacoes == []
    assert r["transicoes"]["monitorar->historico"] == 2        # #3 pelo PNCP, #6 pelos itens gravados
    assert r["transicoes"]["monitorar->leads"] == 1
    assert r["consultadas_pncp"] == 2 and r["falha_consulta"] == 1   # #5 falhou: fica indeterminada
    assert r["indeterminadas"] == 1
    # só linhas que o gravado não fechou como historico foram consultadas
    consultadas = {c.args[0]["numero_sequencial"] for c in pncp.compra.call_args_list}
    assert consultadas == {1683, 21, 794}
    assert not pncp.itens.called          # detalhe já decidiu (leads/historico): itens só em "monitorar"


def test_backfill_consulta_itens_quando_detalhe_diz_em_julgamento():
    sb = _SbSomenteLeitura([_linhas()[2]])                     # #3, em julgamento
    pncp = MagicMock()
    pncp.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "existeResultado": False,
                                "dataEncerramentoProposta": "2026-09-15T00:00:00"}
    pncp.itens.return_value = [{"numeroItem": 1, "situacaoCompraItemNome": "Deserto", "temResultado": False}]
    r = B.backfill(sb, pncp, agora=AGORA, consultar_pncp=True)
    assert r["transicoes"] == {"monitorar->historico": 1} and sb.atualizacoes == []
    assert "todos os itens finalizados" in r["amostra"]["monitorar->historico"][0][2]


def test_backfill_apply_grava_so_a_coluna_prioridade():
    sb = _SbSomenteLeitura(_linhas())
    r = B.backfill(sb, aplicar=True, agora=AGORA)
    assert r["gravadas"] == 4
    assert sorted((i, c) for _, i, c in sb.atualizacoes) == [
        (1, {"prioridade": "historico"}), (2, {"prioridade": "leads"}),
        (4, {"prioridade": "historico"}), (6, {"prioridade": "historico"})]


def test_backfill_main_padrao_e_dry_run(monkeypatch, capsys):
    sb = _SbSomenteLeitura(_linhas())
    monkeypatch.setattr(B, "Supabase", lambda *a, **kw: sb)
    monkeypatch.setattr(B, "env", lambda *a, **kw: "0")
    monkeypatch.setattr(B, "PNCP", lambda **k: pytest.fail("sem --consultar-pncp não cria cliente PNCP"))
    assert B.main([]) == 0
    assert sb.atualizacoes == []
    assert "leads->historico: 1" in capsys.readouterr().out


# --- coletor: o detalhe da compra decide a prioridade (a busca pode estar defasada) ------------------

# Item da busca "atrasado": prazo aberto, sem resultado, situação Divulgada. Itens em andamento.
BUSCA_ABERTA = dict(ABERTA, orgao_cnpj="33781055000135", ano="2026", numero_sequencial="1683",
                    description="Aquisição de piso emborrachado para academia", municipio_nome="Salvador",
                    uf="BA", modalidade_licitacao_nome="Pregão - Eletrônico", valor_global=None)
ITENS_EM_ANDAMENTO = [{"numeroItem": 1, "descricao": "Piso emborrachado 10mm", "quantidade": 100,
                       "situacaoCompraItemNome": "Em andamento", "temResultado": False}]
DETALHE_ABERTO = {"processo": "123/2026", "numeroCompra": "90", "anoCompra": 2026,
                  "modalidadeNome": "Pregão - Eletrônico", "situacaoCompraNome": "Divulgada no PNCP",
                  "existeResultado": False, "valorTotalHomologado": None,
                  "dataEncerramentoProposta": "2026-10-13T09:30:00"}


def _pncp_coleta(detalhe, busca=BUSCA_ABERTA):
    """PNCP falso: `detalhe` = dict (resposta do detalhe) ou Exception (consulta falha)."""
    p = MagicMock()
    p.buscar.return_value = {"items": [busca], "total": 1}
    p.itens.return_value = ITENS_EM_ANDAMENTO
    p.resultados.return_value = []
    p.arquivos.return_value = []
    if isinstance(detalhe, Exception):
        p.compra.side_effect = detalhe
    else:
        p.compra.return_value = detalhe
    return p


def _sb_coleta():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, linhas, conflito: [{"id": 7}] if t == "licitacoes_externas" else linhas
    return sb


def _coletar(p, sb=None, dry_run=False, status="recebendo_proposta"):
    sb = sb if sb is not None else _sb_coleta()
    r = P.coletar(p, sb, None, ["piso emborrachado"], status, 1, 50, com_resultados=True,
                  baixar_arquivos=False, max_bytes=10**8, dry_run=dry_run, modo="leads", agora=AGORA,
                  pausa_segunda_passada=0)
    linhas = [c.args[1] for c in sb.upsert.call_args_list if c.args[0] == "licitacoes_externas"]
    return r, (linhas[0] if linhas else None)


def test_busca_aberta_mas_detalhe_com_resultado_grava_historico():
    p = _pncp_coleta(dict(DETALHE_ABERTO, existeResultado=True))
    r, lic = _coletar(p)
    assert lic["prioridade"] == "historico"
    assert r["prioridade_historico"] == 1 and "prioridade_leads" not in r
    assert r["prioridade_diferente_do_modo"] == 1
    assert lic["numero_processo"] == "123/2026"          # identificação do mesmo detalhe
    assert p.compra.call_count == 1


def test_detalhe_com_valor_homologado_grava_historico():
    p = _pncp_coleta(dict(DETALHE_ABERTO, valorTotalHomologado=15760.03))
    r, lic = _coletar(p)
    assert lic["prioridade"] == "historico" and r["prioridade_historico"] == 1
    assert p.compra.call_count == 1


def test_detalhe_com_prazo_encerrado_sem_resultado_e_monitorar_mesmo_com_busca_aberta():
    p = _pncp_coleta(dict(DETALHE_ABERTO, dataEncerramentoProposta="2026-09-20T09:30:00"))
    r, lic = _coletar(p)
    assert lic["prioridade"] == "monitorar" and r["prioridade_monitorar"] == 1
    assert p.compra.call_count == 1


def test_detalhe_aberto_confirma_lead():
    p = _pncp_coleta(DETALHE_ABERTO)
    r, lic = _coletar(p)
    assert lic["prioridade"] == "leads" and r["prioridade_leads"] == 1
    assert "prioridade_leads_sem_detalhe" not in r and p.compra.call_count == 1


def test_falha_no_detalhe_e_busca_aberta_nao_grava_leads():
    """Fail-closed: sem o detalhe, leads só pela busca+itens pode ser compra já homologada."""
    p = _pncp_coleta(RuntimeError("timeout do PNCP"))
    r, lic = _coletar(p)
    assert lic is not None and "prioridade" not in lic          # fica o valor do banco
    assert "numero_processo" not in lic and "numero_edital" not in lic
    assert r["prioridade_leads_sem_detalhe"] == 1 and r["falha_detalhe"] == 1
    assert "prioridade_leads" not in r and "prioridade_diferente_do_modo" not in r
    assert r["gravadas"] == 1 and r["erros"] == 0
    assert p.compra.call_count == 1


def test_falha_no_detalhe_e_busca_encerrada_grava_historico():
    p = _pncp_coleta(RuntimeError("503 do PNCP"), busca=dict(BUSCA_ABERTA, tem_resultado=True))
    r, lic = _coletar(p, status="encerradas")
    assert lic["prioridade"] == "historico" and r["prioridade_historico"] == 1
    assert "prioridade_leads_sem_detalhe" not in r and r["falha_detalhe"] == 1


def test_falha_no_detalhe_e_prazo_encerrado_na_busca_grava_monitorar():
    p = _pncp_coleta(RuntimeError("503 do PNCP"), busca=dict(BUSCA_ABERTA, data_fim_vigencia="2026-09-20T09:30"))
    r, lic = _coletar(p, status="em_julgamento")
    assert lic["prioridade"] == "monitorar" and r["prioridade_monitorar"] == 1


def test_detalhe_consultado_uma_vez_por_compra_inclusive_em_dry_run():
    outra = dict(BUSCA_ABERTA, numero_controle_pncp="33781055000135-1-001684/2026", numero_sequencial="1684")
    p = _pncp_coleta(dict(DETALHE_ABERTO, existeResultado=True))
    p.buscar.return_value = {"items": [BUSCA_ABERTA, outra], "total": 2}
    r, lic = _coletar(p, sb=MagicMock(), dry_run=True)
    assert lic is None                                          # dry-run não grava
    assert p.compra.call_count == 2
    assert sorted(c.args[0]["numero_sequencial"] for c in p.compra.call_args_list) == ["1683", "1684"]
    assert r["prioridade_historico"] == 2 and "prioridade_leads" not in r


def test_compra_com_detalhe_o_detalhe_vence_a_busca():
    busca = dict(BUSCA_ABERTA, tem_resultado=False, situacao_nome="Divulgada no PNCP")
    det = {"existeResultado": True, "situacaoCompraNome": "Revogada", "dataEncerramentoProposta": "2026-09-20T00:00",
           "valorTotalHomologado": None, "processo": "1/2026"}
    v = P.compra_com_detalhe(busca, det)
    assert P.motivo_prioridade(v, agora=AGORA) == ("historico", "compra com resultado")
    assert P.motivo_prioridade(dict(v, existeResultado=False), agora=AGORA)[1] == "situação Revogada"
    assert P.prioridade_da_compra(P.compra_com_detalhe(busca, {"dataEncerramentoProposta": "2026-09-20T00:00"}),
                                  agora=AGORA) == "monitorar"
    # resultado visto em qualquer fonte vence: detalhe sem resultado não reabre como lead (fail-closed)
    assert P.prioridade_da_compra(P.compra_com_detalhe(dict(busca, tem_resultado=True),
                                                       {"existeResultado": False}), agora=AGORA) == "historico"
    # campo vazio no detalhe não apaga o da busca; só estado entra na visão; entradas intactas
    assert "processo" not in v and "valorTotalHomologado" not in v
    assert busca["situacao_nome"] == "Divulgada no PNCP" and "existeResultado" not in busca
    assert P.compra_com_detalhe(busca, None) is busca


# --- backfill: detalhe vence e fail-closed ------------------------------------------------------------

def test_backfill_falha_na_consulta_nao_grava_leads():
    ln = dict(_linhas()[1])                                    # #2 monitorar; gravado diz leads
    sb = _SbSomenteLeitura([ln])
    pncp = MagicMock()
    pncp.compra.side_effect = RuntimeError("429 do PNCP")
    r = B.backfill(sb, pncp, aplicar=True, agora=AGORA, consultar_pncp=True)
    assert sb.atualizacoes == [] and r["gravadas"] == 0
    assert r["leads_sem_detalhe"] == 1 and r["falha_consulta"] == 1 and r["transicoes"] == {}


def test_backfill_detalhe_vence_o_gravado():
    ln = dict(_linhas()[1])                                    # gravado: prazo aberto, sem resultado
    sb = _SbSomenteLeitura([ln])
    pncp = MagicMock()
    pncp.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "existeResultado": False,
                                "valorTotalHomologado": 900.0, "dataEncerramentoProposta": "2026-10-13T09:30:00"}
    r = B.backfill(sb, pncp, aplicar=True, agora=AGORA, consultar_pncp=True)
    assert sb.atualizacoes == [("licitacoes_externas", 2, {"prioridade": "historico"})]
    assert "valor homologado" in r["amostra"]["monitorar->historico"][0][2]


def test_backfill_historico_nao_e_rebaixado_sem_o_detalhe():
    """O coletor grava historico pelo detalhe (existeResultado), que não fica nas colunas: sem consulta, não rebaixa."""
    ln = dict(_linhas()[1], prioridade="historico")            # gravado diria leads
    sb = _SbSomenteLeitura([ln])
    r = B.backfill(sb, aplicar=True, agora=AGORA)
    assert sb.atualizacoes == [] and r["historico_mantido_sem_detalhe"] == 1
    # com o detalhe confirmando compra aberta e sem resultado, sai de historico
    pncp = MagicMock()
    pncp.compra.return_value = DETALHE_ABERTO
    r = B.backfill(sb, pncp, aplicar=True, agora=AGORA, consultar_pncp=True)
    assert sb.atualizacoes == [("licitacoes_externas", 2, {"prioridade": "leads"})]
    assert r["historico_mantido_sem_detalhe"] == 0


def test_dispensa_homologada_com_prazo_futuro_nao_e_lead():
    """Dispensa homologada antes do fim do prazo de proposta (caso PM-BA): nunca lead."""
    busca = dict(BUSCA_ABERTA, modalidade_licitacao_nome="Dispensa", tem_resultado=True)
    det = dict(DETALHE_ABERTO, modalidadeNome="Dispensa", existeResultado=False)   # prazo 13/10, futuro
    r, lic = _coletar(_pncp_coleta(det, busca))
    assert lic["prioridade"] == "historico" and "prioridade_leads" not in r

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
    monkeypatch.setenv("SUPABASE_URL", "https://exemplo.invalid")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-teste")
    monkeypatch.setattr(B, "Supabase", lambda url, key: sb)
    monkeypatch.setattr(B, "PNCP", lambda **k: pytest.fail("sem --consultar-pncp não cria cliente PNCP"))
    assert B.main([]) == 0
    assert sb.atualizacoes == []
    assert "leads->historico: 1" in capsys.readouterr().out

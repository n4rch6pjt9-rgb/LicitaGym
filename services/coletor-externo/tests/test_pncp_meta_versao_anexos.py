"""linkSistemaOrigem, anexos inativos (statusAtivo=false -> removido_do_portal_em) e recoleta por dataAtualizacao do PNCP.

Formatos reais conferidos em 02/10/2026 na compra 04873618000117-1-000049/2026 (Viseu/PA):
  detalhe  -> dataAtualizacao "2026-10-01T17:10:57", dataAtualizacaoGlobal "2026-10-01T19:44:16" (sem fuso =
              Brasília), linkSistemaOrigem "https://www.portaldecompraspublicas.com.br/processos/PA/...";
  /arquivos -> statusAtivo true/false por anexo.
"""
from unittest.mock import MagicMock

import pytest

from coletor import pncp as P
from coletor import pncp_cloud_run

from tests.test_pncp import AGORA, ARQUIVOS, COMPRA, _pncp, _sb

LINK = "https://www.portaldecompraspublicas.com.br/processos/PA/Prefeitura-Municipal-de-Viseu-1204/RPE-PE-020-2026-2026-504183"
DET = {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026, "modalidadeNome": "Pregão - Eletrônico",
       "dataAtualizacao": "2026-10-01T17:10:57", "dataAtualizacaoGlobal": "2026-10-01T19:44:16",
       "linkSistemaOrigem": LINK, "objetoCompra": COMPRA["description"], "situacaoCompraNome": "Divulgada no PNCP"}
INATIVO = dict(ARQUIVOS[0], sequencialDocumento=2, statusAtivo=False, titulo="Edital (versão substituída).pdf",
               url="https://pncp.gov.br/pncp-api/v1/orgaos/44892693000140/compras/2026/157/arquivos/2")


def _upserts(sb, tabela):
    return [c.args[1] for c in sb.upsert.call_args_list if c.args[0] == tabela]


def _coletar(p, sb, baixar=False, arm=None):
    return P.coletar(p, sb, arm, ["borracha granulada"], "todos", 1, 50, com_resultados=True,
                     baixar_arquivos=baixar, max_bytes=10**8, dry_run=False, agora=AGORA)


# 1) linkSistemaOrigem -----------------------------------------------------------------------------------------

def test_grava_link_sistema_origem_do_detalhe():
    p, sb = _pncp([COMPRA]), _sb()
    p.compra.return_value = DET
    _coletar(p, sb)
    assert _upserts(sb, "licitacoes_externas")[0]["link_sistema_origem"] == LINK


def test_link_sistema_origem_cai_para_o_item_da_busca():
    p, sb = _pncp([dict(COMPRA, link_sistema_origem=LINK)]), _sb()
    _coletar(p, sb)   # detalhe sem linkSistemaOrigem
    assert _upserts(sb, "licitacoes_externas")[0]["link_sistema_origem"] == LINK


@pytest.mark.parametrize("ruim", [None, "", "javascript:alert(1)", "ftp://x.gov.br/a", "www.sem-esquema.com.br"])
def test_link_ausente_ou_nao_http_nao_vai_no_upsert(ruim):
    p, sb = _pncp([COMPRA]), _sb()
    p.compra.return_value = dict(DET, linkSistemaOrigem=ruim)
    _coletar(p, sb)
    assert "link_sistema_origem" not in _upserts(sb, "licitacoes_externas")[0]   # não apaga link já gravado


# 2) anexos inativos: não grava, marca o que já existia, e o download de pendentes ignora removido -----------

def test_anexo_inativo_nao_e_gravado_nem_baixado(tmp_path):
    """statusAtivo=false não entra no upsert e pncp.baixar não é chamado para ele."""
    from coletor.destino import Armazenamento
    p, sb = _pncp([COMPRA]), _sb()
    sb.selecionar.return_value = []
    p.arquivos.return_value = [ARQUIVOS[0], INATIVO]
    p.baixar.return_value = (b"%PDF-1.7 edital", "application/octet-stream")
    _coletar(p, sb, baixar=True, arm=Armazenamento(pasta_local=tmp_path))
    docs = _upserts(sb, "licitacao_documentos")[0]
    assert [d["arquivo_origem"] for d in docs] == ["pncp-1"]
    assert p.baixar.call_count == 1 and p.baixar.call_args.args[0] == ARQUIVOS[0]["url"]


def test_anexo_ja_gravado_inativo_recebe_removido_do_portal_em():
    """Anexo já gravado que o PNCP passa a devolver com statusAtivo=false ganha removido_do_portal_em."""
    p, sb = _pncp([COMPRA]), _sb()
    p.arquivos.return_value = [ARQUIVOS[0], INATIVO]
    existentes = [{"id": 8, "arquivo_origem": "pncp-2", "removido_do_portal_em": None}]
    sb.selecionar.side_effect = lambda t, **kw: existentes if t == "licitacao_documentos" else []
    r = _coletar(p, sb)
    docs = _upserts(sb, "licitacao_documentos")[0]
    assert [d["arquivo_origem"] for d in docs] == ["pncp-1"]
    marcados = [c for c in sb.atualizar.call_args_list if c.args[0] == "licitacao_documentos"]
    assert len(marcados) == 1 and marcados[0].args[1] == 8
    assert marcados[0].args[2]["removido_do_portal_em"]
    assert r["documentos_removidos_do_portal"] == 1


def test_baixar_pendentes_seleciona_so_removido_do_portal_nulo():
    """O select de pendentes inclui removido_do_portal_em=is.null."""
    sb = MagicMock()
    sb.selecionar.return_value = []
    P.baixar_pendentes(MagicMock(), sb, None, dry_run=True)
    docs = [c for c in sb.selecionar.call_args_list if c.args[0] == "licitacao_documentos"]
    assert len(docs) == 1
    assert docs[0].kwargs["status_processamento"] == "eq.pendente"
    assert docs[0].kwargs["removido_do_portal_em"] == "is.null"


# 3) versão da compra (dataAtualizacao) --------------------------------------------------------------------------

def test_datas_atualizacao_sem_fuso_sao_brasilia():
    assert P.datas_atualizacao(DET) == {"pncp_data_atualizacao": "2026-10-01T17:10:57-03:00",
                                        "pncp_data_atualizacao_global": "2026-10-01T19:44:16-03:00"}
    assert P.datas_atualizacao({"dataAtualizacao": None}) == {} and P.datas_atualizacao(None) == {}


def test_coleta_grava_versao_so_depois_da_lista_de_arquivos():
    p, sb = _pncp([COMPRA]), _sb()
    p.compra.return_value = DET
    _coletar(p, sb)
    nomes = [(c[0], c.args[0]) for c in sb.mock_calls if c[0] in ("upsert", "atualizar")]
    assert nomes[-1] == ("atualizar", "licitacoes_externas")
    assert ("upsert", "licitacao_documentos") in nomes[:-1]
    assert sb.atualizar.call_args.args[1:] == (9, P.datas_atualizacao(DET))
    assert "pncp_data_atualizacao" not in _upserts(sb, "licitacoes_externas")[0]


def test_falha_na_lista_de_arquivos_nao_grava_versao():
    p, sb = _pncp([COMPRA]), _sb()
    p.compra.return_value = DET
    p.arquivos.side_effect = RuntimeError("503 do PNCP")
    r = P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=AGORA, pausa_segunda_passada=0)
    assert r["erros"] == 1
    assert not any(c.args[0] == "licitacoes_externas" for c in sb.atualizar.call_args_list)


@pytest.mark.parametrize("guardado,esperado", [
    ({"pncp_data_atualizacao": "2026-10-01T20:10:57+00:00", "pncp_data_atualizacao_global": "2026-10-01T22:44:16+00:00"},
     None),   # mesmo instante em UTC (como o PostgREST devolve)
    ({"pncp_data_atualizacao": "2026-10-01T20:10:57+00:00", "pncp_data_atualizacao_global": "2026-10-01T20:10:57+00:00"},
     "dataAtualizacaoGlobal mudou"),
    ({"pncp_data_atualizacao": "2026-09-30T10:00:00+00:00", "pncp_data_atualizacao_global": "2026-10-01T22:44:16+00:00"},
     "dataAtualizacao mudou"),
    ({"pncp_data_atualizacao": None, "pncp_data_atualizacao_global": None}, "sem valor guardado"),
    ({}, "sem valor guardado"),
])
def test_mudou_no_pncp(guardado, esperado):
    assert P.mudou_no_pncp(guardado, DET) == esperado


def test_mudou_no_pncp_sem_data_no_detalhe_nao_decide():
    assert P.mudou_no_pncp({}, {"processo": "1"}) is None


RAW = dict(COMPRA, situacao_nome="Divulgada no PNCP", data_atualizacao_pncp="2026-09-20T10:00:00")


def _linha(id_, seq, guardado_atual, guardado_global):
    codigo = f"44892693000140-1-{seq:06d}/2026"
    return {"id": id_, "codigo_externo": codigo, "pncp_data_atualizacao": guardado_atual,
            "pncp_data_atualizacao_global": guardado_global,
            "raw": dict(RAW, numero_controle_pncp=codigo, numero_sequencial=seq)}


class _SbRecoleta:
    def __init__(self, linhas, prioridades):
        self.linhas, self.prioridades = linhas, prioridades
        self.upserts, self.atualizacoes, self.filtros = [], [], {}

    def selecionar(self, tabela, **kw):
        self.filtros[tabela] = kw
        if tabela == "licitacoes_externas_prioridade_efetiva":
            return [{"id": i, "prioridade": p} for i, p in self.prioridades.items()]
        if tabela == "licitacao_documentos":
            return []
        return self.linhas

    def upsert(self, tabela, linhas, conflito):
        self.upserts.append((tabela, linhas))
        if tabela == "licitacoes_externas":
            return [{"id": 9}]
        if tabela == "licitacao_documentos":
            return [{"id": 1, "status_processamento": "pendente", **x} for x in linhas]
        return linhas

    def atualizar(self, tabela, id_, campos):
        self.atualizacoes.append((tabela, id_, campos))


def _cenario():
    igual = ("2026-10-01T20:10:57+00:00", "2026-10-01T22:44:16+00:00")
    linhas = [_linha(1, 157, *igual),                       # leads, sem mudança
              _linha(2, 158, "2026-10-01T20:10:57+00:00", "2026-09-30T12:00:00+00:00"),   # monitorar, mudou
              _linha(3, 159, None, None),                    # monitorar, nunca coletada com versão
              _linha(4, 160, None, None)]                    # historico: fora do padrão leads,monitorar
    sb = _SbRecoleta(linhas, {1: "leads", 2: "monitorar", 3: "monitorar", 4: "historico"})
    p = _pncp([])
    p.compra.return_value = DET
    return sb, p


def test_recoletar_atualizadas_so_recoleta_o_que_mudou():
    sb, p = _cenario()
    r = P.recoletar_atualizadas(p, sb, agora=AGORA)
    assert (r["lidas"], r["consultadas"], r["sem_mudanca"], r["mudaram"], r["recoletadas"]) == (3, 3, 1, 2, 2)
    assert r["motivos"] == {"dataAtualizacaoGlobal mudou": 1, "sem valor guardado": 1}
    assert [c.args[0]["numero_sequencial"] for c in p.itens.call_args_list] == [158, 159]
    assert p.compra.call_count == 3          # um detalhe por compra lida; _processar reaproveita
    assert p.arquivos.call_count == 2 and p.baixar.call_count == 0   # nunca baixa
    lics = [ln for t, ln in sb.upserts if t == "licitacoes_externas"]
    assert all("termos_busca" not in ln for ln in lics)               # mantém os termos do banco
    assert all(ln["link_sistema_origem"] == LINK for ln in lics)
    versoes = [(t, c) for t, _, c in sb.atualizacoes if t == "licitacoes_externas"]
    assert versoes == [("licitacoes_externas", P.datas_atualizacao(DET))] * 2
    assert sb.filtros["licitacoes_externas"]["categoria_escopo"] == "not.is.null"


def test_recoleta_usa_o_detalhe_atualizado_na_linha():
    sb, p = _cenario()
    p.compra.return_value = dict(DET, situacaoCompraNome="Suspensa", objetoCompra=COMPRA["description"] + " (retificado)")
    P.recoletar_atualizadas(p, sb, agora=AGORA)
    ln = next(ln for t, ln in sb.upserts if t == "licitacoes_externas")
    assert ln["situacao"] == "Suspensa" and ln["objeto"].endswith("(retificado)")
    assert ln["raw"]["data_atualizacao_pncp"] == DET["dataAtualizacao"]


def test_recoleta_dry_run_limite_e_prioridades():
    sb, p = _cenario()
    r = P.recoletar_atualizadas(p, sb, dry_run=True)
    assert r["mudaram"] == 2 and r["recoletadas"] == 0 and not sb.upserts and not sb.atualizacoes
    sb, p = _cenario()
    r = P.recoletar_atualizadas(p, sb, limite=1, agora=AGORA)
    assert r["recoletadas"] == 1 and p.itens.call_count == 1
    sb, p = _cenario()
    r = P.recoletar_atualizadas(p, sb, prioridades="historico", agora=AGORA)
    assert (r["lidas"], r["recoletadas"]) == (1, 1)


def test_recoleta_falha_de_detalhe_ou_de_itens_nao_grava_versao():
    sb, p = _cenario()
    p.compra.side_effect = RuntimeError("timeout")
    r = P.recoletar_atualizadas(p, sb)
    assert r["falha_detalhe"] == 3 and not sb.upserts
    sb, p = _cenario()
    p.itens.side_effect = RuntimeError("503 do PNCP")
    r = P.recoletar_atualizadas(p, sb, agora=AGORA)
    assert r["erros"] == 2 and r["recoletadas"] == 0 and not sb.atualizacoes


def test_cli_recoletar_atualizadas(monkeypatch):
    chamado = {}
    monkeypatch.setenv("SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "k")
    monkeypatch.setattr(P, "recoletar_atualizadas", lambda pncp, sb, arm, **kw: chamado.update(kw) or {})
    monkeypatch.setattr(P, "drenar_licitacao_match", lambda sb: None)
    assert P.main(["--recoletar-atualizadas", "--dry-run", "--limite-recoleta", "5"]) == 0
    assert chamado["prioridades"] == "leads,monitorar" and chamado["dry_run"] and chamado["limite"] == 5


def test_cloud_run_recusa_recoleta_com_varias_tasks(monkeypatch):
    monkeypatch.setattr(P, "main", lambda a: 0)
    monkeypatch.setenv("CLOUD_RUN_TASK_INDEX", "0")
    monkeypatch.setenv("CLOUD_RUN_TASK_COUNT", "3")
    with pytest.raises(SystemExit, match="não divide em lotes"):
        pncp_cloud_run.main(["--recoletar-atualizadas"])

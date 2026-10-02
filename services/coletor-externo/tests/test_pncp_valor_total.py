"""valor_total das compras PNCP: vem do detalhe (valorTotalEstimado), não de valor_global da busca
(vazio em editais). Offline: HTTP e Supabase mockados."""
from unittest.mock import MagicMock

import pytest

from coletor import backfill_valor_total_pncp as B
from coletor import pncp as P
from test_pncp import COMPRA, _pncp, _resp, _sb

DETALHE = {"processo": "3789/2026", "numeroCompra": "41", "anoCompra": 2026,
           "modalidadeNome": "Pregão - Eletrônico", "valorTotalEstimado": 5571821.29}
EDITAL_SEM_VALOR = dict(COMPRA, valor_global=None)


def _lic(sb):
    return next(c.args[1] for c in sb.upsert.call_args_list if c.args[0] == "licitacoes_externas")


def _coletar(p, sb):
    return P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False)


# --- identificacao ---------------------------------------------------------------------------

def test_identificacao_extrai_valor_total_estimado_via_http(monkeypatch):
    """Resposta HTTP real do detalhe (/api/consulta/v1) -> valor_total."""
    cli = P.PNCP(delay=0, tentativas=1)
    monkeypatch.setattr(P.time, "sleep", lambda s: None)
    sess = MagicMock()
    sess.get.side_effect = [_resp(200, dict(DETALHE, valorTotalEstimado="5571821.29"))]
    cli._local.s = sess
    ident = P.identificacao(cli, COMPRA)
    assert ident["valor_total"] == 5571821.29 and ident["numero_processo"] == "3789/2026"
    assert "/api/consulta/v1/" in sess.get.call_args.args[0]


@pytest.mark.parametrize("det", [
    {k: v for k, v in DETALHE.items() if k != "valorTotalEstimado"},
    dict(DETALHE, valorTotalEstimado=None),
    dict(DETALHE, valorTotalEstimado=0),            # orçamento sigiloso
    dict(DETALHE, valorTotalEstimado="n/d"),
])
def test_identificacao_sem_estimado_omite_a_chave(det):
    p = _pncp([COMPRA]); p.compra.return_value = det
    assert "valor_total" not in P.identificacao(p, COMPRA)


def test_homologado_nao_e_fallback_do_estimado():
    """Decisão: valorTotalHomologado é outra grandeza (valor adjudicado); não vira valor_total."""
    p = _pncp([COMPRA])
    p.compra.return_value = dict({k: v for k, v in DETALHE.items() if k != "valorTotalEstimado"},
                                 valorTotalHomologado=4000000.0)
    assert "valor_total" not in P.identificacao(p, COMPRA)


# --- linha gravada em licitacoes_externas ----------------------------------------------------

def test_coleta_usa_valor_total_estimado_do_detalhe():
    sb, p = _sb(), _pncp([EDITAL_SEM_VALOR]); p.compra.return_value = DETALHE
    _coletar(p, sb)
    assert _lic(sb)["valor_total"] == 5571821.29
    assert p.compra.call_count == 1     # o mesmo detalhe serve identificação, valor e prioridade


def test_detalhe_tem_prioridade_sobre_valor_global():
    sb, p = _sb(), _pncp([COMPRA]); p.compra.return_value = DETALHE     # COMPRA.valor_global = 300000
    _coletar(p, sb)
    assert _lic(sb)["valor_total"] == 5571821.29


def test_detalhe_sem_estimado_cai_para_valor_global():
    sb, p = _sb(), _pncp([COMPRA])                                       # detalhe padrão sem valor
    _coletar(p, sb)
    assert _lic(sb)["valor_total"] == 300000.0


def test_detalhe_falho_cai_para_valor_global():
    sb, p = _sb(), _pncp([COMPRA]); p.compra.side_effect = RuntimeError("timeout")
    _coletar(p, sb)
    assert _lic(sb)["valor_total"] == 300000.0


@pytest.mark.parametrize("valor_global", [None, 0, ""])
def test_sem_valor_nenhum_a_chave_fica_fora_do_upsert(valor_global):
    sb, p = _sb(), _pncp([dict(COMPRA, valor_global=valor_global)])
    _coletar(p, sb)
    assert "valor_total" not in _lic(sb)


def test_recoleta_sem_valor_nao_apaga_valor_ja_gravado():
    """Upsert merge-duplicates: coluna ausente no payload preserva o valor do banco."""
    from test_pncp import _FakeSbIdempotente
    sb = _FakeSbIdempotente()
    p = _pncp([EDITAL_SEM_VALOR]); p.compra.return_value = DETALHE
    _coletar(p, sb)
    p.compra.return_value = {k: v for k, v in DETALHE.items() if k != "valorTotalEstimado"}
    _coletar(p, sb)
    (linha,) = sb.tabelas["licitacoes_externas"].values()
    assert linha["valor_total"] == 5571821.29


def test_corrigir_processos_grava_valor_total_so_quando_existe():
    from test_pncp import _FakeSbCorrigir
    sb = _FakeSbCorrigir([{"id": 1, "codigo_externo": "44892693000140-1-000157/2026"},
                          {"id": 2, "codigo_externo": "44892693000140-1-000158/2026"}])
    p = MagicMock()
    p.compra.side_effect = lambda c: DETALHE if c["numero_sequencial"] == 157 else {"numeroCompra": "42"}
    P.corrigir_processos(p, sb)
    assert sb.atualizacoes[0][1]["valor_total"] == 5571821.29
    assert "valor_total" not in sb.atualizacoes[1][1]


def test_compra_de_codigo():
    assert P.compra_de_codigo("44892693000140-1-000157/2026") == {
        "orgao_cnpj": "44892693000140", "numero_sequencial": 157, "ano": 2026,
        "numero_controle_pncp": "44892693000140-1-000157/2026"}
    assert P.compra_de_codigo("sestsenat-32/18") is None and P.compra_de_codigo(None) is None


# --- backfill --------------------------------------------------------------------------------

class _FakeSbBackfill:
    def __init__(self, linhas):
        self.linhas, self.filtros, self.atualizacoes = linhas, None, []

    def selecionar(self, tabela, **kw):
        assert tabela == "licitacoes_externas"
        self.filtros = kw
        return self.linhas[: int(kw["limit"])] if "limit" in kw else self.linhas

    def atualizar(self, tabela, id_, campos):
        self.atualizacoes.append((tabela, id_, campos))


LINHAS = [{"id": 1, "codigo_externo": "44892693000140-1-000157/2026"},   # detalhe com valor
          {"id": 2, "codigo_externo": "44892693000140-1-000158/2026"},   # detalhe sem valor
          {"id": 3, "codigo_externo": "44892693000140-1-000159/2026"},   # consulta falha
          {"id": 4, "codigo_externo": "codigo-fora-do-padrao"}]


def _pncp_backfill():
    p = MagicMock()
    respostas = {157: DETALHE, 158: {"numeroCompra": "42", "valorTotalEstimado": None},
                 159: RuntimeError("429 do PNCP")}

    def compra(c):
        v = respostas[c["numero_sequencial"]]
        if isinstance(v, Exception):
            raise v
        return v
    p.compra.side_effect = compra
    return p


def test_backfill_seleciona_so_pncp_sem_valor():
    sb = _FakeSbBackfill(LINHAS)
    B.backfill(_pncp_backfill(), sb)
    assert sb.filtros["fonte"] == "eq.pncp" and sb.filtros["valor_total"] == "is.null"
    assert "limit" not in sb.filtros


def test_backfill_padrao_e_dry_run_nao_grava():
    sb = _FakeSbBackfill(LINHAS)
    r = B.backfill(_pncp_backfill(), sb)
    assert sb.atualizacoes == []
    assert (r["lidas"], r["com_valor"], r["gravadas"], r["sem_valor"], r["falha_consulta"],
            r["codigo_invalido"]) == (4, 1, 0, 1, 1, 1)
    assert r["amostra"] == [(1, "44892693000140-1-000157/2026", 5571821.29)]


def test_backfill_apply_grava_so_valor_total_quando_encontrado():
    sb = _FakeSbBackfill(LINHAS)
    r = B.backfill(_pncp_backfill(), sb, aplicar=True)
    assert sb.atualizacoes == [("licitacoes_externas", 1, {"valor_total": 5571821.29})]
    assert r["gravadas"] == 1


def test_backfill_limit():
    sb = _FakeSbBackfill(LINHAS)
    p = _pncp_backfill()
    r = B.backfill(p, sb, limite=2)
    assert sb.filtros["limit"] == "2" and r["lidas"] == 2 and p.compra.call_count == 2


def test_backfill_main_sem_apply_nao_grava(monkeypatch):
    sb = _FakeSbBackfill(LINHAS)
    monkeypatch.setattr(B, "Supabase", lambda *a, **kw: sb)
    monkeypatch.setattr(B, "PNCP", lambda **kw: _pncp_backfill())
    monkeypatch.setattr(B, "env", lambda *a, **kw: "0")
    assert B.main(["--limit", "3"]) == 0 and sb.atualizacoes == []
    assert B.main(["--apply"]) == 0
    assert sb.atualizacoes == [("licitacoes_externas", 1, {"valor_total": 5571821.29})]


def test_backfill_exige_credenciais_do_ambiente(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(SystemExit):
        B.main([])

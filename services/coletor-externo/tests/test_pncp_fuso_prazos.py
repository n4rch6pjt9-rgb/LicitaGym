"""#332: prazo e publicação do PNCP sem fuso estão no horário de Brasília (_data_pncp)."""
from datetime import datetime
from unittest.mock import MagicMock

from coletor import backfill_fuso_prazos_pncp as B
from coletor.pncp import _data, _data_pncp, _instante


def test_data_pncp_sem_fuso_fica_em_brasilia():
    # Caso real (licitação 185, SSP/SP): o PNCP manda "2026-10-08T10:00" e o prazo é 10:00 de Brasília (13:00 UTC).
    assert _data_pncp("2026-10-08T10:00") == "2026-10-08T10:00:00-03:00"
    assert datetime.fromisoformat(_data_pncp("2026-10-08T10:00")) == _instante("2026-10-08T10:00")


def test_data_pncp_com_fuso_explicito_nao_muda():
    assert _data_pncp("2026-10-08T13:00:00Z") == "2026-10-08T13:00:00+00:00"
    assert _data_pncp("2026-10-08T13:00:00+00:00") == "2026-10-08T13:00:00+00:00"
    assert _data_pncp("2026-10-08T10:00:00-03:00") == "2026-10-08T10:00:00-03:00"


def test_data_pncp_vazia_ou_invalida():
    assert _data_pncp(None) is None
    assert _data_pncp("") is None
    assert _data_pncp("não é data") is None


def test_data_legado_continua_rotulando_utc():
    # data_documento/data_resultado/data_homologacao seguem no formato antigo, que o reclassificador lê cortando o
    # fuso (reclassificar_escopo_pncp.carregar_documentos). Mudar isto exige migrar as linhas antigas (issue própria).
    assert _data("2026-09-14T10:00") == "2026-09-14T10:00:00+00:00"


def test_linha_da_compra_usa_o_fuso_do_pncp_no_prazo_e_na_publicacao():
    # _processar monta a linha de licitacoes_externas; prazo e publicação não podem voltar a usar o _data legado.
    import inspect
    from coletor import pncp as P
    fonte = inspect.getsource(P._processar)
    assert '"data_fim": _data_pncp(' in fonte and '"data_publicacao": _data_pncp(' in fonte


def _sb(linhas):
    sb = MagicMock()
    sb.selecionar.return_value = linhas
    return sb


GRAVADA_COMO_UTC = {
    "id": 185, "codigo_externo": "46377800000127-1-003879/2026", "normalizacoes": None,
    "data_fim": "2026-10-08T10:00:00+00:00", "data_publicacao": "2026-09-14T10:54:48+00:00",
    "raw": {"data_fim_vigencia": "2026-10-08T10:00", "data_publicacao_pncp": "2026-09-14T10:54:48"},
}


def test_backfill_dry_run_conta_e_nao_grava():
    sb = _sb([GRAVADA_COMO_UTC])
    r = B.backfill(sb)
    assert r["lidas"] == 1 and r["corrigir"] == 1 and r["gravadas"] == 0
    sb.atualizar.assert_not_called()
    assert r["amostra"][0][2] == {
        "data_fim": ("2026-10-08T10:00:00+00:00", "2026-10-08T10:00:00-03:00"),
        "data_publicacao": ("2026-09-14T10:54:48+00:00", "2026-09-14T10:54:48-03:00")}


def test_backfill_apply_grava_so_as_colunas_de_prazo():
    sb = _sb([GRAVADA_COMO_UTC])
    r = B.backfill(sb, aplicar=True)
    assert r["gravadas"] == 1
    sb.atualizar.assert_called_once_with("licitacoes_externas", 185, {
        "data_fim": "2026-10-08T10:00:00-03:00", "data_publicacao": "2026-09-14T10:54:48-03:00"})


def test_backfill_ja_correta_nao_regrava():
    # Mesmo instante em outra representação (13:00 UTC == 10:00 -03) não é mudança.
    ln = {**GRAVADA_COMO_UTC, "data_fim": "2026-10-08T13:00:00+00:00", "data_publicacao": "2026-09-14T13:54:48+00:00"}
    r = B.backfill(_sb([ln]), aplicar=True)
    assert r["corrigir"] == 0 and r["gravadas"] == 0 and r["ja_corretas"] == 1


def test_backfill_respeita_prazo_normalizado():
    # data_fim normalizado (normalizacao_prazo, já calculado com o fuso do PNCP) não é tocado; publicação é.
    ln = {**GRAVADA_COMO_UTC, "normalizacoes": {"data_fim": {"normalizado": "2026-10-08T10:00:00-03:00"}},
          "data_fim": "2026-10-08T10:00:00-03:00"}
    sb = _sb([ln])
    B.backfill(sb, aplicar=True)
    sb.atualizar.assert_called_once_with("licitacoes_externas", 185,
                                         {"data_publicacao": "2026-09-14T10:54:48-03:00"})


def test_backfill_sem_raw_ou_com_fuso_no_raw_nao_inventa():
    sem_raw = {**GRAVADA_COMO_UTC, "id": 1, "raw": None}
    com_fuso = {**GRAVADA_COMO_UTC, "id": 2, "raw": {"data_fim_vigencia": "2026-10-08T10:00:00+00:00",
                                                    "data_publicacao_pncp": "2026-09-14T10:54:48Z"}}
    sb = _sb([sem_raw, com_fuso])
    r = B.backfill(sb, aplicar=True)
    assert r["sem_raw"] == 1 and r["gravadas"] == 0
    sb.atualizar.assert_not_called()


def test_backfill_le_so_pncp_paginado():
    sb = _sb([])
    B.backfill(sb, limite=5)
    tabela = sb.selecionar.call_args.args[0]
    kw = sb.selecionar.call_args.kwargs
    assert tabela == "licitacoes_externas" and kw["fonte"] == "eq.pncp" and kw["limit"] == "5"
    assert "raw" in kw["select"] and "normalizacoes" in kw["select"]


# --- #333: data_inicio (abertura das propostas) ---

def test_abertura_vem_do_detalhe_e_senao_da_busca():
    from coletor import pncp as P
    c = {"data_inicio_vigencia": "2026-09-23T12:30"}
    assert P.abertura_das_propostas(c, None) == "2026-09-23T12:30:00-03:00"
    assert P.abertura_das_propostas(c, {"dataAberturaProposta": "2026-09-24T08:00:00"}) == "2026-09-24T08:00:00-03:00"
    assert P.abertura_das_propostas({}, {}) is None


def test_linha_da_compra_grava_data_inicio_sem_apagar_quando_falta():
    import inspect
    from coletor import pncp as P
    fonte = inspect.getsource(P._processar)
    assert "abertura_das_propostas(" in fonte and 'linha["data_inicio"]' in fonte


def test_backfill_preenche_data_inicio_vazia():
    ln = {**GRAVADA_COMO_UTC, "data_fim": "2026-10-08T10:00:00-03:00", "data_publicacao": "2026-09-14T10:54:48-03:00",
          "data_inicio": None, "raw": {**GRAVADA_COMO_UTC["raw"], "data_inicio_vigencia": "2026-09-23T12:30"}}
    sb = _sb([ln])
    B.backfill(sb, aplicar=True)
    sb.atualizar.assert_called_once_with("licitacoes_externas", 185, {"data_inicio": "2026-09-23T12:30:00-03:00"})
    assert "data_inicio" in sb.selecionar.call_args.kwargs["select"]

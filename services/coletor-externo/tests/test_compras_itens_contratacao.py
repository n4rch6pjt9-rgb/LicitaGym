"""Spec 0031, fase A: estimado × homologado e link da compra (coletor.compras_itens_contratacao).

CA-1 a CA-5. Nenhum teste chama a API real: a sessão HTTP é falsa e responde por URL com as respostas gravadas em
21/10/2026 (tests/fixtures/compras_itens_contratacao_*.json e pncp_compra_*.json); qualquer outra URL é erro de teste.
O banco é um Supabase falso em memória.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from coletor import compras_itens_contratacao as C
from coletor import main as M

FIX = Path(__file__).parent / "fixtures"
URL_ITENS = C.BASE_COMPRAS + C.ENDPOINT_ITENS
COMPRA_ESTEIRA = "93099205000052026"  # caso de referência 1 (item 11)
COMPRA_BELEM = "16021805900022026"    # caso de referência 2 (item 66)


def _fixture(nome: str) -> dict:
    return json.loads((FIX / nome).read_text(encoding="utf-8"))


def _resp(status: int, corpo=None, headers: dict | None = None, json_invalido: bool = False):
    r = MagicMock()
    r.status_code = status
    r.headers = headers or {}
    r.text = ""
    if json_invalido:
        r.json.side_effect = ValueError("Expecting value")
    else:
        r.json.return_value = corpo
    return r


class SessaoFalsa:
    def __init__(self, itens: dict[str, object] | None = None, pncp: dict[str, object] | None = None):
        self.headers: dict = {}
        self.chamadas: list[tuple[str, dict]] = []
        self.itens = itens or {}
        self.pncp = pncp or {}

    def get(self, url, params=None, timeout=None):
        assert timeout, "toda requisição tem timeout explícito"
        self.chamadas.append((url, dict(params or {})))
        if url == URL_ITENS:
            assert params["tipo"] == "idCompra"
            r = self.itens[params["codigo"]]
            return r if isinstance(r, MagicMock) else r()
        if url.startswith(C.BASE_PNCP + "/orgaos/"):
            r = self.pncp[url[len(C.BASE_PNCP):]]
            return r if isinstance(r, MagicMock) else r()
        raise AssertionError(f"URL inesperada no teste: {url}")


class SupabaseFalso:
    def __init__(self, pendentes=None, falhar_em: str | None = None):
        self.tabelas: dict[str, dict[tuple, dict]] = {}
        self.pendentes = pendentes or []
        self.rpcs: list[tuple[str, dict]] = []
        self.falhar_em = falhar_em

    def rpc(self, funcao, params):
        self.rpcs.append((funcao, params))
        return self.pendentes

    def upsert(self, tabela, linhas, conflito):
        if self.falhar_em == tabela:
            raise RuntimeError("Supabase upsert: 500")
        linhas = linhas if isinstance(linhas, list) else [linhas]
        chaves = conflito.split(",")
        t = self.tabelas.setdefault(tabela, {})
        for ln in linhas:
            t[tuple(ln[k] for k in chaves)] = ln
        return linhas


def _cliente(sessao: SessaoFalsa) -> C.ClienteContratacoes:
    c = C.ClienteContratacoes(sessao=sessao)
    c.delay = 0  # sem espera no teste (o mínimo de 1 s vale no construtor)
    return c


def _sessao_padrao() -> SessaoFalsa:
    return SessaoFalsa(
        itens={
            COMPRA_ESTEIRA: _resp(200, _fixture("compras_itens_contratacao_93099205000052026.json")),
            COMPRA_BELEM: _resp(200, _fixture("compras_itens_contratacao_16021805900022026.json")),
        },
        pncp={
            "/orgaos/44678797000156/compras/2026/4": _resp(200, {"linkSistemaOrigem": None}),
            "/orgaos/00394452000103/compras/2026/10524": _resp(200, _fixture("pncp_compra_00394452000103_2026_10524.json")),
        },
    )


# CA-1 --------------------------------------------------------------------------------------------------------------

def test_ca1_esteira_item11_homologado_e_descarta_em_andamento():
    compra, itens = C.consultar_compra(_cliente(_sessao_padrao()), COMPRA_ESTEIRA, "2026-01-10T10:00:00")
    por_item = {i["numero_item_compra"]: i for i in itens}
    it11 = por_item[11]
    assert it11["valor_unitario_estimado"] == 80800.0
    assert it11["valor_unitario_resultado"] == 52000.0
    assert it11["situacao_item"] == "Homologado"
    assert it11["numero_controle_pncp"] == "44678797000156-1-000004/2026"
    # uma linha por item: a "Em andamento" (estimado 0) foi descartada
    assert len(itens) == len({i["numero_item_compra"] for i in itens}) == 11
    assert compra["encontrada"] is True
    assert (compra["orgao_entidade_cnpj"], compra["ano_compra_pncp"], compra["sequencial_compra_pncp"]) == (
        "44678797000156", 2026, 4)
    # sigilo não é gravado em coluna (decisão de 21/10: não existe depois de homologado); fica só no raw
    assert "orcamento_sigiloso" not in it11


# CA-2 --------------------------------------------------------------------------------------------------------------

def test_ca2_belem_item66_estimado_resultado_e_link_do_pncp():
    compra, itens = C.consultar_compra(_cliente(_sessao_padrao()), COMPRA_BELEM, "2026-08-06T01:10:04")
    it66 = {i["numero_item_compra"]: i for i in itens}[66]
    assert it66["valor_unitario_estimado"] == 3156.67
    assert it66["valor_unitario_resultado"] == 2229.0
    assert it66["situacao_item"] == "Homologado"
    assert compra["link_sistema_origem"] == (
        "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra"
        "&compra=16021805900022026")
    assert compra["data_hora_atualizacao_compra"] == "2026-08-06T01:10:04"


# CA-3 --------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("valor", [0, 0.0, None, "", -5, "abc", True])
def test_ca3_estimado_zero_ou_ausente_vira_null(valor):
    item = C.normalizar_item(COMPRA_BELEM, {"numeroItemCompra": 1, "valorUnitarioEstimado": valor,
                                            "valorUnitarioResultado": valor})
    assert item["valor_unitario_estimado"] is None
    assert item["valor_unitario_resultado"] is None


def test_ca3_item_sem_resultado_fica_com_a_linha_mais_nova():
    linhas = C.escolher_linhas([
        {"numeroItemCompra": 4, "situacaoCompraItemNome": "Em andamento", "dataAtualizacaoPncp": "2026-01-01"},
        {"numeroItemCompra": 4, "situacaoCompraItemNome": "Fracassado", "dataAtualizacaoPncp": "2026-02-01"},
    ])
    assert linhas[4]["situacaoCompraItemNome"] == "Fracassado"


def test_ca3_empate_de_resultado_fica_a_mais_nova():
    linhas = C.escolher_linhas([
        {"numeroItemCompra": 1, "temResultado": True, "valorUnitarioEstimado": 10, "dataAtualizacaoPncp": "2026-03-01"},
        {"numeroItemCompra": 1, "temResultado": True, "valorUnitarioEstimado": 20, "dataAtualizacaoPncp": "2026-04-01"},
        {"numeroItemCompra": 1, "temResultado": None, "valorUnitarioEstimado": 99, "dataAtualizacaoPncp": "2026-05-01"},
    ])
    assert linhas[1]["valorUnitarioEstimado"] == 20


# CA-4 --------------------------------------------------------------------------------------------------------------

def test_ca4_recorte_de_24_meses_vai_para_a_consulta_de_pendentes():
    sb = SupabaseFalso(pendentes=[])
    res = C.coletar(_cliente(SessaoFalsa()), sb, hoje=lambda: date(2026, 10, 21))
    assert sb.rpcs == [("precos_compras_pendentes_contratacao", {"p_desde": "2024-10-22", "p_limite": C.LIMITE_PADRAO})]
    assert res["desde"] == "2024-10-22" and res["sucesso"] is True and res["compras"] == 0


@pytest.mark.parametrize("hoje,esperado", [
    (date(2026, 10, 21), date(2024, 10, 22)),
    (date(2026, 2, 28), date(2024, 2, 29)),   # 28/02/2024 + 1 dia (2024 é bissexto)
    (date(2026, 3, 31), date(2024, 4, 1)),    # 31/03/2024 + 1 dia
    (date(2028, 2, 29), date(2026, 3, 1)),    # 29/02 -> 28/02/2026 + 1 dia (mesma regra da api-precos)
])
def test_ca4_inicio_do_recorte_igual_ao_da_api_precos(hoje, esperado):
    assert C.desde_recorte(hoje) == esperado


def test_ca4_grava_compras_pendentes_e_nao_encontrada():
    sessao = _sessao_padrao()
    sessao.itens["15200506000012021"] = _resp(200, {"resultado": [], "totalRegistros": 0, "totalPaginas": 0,
                                                     "paginasRestantes": 0})
    sb = SupabaseFalso()
    pend = [{"id_compra": COMPRA_BELEM, "data_hora_atualizacao_compra": "2026-08-06T01:10:04"},
            {"id_compra": "15200506000012021", "data_hora_atualizacao_compra": None}]
    res = C.coletar(_cliente(sessao), sb, pendentes=pend)
    assert res["sucesso"] is True
    assert (res["encontradas"], res["nao_encontradas"], res["com_link"]) == (1, 1, 1)
    compras = sb.tabelas["precos_compras_contratacao"]
    assert compras[(COMPRA_BELEM,)]["encontrada"] is True
    assert compras[("15200506000012021",)]["encontrada"] is False
    assert (COMPRA_BELEM, 66) in sb.tabelas["precos_itens_contratacao"]
    # a compra não encontrada não chama o PNCP
    assert not any("/compras/2021/" in u for u, _ in sessao.chamadas)


# CA-5 --------------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("resposta", [
    _resp(500, None),
    _resp(404, None),
    _resp(200, None, json_invalido=True),
    _resp(200, {"sem": "resultado"}),
    _resp(200, {"resultado": [{"numeroItemCompra": 1}], "paginasRestantes": 2}),
])
def test_ca5_erro_da_api_conta_falha_e_nao_grava(resposta):
    sessao = _sessao_padrao()
    sessao.itens["99999999999999999"] = resposta
    sb = SupabaseFalso()
    pend = [{"id_compra": "99999999999999999"}, {"id_compra": COMPRA_BELEM}]
    res = C.coletar(_cliente(sessao), sb, pendentes=pend)
    assert res["falhas"] == 1 and res["sucesso"] is False
    assert ("99999999999999999",) not in sb.tabelas.get("precos_compras_contratacao", {})
    # a outra compra segue
    assert (COMPRA_BELEM,) in sb.tabelas["precos_compras_contratacao"]


def test_ca5_erro_no_pncp_nao_marca_a_compra():
    sessao = _sessao_padrao()
    sessao.pncp["/orgaos/00394452000103/compras/2026/10524"] = _resp(404, None)
    sb = SupabaseFalso()
    res = C.coletar(_cliente(sessao), sb, pendentes=[{"id_compra": COMPRA_BELEM}])
    assert res["falhas"] == 1 and not sb.tabelas


def test_ca5_falha_na_gravacao_dos_itens_nao_marca_a_compra():
    sb = SupabaseFalso(falhar_em="precos_itens_contratacao")
    res = C.coletar(_cliente(_sessao_padrao()), sb, pendentes=[{"id_compra": COMPRA_BELEM}])
    assert res["falhas"] == 1 and res["sucesso"] is False
    assert "precos_compras_contratacao" not in sb.tabelas


def test_ca5_429_respeita_retry_e_depois_responde(monkeypatch):
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    respostas = iter([_resp(429, None, headers={"Retry-After": "1"}),
                      _resp(200, _fixture("compras_itens_contratacao_16021805900022026.json"))])
    sessao = _sessao_padrao()
    sessao.itens[COMPRA_BELEM] = lambda: next(respostas)
    res = C.coletar(_cliente(sessao), SupabaseFalso(), pendentes=[{"id_compra": COMPRA_BELEM}])
    assert res["sucesso"] is True


def test_ca5_id_compra_invalido_e_falha_sem_chamar_api():
    sessao = _sessao_padrao()
    res = C.coletar(_cliente(sessao), SupabaseFalso(), pendentes=[{"id_compra": "ZZTESTE"}])
    assert res["falhas"] == 1 and sessao.chamadas == []


def test_ca5_main_sai_com_codigo_1_quando_o_enriquecimento_falha(monkeypatch):
    """O Job (coletor.main --coleta precos) fica com código 1 se o estimado/link falhar."""
    monkeypatch.setattr(M.compras_precos, "coletar", lambda cliente, sb, dry_run=False: {"sucesso": True})
    monkeypatch.setattr(M.compras_precos, "completar_detalhes", lambda cliente, sb: {"sucesso": True})
    monkeypatch.setattr(M.compras_itens_contratacao, "coletar",
                        lambda cliente, sb, limite=0: {"sucesso": False, "falhas": 1, "erros": ["x"]})
    assert M.coletar_precos(object(), dry_run=False, delay=1.0) is False
    monkeypatch.setattr(M.compras_itens_contratacao, "coletar",
                        lambda cliente, sb, limite=0: {"sucesso": True, "erros": []})
    assert M.coletar_precos(object(), dry_run=False, delay=1.0) is True


def test_numero_controle_fora_do_formato_e_ausente():
    assert C.partes_numero_controle("00394452000103-1-010524/2026") == ("00394452000103", 2026, 10524)
    assert C.partes_numero_controle("00394452000103-1-010524") is None
    assert C.partes_numero_controle(None) is None


def test_link_do_pncp_so_https():
    assert C._link_https("http://inseguro") is None
    assert C._link_https("  ") is None


def test_data_atualizacao_pncp_sem_fuso_e_horario_de_brasilia():
    item = C.normalizar_item(COMPRA_BELEM, {"numeroItemCompra": 1, "dataAtualizacaoPncp": "2026-07-09T10:36:04"})
    assert item["data_atualizacao_pncp"] == "2026-07-09T10:36:04-03:00"
    item = C.normalizar_item(COMPRA_BELEM, {"numeroItemCompra": 1, "dataAtualizacaoPncp": "2026-07-09T10:36:04Z"})
    assert item["data_atualizacao_pncp"] == "2026-07-09T10:36:04Z"

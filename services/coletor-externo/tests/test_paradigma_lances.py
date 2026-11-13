"""Spec 0061, K-11: o coletor Paradigma grava todos os lances do item em licitacao_lances (histórico da disputa).

Fixture: HAR do mural da FIEB, processo 38191 (12/11/2026), 33 lances do item 1, 7 com posição e 1 vencedor; nomes e
CNPJs das empresas trocados por valores de teste. Nenhum teste chama o portal.
"""
import json
from pathlib import Path
from unittest.mock import MagicMock

from coletor import paradigma as P

FX = json.loads((Path(__file__).parent / "fixtures" / "paradigma" / "fieb_38191_lances.json").read_text(encoding="utf-8"))


class SbFake:
    """Upsert por chave de conflito, como o PostgREST com on_conflict: a mesma chave não duplica."""

    def __init__(self):
        self.tabelas: dict[str, dict] = {}
        self._ids = 1000

    def upsert(self, tabela, linhas, conflito):
        linhas = linhas if isinstance(linhas, list) else [linhas]
        destino = self.tabelas.setdefault(tabela, {})
        saida = []
        for ln in linhas:
            chave = tuple(ln.get(c) for c in conflito.split(","))
            atual = destino.get(chave)
            if atual is None:
                self._ids += 1
                atual = {"id": self._ids}
            atual.update(ln)
            destino[chave] = atual
            saida.append(atual)
        return saida

    def selecionar(self, *a, **k):
        return []

    def atualizar(self, *a, **k):
        return None


def _portal():
    p = P.PortalParadigma(P.FONTES["fieb"], sessao=MagicMock(), delay=0)
    p.detalhes = MagicMock(return_value=P.limpar(FX["detalhe"]))
    p.itens = MagicMock(return_value=P.limpar(FX["itens"]))
    p.resultado_item = lambda d, it: P.limpar(FX["lances"])
    return p


def test_ca12_linhas_lances_guarda_a_disputa_inteira():
    """CA-12: 33 lances, 7 com posição final e 1 vencedor; data e hora, valor, empresa, CNPJ, marca e modelo."""
    linhas = P.linhas_lances(10, 1, P.limpar(FX["lances"]))
    assert len(linhas) == 33
    assert sum(1 for x in linhas if x["posicao"]) == 7
    assert sum(1 for x in linhas if x["vencedor"]) == 1
    venc = next(x for x in linhas if x["vencedor"])
    assert venc["posicao"] == 1 and venc["valor"] == 38.79 and venc["moeda"] == "R$"
    assert venc["data_lance"].startswith("2023-08-25") and venc["fornecedor_cnpj"] and len(venc["fornecedor_cnpj"]) == 14
    assert {x["id_lance_externo"] for x in linhas} == {x["nCdLance"] for x in FX["lances"]}
    assert all(x["licitacao_id"] == 10 and x["numero_item"] == 1 and x["raw"] for x in linhas)


def test_ca12_coletar_duas_vezes_nao_duplica_e_resultados_seguem_iguais():
    """CA-12: gravar duas vezes deixa 33 lances (não 66); licitacao_resultados continua com as mesmas 7 posições."""
    sb = SbFake()
    for _ in range(2):
        resumo = P.coletar(_portal(), sb, [], 1, False, True, None, None, [(38191, 19)], origem="manual")
        assert resumo["erros"] == 0, resumo
    assert len(sb.tabelas["licitacao_lances"]) == 33
    assert len(sb.tabelas["licitacao_resultados"]) == 7
    assert resumo["lances"] == 33


def test_ca12_lances_gravados_mesmo_com_processo_em_julgamento():
    """Histórico da disputa não depende da homologação (#537 só barra licitacao_resultados)."""
    sb = SbFake()
    portal = _portal()
    portal.detalhes = MagicMock(return_value={**P.limpar(FX["detalhe"]), "sDsSituacao": "Análise dos lances"})
    P.coletar(portal, sb, [], 1, False, True, None, None, [(38191, 19)], origem="manual")
    assert len(sb.tabelas["licitacao_lances"]) == 33
    assert "licitacao_resultados" not in sb.tabelas


def test_ca12_ranking_sem_id_de_lance_nao_vira_lance():
    """A aba Classificação (fallback de resultado_item) não traz nCdLance: não é lance e não entra na tabela."""
    ranking = [{"nNrRanking": 1, "sNmEmpresa": "FORNECEDOR TESTE 1 LTDA - 11.222.334/0001-62", "dVlProposta": 10.0}]
    assert P.linhas_lances(10, 1, ranking) == []

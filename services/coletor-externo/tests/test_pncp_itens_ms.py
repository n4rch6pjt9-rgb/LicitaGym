"""material_ou_servico dos itens do PNCP (CHECK licitem_ms_chk: só 'M', 'S' ou NULL).

Rodada de produção de 30/09/2026: o coletor gravava materialOuServicoNome ("Material"/"Serviço"), todo insert de
item falhava com 23514 e a exceção interrompia a compra antes dos resultados e documentos."""
import pytest

from coletor import pncp as P
from test_pncp import ARQUIVOS, COMPRA, ITENS, _pncp


@pytest.mark.parametrize("item,esperado", [
    ({"materialOuServico": "M", "materialOuServicoNome": "Material"}, "M"),
    ({"materialOuServico": "S", "materialOuServicoNome": "Serviço"}, "S"),
    ({"materialOuServico": "s"}, "S"),
    ({"materialOuServicoNome": "Material"}, "M"),
    ({"materialOuServicoNome": "Serviço"}, "S"),
    ({"materialOuServicoNome": "SERVICO"}, "S"),
    ({"materialOuServicoNome": " serviços "}, "S"),
    ({"materialOuServicoNome": "MATERIAL"}, "M"),
    ({"materialOuServico": "X", "materialOuServicoNome": "Material"}, "M"),   # código desconhecido: vale o nome
    ({"materialOuServico": "M", "materialOuServicoNome": "Serviço"}, "M"),    # código vence o nome
    ({"materialOuServicoNome": "Obra"}, None),
    ({"materialOuServico": "", "materialOuServicoNome": ""}, None),
    ({}, None),
])
def test_material_ou_servico_so_devolve_m_s_ou_none(item, esperado):
    assert P.material_ou_servico(item) == esperado


class SupabaseComCheck:
    """Fake que aplica o CHECK licitem_ms_chk como o Postgres (23514)."""

    def __init__(self):
        self.gravado = {}

    def upsert(self, tabela, linhas, conflito):
        if tabela == "licitacao_itens":
            for ln in linhas:
                if ln["material_ou_servico"] not in (None, "M", "S"):
                    raise RuntimeError('Supabase licitacao_itens: 400 {"code":"23514","message":"new row for '
                                       'relation \\"licitacao_itens\\" violates check constraint \\"licitem_ms_chk\\""}')
        self.gravado.setdefault(tabela, []).append(linhas)
        if tabela == "licitacoes_externas":
            return [{"id": 9}]
        if tabela == "licitacao_documentos":
            return [{"id": 1, "status_processamento": "pendente", **x} for x in linhas]
        return linhas

    def selecionar(self, tabela, **filtros):   # reconciliação de documentos removidos (nenhum gravado antes)
        return []

    def atualizar(self, tabela, id_, campos):
        self.gravado.setdefault(f"{tabela}:atualizar", []).append((id_, campos))


def test_coleta_grava_itens_resultados_e_documentos_com_ms_valido():
    itens = [dict(ITENS[0], materialOuServico="M", materialOuServicoNome="Material"),
             dict(ITENS[1], materialOuServicoNome="Serviço")]
    p = _pncp([COMPRA])
    p.itens.return_value = itens
    sb = SupabaseComCheck()
    r = P.coletar(p, sb, None, ["borracha granulada"], "todos", 1, 50, com_resultados=True,
                  baixar_arquivos=False, max_bytes=10**8, dry_run=False)
    assert r["gravadas"] == 1 and r["erros"] == 0
    assert [i["material_ou_servico"] for i in sb.gravado["licitacao_itens"][0]] == ["M", "S"]
    assert len(sb.gravado["licitacao_resultados"][0]) == 2      # um resultado por item relevante
    assert sb.gravado["licitacao_documentos"][0][0]["raw"]["tipo_documento"] == ARQUIVOS[0]["tipoDocumentoNome"]


def test_valor_desconhecido_vira_none_e_nao_derruba_resultados():
    p = _pncp([COMPRA])
    p.itens.return_value = [dict(it, materialOuServicoNome="Obra", materialOuServico=None) for it in ITENS]
    sb = SupabaseComCheck()
    r = P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, pausa_segunda_passada=0)
    assert r["erros"] == 0
    assert all(i["material_ou_servico"] is None for i in sb.gravado["licitacao_itens"][0])
    assert "licitacao_resultados" in sb.gravado and "licitacao_documentos" in sb.gravado


def test_regressao_nome_cru_seria_recusado_pelo_check():
    """O fake recusa o nome cru como o banco: garante que o teste acima pegaria a regressão."""
    with pytest.raises(RuntimeError, match="23514"):
        SupabaseComCheck().upsert("licitacao_itens", [{"material_ou_servico": "Material"}], "x")

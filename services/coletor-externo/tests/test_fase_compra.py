"""Fase real da compra e compra só de serviço (02/10/2026; DIAG-SITUACAO-MATCH.md). Offline, dados fictícios
com os títulos/datas dos casos reais do diagnóstico."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
import requests

from coletor import pncp as P

AGORA = datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc)
ABERTA = {"situacao_nome": "Divulgada no PNCP", "tem_resultado": False, "data_fim_vigencia": "2026-10-20T09:00"}
VENCIDA = dict(ABERTA, data_fim_vigencia="2026-09-01T09:00")


def _arq(titulo, data, tipo="Outros Documentos"):
    return {"titulo": titulo, "tipoDocumentoNome": tipo, "dataPublicacaoPncp": data, "statusAtivo": True}


@pytest.mark.parametrize("fim", ["2604-04-16T09:00", "9999-12-31T23:59", "2029-03-01T09:00"])
def test_prazo_implausivel_nao_e_lead(fim):
    fase, prio, motivo = P.fase_da_compra(dict(ABERTA, data_fim_vigencia=fim), agora=AGORA)
    assert (fase, prio) == ("Prazo inválido", "monitorar") and "implausível" in motivo


def test_prazo_normal_continua_lead_e_vencido_em_julgamento():
    assert P.fase_da_compra(ABERTA, agora=AGORA)[:2] == ("Recebendo propostas", "leads")
    assert P.fase_da_compra(VENCIDA, agora=AGORA)[:2] == ("Em julgamento", "monitorar")


def test_excluida_vence_tudo():
    assert P.fase_da_compra(ABERTA, agora=AGORA, excluida=True)[:2] == ("Excluída do PNCP", "historico")


def test_resultado_e_situacao_oficial_vencem_documento():
    docs = [_arq("Aviso de suspensão", "2026-09-29T14:18:52")]
    assert P.fase_da_compra(dict(ABERTA, tem_resultado=True), agora=AGORA, documentos=docs)[:2] == \
        ("Homologada / com resultado", "historico")
    assert P.fase_da_compra(dict(ABERTA, situacao_nome="Revogada"), agora=AGORA)[:2] == ("Revogada", "historico")
    assert P.fase_da_compra(dict(ABERTA, situacao_nome="Suspensa"), agora=AGORA)[:2] == ("Suspensa", "monitorar")


def test_documentos_da_compra_mudam_a_fase():
    hom = [_arq("ADJUDICAÇÃO E HOMOLOGAÇÃO", "2026-08-19T10:00:00")]
    rev = [_arq("TERMO DE REVOGAÇÃO DE LICITAÇÃO … PE 012/2026", "2026-08-21T10:00:00")]
    sus = [_arq("ATA RELATIVA E DECISÃO ADM. DE SUSPENSÃO", "2026-09-29T14:18:52")]
    assert P.fase_da_compra(VENCIDA, agora=AGORA, documentos=hom)[:2] == ("Homologada (documento)", "historico")
    assert P.fase_da_compra(VENCIDA, agora=AGORA, documentos=rev)[:2] == ("Revogada/Anulada (documento)", "historico")
    assert P.fase_da_compra(ABERTA, agora=AGORA, documentos=sus, retificada_em="2026-09-29T14:18:52")[:2] == \
        ("Suspensa (documento)", "monitorar")


@pytest.mark.parametrize("titulo", [
    "Extrato de Suspensao de Contrato",           # id 229: suspende um contrato, não a compra
    "Ata de Registro de Preços - homologação",
    "Termo aditivo - revogação de cláusula",
    "Resultado da amostra",
    "Revogação parcial do item 3",
    "Edital - aquisição de borracha granulada",    # "granulada" contém "anula"
    "Aviso de suspensão",                           # inativo
])
def test_documento_que_nao_muda_a_compra(titulo):
    docs = [dict(_arq(titulo, "2026-09-29T10:00:00"), statusAtivo=titulo != "Aviso de suspensão")]
    assert P.sinal_documental(docs) is None


@pytest.mark.parametrize("titulo,sinal", [
    # nomes reais gravados em licitacao_documentos (135, 492, 2267): "_" no lugar de espaço e acento perdido
    ("ATA_RELATIVA_E_DECIS_O_ADM._DE_SUSPENS_O.pdf", "suspensao"),
    ("AVISO_SUSPENSAO_P_E_35_2026_28_09.pdf", "suspensao"),
    ("TERMO_DE_REVOGAO_DE_LICITAO__AVISO__PREGO_ELETRNICO_N_0122026", "revogacao"),
    ("ADJUDICACAO_E_HOMOLOGACAO.pdf", "resultado"),
])
def test_nome_de_arquivo_com_sublinhado(titulo, sinal):
    assert P.sinal_documental([_arq(titulo, "2026-09-29T14:18:52")]) == sinal


def test_suspensao_antes_da_ultima_retificacao_foi_reaberta():
    sus = [_arq("Memorando de suspensão", "2026-08-28T09:00:00")]
    assert P.sinal_documental(sus, retificada_em="2026-09-24T10:00:00") is None
    assert P.sinal_documental(sus, retificada_em="2026-08-28T09:05:00") == "suspensao"   # mesma publicação
    assert P.sinal_documental(sus) == "suspensao"


def test_compra_excluida_do_erro():
    r = MagicMock(status_code=410)
    assert P.compra_excluida_do_erro(requests.HTTPError("410 Gone", response=r))
    assert P.compra_excluida_do_erro(RuntimeError("PNCP detalhe: 410 Compra excluída"))
    assert not P.compra_excluida_do_erro(requests.HTTPError("404", response=MagicMock(status_code=404)))
    p = MagicMock()
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Compra excluída")
    with pytest.raises(P.CompraExcluida):
        P.consultar_detalhe(p, {"numero_controle_pncp": "x"})
    with pytest.raises(P.ConsultaFalhou):   # quem só trata falha continua pegando
        P.consultar_detalhe(p, {"numero_controle_pncp": "x"})


def _it(n, desc, ms):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms}


@pytest.mark.parametrize("objeto,itens", [
    ("Contratação de empresa para manutenção preventiva e corretiva de equipamentos de musculação",
     [_it(1, "Manutenção preventiva de aparelhos de musculação", "S"), _it(2, "Manutenção corretiva", "S")]),
    ("Locação de equipamentos de ginástica e musculação para a academia municipal",
     [_it(1, "Locação mensal de esteira ergométrica", "S")]),
    ("Serviços de orientação técnica em jiu jitsu, judô, tênis, treinamento funcional",
     [_it(n, "Serviço de orientação técnica", "S") for n in range(1, 4)]),
])
def test_compra_so_de_servico_fica_fora_mesmo_com_objeto_forte(objeto, itens):
    assert P.avaliar({"description": objeto}, itens)[0] is None


def test_compra_so_de_servico_que_fornece_produto_continua():
    itens = [_it(1, "Fornecimento e instalação de equipamentos de musculação", "S")]
    assert P.avaliar({"description": "Implantação de academia no ginásio"}, itens)[0] == "forte"
    obj = "Aquisição de equipamentos de musculação, com instalação"
    assert P.avaliar({"description": obj}, [_it(1, "Instalação", "S")])[0] == "forte"


def test_piso_de_obra_em_item_de_servico_continua_e_compra_mista_nao_muda():
    assert P.avaliar({"description": "Reforma da quadra"}, [_it(1, "Execução de piso emborrachado em EPDM", "S")])[0] \
        == "borracha"
    objeto = "Contratação de empresa para manutenção de equipamentos de musculação"
    mista = [_it(1, "Manutenção de aparelhos de musculação", "S"), _it(2, "Cabo de aço para aparelho", "M")]
    assert P.avaliar({"description": objeto}, mista)[0] == P.classificar(objeto)


def test_coletor_grava_fase_e_historico_quando_detalhe_responde_410():
    from tests.test_pncp import ABERTA as ABERTA_BUSCA, ITENS_ABERTOS, _pncp_aberto, _sb, _lic
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Compra excluída")
    sb = _sb()
    r = P.coletar(p, sb, None, ["x"], "recebendo_proposta", 1, 50, True, False, 10**8, False, modo="leads",
                  agora=datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc))
    lic = _lic(sb)
    assert r["excluidas_do_pncp"] == 1
    assert lic["prioridade"] == "historico" and lic["fase"] == "Excluída do PNCP"
    assert lic["situacao"] == "Divulgada no PNCP"   # situacao continua a oficial da busca


def test_coletor_grava_fase_do_documento_e_nao_grava_fase_sem_rotulo():
    from tests.test_pncp import ABERTA as ABERTA_BUSCA, _pncp_aberto, _sb, _lic
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = {"processo": "1/2026", "dataAtualizacao": "2026-09-20T10:00:00"}
    p.arquivos.return_value = [_arq("Aviso de suspensão do pregão", "2026-09-28T10:00:00")]
    sb = _sb()
    P.coletar(p, sb, None, ["x"], "recebendo_proposta", 1, 50, True, False, 10**8, False, modo="leads",
              agora=datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc))
    lic = _lic(sb)
    assert lic["prioridade"] == "monitorar" and lic["fase"] == "Suspensa (documento)"

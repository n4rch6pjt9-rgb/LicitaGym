"""Fase reconciliada (09/10/2026): republicação vence suspensão (caso 135), ata de registro de preço (caso 129) e
normalização do prazo de proposta implausível. Offline: fixtures com dados públicos do PNCP (tests/fixtures)."""
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests

from coletor import pncp as P

FIX = Path(__file__).parent / "fixtures"
C135 = json.loads((FIX / "pncp_caso_135.json").read_text(encoding="utf-8"))
C129 = json.loads((FIX / "pncp_caso_129.json").read_text(encoding="utf-8"))
AGORA = datetime(2026, 10, 9, 15, 0, tzinfo=timezone.utc)


def _arq(titulo, data, tipo="Outros Documentos", ativo=True):
    return {"titulo": titulo, "tipoDocumentoNome": tipo, "dataPublicacaoPncp": data, "statusAtivo": ativo}


# --- 1. Republicação vence suspensão -----------------------------------------------------------------------------

def test_caso_135_republicacao_vence_suspensao_do_mesmo_upload():
    fase, prio, motivo = P.fase_da_compra(
        P.compra_com_detalhe(C135["busca"], C135["detalhe"]), agora=AGORA, documentos=C135["arquivos"],
        retificada_em=C135["detalhe"]["dataAtualizacao"])
    assert (fase, prio) == ("Recebendo propostas", "leads")
    assert "suspensão anterior; republicado" in motivo


def test_caso_135_sem_a_republicacao_continua_suspensa():
    sem_edital = [a for a in C135["arquivos"] if a["tipoDocumentoNome"] != "Edital"]
    assert P.sinal_documental(sem_edital, retificada_em="2026-09-29T14:18:52") == "suspensao"


@pytest.mark.parametrize("doc,sinal", [
    # republicação muito antes da suspensão não a neutraliza
    (_arq("Edital republicação", "2026-09-01T10:00:00", "Edital"), "suspensao"),
    # "republica" fora de documento do tipo Edital não conta
    (_arq("Aviso de republicação", "2026-09-29T14:18:51", "Aviso de Contratação Direta"), "suspensao"),
    # edital inativo não conta
    (_arq("Edital republicado", "2026-09-29T14:18:51", "Edital", ativo=False), "suspensao"),
    # minuta de edital republicado é etapa
    (_arq("Minuta do edital republicado", "2026-09-29T14:18:51", "Edital"), "suspensao"),
    # dentro da tolerância (10 min antes) e depois neutralizam
    (_arq("EDITAL_REPUBLICACAO.pdf", "2026-09-29T14:10:00", "Edital"), None),
    (_arq("Edital - republicação", "2026-09-30T09:00:00", "Edital"), None),
])
def test_republicacao_so_neutraliza_com_edital_ativo_na_janela(doc, sinal):
    sus = _arq("Aviso de suspensão do pregão", "2026-09-29T14:18:52")
    assert P.sinal_documental([sus, doc]) == sinal


def test_republicacao_nao_neutraliza_homologacao_nem_revogacao():
    rep = _arq("Edital republicação", "2026-09-29T14:18:51", "Edital")
    assert P.sinal_documental([rep, _arq("Termo de homologação", "2026-09-28T10:00:00")]) == "resultado"
    assert P.sinal_documental([rep, _arq("Termo de revogação", "2026-09-28T10:00:00")]) == "revogacao"


def test_licitacao_documentos_tambem_reconhece_republicacao():
    docs = [{"nome_original": "EDITAL_REPUBLICACAO.doc", "tipo_documento": "Edital",
             "data_documento": "2026-09-29T14:18:51", "statusAtivo": True},
            {"nome_original": "AVISO_SUSPENSAO.pdf", "tipo_documento": "Outros Documentos",
             "data_documento": "2026-09-29T14:18:52", "statusAtivo": True}]
    assert P.analise_documental(docs) == (None, True)


# --- 2. Ata de registro de preço ---------------------------------------------------------------------------------

def test_caso_129_ata_assinada_vira_registro_de_preco_historico():
    fase, prio, motivo = P.fase_da_compra(
        P.compra_com_detalhe(C129["busca"], C129["detalhe"]), agora=AGORA, atas=C129["atas"]["data"])
    assert (fase, prio) == ("Registro de Preço", "historico")
    assert "39" in motivo and "2024-05-10" in motivo


def test_ata_cancelada_ou_sem_informacao_nao_decide():
    compra = P.compra_com_detalhe(C129["busca"], C129["detalhe"])
    cancelada = [dict(C129["atas"]["data"][0], cancelado=True)]
    assert P.fase_da_compra(compra, agora=AGORA, atas=cancelada)[:2] == ("Prazo inválido", "monitorar")
    assert P.fase_da_compra(compra, agora=AGORA, atas=None)[:2] == ("Prazo inválido", "monitorar")
    com_data_cancelamento = [dict(C129["atas"]["data"][0], dataCancelamento="2024-06-01T10:00:00")]
    assert P.atas_nao_canceladas(com_data_cancelamento) == []


def test_ata_vem_depois_do_oficial_e_antes_de_suspensao_e_prazo():
    ata = C129["atas"]["data"]
    aberta = {"situacao_nome": "Divulgada no PNCP", "data_fim_vigencia": "2026-10-20T09:00"}
    assert P.fase_da_compra(dict(aberta, tem_resultado=True), agora=AGORA, atas=ata)[:2] == \
        ("Homologada / com resultado", "historico")
    assert P.fase_da_compra(dict(aberta, situacao_nome="Suspensa"), agora=AGORA, atas=ata)[:2] == \
        ("Suspensa", "monitorar")
    sus = [_arq("Aviso de suspensão", "2026-09-29T14:18:52")]
    assert P.fase_da_compra(aberta, agora=AGORA, atas=ata, documentos=sus)[:2] == ("Registro de Preço", "historico")
    assert P.fase_da_compra(aberta, agora=AGORA, atas=ata)[:2] == ("Registro de Preço", "historico")
    assert P.fase_da_compra(aberta, agora=AGORA, atas=ata, excluida=True)[:2] == ("Excluída do PNCP", "historico")


def test_cliente_atas_le_envelope_paginado_e_204():
    p = P.PNCP(delay=0)
    p._get = MagicMock(return_value=C129["atas"])
    assert p.atas({"orgao_cnpj": "08182313000110", "ano": 2024, "numero_sequencial": 50}) == C129["atas"]["data"]
    caminho, kw = p._get.call_args.args[0], p._get.call_args.kwargs
    assert caminho == "/api/pncp/v1/orgaos/08182313000110/compras/2024/50/atas"
    assert kw == {"pagina": 1, "tamanhoPagina": P.TAMANHO_PAGINA_ATAS} and 10 <= P.TAMANHO_PAGINA_ATAS <= 500
    p._get = MagicMock(return_value=[])
    assert p.atas({"orgao_cnpj": "1", "ano": 2024, "numero_sequencial": 1}) == []


def test_cliente_atas_segue_paginas_e_recusa_envelope_invalido():
    p = P.PNCP(delay=0)
    p._get = MagicMock(side_effect=[{"data": [{"sequencialAta": 1}], "paginasRestantes": 1},
                                    {"data": [{"sequencialAta": 2}], "paginasRestantes": 0}])
    assert [a["sequencialAta"] for a in p.atas({"orgao_cnpj": "1", "ano": 2024, "numero_sequencial": 1})] == [1, 2]
    p._get = MagicMock(return_value={"mensagem": "x"})
    with pytest.raises(P.RespostaInvalida):
        p.atas({"orgao_cnpj": "1", "ano": 2024, "numero_sequencial": 1})
    pagina = {"data": [{"sequencialAta": 1}], "paginasRestantes": 3}
    p._get = MagicMock(return_value=pagina)
    with pytest.raises(P.RespostaInvalida):   # página repetida não é fim
        p.atas({"orgao_cnpj": "1", "ano": 2024, "numero_sequencial": 1})


# --- 3. Normalização do prazo de proposta ------------------------------------------------------------------------

def test_caso_129_prazo_2604_limitado_por_ata():
    norm = P.normalizacao_prazo(P.compra_com_detalhe(C129["busca"], C129["detalhe"]), agora=AGORA,
                                atas=C129["atas"]["data"])
    assert norm == {"campo": "data_fim", "original": "2604-04-16T08:30:00", "normalizado": None,
                    "regra": "limitado_por_ata", "origem": "inferido"}


def test_caso_129_sem_ata_nao_normaliza():
    # 2024-04-16 fica antes da abertura (2024-04-26): troca de ano não fecha e não há fato que limite
    assert P.normalizacao_prazo(P.compra_com_detalhe(C129["busca"], C129["detalhe"]), agora=AGORA) is None


def test_troca_de_ano_pela_abertura_quando_fecha():
    norm = P.normalizar_prazo_proposta("2062-10-14T09:00:00", abertura="2026-10-01T08:00:00",
                                       publicacao="2026-09-29T10:00:00")
    assert norm["regra"] == "ano_da_abertura" and norm["normalizado"].startswith("2026-10-14T09:00:00")
    assert norm["original"] == "2062-10-14T09:00:00" and norm["origem"] == "inferido"


def test_troca_de_ano_pela_publicacao_e_teto():
    # abertura ausente: piso = publicação
    norm = P.normalizar_prazo_proposta("2205-03-10T09:00", publicacao="2025-02-20T10:00")
    assert norm["regra"] == "ano_da_publicacao" and norm["normalizado"].startswith("2025-03-10")
    # corrigido depois do fato (ata) não é aceito; fica limitado pelo fato
    limite = datetime(2025, 3, 1, tzinfo=P.FUSO_PNCP)
    norm = P.normalizar_prazo_proposta("2205-03-10T09:00", publicacao="2025-02-20T10:00", limite=limite,
                                       regra_limite="limitado_por_ata")
    assert (norm["normalizado"], norm["regra"]) == (None, "limitado_por_ata")


@pytest.mark.parametrize("original", ["9999-12-31T23:59", "lixo", None])
def test_sentinela_e_invalido_nao_normalizam(original):
    assert P.normalizar_prazo_proposta(original, abertura="2026-01-01", publicacao="2026-01-01") is None


def test_prazo_normalizado_decide_a_fase():
    compra = {"situacao_nome": "Divulgada no PNCP", "data_inicio_vigencia": "2026-10-01T08:00:00",
              "data_fim_vigencia": "2062-10-14T09:00:00", "data_publicacao_pncp": "2026-09-29T10:00:00"}
    assert P.fase_da_compra(compra, agora=AGORA)[:2] == ("Recebendo propostas", "leads")
    depois = datetime(2026, 10, 20, tzinfo=timezone.utc)
    assert P.fase_da_compra(compra, agora=depois)[:2] == ("Em julgamento", "monitorar")


# --- coletor: grava normalização e trata falha de /atas como sem informação -------------------------------------

def _sb():
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 9}] if t == "licitacoes_externas" else (
        [{"id": 1, "status_processamento": "pendente", **x} for x in l] if t == "licitacao_documentos" else l)
    return sb


def _pncp_129():
    from tests.test_pncp import ITENS_ABERTOS
    busca = dict(C129["busca"], description="Aquisição de equipamentos de musculação", municipio_nome="Lagoa Nova",
                 uf="RN")
    p = MagicMock()
    p.buscar.return_value = {"items": [busca], "total": 1}
    p.itens.return_value = ITENS_ABERTOS
    p.resultados.return_value = []
    p.arquivos.return_value = []
    p.compra.return_value = dict(C129["detalhe"], processo="1/2024")
    p.atas.return_value = C129["atas"]["data"]
    return p


def _lic(sb):
    return {c.args[0]: c.args[1] for c in sb.upsert.call_args_list}["licitacoes_externas"]


def test_coletor_grava_registro_de_preco_e_normalizacao_sem_tocar_o_bruto():
    p, sb = _pncp_129(), _sb()
    P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=AGORA)
    lic = _lic(sb)
    assert (lic["fase"], lic["prioridade"]) == ("Registro de Preço", "historico")
    assert lic["normalizacoes"]["data_fim"]["regra"] == "limitado_por_ata"
    assert lic["data_fim"] is None
    assert lic["raw"]["data_fim_vigencia"] == "2604-04-16T08:30:00"   # bruto preservado


def test_coletor_falha_em_atas_nao_grava_fase_nem_prioridade():
    p, sb = _pncp_129(), _sb()
    p.atas.side_effect = requests.HTTPError("503 do PNCP")
    r = P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=AGORA)
    lic = _lic(sb)
    assert "fase" not in lic and "prioridade" not in lic and "normalizacoes" not in lic
    assert r["falha_atas"] == 1 and r["prioridade_nao_gravada_sem_atas"] == 1


def test_coletor_nao_consulta_atas_de_compra_sem_srp():
    p, sb = _pncp_129(), _sb()
    p.compra.return_value = dict(C129["detalhe"], srp=False, processo="1/2024")
    P.coletar(p, sb, None, ["x"], "todos", 1, 50, True, False, 10**8, False, agora=AGORA)
    p.atas.assert_not_called()
    assert _lic(sb)["fase"] == "Prazo inválido" and _lic(sb)["normalizacoes"] is None


def test_reclassificador_mantem_registro_de_preco_sem_atas():
    from coletor.reclassificar_escopo_pncp import _nova_prioridade
    ln = {"prioridade": "historico", "fase": "Registro de Preço", "raw": C129["busca"],
          "data_fim": None, "situacao": "Divulgada no PNCP"}
    prio, _, trava, fase = _nova_prioridade(ln, None, AGORA, det=C129["detalhe"])
    assert (prio, trava, fase) == (None, "registro_preco_mantido_sem_atas", None)


def test_caso_129_sem_ata_limitado_pela_homologacao_lida_na_coleta():
    """Sem ata, a homologação lida dos resultados na mesma coleta limita o prazo absurdo (limitado_por_resultado)."""
    visao = P.compra_com_detalhe(C129["busca"], C129["detalhe"])
    assert P.normalizacao_prazo(visao, agora=AGORA) is None  # sem a data, nada limita
    homologada = datetime(2024, 6, 3, 15, 0, tzinfo=timezone.utc)
    norm = P.normalizacao_prazo(P.visao_para_prazo(visao, homologada), agora=AGORA)
    assert norm is not None
    assert "limitado_por_resultado" in json.dumps(norm)


def test_visao_para_prazo_nao_sobrescreve_data_ja_presente():
    visao = {"data_homologacao": "2024-05-01"}
    assert P.visao_para_prazo(visao, datetime(2024, 6, 3, tzinfo=timezone.utc)) is visao
    assert P.visao_para_prazo({"x": 1}, None) == {"x": 1}

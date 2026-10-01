"""Reclassificação de escopo das compras PNCP gravadas (coletor.reclassificar_escopo_pncp). Offline."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from coletor import reclassificar_escopo_pncp as R

AGORA = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)
RAW_ABERTA = {"data_fim_vigencia": "2026-10-20T09:00", "situacao_nome": "Divulgada no PNCP", "tem_resultado": False}


def _linha(id_, objeto, cat="forte", prio="leads", itens=None, termos=("puxador",), ib=False, codigo=None):
    return {"id": id_, "codigo_externo": codigo or f"12345678000199-1-{id_:06d}/2026", "objeto": objeto,
            "categoria_escopo": cat, "interesse_borracha": ib, "prioridade": prio, "situacao": "Divulgada no PNCP",
            "data_homologacao": None, "data_fim": None, "termos_busca": list(termos),
            "created_at": "2026-09-30T23:30:00+00:00", "raw": dict(RAW_ABERTA, description=objeto),
            "licitacao_itens": itens or []}


PORTA = _linha(273, "Porta de madeira, ferragens e acessórios para marcenaria.")
MOBILIARIO = _linha(276, "AQUISIÇÃO DE EQUIPAMENTO E MATERIAL PERMANENTE")
ACADEMIA = _linha(400, "Aquisição de equipamentos de academia", termos=("equipamentos de academia",))

ITENS_PNCP = {
    PORTA["codigo_externo"]: [{"numeroItem": 1, "descricao": "PUXADOR DE ALUMINIO PARA PORTA"},
                              {"numeroItem": 2, "descricao": "puxador para gaveta inox"}],
    MOBILIARIO["codigo_externo"]: [{"numeroItem": 1, "descricao": "Armário de aço com puxador"},
                                   {"numeroItem": 2, "descricao": "PUXADOR ALTO E BAIXO COM POLIA"}],
    ACADEMIA["codigo_externo"]: [{"numeroItem": 1, "descricao": "Leg press 45 graus"}],
}


def _pncp():
    p = MagicMock()
    p.itens.side_effect = lambda c: ITENS_PNCP[c["numero_controle_pncp"]]
    return p


def _sb(linhas):
    sb = MagicMock()
    sb.selecionar.return_value = linhas
    return sb


def test_dry_run_nunca_grava_e_conta_saidas_dos_leads():
    sb = _sb([PORTA, MOBILIARIO, ACADEMIA])
    r = R.reclassificar(R.SomenteLeitura(sb), _pncp(), consultar_pncp=True, agora=AGORA)
    sb.atualizar.assert_not_called()
    sb.upsert.assert_not_called()
    assert r["lidas"] == 3 and r["itens_pncp"] == 2 and r["decididas_pelo_objeto"] == 1
    assert r["sai_do_escopo"] == 1 and r["sai_dos_leads"] == 1
    assert r["transicoes_categoria"] == {"forte->NULL": 1}
    porta = next(ln for ln in r["linhas"] if ln["id"] == 273)
    assert porta["campos"] == {"categoria_escopo": None, "prioridade": None}   # interesse já era False
    assert r["muda_interesse"] == 0
    assert {ln["id"]: ln["status"] for ln in r["linhas"]} == {273: "sai_do_escopo", 276: "sem_mudanca", 400: "sem_mudanca"}


def test_somente_leitura_bloqueia_escrita():
    ro = R.SomenteLeitura(MagicMock())
    with pytest.raises(PermissionError):
        ro.atualizar("licitacoes_externas", 1, {"prioridade": None})
    with pytest.raises(PermissionError):
        ro.upsert("licitacoes_externas", [], "x")


def test_apply_grava_so_os_campos_que_mudam():
    sb = _sb([PORTA, MOBILIARIO])
    r = R.reclassificar(sb, _pncp(), aplicar=True, consultar_pncp=True, agora=AGORA)
    assert r["gravadas"] == 1
    sb.atualizar.assert_called_once_with("licitacoes_externas", 273, {"categoria_escopo": None, "prioridade": None})


def test_sem_itens_e_sem_consulta_nao_mexe_se_o_objeto_nao_confirma():
    r = R.reclassificar(R.SomenteLeitura(_sb([PORTA, ACADEMIA])), None, agora=AGORA)
    assert r["sem_itens"] == 1 and r["sem_mudanca"] == 1 and r["sai_do_escopo"] == 0


def test_falha_na_consulta_de_itens_nao_mexe():
    p = MagicMock()
    p.itens.side_effect = RuntimeError("503 do PNCP")
    r = R.reclassificar(R.SomenteLeitura(_sb([PORTA])), p, consultar_pncp=True, agora=AGORA)
    assert r["falha_consulta"] == 1 and r["sai_do_escopo"] == 0 and r["linhas"][0]["status"] == "falha_consulta"


def test_itens_gravados_sao_usados_e_itens_que_mudam_sao_atualizados():
    ln = _linha(10, "Aquisição de materiais diversos", itens=[
        {"id": 501, "numero_item": 1, "descricao": "PUXADOR DE ALUMINIO PARA PORTA", "situacao": "Em andamento",
         "tem_resultado": False, "categoria_escopo": "forte", "interesse_borracha": False}])
    p = MagicMock()
    sb = _sb([ln])
    r = R.reclassificar(sb, p, aplicar=True, consultar_pncp=True, agora=AGORA)
    p.itens.assert_not_called()
    assert r["itens_gravados"] == 1 and r["sai_do_escopo"] == 1 and r["itens_mudariam"] == 1
    sb.atualizar.assert_any_call("licitacao_itens", 501, {"categoria_escopo": None})


def test_prioridade_nao_promove_a_leads_nem_sai_de_historico_sem_detalhe():
    hist = _linha(20, "Aquisição de equipamentos de academia", prio="historico", termos=("x",))
    mon = _linha(21, "Aquisição de equipamentos de academia", prio="monitorar", termos=("x",))
    r = R.reclassificar(R.SomenteLeitura(_sb([hist, mon])), None, agora=AGORA)
    assert r["muda_prioridade"] == 0
    assert r["trava_prioridade"] == {"historico_mantido_sem_detalhe": 1, "leads_sem_detalhe": 1}


def test_prioridade_rebaixa_lead_com_prazo_vencido():
    ln = _linha(22, "Aquisição de equipamentos de academia", termos=("x",))
    ln["raw"] = dict(ln["raw"], data_fim_vigencia="2026-09-30T09:00")
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), None, agora=AGORA)
    assert r["transicoes_prioridade"] == {"leads->monitorar": 1}


def test_cache_de_itens_evita_nova_consulta():
    cache = {PORTA["codigo_externo"]: ITENS_PNCP[PORTA["codigo_externo"]]}
    p = _pncp()
    r = R.reclassificar(R.SomenteLeitura(_sb([PORTA, MOBILIARIO])), p, consultar_pncp=True, agora=AGORA,
                        cache_itens=cache)
    assert p.itens.call_count == 1 and MOBILIARIO["codigo_externo"] in cache and r["itens_pncp"] == 2


def test_filtros_de_id_termo_e_data():
    f = R._filtros(50, 556, "2026-09-30T23:08:00Z", "puxador", 10)
    assert f["and"] == "(id.gte.50,id.lte.556)" and f["termos_busca"] == 'cs.{"puxador"}'
    assert f["created_at"] == "gte.2026-09-30T23:08:00Z" and f["limit"] == "10" and f["fonte"] == "eq.pncp"
    assert R._filtros(50, None, None, None, None)["id"] == "gte.50"


def test_objeto_de_servico_sai_do_escopo_sem_consultar_itens():
    """id 229 (Angatuba/SP): credenciamento de oficineiros, termos_busca ["treinamento funcional"]."""
    ln = _linha(229, "Credenciamento de Oficineiros para atender ao Serviço de Convivência e Fortalecimento de "
                     "Vínculos (SCFV) e da demanda de aulas da Secretaria de Esporte e Lazer",
                termos=("treinamento funcional",), codigo="46634234000191-1-000058/2025")
    ln["raw"]["data_fim_vigencia"] = "9999-12-31T23:59"
    p = MagicMock()
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_pncp=True, agora=AGORA)
    p.itens.assert_not_called()
    assert r["sai_do_escopo"] == 1 and r["sai_dos_leads"] == 1 and r["decididas_pelo_objeto"] == 1


def test_compra_de_academia_ao_ar_livre_sai_do_escopo_e_com_piso_vira_piso():
    ati = _linha(30, "Aquisição de academia ao ar livre para praças", termos=("academia ao ar livre",),
                 codigo="12345678000199-1-000030/2026")
    ati_piso = _linha(31, "Aquisição de academia ao ar livre para praças", termos=("academia ao ar livre",),
                      codigo="12345678000199-1-000031/2026")
    itens = {ati["codigo_externo"]: [{"numeroItem": 1, "descricao": "LEG PRESS DUPLO"}],
             ati_piso["codigo_externo"]: [{"numeroItem": 1, "descricao": "LEG PRESS DUPLO"},
                                          {"numeroItem": 2, "descricao": "Piso emborrachado 50x50 25 mm"}]}
    p = MagicMock()
    p.itens.side_effect = lambda c: itens[c["numero_controle_pncp"]]
    r = R.reclassificar(R.SomenteLeitura(_sb([ati, ati_piso])), p, consultar_pncp=True, agora=AGORA)
    assert r["transicoes_categoria"] == {"forte->NULL": 1, "forte->piso": 1}

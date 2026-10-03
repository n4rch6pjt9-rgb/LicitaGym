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
            "fase": "Recebendo propostas",   # fase já gravada coerente com RAW_ABERTA (prazo aberto)
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
    """Supabase falso: compras sem itens embutidos; os itens vêm de licitacao_itens e os documentos de
    licitacao_documentos (filtro licitacao_id=in.(...)); documentos do teste ficam em ln["documentos"]."""
    sb = MagicMock()

    def selecionar(tabela, **f):
        if tabela == "licitacoes_externas":
            return [{k: v for k, v in ln.items() if k not in ("licitacao_itens", "documentos")} for ln in linhas]
        assert tabela in ("licitacao_itens", "licitacao_documentos") and f["licitacao_id"].startswith("in.(")
        ids = {int(x) for x in f["licitacao_id"][4:-1].split(",")}
        chave = "licitacao_itens" if tabela == "licitacao_itens" else "documentos"
        return [dict(it, licitacao_id=ln["id"]) for ln in linhas if ln["id"] in ids
                for it in (ln.get(chave) or [])]
    sb.selecionar.side_effect = selecionar
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


def test_le_todos_os_itens_sem_o_corte_de_1000_do_embutido():
    # #799 tinha 5357 itens; o embutido trazia só 1000. Agora os itens vêm paginados de licitacao_itens.
    itens = [{"id": 10_000 + n, "numero_item": n, "descricao": "CIMENTO PORTLAND CP II", "categoria_escopo": None,
              "interesse_borracha": False} for n in range(1, 2500)]
    itens.append({"id": 99_999, "numero_item": 2500, "descricao": "Leg press 45 graus", "categoria_escopo": None,
                  "interesse_borracha": False})
    ln = _linha(901, "Aquisição de materiais diversos", cat=None, prio=None, itens=itens)
    pagina = 1000
    todos = [dict(it, licitacao_id=901) for it in itens]
    sb = MagicMock()

    def selecionar(tabela, **f):   # imita o PostgREST: no máximo 1000 por requisição, Supabase.selecionar pagina
        if tabela == "licitacoes_externas":
            return [{k: v for k, v in ln.items() if k != "licitacao_itens"}]
        if tabela == "licitacao_documentos":
            return []
        assert "material_ou_servico" in f["select"]
        out, off = [], 0
        while True:
            lote = todos[off:off + pagina]
            out += lote
            off += pagina
            if len(lote) < pagina:
                return out
    sb.selecionar.side_effect = selecionar
    r = R.reclassificar(R.SomenteLeitura(sb), agora=AGORA)
    assert r["itens_lidos"] == 2500
    linha = r["linhas"][0]
    assert linha["n_itens"] == 2500 and linha["categoria_depois"] == "forte"


def test_item_de_servico_gravado_nao_conta_como_equipamento():
    # material_ou_servico agora é lido: item 'S' sem fornecimento de material não vira "forte"
    itens = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "S",
              "categoria_escopo": "forte", "interesse_borracha": False}]
    ln = _linha(902, "Contratação de serviços diversos para a Secretaria de Esportes", itens=itens)
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)
    assert r["linhas"][0]["categoria_depois"] is None
    itens[0]["material_ou_servico"] = "M"
    ln = _linha(903, "Contratação de serviços diversos para a Secretaria de Esportes", itens=itens)
    assert R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)["linhas"][0]["categoria_depois"] == "forte"


def test_carregar_itens_entre_lotes_mapeia_cada_compra_e_compra_sem_itens_fica_vazia():
    # lote de 2 compras por consulta: 5 compras = 3 consultas; a do meio não tem itens gravados
    linhas = [_linha(i, f"Compra {i}", itens=[{"id": i * 100 + n, "numero_item": n, "descricao": f"item {n}"}
                                              for n in range(1, i % 4 + 1)] if i != 3 else [])
              for i in range(1, 6)]
    sb = _sb(linhas)
    sem_itens = [{k: v for k, v in ln.items() if k != "licitacao_itens"} for ln in linhas]
    total = R.carregar_itens(sb, sem_itens, lote=2)
    assert [c.kwargs["licitacao_id"] for c in sb.selecionar.call_args_list] == ["in.(1,2)", "in.(3,4)", "in.(5)"]
    assert {ln["id"]: len(ln["licitacao_itens"]) for ln in sem_itens} == {1: 1, 2: 2, 3: 0, 4: 0, 5: 1}
    assert total == 4
    assert all(it["licitacao_id"] == ln["id"] for ln in sem_itens for it in ln["licitacao_itens"])


def test_venda_de_bens_sem_itens_gravados_decide_pelo_objeto_sem_cache_nem_pncp():
    # #240 (01/10/2026): "Alienação de bens móveis inservíveis", 0 itens no banco e 12 no cache antigo do PNCP.
    # Com a regra de venda de bens o objeto decide (fora): n_itens=0 é esperado, não é item perdido.
    ln = _linha(240, "Alienação de bens móveis inservíveis do Município de Guaramirim.", cat=None, prio=None,
                codigo="83102475000116-1-000132/2026")
    pncp = _pncp()
    cache = {ln["codigo_externo"]: [{"numeroItem": 1, "descricao": "BICICLETA ERGOMÉTRICA usada"}]}
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), pncp, consultar_pncp=True, agora=AGORA, cache_itens=cache)
    pncp.itens.assert_not_called()
    linha = r["linhas"][0]
    assert linha["fonte_itens"] == "objeto" and linha["n_itens"] == 0 and linha["status"] == "sem_mudanca"
    assert r["decididas_pelo_objeto"] == 1 and r["itens_pncp"] == 0


# --------------------------------------------------------------------------------------------------------------
# Fase real (02/10/2026): documentos da compra, prazo implausível, 410 e compra só de serviço. Dados fictícios
# com os títulos reais dos casos do diagnóstico (135, 1458, 2267, 229, 129, 1315).
# --------------------------------------------------------------------------------------------------------------

def _doc(nome, data, tipo=None):
    return {"nome_original": nome, "data_documento": data, "raw": {"tipo_documento": tipo}}


def test_documento_de_suspensao_da_compra_tira_dos_leads_e_grava_a_fase():
    ln = _linha(135, "Aquisição de equipamentos de academia", termos=("academia",),
                itens=[{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
                        "categoria_escopo": "forte", "interesse_borracha": False}])
    ln["raw"]["data_atualizacao_pncp"] = "2026-09-29T14:18:52"
    ln["documentos"] = [_doc("ATA RELATIVA E DECISÃO ADM. DE SUSPENSÃO.pdf", "2026-09-29T14:18:52+00:00")]
    ln["fase"] = None
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)
    linha = r["linhas"][0]
    assert linha["campos"] == {"prioridade": "monitorar", "fase": "Suspensa (documento)"}
    assert r["transicoes_prioridade"] == {"leads->monitorar": 1}
    assert r["transicoes_fase"] == {"NULL->Suspensa (documento)": 1}


def test_suspensao_anterior_a_retificacao_nao_vale():
    ln = _linha(77, "Aquisição de equipamentos de academia", termos=("academia",),
                itens=[{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
                        "categoria_escopo": "forte", "interesse_borracha": False}])
    ln["raw"]["data_atualizacao_pncp"] = "2026-09-24T10:00:00"
    ln["documentos"] = [_doc("Memorando suspensão.pdf", "2026-08-28T09:00:00+00:00")]
    linha = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)["linhas"][0]
    assert linha["status"] == "sem_mudanca" and linha["campos"] == {} and linha["prioridade_depois"] == "leads"


def test_homologacao_e_revogacao_por_documento_vao_para_historico_e_extrato_de_contrato_nao():
    item = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
             "categoria_escopo": "forte", "interesse_borracha": False}]
    hom = _linha(1458, "Aquisição de equipamentos de academia", prio="monitorar", itens=item)
    hom["raw"]["data_fim_vigencia"] = "2026-08-01T09:00"
    hom["documentos"] = [_doc("ADJUDICAÇÃO E HOMOLOGAÇÃO.pdf", "2026-08-19T10:00:00+00:00")]
    rev = _linha(2267, "Aquisição de equipamentos de academia", prio="monitorar", itens=item)
    rev["raw"]["data_fim_vigencia"] = "2026-08-01T09:00"
    rev["documentos"] = [_doc("TERMO DE REVOGAÇÃO DE LICITAÇÃO PE 012-2026.pdf", "2026-08-21T10:00:00+00:00")]
    contrato = _linha(229, "Aquisição de equipamentos de academia", prio="monitorar", itens=item)
    contrato["raw"]["data_fim_vigencia"] = "2026-08-01T09:00"
    contrato["documentos"] = [_doc("Extrato de Suspensao de Contrato.pdf", "2026-06-29T10:33:00+00:00"),
                              _doc("Edital borracha granulada.pdf", "2026-06-01T10:00:00+00:00")]
    r = R.reclassificar(R.SomenteLeitura(_sb([hom, rev, contrato])), agora=AGORA)
    por_id = {ln["id"]: ln["campos"] for ln in r["linhas"]}
    assert por_id[1458] == {"prioridade": "historico", "fase": "Homologada (documento)"}
    assert por_id[2267] == {"prioridade": "historico", "fase": "Revogada/Anulada (documento)"}
    assert por_id[229] == {"fase": "Em julgamento"}


def test_prazo_implausivel_nao_e_lead():
    item = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
             "categoria_escopo": "forte", "interesse_borracha": False}]
    ln = _linha(129, "Aquisição de equipamentos de academia", itens=item)
    ln["raw"]["data_fim_vigencia"] = "2604-04-16T09:00"
    linha = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)["linhas"][0]
    assert linha["campos"] == {"prioridade": "monitorar", "fase": "Prazo inválido"}


def test_compra_excluida_do_pncp_vai_para_historico_com_consultar_detalhe():
    from coletor.pncp import CompraExcluida
    item = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
             "categoria_escopo": "forte", "interesse_borracha": False}]
    ln = _linha(1315, "Aquisição de equipamentos de academia", prio="monitorar", itens=item)
    p = MagicMock()
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Gone")
    sb = _sb([ln])
    r = R.reclassificar(R.SomenteLeitura(sb), p, consultar_detalhe_pncp=True, agora=AGORA)
    assert r["excluidas_do_pncp"] == 1 and r["detalhes_consultados"] == 1
    assert r["linhas"][0]["campos"] == {"prioridade": "historico", "fase": "Excluída do PNCP"}
    sb.atualizar.assert_not_called()
    assert issubclass(CompraExcluida, R.CompraExcluida)


def test_compra_so_de_servico_sai_do_escopo_mesmo_com_objeto_de_equipamento():
    itens = [{"id": 1, "numero_item": 1, "descricao": "Manutenção preventiva e corretiva de aparelhos de musculação",
              "material_ou_servico": "S", "categoria_escopo": "forte", "interesse_borracha": False}]
    ln = _linha(1635, "Contratação de empresa para manutenção de equipamentos de musculação", prio="monitorar",
                itens=itens)
    linha = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA)["linhas"][0]
    assert linha["status"] == "sai_do_escopo"
    assert linha["campos"] == {"categoria_escopo": None, "prioridade": None}

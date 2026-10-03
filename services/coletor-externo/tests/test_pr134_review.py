"""Regressões dos achados do Copilot/Codex no PR #134 (02/10/2026). Offline, dados fictícios."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
import requests

from coletor import pncp as P
from coletor import reclassificar_escopo_pncp as R
from tests.test_pncp import ABERTA as ABERTA_BUSCA, _FakeSbIdempotente, _lic, _pncp_aberto, _sb as _sb_coleta
from tests.test_reclassificar_escopo_pncp import AGORA as AGORA_R, _doc, _linha, _sb

AGORA = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
SUSPENSAO = {"sequencialDocumento": 7, "titulo": "Aviso de suspensão do pregão", "tipoDocumentoNome": "Outros",
             "dataPublicacaoPncp": "2026-09-28T10:00:00", "statusAtivo": True, "url": "u7"}
DETALHE = {"processo": "1/2026", "dataAtualizacao": "2026-09-20T10:00:00"}


def _coletar(p, sb, dry_run=False):
    return P.coletar(p, sb, None, ["x"], "recebendo_proposta", 1, 50, True, False, 10**8, dry_run, modo="leads",
                     agora=AGORA, pausa_segunda_passada=0)


def _tabela(sb, nome):
    return [c.args[1] for c in sb.upsert.call_args_list if c.args[0] == nome]


# ---------- 1. /arquivos falhou: nada é decidido nem gravado ----------
def test_falha_em_arquivos_nao_decide_nem_grava_a_compra():
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = DETALHE
    p.arquivos.side_effect = requests.Timeout("read timeout")
    sb = _sb_coleta()
    r = _coletar(p, sb)
    assert _tabela(sb, "licitacoes_externas") == [] and _tabela(sb, "licitacao_itens") == []
    assert r["erros"] == 1 and r["falha_arquivos"] == 2          # primeira e segunda passada
    assert not any(k.startswith("prioridade_") for k in r)          # nenhuma decisão contada


def test_reexecucao_depois_do_timeout_grava_a_fase_do_documento():
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = DETALHE
    p.arquivos.side_effect = [requests.Timeout("read timeout"), [SUSPENSAO]]
    sb = _sb_coleta()
    r = _coletar(p, sb)
    assert r["falha_arquivos"] == 1 and r["erros"] == 0
    assert len(_tabela(sb, "licitacoes_externas")) == 1
    lic = _lic(sb)
    assert lic["prioridade"] == "monitorar" and lic["fase"] == "Suspensa (documento)"


def test_dry_run_com_arquivos_indisponivel_nao_conta_decisao():
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = DETALHE
    p.arquivos.side_effect = requests.ConnectionError("reset")
    r = _coletar(p, MagicMock(), dry_run=True)
    assert r["erros"] == 1 and not any(k.startswith("prioridade_") for k in r)


def test_410_confirmado_decide_mesmo_sem_arquivos():
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Compra excluída")
    p.arquivos.side_effect = requests.HTTPError("410 Gone")
    sb = _sb_coleta()
    r = _coletar(p, sb)
    assert r["erros"] == 0 and r.get("falha_arquivos", 0) == 0
    lic = _lic(sb)
    assert lic["prioridade"] == "historico" and lic["fase"] == "Excluída do PNCP"
    assert _tabela(sb, "licitacao_documentos") == []


# ---------- 6. coletor marca documento inativado/retirado ----------
def test_coletor_marca_documento_que_saiu_de_arquivos_e_desmarca_o_que_voltou():
    hom = dict(SUSPENSAO, sequencialDocumento=8, titulo="Termo de homologação")
    sb = _FakeSbIdempotente()
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = DETALHE
    p.arquivos.return_value = [SUSPENSAO, hom]
    _coletar(p, sb)
    docs = sb.tabelas["licitacao_documentos"]
    assert {d["arquivo_origem"]: d["removido_do_portal_em"] for d in docs.values()} == {"pncp-7": None, "pncp-8": None}
    p.arquivos.return_value = [SUSPENSAO, dict(hom, statusAtivo=False)]   # órgão inativou a homologação
    r = _coletar(p, sb)
    marcados = {d["arquivo_origem"]: d["removido_do_portal_em"] for d in docs.values()}
    assert marcados["pncp-7"] is None and marcados["pncp-8"] is not None
    assert r["documentos_removidos_do_portal"] == 1
    p.arquivos.return_value = [SUSPENSAO, hom]                             # voltou a ficar ativo
    _coletar(p, sb)
    assert all(d["removido_do_portal_em"] is None for d in docs.values())


# ---------- 2. 410 confirmado vale sem reavaliar itens ----------
SEM_ITENS = dict(objeto="AQUISIÇÃO DE EQUIPAMENTO E MATERIAL PERMANENTE", cat="forte", prio="monitorar")


def _p410(itens_falham=False):
    p = MagicMock()
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Gone")
    if itens_falham:
        p.itens.side_effect = requests.Timeout("itens")
    return p


def test_410_em_linha_sem_itens_vai_para_historico_e_mantem_a_categoria():
    ln = _linha(901, SEM_ITENS["objeto"], cat="forte", prio="monitorar")
    assert not R.objeto_decide(ln)
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), _p410(), consultar_detalhe_pncp=True, agora=AGORA_R)
    linha = r["linhas"][0]
    assert linha["status"] == "muda" and linha["campos"] == {"prioridade": "historico", "fase": "Excluída do PNCP"}
    assert linha["categoria_depois"] == "forte" and r["sem_itens"] == 0


def test_410_com_consulta_de_itens_que_falhou_tambem_vai_para_historico():
    ln = _linha(902, SEM_ITENS["objeto"], cat="forte", prio="monitorar")
    sb = _sb([ln])
    r = R.reclassificar(R.SomenteLeitura(sb), _p410(itens_falham=True), consultar_pncp=True,
                        consultar_detalhe_pncp=True, agora=AGORA_R)
    assert r["falha_consulta"] == 1
    assert r["linhas"][0]["campos"] == {"prioridade": "historico", "fase": "Excluída do PNCP"}
    assert r["transicoes_prioridade"] == {"monitorar->historico": 1}
    sb.atualizar.assert_not_called()


def test_sem_410_falha_de_itens_continua_sem_mexer():
    ln = _linha(903, SEM_ITENS["objeto"], cat="forte", prio="monitorar")
    p = MagicMock()
    p.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP"}
    p.arquivos.return_value = []
    p.itens.side_effect = requests.Timeout("itens")
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_pncp=True, consultar_detalhe_pncp=True,
                        agora=AGORA_R)
    assert r["linhas"][0]["status"] == "falha_consulta" and r["muda_prioridade"] == 0


# ---------- 3. fornecimento explícito de produto em compra só de serviço ----------
def _it(n, desc, ms="S"):
    return {"numeroItem": n, "descricao": desc, "materialOuServico": ms}


@pytest.mark.parametrize("desc", [
    "Fornecimento de halteres para academia",
    "Fornecimento e instalação de esteiras ergométricas",
    "Fornecimento e montagem de equipamentos de musculação",
    "Fornecimento, instalação e montagem de aparelhos de musculação",
    "Fornecimento de todos os equipamentos de musculação da academia",
])
def test_fornecimento_explicito_de_produto_continua_no_escopo(desc):
    assert P.avaliar({"description": "Implantação de academia no ginásio"}, [_it(1, desc)])[0] == "forte"
    assert P.avaliar({"description": desc}, [_it(1, "Instalação"), _it(2, "Frete")])[0] == "forte"


@pytest.mark.parametrize("objeto,desc", [
    ("Manutenção preventiva e corretiva de equipamentos de musculação",
     "Manutenção de esteiras ergométricas com fornecimento de peças"),
    ("Manutenção de aparelhos de musculação", "Manutenção com fornecimento de todas as peças de reposição"),
    ("Locação de equipamentos de musculação", "Locação de esteiras com fornecimento de mão de obra"),
    ("Locação de equipamentos de ginástica e musculação", "Locação mensal de esteira ergométrica"),
    ("Contratação de empresa para manutenção de academia", "Fornecimento de mão de obra para manutenção de aparelhos"),
    ("Contratação de empresa para manutenção de academia", "Fornecimento de serviço de manutenção de esteiras"),
    # redação real das compras 2032/2048/2064 (dry-run de 02/10/2026): manutenção que nomeia a peça continua serviço
    ("Contratação de empresa especializada em manutenção de equipamentos de musculação",
     "MANUTENÇÃO EM DECK DE ESTEIRA COM FORNECIMENTO DAS RESPECTIVAS PEÇAS, COM GARANTIA DE FÁBRICA DA PEÇA"),
    ("Contratação de empresa especializada em manutenção de equipamentos de musculação",
     "TROCA DE ROLDANA DE EQUIPAMENTO DE MUSCULAÇÃO LEG PRESS COM FORNECIMENTO DAS RESPECTIVAS PEÇAS"),
    ("Manutenção e reparo de material esportivo",
     "Reparo de aparelho de musculação, incluído fornecimento e instalação de acolchoamento e de pilha de pesos"),
    ("Locação de equipamentos de musculação", "Fornecimento de esteira ergométrica em regime de locação mensal"),
])
def test_manutencao_e_locacao_continuam_fora(objeto, desc):
    assert P.avaliar({"description": objeto}, [_it(1, desc)])[0] is None


def test_credenciamento_de_oficineiros_continua_fora():
    obj = "Credenciamento de oficineiros para aulas de musculação com fornecimento de profissionais"
    assert P.avaliar({"description": obj}, [_it(1, "Oficineiro de musculação")])[0] is None


# ---------- 4 e 5. títulos de documento ----------
def _arq(titulo):
    return [{"titulo": titulo, "tipoDocumentoNome": "Outros", "dataPublicacaoPncp": "2026-09-29T10:00:00",
             "statusAtivo": True}]


@pytest.mark.parametrize("titulo,sinal", [
    ("Termo de homologação da contratação", "resultado"),
    ("Aviso de suspensão da contratação", "suspensao"),
    ("Revogação da contratação", "revogacao"),
    ("Resultado final do pregão", "resultado"),
    ("Resultado do julgamento", "resultado"),
    ("Resultado da licitação", "resultado"),
    ("Aviso de resultado", "resultado"),
    ("Extrato de Suspensao de Contrato", None),
    ("Rescisão contratual - revogação", None),
    ("Ata de registro de preços - homologação", None),
    ("Termo aditivo - revogação de cláusula", None),
    ("Resultado da impugnação", None),
    ("Resultado de esclarecimento", None),
    ("Resultado preliminar", None),
    ("Resultado da amostra", None),
    ("Resultado", None),
    ("Resultado do julgamento da impugnação ao edital", None),
    ("Resultado de recurso", None),
])
def test_titulos_contratacao_e_resultado_conclusivo(titulo, sinal):
    assert P.sinal_documental(_arq(titulo)) == sinal


def test_reclassificador_respeita_titulo_conclusivo():
    item = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
             "categoria_escopo": "forte", "interesse_borracha": False}]
    imp = _linha(904, "Aquisição de equipamentos de academia", prio="monitorar", itens=item)
    imp["raw"]["data_fim_vigencia"] = "2026-08-01T09:00"
    imp["fase"] = "Em julgamento"
    imp["documentos"] = [_doc("Resultado da impugnação.pdf", "2026-08-10T10:00:00+00:00")]
    hom = dict(imp, id=905, codigo_externo="12345678000199-1-000905/2026",
               documentos=[_doc("Termo de homologação da contratação.pdf", "2026-08-19T10:00:00+00:00")])
    r = R.reclassificar(R.SomenteLeitura(_sb([imp, hom])), agora=AGORA_R)
    por_id = {ln["id"]: ln["campos"] for ln in r["linhas"]}
    assert por_id[904] == {}
    assert por_id[905] == {"prioridade": "historico", "fase": "Homologada (documento)"}


# ---------- 6. documento removido não decide; com detalhe vale a lista ao vivo ----------
ITEM = [{"id": 1, "numero_item": 1, "descricao": "Leg press 45 graus", "material_ou_servico": "M",
         "categoria_escopo": "forte", "interesse_borracha": False}]


def _monitorar_vencido(id_):
    ln = _linha(id_, "Aquisição de equipamentos de academia", prio="monitorar", itens=ITEM)
    ln["raw"]["data_fim_vigencia"] = "2026-08-01T09:00"
    ln["fase"] = "Em julgamento"
    return ln


def test_documento_removido_do_portal_nao_forca_historico():
    ln = _monitorar_vencido(906)
    ln["documentos"] = [dict(_doc("Termo de homologação.pdf", "2026-08-19T10:00:00+00:00"),
                             removido_do_portal_em="2026-09-01T12:00:00+00:00")]
    linha = R.reclassificar(R.SomenteLeitura(_sb([ln])), agora=AGORA_R)["linhas"][0]
    assert linha["campos"] == {} and linha["prioridade_depois"] == "monitorar"
    assert "removido_do_portal_em" in R.SELECT_DOCUMENTOS


def test_com_detalhe_vale_a_lista_atual_de_arquivos():
    ln = _monitorar_vencido(907)
    ln["documentos"] = [_doc("Termo de homologação.pdf", "2026-08-19T10:00:00+00:00")]   # gravado, já retirado
    p = MagicMock()
    p.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "existeResultado": False}
    p.arquivos.return_value = [{"titulo": "Termo de homologação.pdf", "tipoDocumentoNome": "Outros",
                                "dataPublicacaoPncp": "2026-08-19T10:00:00", "statusAtivo": False},
                               {"titulo": "Edital.pdf", "tipoDocumentoNome": "Edital",
                                "dataPublicacaoPncp": "2026-07-01T10:00:00", "statusAtivo": True}]
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_detalhe_pncp=True, agora=AGORA_R)
    assert r["documentos_ao_vivo"] == 1 and r["linhas"][0]["campos"] == {}
    # sem o detalhe, o documento gravado (sem marca de removido) ainda decide: limitação documentada
    sem_det = R.reclassificar(R.SomenteLeitura(_sb([_monitorar_vencido(907) | {"documentos": ln["documentos"]}])),
                              agora=AGORA_R)
    assert sem_det["linhas"][0]["campos"] == {"prioridade": "historico", "fase": "Homologada (documento)"}


def test_com_detalhe_e_arquivos_indisponivel_descarta_o_detalhe():
    ln = _monitorar_vencido(908)
    p = MagicMock()
    p.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "dataEncerramentoProposta": "2026-10-20T09:00"}
    p.arquivos.side_effect = requests.Timeout("arquivos")
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_detalhe_pncp=True, agora=AGORA_R)
    assert r["falha_arquivos"] == 1 and r["linhas"][0]["campos"] == {}


# ---------- 7. leads só com o prazo que a view lê ----------
def test_detalhe_com_prazo_futuro_nao_promove_lead_que_a_view_rebaixaria():
    ln = _monitorar_vencido(909)
    p = MagicMock()
    p.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "dataEncerramentoProposta": "2026-10-20T09:00"}
    p.arquivos.return_value = []
    r = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_detalhe_pncp=True, agora=AGORA_R)
    linha = r["linhas"][0]
    assert linha["campos"] == {} and linha["trava_prioridade"] == "leads_prazo_gravado_vencido"
    assert r["trava_prioridade"] == {"leads_prazo_gravado_vencido": 1}


def test_detalhe_promove_a_leads_quando_o_prazo_gravado_esta_aberto():
    ln = _linha(910, "Aquisição de equipamentos de academia", prio="monitorar", itens=ITEM)   # raw aberto
    ln["fase"] = None
    p = MagicMock()
    p.compra.return_value = {"situacaoCompraNome": "Divulgada no PNCP", "dataEncerramentoProposta": "2026-10-20T09:00"}
    p.arquivos.return_value = []
    linha = R.reclassificar(R.SomenteLeitura(_sb([ln])), p, consultar_detalhe_pncp=True, agora=AGORA_R)["linhas"][0]
    assert linha["campos"] == {"prioridade": "leads", "fase": "Recebendo propostas"}


# ================= 2ª rodada do Copilot sobre fa26946 (02/10/2026) =================
# ---------- 2.1 trava de serviço também no ramo FORNECE_PRODUTO ----------
@pytest.mark.parametrize("objeto,desc", [
    ("Fornecimento de aparelhos de musculação em regime de locação mensal", "Locação mensal de esteira ergométrica"),
    ("Fornecimento de aparelhos de musculação em regime de locação mensal",
     "Fornecimento de aparelhos de musculação em regime de locação mensal"),
    ("Manutenção de aparelhos de musculação com aquisição de peças de reposição",
     "Manutenção de esteira com aquisição de peças"),
    ("Manutenção de aparelhos de musculação com aquisição de peças de reposição",
     "Manutenção de aparelhos de musculação com aquisição de peças de reposição"),
    ("Contratação de empresa para manutenção corretiva de equipamentos de academia",
     "Manutenção corretiva com fornecimento de materiais e peças"),
    ("Aluguel de equipamentos de musculação", "Aquisição de equipamentos de musculação sob regime de aluguel"),
    ("Troca de cabos de aparelhos de musculação", "Troca de cabos com aquisição de cabos de aço"),
])
def test_trava_de_servico_vale_para_fornece_produto(objeto, desc):
    assert not P.fornece_produto(P.normalizar(desc))
    assert P.avaliar({"description": objeto}, [_it(1, desc)])[0] is None


@pytest.mark.parametrize("desc", [
    "Aquisição de esteiras ergométricas com manutenção preventiva durante a garantia",
    "Aquisição de equipamentos de musculação, incluindo instalação, treinamento e manutenção",
    "Fornecimento e instalação de aparelhos de musculação com assistência técnica e manutenção no período de garantia",
    "Compra de halteres e anilhas para substituição dos atuais",
    # redação real da 1894 (dry-run de 02/10/2026): aquisição de equipamento novo junto com a manutenção
    ("Prestação de serviços de revitalização, manutenção e recuperação de equipamentos de academia, com fornecimento "
     "de materiais, peças, componentes e acessórios, bem como aquisição de novos equipamentos e itens complementares"),
])
def test_compra_com_manutencao_acessoria_continua_produto(desc):
    assert P.fornece_produto(P.normalizar(desc))
    assert P.avaliar({"description": "Implantação de academia no ginásio"}, [_it(1, desc)])[0] == "forte"


# ---------- 2.2 veto de etapa também na homologação/adjudicação ----------
@pytest.mark.parametrize("titulo", [
    "Pedido de adjudicação",
    "Recurso contra a homologação",
    "Impugnação da homologação",
    "Solicitação de homologação",
    "Esclarecimento sobre os critérios de adjudicação e homologação",
    "Contrarrazões ao recurso contra a adjudicação",
    "Requerimento de adjudicação parcial",
    "Adjudicação preliminar",
    "Homologação da amostra",
    "Minuta do termo de homologação",
])
def test_etapa_nao_conta_como_homologacao(titulo):
    assert P.sinal_documental(_arq(titulo)) is None


@pytest.mark.parametrize("titulo", [
    "Termo de homologação", "Termo de adjudicação e homologação", "Adjudicação e homologação do pregão",
    "Termo de homologação e habilitação", "TERMO_DE_HOMOLOGACAO_PE_35_2026.pdf",
])
def test_ato_conclusivo_de_homologacao_continua_resultado(titulo):
    assert P.sinal_documental(_arq(titulo)) == "resultado"


def test_fase_da_compra_aberta_com_pedido_de_adjudicacao_continua_oportunidade():
    c = {"description": "Aquisição de esteiras", "situacao_nome": "Divulgada no PNCP",
         "data_fim_vigencia": "2026-10-13T09:30"}
    fase, prio, _ = P.fase_da_compra(c, False, agora=AGORA, documentos=_arq("Pedido de adjudicação"))
    assert prio == "leads" and fase != "Homologada (documento)"


# ---------- 2.3 fallback status_busca=encerradas depois dos documentos ----------
SEM_PRAZO = {"description": "Aquisição de esteiras", "situacao_nome": "Divulgada no PNCP"}


def test_busca_encerradas_sem_prazo_com_suspensao_vigente_vai_para_monitorar():
    assert P.motivo_prioridade(SEM_PRAZO, False, agora=AGORA, status_busca="encerradas")[0] == "historico"
    fase, prio, _ = P.fase_da_compra(SEM_PRAZO, False, agora=AGORA, status_busca="encerradas",
                                     documentos=[SUSPENSAO], retificada_em="2026-09-20T10:00:00")
    assert (fase, prio) == ("Suspensa (documento)", "monitorar")


def test_busca_encerradas_sem_prazo_suspensao_retificada_ou_sem_documento_segue_historico():
    assert P.fase_da_compra(SEM_PRAZO, False, agora=AGORA, status_busca="encerradas", documentos=[])[1] == "historico"
    retificada = P.fase_da_compra(SEM_PRAZO, False, agora=AGORA, status_busca="encerradas", documentos=[SUSPENSAO],
                                  retificada_em="2026-09-29T10:00:00")
    assert retificada[1] == "historico"


def test_busca_encerradas_sem_prazo_homologacao_documental_da_fase():
    fase, prio, _ = P.fase_da_compra(SEM_PRAZO, False, agora=AGORA, status_busca="encerradas",
                                     documentos=_arq("Termo de homologação"))
    assert (fase, prio) == ("Homologada (documento)", "historico")


def test_sinal_oficial_continua_antes_do_documento():
    homologada = dict(SEM_PRAZO, existeResultado=True)
    fase, prio, _ = P.fase_da_compra(homologada, True, agora=AGORA, status_busca="encerradas", documentos=[SUSPENSAO])
    assert prio == "historico" and fase != "Suspensa (documento)"


# ---------- 2.4 410 tratado mesmo quando itens/resultados falham ----------
def _sb_com_linha(codigo, prio="leads"):
    sb = _FakeSbIdempotente()
    sb.upsert("licitacoes_externas", [{"fonte": "pncp", "codigo_externo": codigo, "prioridade": prio,
                                       "fase": None, "categoria_escopo": "forte"}], "fonte,codigo_externo")
    return sb


@pytest.mark.parametrize("falha", ["itens", "resultados"])
def test_coletor_410_com_itens_ou_resultados_falhando_marca_linha_gravada(falha):
    codigo = ABERTA_BUSCA["numero_controle_pncp"]
    sb = _sb_com_linha(codigo)
    p = _pncp_aberto([ABERTA_BUSCA])
    p.itens.return_value = [dict(it, temResultado=True) for it in p.itens.return_value]   # resultados é consultado
    getattr(p, falha).side_effect = requests.Timeout(f"{falha} timeout")
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Gone")
    r = _coletar(p, sb)
    linha = next(iter(sb.tabelas["licitacoes_externas"].values()))
    assert linha["prioridade"] == "historico" and linha["fase"] == "Excluída do PNCP"
    assert linha["categoria_escopo"] == "forte"                      # dados anteriores preservados
    assert r["erros"] == 0 and r["excluidas_sem_itens"] == 1 and r["excluidas_marcadas"] == 1
    assert set(sb.tabelas) == {"licitacoes_externas"}                # nada de itens/resultados/documentos
    p.arquivos.assert_not_called()


def test_coletor_410_sem_linha_gravada_nao_insere_nada():
    sb = _FakeSbIdempotente()
    p = _pncp_aberto([ABERTA_BUSCA])
    p.itens.side_effect = requests.Timeout("itens")
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Gone")
    r = _coletar(p, sb)
    assert sb.tabelas.get("licitacoes_externas", {}) == {} and r["erros"] == 0 and "excluidas_marcadas" not in r


def test_coletor_itens_falhando_sem_410_nao_decide_nem_grava():
    codigo = ABERTA_BUSCA["numero_controle_pncp"]
    sb = _sb_com_linha(codigo, prio="monitorar")
    for compra in ({"side_effect": None, "return_value": DETALHE},
                   {"side_effect": requests.Timeout("detalhe"), "return_value": None}):
        p = _pncp_aberto([ABERTA_BUSCA])
        p.itens.side_effect = requests.Timeout("itens")
        p.compra.side_effect, p.compra.return_value = compra["side_effect"], compra["return_value"]
        r = _coletar(p, sb)
        linha = next(iter(sb.tabelas["licitacoes_externas"].values()))
        assert linha["prioridade"] == "monitorar" and linha["fase"] is None
        assert r["erros"] == 1 and not any(k.startswith("prioridade_") for k in r)


def test_coletor_dry_run_410_sem_itens_so_conta():
    sb = MagicMock()
    p = _pncp_aberto([ABERTA_BUSCA])
    p.itens.side_effect = requests.Timeout("itens")
    p.compra.side_effect = RuntimeError("PNCP detalhe: 410 Gone")
    r = _coletar(p, sb, dry_run=True)
    assert r["excluidas_sem_itens"] == 1 and not sb.atualizar.called and not sb.upsert.called


# ================= 3ª rodada do Copilot sobre 0eec5b0 (02/10/2026) =================
# ---------- 3.1 "aquisição de serviço(s)" não fornece produto; exceção só com o equipamento como objeto ----------
@pytest.mark.parametrize("desc", [
    "Aquisição de serviços de manutenção preventiva de aparelhos de musculação",
    "Aquisição de serviço de manutenção corretiva de esteiras ergométricas",
    "Compra de serviços de instalação de equipamentos de academia",
    "Aquisição de prestação de serviços de reparo em aparelhos de ginástica",
    "Manutenção de aparelhos de musculação com aquisição de equipamentos de proteção individual",
    "Serviço de manutenção de esteiras com aquisição de peças de equipamentos",
])
def test_aquisicao_de_servico_nao_fornece_produto(desc):
    assert not P.fornece_produto(P.normalizar(desc))
    assert P.avaliar({"description": desc}, [_it(1, desc)])[0] is None


@pytest.mark.parametrize("desc", [
    "Aquisição de aparelhos de musculação com manutenção preventiva no período de garantia",
    "Aquisição de equipamentos de academia, incluindo serviços de instalação e manutenção",
    "Manutenção dos aparelhos existentes e aquisição de novos equipamentos de musculação",
])
def test_aquisicao_do_equipamento_com_servico_acessorio_continua_produto(desc):
    assert P.fornece_produto(P.normalizar(desc))
    assert P.avaliar({"description": "Implantação de academia no ginásio"}, [_it(1, desc)])[0] == "forte"


# ---------- 3.2 filtro único de etapa em TODOS os sinais documentais ----------
@pytest.mark.parametrize("titulo", [
    "Pedido de revogação da licitação", "Minuta do termo de revogação", "Pedido de suspensão do pregão",
    "Indeferimento do pedido de suspensão do pregão", "Parecer de Revogação", "Parecer jurídico sobre a homologação",
    "Despacho - encaminha para homologação", "Intenção de recurso contra a adjudicação",
    "Proposta de anulação do certame", "Solicitação de suspensão", "SOLICITAO_DE_REVOGAO",
    "Requerimento de anulação", "Recurso administrativo - suspensão", "Impugnação - pedido de suspensão",
    "Esclarecimento sobre suspensão", "Contrarrazões à revogação", "Revogação provisória (minuta)",
    "Homologação - minuta", "Resultado de habilitação", "AVISO_DE_SUSPENSAO_PARCIAL_LOTE_4",
    "Revogação da suspensão do pregão", "Aviso de reabertura após suspensão", "Suspensão revogada",
])
def test_documento_de_etapa_nao_aciona_nenhum_sinal(titulo):
    assert P.sinal_documental(_arq(titulo)) is None


@pytest.mark.parametrize("titulo,sinal", [
    ("Termo de revogação", "revogacao"), ("Aviso de revogação da licitação", "revogacao"),
    ("Decisão de anulação do certame", "revogacao"), ("TERMO_DE_REVOGAO_DE_LICITAO__AVISO", "revogacao"),
    ("Revogação do pregão suspenso", "revogacao"),
    ("Aviso de suspensão", "suspensao"), ("DESPACHO DE SUSPENSAO PE 0262026", "suspensao"),
    ("COMUNICADO SUSPENSAO", "suspensao"), ("Termo de suspensão assinado", "suspensao"),
    ("Despacho de Adjudicação e Homologação", "resultado"), ("Termo de homologação", "resultado"),
    ("Despacho homologatório", "resultado"), ("Aviso de resultado", "resultado"),
])
def test_ato_efetivo_continua_valendo(titulo, sinal):
    assert P.sinal_documental(_arq(titulo)) == sinal


def test_compra_aberta_com_pedido_de_revogacao_ou_suspensao_continua_lead():
    c = {"description": "Aquisição de esteiras", "situacao_nome": "Divulgada no PNCP",
         "data_fim_vigencia": "2026-10-13T09:30"}
    for titulo in ("Pedido de revogação da licitação", "Indeferimento do pedido de suspensão do pregão"):
        fase, prio, _ = P.fase_da_compra(c, False, agora=AGORA, documentos=_arq(titulo))
        assert (fase, prio) == ("Recebendo propostas", "leads"), titulo


# ---------- 3.4 prazo do detalhe também no raw/data_fim que a view lê ----------
def test_busca_defasada_grava_prazo_do_detalhe_e_preserva_o_da_busca():
    vencida = dict(ABERTA_BUSCA, data_fim_vigencia="2026-09-20T09:30")      # busca: prazo já passou
    p = _pncp_aberto([vencida])
    p.compra.return_value = dict(DETALHE, dataEncerramentoProposta="2026-10-20T09:30:00")   # detalhe: reaberta
    p.arquivos.return_value = []
    sb = _sb_coleta()
    _coletar(p, sb)
    lic = _lic(sb)
    assert lic["prioridade"] == "leads" and lic["fase"] == "Recebendo propostas"
    assert lic["raw"]["data_fim_vigencia"] == "2026-10-20T09:30:00"
    assert lic["raw"]["data_fim_vigencia_busca"] == "2026-09-20T09:30"
    assert lic["raw"]["data_fim_vigencia_fonte"] == "detalhe"
    assert lic["data_fim"].startswith("2026-10-20")
    # a regra da view (raw.data_fim_vigencia em BRT, senão data_fim) lê o mesmo prazo: não rebaixa
    assert P._instante(lic["raw"]["data_fim_vigencia"]) > AGORA
    assert vencida["data_fim_vigencia"] == "2026-09-20T09:30"                # item da busca não é alterado


def test_detalhe_com_prazo_vencido_e_busca_aberta_grava_o_vencido():
    p = _pncp_aberto([ABERTA_BUSCA])
    p.compra.return_value = dict(DETALHE, dataEncerramentoProposta="2026-09-25T09:30:00")
    p.arquivos.return_value = []
    sb = _sb_coleta()
    _coletar(p, sb)
    lic = _lic(sb)
    assert lic["prioridade"] == "monitorar" and lic["fase"] == "Em julgamento"
    assert lic["raw"]["data_fim_vigencia"] == "2026-09-25T09:30:00"


def test_sem_prazo_no_detalhe_ou_igual_o_raw_e_a_busca():
    assert P.raw_com_prazo_do_detalhe(ABERTA_BUSCA, None) is ABERTA_BUSCA
    assert P.raw_com_prazo_do_detalhe(ABERTA_BUSCA, DETALHE) is ABERTA_BUSCA
    igual = {"dataEncerramentoProposta": ABERTA_BUSCA["data_fim_vigencia"]}
    assert P.raw_com_prazo_do_detalhe(ABERTA_BUSCA, igual) is ABERTA_BUSCA

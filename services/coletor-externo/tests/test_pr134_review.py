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

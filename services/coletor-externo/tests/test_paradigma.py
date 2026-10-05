"""Testes offline do adaptador Paradigma com respostas reais do portal FIESC (capturadas em 24/09/2026)."""
import json
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from coletor import paradigma as P

NULO = "\u0013\u0012\u0012\u0013"
DEC_MIN = -79228162514264337593543950335

# PesquisarProcessos (linha real, reduzida)
LISTA = [{"nCdProcesso": 9615, "nCdOrigem": 8003, "sNrEdital": "SDE 2026001107",
          "sNmEmpresa": "100 - SESI/SC - DEPARTAMENTO REGIONAL", "nCdModulo": 59,
          "sNmModalidade": "Processo de seleção sem disputa",
          "sDsObjeto": "MATERIAL DIVERSOS - Centro de Distribuição CD"},
         {"nCdProcesso": 9619, "nCdOrigem": -2147483648, "sNrEdital": "CRED 030/2026",
          "sDsObjeto": "Serviços de Medicina do Trabalho"}]

# PesquisarProcessoDetalhes(7752) — real
DETALHE_7752 = {
    "nCdProcesso": 7752, "sNrProcesso": "CDE 2026000149", "sNrEdital": "CDE 2026000149",
    "sDsObjeto": "Aquisição de acessórios e equipamentos, de linha comercial, para academias das Unidades do SESI, "
                 "conforme condições e exigências do Chamamento Público e seus anexos.",
    "tDtInicial": "/Date(1784300000000)/", "tDtFinal": "/Date(-62135589600000)/",
    "tDtHomologacao": "/Date(1788961898763)/", "nIdTipoApuracao": 1, "nCdAnexo": 10499308,
    "sDsSituacao": "Homologado", "sDsFase": "Resultado do processo", "nCdFase": 6,
    "sNmEmpresa": "100 - SESI/SC - DEPARTAMENTO REGIONAL", "nCdModulo": 59, "nCdSituacao": 4,
    "sNmModalidade": "Processo de Seleção com Disputa (Proposta comercial, Disputa aberta, Julgamento, "
                     "Qualificação e Resultado do Processo)",
    "sNmModalidadeTipo": NULO, "dVlTotal": DEC_MIN,
}
# PesquisarProcessoDetalheItemProduto(7752, nCdLote=0) — real (2 de 5)
ITENS_7752 = [
    {"nCdItem": 28909, "nCdItemSequencial": 1, "dVlReferencia": 147639.76,
     "sDsItem": "1 - LOTE 1 - Equipamentos de Cárdio", "sStItem": "Homologado", "dQtItem": 1,
     "sDsUnidadeMedida": "Unidade"},
    {"nCdItem": 28915, "nCdItemSequencial": 4, "dVlReferencia": 19612.38,
     "sDsItem": "4 - LOTE 4 - Equipamentos de Musculação com peso livre (anilhas) - Homologados",
     "sStItem": "Homologado", "dQtItem": 1, "sDsUnidadeMedida": "Unidade"},
]
# PesquisarProcessoClassificacaoItemLoteEmpresas(28909) — real
RANKING_28909 = [
    {"nCdFase": 6, "nNrRanking": 1, "sNmEmpresa": "JOHNSON INDUSTRIAL DO BRASIL LTDA",
     "sDsStatus": "Classificada", "dVlProposta": 120000},
    {"nCdFase": 6, "nNrRanking": 0, "sNmEmpresa": "JOHNSON INDUSTRIAL DO BRASIL LTDA",
     "sDsStatus": "Classificada", "dVlProposta": 135905.06},
]
# Item de cotação (SDE 2025001643, SESI/SC Academia Joinville III) — real
ITEM_COTACAO = {
    "nCdItem": 22373, "nCdItemSequencial": 2, "dVlReferencia": 5000, "dQtItem": 1, "sDsUnidadeMedida": "Unidade",
    "sStItem": "Homologado (Fracassado)",
    "sDsItem": "2 - Acessorios para pilates e equipamentos de academia em geral\r\nVariação: Equipamentos para academia"
               "\r\nDescrição: Simplificado: Power Rack Parede \r\n- Estrutura: perfil de aço tubular",
}
ITEM_SERVICO = {"nCdItem": 1, "nCdItemSequencial": 1, "dVlReferencia": 24850, "dQtItem": 1,
                "sDsItem": "1 - Servicos de manutencao e reparo de equipamentos de academia\r\nVariação: Equipamentos de academia"}


def test_valor_sentinela_e_zero():
    assert P.valor(DEC_MIN) is None
    assert P.valor(0) is None
    assert P.valor(-3) is None
    assert P.valor(147639.76) == 147639.76


def test_partes_item_cotacao():
    p = P.partes_item(ITEM_COTACAO["sDsItem"])
    assert p["sequencial"] == 2
    assert p["categoria"] == "Acessorios para pilates e equipamentos de academia em geral"
    assert p["variacao"] == "Equipamentos para academia"


def test_classifica_itens_material_e_servico():
    assert P.classificar_item(ITEM_COTACAO)[0] == "forte"
    assert P.classificar_item(ITENS_7752[1])[0] == "forte"
    cat, borr, ms = P.classificar_item(ITEM_SERVICO)
    assert (cat, borr, ms) == (None, False, "S")


def test_objeto_generico_de_cotacao_entra_pelos_itens():
    d = dict(DETALHE_7752, sDsObjeto="EQUIPAMENTOS E MATERIAIS DE ESPORTE E LAZER - [FRETE CIF | PAGAMENTO 45 DIAS]")
    cat, _ = P.avaliar_processo(d, [ITEM_COTACAO])
    assert cat == "forte"


def test_status_e_acionabilidade():
    assert P.status_normalizado("Homologado") == "homologada"
    assert P.status_normalizado("Homologado (Fracassado)") == "sem_vencedor"
    assert P.status_normalizado("Cancelado") == "cancelada"
    assert P.status_normalizado(None) == "desconhecida"
    agora = datetime(2026, 9, 24, tzinfo=timezone.utc)
    assert P.acionabilidade("homologada", None, agora) == "NOT_ACTIONABLE"
    assert P.acionabilidade("aberta", "2026-10-01T00:00:00+00:00", agora) == "ACTIONABLE"
    assert P.acionabilidade("aberta", None, agora) == "ACTIONABILITY_UNRESOLVED"  # prazo nulo nunca vira oportunidade


def test_status_normalizado_textos_reais():
    # Textos reais de portais Paradigma (SFIEC, FIESC, SEST SENAT, etc.)
    # Recebendo proposta / aberta
    for s in ("Em Andamento", "Recebendo Propostas", "Publicado", "Aberto para Propostas", "Aberto"):
        assert P.status_normalizado(s) == "aberta", s
    # Julgamento / disputa
    for s in ("Em Julgamento", "Análise de Propostas", "Em Habilitação", "Em Negociação", "Disputa Aberta", "Fase de Lances"):
        assert P.status_normalizado(s) == "em_julgamento", s
    # Suspensa
    for s in ("Suspenso", "Processo Suspenso", "Fase Suspensa"):
        assert P.status_normalizado(s) == "suspensa", s
    # Encerrada / Homologada / Adjudicada
    for s in ("Homologado", "Encerrado", "Finalizado", "Adjudicado", "Concluído", "Concluido"):
        assert P.status_normalizado(s) in ("homologada", "encerrada"), s
    # Cancelada / Revogada / Anulada
    for s in ("Cancelado", "Revogado", "Anulado"):
        assert P.status_normalizado(s) == "cancelada", s
    # Fracassada / Deserta
    for s in ("Fracassado", "Deserto", "Homologado (Fracassado)", "Homologado (Deserto)"):
        assert P.status_normalizado(s) == "sem_vencedor", s
    # Homologado parcialmente fracassado / deserto -> homologada
    for s in ("Homologado parcialmente fracassado", "Homologado parcialmente deserto",
              "Homologado Parcialmente Fracassado", "Homologação Parcial"):
        assert P.status_normalizado(s) == "homologada", s
    # Desconhecida
    for s in ("Status Inusitado XYZ", "Qualquer Outra Coisa", "", None):
        assert P.status_normalizado(s) == "desconhecida", s


def test_prioridade_da_compra_regras():
    agora = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
    # 1. Aberta com prazo futuro -> leads
    fim_futuro_utc = "2026-10-03T15:00:00+00:00"
    prio, motivo = P.prioridade_da_compra("aberta", fim_futuro_utc, agora)
    assert prio == "leads" and motivo == "recebendo proposta"

    # Aberta com prazo passado -> monitorar
    fim_passado_utc = "2026-10-01T15:00:00+00:00"
    prio, motivo = P.prioridade_da_compra("aberta", fim_passado_utc, agora)
    assert prio == "monitorar" and motivo == "prazo de proposta vencido"

    # Aberta sem prazo -> monitorar
    prio, motivo = P.prioridade_da_compra("aberta", None, agora)
    assert prio == "monitorar" and motivo == "aberta sem prazo de proposta"

    # 2. Em julgamento / suspensa -> monitorar
    assert P.prioridade_da_compra("em_julgamento", fim_futuro_utc, agora)[0] == "monitorar"
    assert P.prioridade_da_compra("suspensa", fim_futuro_utc, agora)[0] == "monitorar"

    # 3. Encerrada, homologada, cancelada, sem_vencedor -> historico
    for st in ("encerrada", "homologada", "cancelada", "sem_vencedor"):
        assert P.prioridade_da_compra(st, fim_futuro_utc, agora)[0] == "historico"

    # 4. Desconhecida -> None (com aviso no log)
    prio, motivo = P.prioridade_da_compra("desconhecida", fim_futuro_utc, agora)
    assert prio is None
    assert "desconhecido" in motivo


def test_prioridade_fuso_horario_brasilia():
    # tDtFinal do Paradigma sem fuso (ex: 2026-10-02T13:00:00)
    # Se agora for 12:00 BRT (15:00 UTC) e o fim for 13:00 BRT (16:00 UTC):
    # fim no futuro em BRT -> leads
    agora_brt = datetime(2026, 10, 2, 15, 0, tzinfo=timezone.utc)  # 12:00 BRT
    fim_sem_fuso = "2026-10-02T13:00:00"  # 13:00 BRT = 16:00 UTC
    prio, _ = P.prioridade_da_compra("aberta", fim_sem_fuso, agora_brt)
    assert prio == "leads"

    # Se agora for 14:00 BRT (17:00 UTC) e o fim for 13:00 BRT:
    # fim no passado em BRT -> monitorar
    agora_brt_depois = datetime(2026, 10, 2, 17, 0, tzinfo=timezone.utc)
    prio, _ = P.prioridade_da_compra("aberta", fim_sem_fuso, agora_brt_depois)
    assert prio == "monitorar"


def test_dry_run_mostra_prioridade(capsys):
    portal = MagicMock()
    portal.fonte = P.FONTES["sfiec"]
    d = {
        "nCdProcesso": 103, "sNrEdital": "PE000192023", "sDsSituacao": "Homologado",
        "sDsObjeto": "Aquisição de Equipamentos de Crossfit", "tDtFinal": None,
        "nCdModulo": 18,
    }
    portal.detalhes.return_value = d
    portal.itens.return_value = []
    resumo = {"processos": 0, "no_escopo": 0, "itens_escopo": 0, "itens_catalogo": 0,
              "resultados": 0, "itens_com_vencedor": 0, "alertas": 0, "erros": 0}
    P.processar_processo(portal, None, 103, 18, resumo, dry_run=True, com_resultados=False,
                       produtos=None, forcar=True)
    out = capsys.readouterr().out
    assert "Homologado | historico | Aquisição" in out


def test_linha_licitacao_fiesc():
    li = P.linha_licitacao(P.FONTES["fiesc"], DETALHE_7752, "forte", False)
    assert li["fonte"] == "fiesc" and li["id_externo"] == 7752 and li["modulo"] == 59
    assert li["uf"] == "SC" and li["regulamento"] == "RCA"
    assert li["valor_total"] is None  # Decimal.MinValue não vira número
    assert li["data_homologacao"].startswith("2026-09")
    assert li["status_normalizado"] == "homologada" and li["acionabilidade"] == "NOT_ACTIONABLE"
    assert li["prioridade"] == "historico"
    assert li["escopo_estado"] == "CLASSIFICATION_CANDIDATE"


def test_linha_licitacao_omite_prioridade_quando_desconhecida():
    # Situação desconhecida -> prioridade é None e NÃO deve constar nas chaves do dict
    # para não sobrescrever valor preexistente no Supabase (merge-duplicates)
    d_desconhecido = dict(DETALHE_7752, sDsSituacao="Situação Desconhecida Inusitada")
    li = P.linha_licitacao(P.FONTES["fiesc"], d_desconhecido, "forte", False)
    assert "prioridade" not in li
    assert li["status_normalizado"] == "desconhecida"

    # Situação Homologado -> tem a chave prioridade com valor 'historico'
    d_homologado = dict(DETALHE_7752, sDsSituacao="Homologado")
    li_homolog = P.linha_licitacao(P.FONTES["fiesc"], d_homologado, "forte", False)
    assert "prioridade" in li_homolog
    assert li_homolog["prioridade"] == "historico"


def test_linhas_itens_e_resultados():
    li = P.linhas_itens(10, ITENS_7752)
    assert [i["numero_item"] for i in li] == [1, 4]
    assert li[0]["valor_total_estimado"] == 147639.76
    res = P.linhas_resultados(10, 1, RANKING_28909, "2026-09-09T00:00:00+00:00")
    assert len(res) == 1  # nNrRanking=0 é proposta anterior (histórico), não resultado
    venc = [r for r in res if r["vencedor"]]
    assert len(venc) == 1 and venc[0]["valor_proposta"] == 120000 and venc[0]["ranking"] == 1
    assert all(r["fornecedor_cnpj"] is None for r in res)  # Paradigma não expõe CNPJ no ranking


def test_fontes_bloqueadas_por_robots():
    with pytest.raises(PermissionError):
        P.PortalParadigma(P.FONTES["sescsp"], sessao=MagicMock())
    P.PortalParadigma(P.FONTES["fiesc"], sessao=MagicMock())  # permitido


def test_ws_sem_resposta_nao_vira_lista_vazia(monkeypatch):
    monkeypatch.setattr(P.time, "sleep", lambda _s: None)
    s = MagicMock()
    s.post.return_value.status_code = 200
    s.post.return_value.json.return_value = {"d": None}
    p = P.PortalParadigma(P.FONTES["fiesc"], delay=0, sessao=s)
    with pytest.raises(RuntimeError):
        p.listar("academia")


def test_coletar_dry_run_usa_nCdOrigem():
    portal = MagicMock()
    portal.fonte = P.FONTES["fiesc"]
    portal.listar.return_value = LISTA
    portal.detalhes.return_value = DETALHE_7752
    portal.itens.return_value = ITENS_7752
    r = P.coletar(portal, None, ["academia"], paginas=1, dry_run=True)
    portal.detalhes.assert_called_once_with(8003, 59)  # id do processo = nCdOrigem; sentinela é ignorada
    assert r["no_escopo"] == 1 and r["itens_escopo"] == 2 and r["erros"] == 0


def test_coletar_respeita_modulo_da_listagem():
    """FIEMS/SFIEC (26/09/2026): pregão no módulo 18; detalhe com 59 volta vazio e o processo sumia."""
    portal = MagicMock()
    portal.fonte = P.FONTES["fiems"]
    portal.listar.return_value = [{"nCdOrigem": 1108, "nCdProcesso": 1256, "nCdModulo": 18,
                                   "sDsObjeto": "Aquisição por compra única de equipamentos de ginástica/ academia"}]
    portal.detalhes.return_value = None
    P.coletar(portal, None, ["academia"], paginas=1, dry_run=True)
    portal.detalhes.assert_called_once_with(1108, 18)


def test_modulo_de_sentinela_e_ausente():
    assert P.modulo_de({"nCdModulo": 18}) == 18
    assert P.modulo_de({"nCdModulo": -2147483648}) == 59
    assert P.modulo_de({}) == 59 and P.modulo_de(None) == 59


def test_novos_tenants_paradigmabs_bloqueados():
    for slug in ("sescdn", "sescrj", "sescba", "sescsp", "sesc_senac_rs"):
        assert P.FONTES[slug].coleta_automatica is False
        assert "paradigmabs.com.br" in P.FONTES[slug].base
    assert P.FONTES["fiemg"].coleta_automatica is False  # Cloudflare bloqueia cliente automatizado
    for slug in ("firjan", "fiergs", "findes", "fieb", "fiems", "fiemt", "sfiec"):
        assert P.FONTES[slug].coleta_automatica is True


def test_itens_academia_formato_codigo_sfiec():
    """SFIEC usa 'AI0300090-LEG PRESS 45o' (sem 'N - '); número vem de nCdItemSequencial."""
    its = [{"nCdItem": 15711, "nCdItemSequencial": 1, "sDsItem": "AI0300090-LEG PRESS 45o", "dQtItem": 2,
            "sDsUnidadeMedida": "UNIDADE", "dVlReferencia": 13556.26},
           {"nCdItem": 15713, "nCdItemSequencial": 3, "sDsItem": "AI0300036-PECK DECK C/ CRUCIFIXO", "dQtItem": 1,
            "sDsUnidadeMedida": "UNIDADE", "dVlReferencia": 17869.98}]
    li = P.linhas_itens(None, its)
    assert [i["numero_item"] for i in li] == [1, 3]
    assert li[0]["valor_total_estimado"] == 27112.52


# ---- v14: vocabulário de item + catálogo SFIEC (26/09/2026) ----
CATALOGO_NO_ESCOPO = [
    "AI0300036-PECK DECK C/ CRUCIFIXO", "AI0300062-MAQUINA ADUTORA-ABDUTORA", "AI0300047-ESTEIRA PROF. LX 160 G2",
    "AI0300070-STEP 13CM", "AI0300084-HACK 45o REGULAGEM", "AI0300067-CADEIRA FLEXO E EXTENSORA",
    "NE5300010-WALL BALL TREINO CROSS 12LBS", "NE5300020-MINI BAND REVESTIDA LEVE CET", "NE5300024-BOLA SUICA PVC 55CM",
    "NE5300029-BOLA HANDBOL H1 PU BUTIL 49CM", "NE5300035-CHAPEU CHINES CONE 19X8CM", "MC0600016-BARRA PARA PULLEY (BARRA DUPLA",
    "MC0600031-BOLA MEDICINE DE BORRACHA PESO", "MC0600110-ELATICO DE TRACAO", "MC0600039-CONJUNTO DE BRINQUEDOS QUE AFU",
]
CATALOGO_FORA = [
    "AI0300003-BALANCA ANTROPOMETRICA E ESTAD", "AI0300017-ESTADIOMETRO PORTATIL ALUMINIO", "MC0600015-APARELHO PARA AFERICAO DA PRES",
    "MC0600028-BANDEIRA DO EST CEARA OFICIAL", "MC0600051-ALFABETO DO A AO Z EM EVA", "MC0600097-MASSAGEADOR DE CABECA",
    "NE5300040-CRONOMETRO DIGITAL",
]
INDUSTRIAIS_FORA = [
    "1 - MOTOR TRIFÁSICO 220/380 V 1745RPM 01CV", "1 - POLIA DE ALUMINIO PARA MOTOR 100MM", "1 - STEP MOTOR NEMA 17",
    "1 - ESPALDAR PARA CADEIRA DE ESCRITORIO", "1 - MANETE DE FREIO MOTOCICLETA", "1 - COLETE REFLETIVO",
    "1 - REDE DE COMPUTADORES CABO CAT6", "1 - ESTEIRA TRANSPORTADORA KIT DIDATICO", "1 - ANILHA DE VEDACAO 1/2",
    "1 - LOCACAO DE ESTEIRA ERGOMETRICA E ELETROCARDIOGRAFO",
]


def test_catalogo_itens_academia_entram():
    for s in CATALOGO_NO_ESCOPO:
        assert P.classificar_item({"sDsItem": s})[0], s


def test_catalogo_itens_fora_do_escopo():
    for s in CATALOGO_FORA + INDUSTRIAIS_FORA:
        assert P.classificar_item({"sDsItem": s})[0] is None, s


def test_prefixo_de_catalogo_so_para_ambiguos():
    # sem código não entra (ambíguo); com código AI03/NE53/MC06 entra marcado como 'catalogo'
    assert P.classificar_item({"sDsItem": "1 - ESPALDAR EM MADEIRA MACICA COM"})[0] is None
    cat, _, _, metodo = P.classificar_item_detalhe({"sDsItem": "MC0600007-ESPALDAR EM MADEIRA MACICA COM"})
    assert cat == "forte" and metodo == "catalogo"
    assert P.classificar_item_detalhe({"sDsItem": "AI0300036-PECK DECK C/ CRUCIFIXO"})[3] == "regra_item"
    li = P.linhas_itens(None, [{"nCdItemSequencial": 1, "sDsItem": "NE5300046-BOMBA AR COMPR DIGIT PORTATIL"}])
    assert li[0]["escopo_metodo"] == "catalogo"


def test_objeto_step_eva_academia_entra_pelos_itens():
    d = {"sDsObjeto": "AQUISICAO DE STEP EM EVA PARA FILIAL SESI CINELANDIA - ACADEMIA DO CENTRO"}
    its = [{"sDsItem": "1 - STEP EM EVA, MEDINDO 90 CM X 30 CM X 15 CM (C X L X A )"}]
    assert P.avaliar_processo(d, its)[0] == "forte"


def test_locacao_esteira_com_eletrocardiografo_fora():
    d = {"sDsObjeto": "LOCAÇÃO DE ESTEIRA ERGOMÉTRICA E ELETROCARDIÓGRAFO"}
    its = [{"sDsItem": "1 - SV LOC ESTEIRA ERGO/ELETROCARD - SERVICO DE LOCACOA DE E"}]
    assert P.avaliar_processo(d, its)[0] is None


def test_piso_eva_e_placa_de_borracha():
    """Pedido do Marcelo (26/09): piso/placa de EVA e placa de borracha de piso entram como 'piso'."""
    dentro = ["1 - PLACA DE BORRACHA 50X50 20MM", "1 - PISO EVA 50X50 20MM", "1 - PLACA DE EVA 1X1M 20MM",
              "1 - TAPETE EVA INFANTIL ENCAIXE", "1 - MANTA DE BORRACHA PARA PISO", "1 - GRAMA SINTETICA 12MM",
              "1 - PISO DE BORRACHA 50X50CM 20MM"]
    fora = ["1 - PLACA DE BORRACHA NEOPRENE 3MM", "1 - PLACA DE BORRACHA 1000X1000X3MM", "1 - LENCOL DE BORRACHA NITRILICA 3MM",
            "1 - PLACA DE EVA COLORIDA 40X60CM 2MM", "1 - FOLHA DE EVA 40X60 2MM", "1 - ALFABETO DO A AO Z EM EVA"]
    for s in dentro:
        assert P.classificar_item({"sDsItem": s})[0] == "piso", s
    for s in fora:
        assert P.classificar_item({"sDsItem": s})[0] is None, s


# ---------------- v15: lances (SFIEC PE000652022, pregão módulo 18), catálogo e fornecedores ----------------
import json as _json
from pathlib import Path as _Path

SFIEC = _json.loads((_Path(__file__).parent / "fixtures" / "sfiec_pe000652022.json").read_text(encoding="utf-8"))
SFIEC_ITEM = {i["nCdItem"]: i for i in SFIEC["itens"]}


def _res(n_cd_item):
    it = SFIEC_ITEM[n_cd_item]
    return P.linhas_resultados(1, it["nCdItemSequencial"], P.limpar(SFIEC["lances"][str(n_cd_item)]),
                               "2022-09-30T00:00:00+00:00", it["sStItem"])


def test_lances_um_vencedor_com_trofeu_e_perdidas():
    res = _res(2241)
    venc = [r for r in res if r["vencedor"]]
    assert len(venc) == 1
    v = venc[0]
    assert v["ranking"] == 1 and v["valor_proposta"] == 8200 == SFIEC_ITEM[2241]["dVlMelhorLanceMoedaVencedor"]
    assert v["fornecedor_nome"] == "PROMED SERVICOS DE EQUIPAMENTOS MEDICOS" and v["fornecedor_cnpj"] == "06165288000130"
    assert (v["marca"], v["modelo"]) == ("PROMED", "TUBULAR CARENADA")
    assert v["situacao"] == "vencedor" and v["valor_unitario_homologado"] == 8200
    perd = [r for r in res if not r["vencedor"]]
    assert perd and all(r["situacao"] == "perdida" and r["valor_unitario_homologado"] is None for r in perd)


def test_lances_historico_fora_e_sem_duplicata():
    brutos = SFIEC["lances"]["2251"]
    res = _res(2251)
    assert len(res) < len(brutos)                        # lances sem posição (histórico) ficam fora
    assert all(r["ranking"] for r in res)
    assert all(r["valor_proposta"] < 100000 for r in res)  # lances-âncora de 100k/500k são histórico
    chaves = [(r["fornecedor_cnpj"], r["valor_proposta"], r["raw"]["tDtLance"]) for r in res]
    assert len(chaves) == len(set(chaves))               # o portal repete a linha do 3º
    assert [r["sequencial_resultado"] for r in res] == list(range(1, len(res) + 1))


def test_item_revogado_sem_vencedor_nao_falha():
    assert _res(2257) == []


def test_assert_um_ganhador():
    base = P.limpar(SFIEC["lances"]["2241"])
    dois = [dict(r, bFlVencedor=1) if r.get("nNrRanking") in (1, 2) else r for r in base]
    with pytest.raises(P.ResultadoInvalido):
        P.linhas_resultados(1, 1, dois, None, "Encerrado")
    nenhum = [dict(r, bFlVencedor=0) for r in base]
    with pytest.raises(P.ResultadoInvalido):
        P.linhas_resultados(1, 1, nenhum, None, "Encerrado")
    assert not any(r["vencedor"] for r in P.linhas_resultados(1, 1, nenhum, None, "Fracassado"))


def test_classificacao_status_vazio_vira_perdida():
    rk = [{"nNrRanking": 1, "sNmEmpresa": "A LTDA - 24.608.949/0001-37", "sDsStatus": "", "dVlProposta": 10},
          {"nNrRanking": 2, "sNmEmpresa": "B LTDA", "sDsStatus": None, "dVlProposta": 12}]
    res = P.linhas_resultados(1, 1, rk, None, "Homologado")
    assert [r["situacao"] for r in res] == ["vencedor", "perdida"]
    assert res[0]["fornecedor_cnpj"] == "24608949000137" and res[0]["fornecedor_nome"] == "A LTDA"


def test_empresa_cnpj():
    assert P.empresa_cnpj("J&A E-COMMERCE LTDA - 24.608.949/0001-37") == ("J&A E-COMMERCE LTDA", "24608949000137")
    assert P.empresa_cnpj("JULIO CESAR GASPARINI JUNIOR - EIRELI ME - 08.973.569/0001-45") == \
        ("JULIO CESAR GASPARINI JUNIOR - EIRELI ME", "08973569000145")
    assert P.empresa_cnpj("Forn. 8") == ("Forn. 8", None)


def test_catalogo_classifica_por_produto_e_respeita_item_fora():
    produtos = {13185: {"codigo": "AI0300075"}, 13163: {"codigo": "AI0300003"}, 13181: {"codigo": "AI0300062"}}
    li = {i["id_item_externo"]: i for i in P.linhas_itens(1, SFIEC["itens"], produtos)}
    assert li[2241]["categoria_escopo"] == "forte" and li[2241]["escopo_metodo"] == "catalogo"
    assert li[2241]["catalogo_codigo_item"] == "AI0300075"
    assert li[2242]["categoria_escopo"] is None           # balança está na categoria, mas é ITEM_FORA
    sem = {i["id_item_externo"]: i for i in P.linhas_itens(1, SFIEC["itens"])}
    assert sem[2241]["catalogo_codigo_item"] == "AI0300075"  # código lido da descrição mesmo sem catálogo


def test_lances_corpo_da_requisicao():
    p = P.PortalParadigma(P.FONTES["sfiec"], sessao=MagicMock(), delay=0)
    p._ws = MagicMock(return_value=[])
    p.lances({**SFIEC["detalhe"], "nCdTipoModalidade": None}, SFIEC_ITEM[2241])
    metodo, corpo = p._ws.call_args.args
    dto = corpo["dtoProcesso"]
    assert metodo == "PesquisarProcessoDetalheItemProdutoLance"
    assert dto["nCdTipoModalidade"] == 0 and dto["nCdModulo"] == 18 and dto["nCdItem"] == 2241  # null -> 500


def test_produtos_escopo_filtra_nome_exato_tipo_e_pagina():
    p = P.PortalParadigma(P.FONTES["sfiec"], sessao=MagicMock(), delay=0)
    classes = {"EQUIPAMENTOS ESPORTIVOS": [{"nCdClasse": 30, "sDsClasse": "EQUIPAMENTOS ESPORTIVOS"}],
               "ESPORTIVO": [{"nCdClasse": 75, "sDsClasse": "DIDATICO ESPORTIVO"},
                             {"nCdClasse": 371, "sDsClasse": "ESPORTIVO"}, {"nCdClasse": 74, "sDsClasse": "ESPORTIVO"}]}
    chamadas = []

    def ws(metodo, corpo):
        dto = corpo["dtoProduto"]
        if metodo == "PesquisarCatalogoProdutoClasses":
            return classes[dto["sDsProduto"]]
        de = dto["dtoPaginacao"]["nPaginaDe"]
        ate = dto["dtoPaginacao"]["nPaginaAte"]
        assert ate - de + 1 <= 100
        chamadas.append((dto["nCdClasse"], dto["nCdTipo"], de))
        if dto["nCdClasse"] == 74 and de == 1:
            n = 100  # página cheia: segue
        elif dto["nCdClasse"] == 74 and de == 101:
            n = 3    # curta, sem total: não encerra
        elif de == 1:
            n = 3
        else:
            n = 0    # página vazia encerra
        base = dto["nCdClasse"] * 10000 + de
        return [{"nCdProduto": base + k, "sCdProdutoEmpresa": f"X{k}", "sDsClasse": "c", "nCdClasse": dto["nCdClasse"]}
                for k in range(n)]
    p._ws = ws
    prods = p.produtos_escopo(tipo="produto")
    assert {c for c, _, _ in chamadas} == {30, 371, 74}   # DIDATICO ESPORTIVO não entra (nome não é exato)
    assert all(t == 1 for _, t, _ in chamadas)            # Tipo = Produto
    assert (74, 1, 101) in chamadas                       # paginou a categoria cheia (100) e a curta seguinte
    assert (74, 1, 104) in chamadas                       # página vazia encerra
    assert len(prods) == 3 + 3 + 100 + 3


def test_mural_estatistico_leva_totais_para_licitacao():
    # linha real de PesquisarProcessosMuralEstatistico (HAR SFIEC, 26/09/2026), reduzida
    est = {"nCdProcesso": 32, "nCdOrigem": 32, "nCdModulo": 18, "nAnoFinalizacao": 2022,
           "dVlEstimado": 723570.83, "dVlNegociado": 367508.5, "dVlEconomia": 356062.33, "dPcEconomia": 49.20905,
           "tDtEncerrado": "/Date(1664557838080)/", "sDsSituacao": NULO}
    li = P.linha_licitacao(P.FONTES["sfiec"], dict(SFIEC["detalhe"], dVlTotal=DEC_MIN), "forte", False, listagem=est)
    assert li["valor_total"] == 723570.83
    assert li["raw"]["mural_estatistico"]["dVlNegociado"] == 367508.5
    assert li["modulo"] == 18 and li["status_normalizado"] == "homologada"


def test_nome_de_mei_com_cpf_fica_inteiro():
    nome, cnpj = P.empresa_cnpj("GABRIEL MOTA LIMA 00982645325 - 32.068.708/0001-70")
    assert nome == "GABRIEL MOTA LIMA 00982645325" and cnpj == "32068708000170"
    assert "***" not in (nome or "")


# ---------------- peças de manutenção (categoria 'manutencao', só com contexto de academia) ----------------
PECAS_SFIEC = [  # itens reais de dispensas da SFIEC (m19), 2022–2023
    "MC1001497-CABO DE ACO GALVA 5/32 6X7 PTO",
    "MC1001586-CABO DE ACO REVEST PVC 1/8 5MM",
    "MC1001555-TECIDO COURVIN PRETO",
    "MC0200029-OLEO DESENGRIPANTE LUBR 300ML",
]


@pytest.mark.parametrize("texto", PECAS_SFIEC)
def test_peca_de_manutencao_entra_com_contexto_do_objeto(texto):
    cat, _, ms, metodo = P.classificar_item_detalhe({"sDsItem": texto}, contexto=True)
    assert (cat, ms, metodo) == ("manutencao", "M", "regra_item")


def test_peca_de_manutencao_sem_contexto_fica_fora():
    for texto in PECAS_SFIEC + ["POLIA DE FERRO FUNDIDO 200MM", "ROLAMENTO 6205 2RS", "MOLA DE COMPRESSAO ACO"]:
        assert P.classificar_item_detalhe({"sDsItem": texto})[0] is None, texto


def test_peca_com_contexto_no_proprio_item():
    assert P.classificar_item_detalhe({"sDsItem": "CABO DE ACO PARA APARELHO DE MUSCULACAO"})[0] == "manutencao"
    assert P.classificar_item_detalhe({"sDsItem": "LONA PARA ESTEIRA ERGOMETRICA"})[0] == "manutencao"


def test_processo_so_de_pecas_vira_manutencao_e_equipamento_prevalece():
    d = {"sDsObjeto": "MATERIAL PARA MANUTENÇÃO DOS EQUIPAMENTOS DA ACADEMIA"}
    assert P.avaliar_processo(d, [{"sDsItem": PECAS_SFIEC[0]}])[0] == "manutencao"
    assert P.avaliar_processo(d, [{"sDsItem": PECAS_SFIEC[0]}, {"sDsItem": "MC0600059-CANELEIRA EMBORRACHADA 4KG"}])[0] == "forte"
    fora = {"sDsObjeto": "MATERIAL DE MANUTENÇÃO PREDIAL - SENAI"}
    assert P.avaliar_processo(fora, [{"sDsItem": PECAS_SFIEC[0]}])[0] is None


@pytest.mark.parametrize("texto,esperado", [
    ("CABO DE ACO PARA LEG PRESS", "manutencao"), ("ESTOFAMENTO PARA BANCO SUPINO", "manutencao"),
    ("CORREIA PARA ESTEIRA ELETRICA", "manutencao"), ("LONA PARA ESTEIRA ERGOMETRICA", "manutencao"),
    ("MC0600012-MOLA PARA TRAMPOLIM/JUMP", "manutencao"),
    ("LEG PRESS 45 COM CABOS DE ACO", "forte"), ("BANCO SUPINO RETO ESTOFADO", "forte"),
    ("ESTACAO DE MUSCULACAO 4 ESTACOES COM POLIAS", "forte"), ("CAMA ELASTICA COM MOLAS", "forte"),
    ("COLCHONETE DE ESPUMA PARA GINASTICA", "forte"), ("TATAME DE ESPUMA EVA 2CM", "forte"),
])
def test_peca_x_equipamento_pela_ordem_dos_termos(texto, esperado):
    assert P.classificar_item_detalhe({"sDsItem": texto}, contexto=True)[0] == esperado


def test_catalogo_refina_peca_para_manutencao():
    it = {"sDsItem": "MC0600012-MOLA PARA TRAMPOLIM/JUMP", "nCdProduto": 999}
    assert P.classificar_item_detalhe(it, {999: {"codigo": "MC0600012"}})[0::3] == ("manutencao", "catalogo")


def test_compra_so_de_pecas_com_objeto_forte_fica_manutencao():
    d = {"sDsObjeto": "CABO DE AÇO GALVANIZADO 5/32, 6X7 EM PVC PRETO PARA EQUIPAMENTO DE ACADEMIA"}
    assert P.classificar(d["sDsObjeto"]) == "forte"
    assert P.avaliar_processo(d, [{"sDsItem": "MC1001497-CABO DE ACO GALVA 5/32 6X7 PTO"}])[0] == "manutencao"
    misto = {"sDsObjeto": "CABOS DE AÇO PARA EQUIPAMENTOS ESPORTIVOS E ÓLEO DESENGRIPANTE SPRAY 300ML"}
    its = [{"sDsItem": "MC1001586-CABO DE ACO REVEST PVC 1/8 5MM"}, {"sDsItem": "MD0400796-LINHA NYLON DIAMETRO DE 080MM"}]
    assert P.avaliar_processo(misto, its)[0] == "manutencao"


def test_valor_do_lance_e_unitario_total_bate_com_relatorio():
    # Relatório Final PE000652022: soma de valor × quantidade dos vencedores = R$ 377.233,50 (bate no centavo)
    it = SFIEC_ITEM[2241]
    res = P.linhas_resultados(1, 1, P.limpar(SFIEC["lances"]["2241"]), None, it["sStItem"], it["dQtItem"])
    v = [r for r in res if r["vencedor"]][0]
    assert v["quantidade_homologada"] == 1 and v["valor_total_homologado"] == 8200
    assert all(r["valor_total_homologado"] is None for r in res if not r["vencedor"])
    b = SFIEC_ITEM[2242]  # balança antropométrica, qtd 4
    rb = P.linhas_resultados(1, 2, P.limpar(SFIEC["lances"]["2242"]), None, b["sStItem"], b["dQtItem"])
    vb = [r for r in rb if r["vencedor"]][0]
    assert vb["valor_unitario_homologado"] == 129 and vb["valor_total_homologado"] == 516


def test_fornecedor_tem_uma_posicao_por_item_e_repete_entre_itens():
    por_item = {k: [r for r in _res(k)] for k in (2241, 2251)}
    for res in por_item.values():
        cnpjs = [r["fornecedor_cnpj"] for r in res]
        assert len(cnpjs) == len(set(cnpjs))               # 1 posição por fornecedor no item
    comuns = {r["fornecedor_cnpj"] for r in por_item[2241]} & {r["fornecedor_cnpj"] for r in por_item[2251]}
    assert comuns                                           # o mesmo fornecedor aparece em itens diferentes


def test_cadastro_recebe_todos_os_participantes_do_certame():
    """Relatório Final: 12 proponentes. Inclui quem só disputou item fora do escopo (balança) e quem ficou sem posição."""
    p = P.PortalParadigma(P.FONTES["sfiec"], sessao=MagicMock(), delay=0)
    p.detalhes = MagicMock(return_value=SFIEC["detalhe"])
    p.itens = MagicMock(return_value=SFIEC["itens"])
    p.resultado_item = lambda d, it: P.limpar(SFIEC["lances"][str(it["nCdItem"])])
    forn = MagicMock()
    forn.cadastrar.return_value = {"consultados": 0, "em_cache": 0, "erros": 0, "linhas": []}
    resumo = P.coletar(p, None, [], 1, True, True, None, forn, [(32, 18)])
    enviados = {c for c in forn.cadastrar.call_args.args[0]}
    esperados = {P.empresa_cnpj(r["sNmEmpresa"])[1] for v in SFIEC["lances"].values() for r in v} - {None}
    assert enviados == esperados and resumo["participantes"] == len(esperados)
    assert "24608949000137" in enviados        # J&A: só disputou balança (fora do escopo)
    assert resumo["erros"] == 0 and resumo["alertas"] == 0


def test_disputa_aberta_2025_sem_trofeu_vence_classificada():
    # PD000062025 (SFIEC, "Contratação ou aquisição (disputa aberta)"): bFlVencedor nulo; vale posição + Classificada
    lances = [{"nCdLance": 19083, "nNrRanking": 1, "bFlVencedor": None, "dVlLanceMoeda": 54.0,
               "sNmEmpresa": "VJ SILVA VARIEDADES LTDA - ME - 19.932.867/0001-03", "sDsSituacaoProposta": "Classificada",
               "tDtLance": "/Date(1738349116303)/"},
              {"nCdLance": 18099, "nNrRanking": None, "bFlVencedor": None, "dVlLanceMoeda": 155.88,
               "sNmEmpresa": "TRAUM ARTIGOS ESPORTIVOS LTDA - 02.441.945/0001-74", "tDtLance": "/Date(1737663415700)/"}]
    res = P.linhas_resultados(1, 1, lances, None, "Homologado", 2)
    assert len(res) == 1 and res[0]["vencedor"] and res[0]["fornecedor_cnpj"] == "19932867000103"
    assert res[0]["valor_total_homologado"] == 108


# ---------------- paginação (regra de 03/10/2026) e CPF sem máscara ----------------

@pytest.mark.parametrize("resp,trecho", [
    ({"mensagem": "indisponível"}, "indisponível"),
    (None, "null"),
    ("indisponível", "indisponível"),
    ({"d": {"mensagem": "indisponível"}}, "indisponível"),
    ({"nCdProcesso": 1}, "nCdProcesso"),
])
def test_envelope_200_sem_lista_levanta(resp, trecho):
    with pytest.raises(RuntimeError, match="sem lista reconhecida") as exc:
        P.paginar_intervalo(lambda de, ate: resp, rotulo="sfiec termo academia")
    msg = str(exc.value)
    assert "sfiec termo academia" in msg and trecho in msg


def test_envelope_invalido_trunca_o_trecho():
    bruto = "x" * 5000
    with pytest.raises(RuntimeError, match="sem lista reconhecida") as exc:
        P.paginar_intervalo(lambda de, ate: bruto, rotulo="longo")
    assert "longo" in str(exc.value) and len(str(exc.value)) < 400


def test_lista_vazia_encerra_normalmente():
    chamadas = []

    def buscar(de, ate):
        chamadas.append((de, ate))
        return []

    itens, avisos = P.paginar_intervalo(buscar, rotulo="vazio")
    assert chamadas == [(1, 100)] and itens == [] and avisos == []


def test_objeto_com_lista_vazia_encerra_normalmente():
    def buscar(de, ate):
        return {"resultado": [], "totalRegistros": 0}

    itens, avisos = P.paginar_intervalo(buscar, rotulo="obj-vazio")
    assert itens == [] and avisos == []


def test_pagina_seguinte_invalida_nao_encerra_com_sucesso():
    def buscar(de, ate):
        if de == 1:
            return [{"n": 1}]
        return {"mensagem": "indisponível"}

    with pytest.raises(RuntimeError, match="sem lista reconhecida"):
        P.paginar_intervalo(buscar, rotulo="meio")


def _lote(inicio: int, n: int) -> list[dict]:
    return [{"id": inicio + i} for i in range(n)]


def test_pagina_curta_intermediaria_ignora_total_paginas_e_coleta_tudo():
    """40 + páginas cheias, totalPaginas=3, 300 registros: não para na 3ª chamada."""
    emitidos = 0
    chamadas = []

    def buscar(de, ate):
        nonlocal emitidos
        chamadas.append((de, ate))
        assert ate - de + 1 <= 100
        if emitidos >= 300:
            return {"resultado": [], "totalPaginas": 3}
        n = 40 if emitidos == 0 else min(100, 300 - emitidos)
        lote = _lote(emitidos + 1, n)
        emitidos += n
        return {"resultado": lote, "totalPaginas": 3}

    itens, avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="tp")
    assert [i["id"] for i in itens] == list(range(1, 301))
    assert len(chamadas) == 5  # 40, 100, 100, 60 e a página vazia
    assert any("não encerram" in a for a in avisos)


def test_pagina_curta_intermediaria_ignora_paginas_restantes():
    emitidos = 0
    chamadas = []

    def buscar(de, ate):
        nonlocal emitidos
        chamadas.append((de, ate))
        if emitidos >= 300:
            return {"resultado": [], "paginasRestantes": 0}
        n = 40 if emitidos == 0 else min(100, 300 - emitidos)
        lote = _lote(emitidos + 1, n)
        emitidos += n
        restantes = max(0, 3 - len(chamadas))
        return {"resultado": lote, "paginasRestantes": restantes}

    itens, _avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="pr")
    assert len(itens) == 300 and itens[-1]["id"] == 300
    assert len(chamadas) == 5


def test_pagina_curta_intermediaria_para_em_total_registros():
    emitidos = 0
    chamadas = []

    def buscar(de, ate):
        nonlocal emitidos
        chamadas.append((de, ate))
        n = 40 if emitidos == 0 else min(100, 300 - emitidos)
        lote = _lote(emitidos + 1, n)
        emitidos += n
        return {"resultado": lote, "totalRegistros": 300}

    itens, avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="tr")
    assert len(itens) == 300 and itens[0]["id"] == 1 and itens[-1]["id"] == 300
    assert len(chamadas) == 4  # para ao acumular 300, sem página vazia extra
    assert avisos  # a página curta com totalRegistros ainda não atingido avisa e segue


def test_faixa_alinhada_para_em_total_paginas_sem_chamada_extra():
    chamadas = []

    def buscar(de, ate):
        chamadas.append(de)
        if len(chamadas) > 3:
            raise AssertionError("chamada além da última página")
        inicio = (len(chamadas) - 1) * 100
        return {"resultado": _lote(inicio + 1, 100), "totalPaginas": 3}

    itens, avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="alinhada")
    assert len(itens) == 300 and chamadas == [1, 101, 201]
    assert avisos == []


def test_paginar_para_pelo_total():
    faixas = []

    def buscar(de, ate):
        faixas.append((de, ate))
        if de == 1:
            return {"resultado": [{"n": i} for i in range(100)], "totalRegistros": 100}
        return [{"n": "nao-deveria"}]

    itens, avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="total")
    assert faixas == [(1, 100)]
    assert len(itens) == 100 and avisos == []


def test_paginar_pagina_curta_sem_total_segue_ate_vazia():
    faixas = []

    def buscar(de, ate):
        faixas.append(ate - de + 1)
        if de == 1:
            return [{"n": i} for i in range(40)]
        if de == 41:
            return [{"n": 100 + i} for i in range(10)]
        return []

    itens, avisos = P.paginar_intervalo(buscar, tamanho=100, rotulo="sem-total")
    assert faixas == [100, 100, 100]
    assert len(itens) == 50 and avisos == []
    assert all(t <= 100 for t in faixas)


def test_paginar_pagina_curta_com_total_confirmado_para():
    faixas = []

    def buscar(de, ate):
        faixas.append((de, ate))
        return {"resultado": [{"n": 1}, {"n": 2}], "total": 2}

    itens, avisos = P.paginar_intervalo(buscar, tamanho=500, rotulo="curta-total")
    assert faixas == [(1, 100)]  # pedido 500 vira 100
    assert [i["n"] for i in itens] == [1, 2]
    assert avisos == []


def test_tamanho_de_pagina_nunca_passa_de_100():
    faixas = []

    def buscar(de, ate):
        faixas.append(ate - de + 1)
        return []

    P.paginar_intervalo(buscar, tamanho=500)
    assert faixas == [100]


def test_listar_limita_faixa_a_100(monkeypatch):
    monkeypatch.setattr(P.time, "sleep", lambda _s: None)
    s = MagicMock()
    s.post.return_value.status_code = 200
    s.post.return_value.json.return_value = {"d": []}
    p = P.PortalParadigma(P.FONTES["fiesc"], delay=0, sessao=s)
    p.listar("academia", 1, 500)
    corpo = json.loads(s.post.call_args.kwargs["data"])
    pag = corpo["dtoProcesso"]["dtoPaginacao"]
    assert pag["nPaginaAte"] - pag["nPaginaDe"] + 1 == 100
    p.listar_encerrados("academia", 2024, 1, 400)
    corpo2 = json.loads(s.post.call_args.kwargs["data"])
    pag2 = corpo2["dtoProcesso"]["dtoPaginacao"]
    assert pag2["nPaginaAte"] - pag2["nPaginaDe"] + 1 == 100


def test_cpf_e_cnpj_ficam_sem_mascara_no_resultado_e_no_raw():
    original = "GABRIEL MOTA LIMA 00982645325 - 32.068.708/0001-70"
    rk = [{
        "nNrRanking": 1,
        "sNmEmpresa": original,
        "sNrCnpj": "32.068.708/0001-70",
        "sDsStatus": "Classificada",
        "dVlProposta": 10,
        "observacao": "cpf 00982645325 e cnpj 32068708000170",
    }]
    res = P.linhas_resultados(1, 1, rk, None, "Homologado")
    assert len(res) == 1
    assert res[0]["fornecedor_nome"] == "GABRIEL MOTA LIMA 00982645325"
    assert res[0]["fornecedor_cnpj"] == "32068708000170"
    assert res[0]["raw"]["sNmEmpresa"] == original
    assert res[0]["raw"]["sNrCnpj"] == "32.068.708/0001-70"
    assert "00982645325" in res[0]["raw"]["observacao"]
    assert "***" not in json.dumps(res[0], ensure_ascii=False)


def test_delay_minimo_entre_requisicoes(monkeypatch):
    pausas = []
    monkeypatch.setattr(P.time, "sleep", lambda s: pausas.append(s))
    s = MagicMock()
    s.post.return_value.status_code = 200
    s.post.return_value.json.return_value = {"d": []}
    p = P.PortalParadigma(P.FONTES["fiesc"], delay=0.2, sessao=s)
    assert p.delay >= 1
    p.listar("academia", 1, 50)
    assert pausas and all(x >= 1 for x in pausas)


def test_pagina_repetida_interrompe_com_aviso():
    def buscar(de, ate):
        return [{"id": 1}]

    itens, avisos = P.paginar_intervalo(buscar, rotulo="repetida")
    assert len(itens) == 1
    assert any("repetido" in a for a in avisos)


def test_limite_de_seguranca_interrompe_com_aviso(monkeypatch):
    monkeypatch.setattr(P, "MAX_PAGINAS_SEGURANCA", 2)
    seq = {"n": 0}

    def buscar(de, ate):
        seq["n"] += 1
        return [{"id": seq["n"]}]

    itens, avisos = P.paginar_intervalo(buscar, rotulo="seguranca")
    assert len(itens) == 2
    assert any("limite de segurança" in a for a in avisos)


def test_coletar_pagina_curta_sem_total_segue_e_pede_100():
    portal = MagicMock()
    portal.fonte = P.FONTES["fiesc"]
    portal.detalhes.return_value = None
    chamadas = []

    def listar(texto, de, ate):
        chamadas.append((de, ate))
        if de == 1:
            return [{"nCdOrigem": 7, "nCdModulo": 59, "sDsObjeto": "academia"}]
        return []

    portal.listar.side_effect = listar
    r = P.coletar(portal, None, ["academia"], paginas=None, dry_run=True, com_resultados=False)
    assert chamadas[0] == (1, 100)
    assert chamadas[-1][0] > 1
    assert all(ate - de + 1 <= 100 for de, ate in chamadas)
    assert r["listados"] == 1 and r["paginacao_avisos"] == []


def test_cli_paginas_padrao_nao_corta(monkeypatch):
    visto = {}
    monkeypatch.setattr(P, "PortalParadigma", lambda *a, **k: MagicMock())

    def falso_coletar(portal, sb, termos, paginas, *a, **k):
        visto["paginas"] = paginas
        return {"erros": 0, "no_escopo": 0}

    monkeypatch.setattr(P, "coletar", falso_coletar)
    assert P.main(["--fonte", "fiesc", "--dry-run", "--sem-catalogo", "--sem-documentos",
                   "--sem-resultados", "--sem-fornecedores"]) == 0
    assert visto["paginas"] is None

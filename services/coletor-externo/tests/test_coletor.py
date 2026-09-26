"""Testes offline com respostas no formato real do portal (capturadas em 23/09/2026)."""
from unittest.mock import MagicMock

from coletor import main as M
from coletor.portal import _deduplicar, cnpj_ou_none, encerrado, limpar, parse_data, processo_para_linha

NULO = "\u0013\u0012\u0012\u0013"

DETALHE = {
    "__type": "Paradigma.Wbc.NovoPortal.Entidade.CWMuralProcessoDetalhe",
    "nCdProcesso": 1, "sNrProcesso": "8453-4/2025", "sNrEdital": "107/2025",
    "sDsObjeto": " Registro de preços de equipamentos de academia ", "tDtInicial": "/Date(1786622400000)/",
    "tDtFinal": "/Date(1787589900000)/", "tDtHomologacao": "/Date(-62135589600000)/",
    "nCdAnexo": 10179566, "sDsSituacao": "Homologado", "sDsFase": "Homologação",
    "sNmEmpresa": "SEST SERVICO SOCIAL DO TRANSPORTE", "nCdEdital": 1200,
    "sNmModalidade": "Pregão Eletrônico", "dVlTotal": 0, "sDsNatureza": NULO,
}
LINHAS_LANCE = [
    {"nCdAnexo": 10201801, "nSqAnexo": 1, "sDsAnexo": "PROPOSTA ATUALIZADA.pdf",
     "sNmArquivo": "wbc20260824164623153.pdf", "tDtAnexo": "/Date(1787600783157)/",
     "sCdUsuario": "07486108000185", "sNmEmpresa": "WR PRO LTDA", "sDsItemLote": "Lote 2",
     "sDsParametroCriptografado": "?q=abc"},
    {"nCdAnexo": 10201801, "nSqAnexo": 1, "sDsAnexo": "PROPOSTA ATUALIZADA.pdf",
     "sNmArquivo": "wbc20260824164623153.pdf", "tDtAnexo": "/Date(1787600783157)/",
     "sCdUsuario": "07486108000185", "sNmEmpresa": "WR PRO LTDA", "sDsItemLote": "Lote 5",
     "sDsParametroCriptografado": "?q=abc"},
    {"nCdAnexo": 1, "nSqAnexo": 2, "sDsAnexo": "rg.pdf", "sNmArquivo": "x.pdf",
     "tDtAnexo": "/Date(1787600783157)/", "sCdUsuario": "123.456.789-01",
     "sNmEmpresa": "Fulano", "sDsItemLote": "Lote 1", "sDsParametroCriptografado": "?q=def"},
]


def test_datas_e_nulos():
    assert parse_data("/Date(1786622400000)/").startswith("2026-08-13")
    assert parse_data("/Date(-62135589600000)/") is None
    assert limpar({"a": NULO, "b": -2147483648, "c": [NULO, 1]}) == {"a": None, "b": None, "c": [None, 1]}


def test_cnpj_so_pessoa_juridica():
    assert cnpj_ou_none("07486108000185") == "07486108000185"
    assert cnpj_ou_none("123.456.789-01") is None


def test_copias_por_lote_com_nomes_internos_diferentes_viram_um_documento():
    copias = [dict(LINHAS_LANCE[0], sNmArquivo=f"wbc{i}.pdf", sDsItemLote=f"Lote {i}") for i in range(19)]
    arqs = _deduplicar("recurso", copias)
    assert len(arqs) == 1 and len(arqs[0].itens_lote) == 19


def test_deduplica_por_arquivo_e_agrega_lotes():
    arqs = _deduplicar("lance", LINHAS_LANCE)
    assert len(arqs) == 2
    a = arqs[0]
    assert a.itens_lote == ["Lote 2", "Lote 5"]
    assert a.fornecedor_cnpj == "07486108000185"
    assert "sDsParametroCriptografado" not in a.raw and "sCdUsuario" not in a.raw
    assert arqs[1].fornecedor_cnpj is None  # CPF descartado


def test_processo_para_linha():
    d = limpar(DETALHE)
    l = processo_para_linha(d, 59)
    assert l["id_externo"] == 1 and l["objeto"] == "Registro de preços de equipamentos de academia"
    assert l["valor_total"] is None and encerrado(d)


def _portal_fake():
    p = MagicMock()
    p.detalhes.return_value = limpar(DETALHE)
    p.esclarecimentos.return_value = [{"titulo": "PEDIDO DE ESCLARECIMENTO"}]
    p.notas.return_value = []
    p.anexos_processo.return_value = _deduplicar("processo", [{
        "nCdAnexo": 10179566, "nSqAnexo": 1, "sDsAnexo": "Edital.pdf", "sNmArquivo": "e.pdf",
        "tDtAnexo": "/Date(1786622400000)/", "sDsParametroCriptografado": "?q=ed"}])
    p.anexos_secao.side_effect = lambda s, *a, **k: _deduplicar(s, LINHAS_LANCE) if s == "lance" else []
    p.baixar.return_value = (b"%PDF-1.7 conteudo", "application/pdf")
    return p


def test_dry_run_nao_grava():
    r = M.coletar_processo(_portal_fake(), None, None, 1, 59, {"processo"}, 10**8, True, True)
    assert r["docs"] == 3 and r["por_secao"] == {"processo": 1, "lance": 2}


def test_fluxo_completo_baixa_so_secoes_configuradas(tmp_path):
    portal = _portal_fake()
    sb = MagicMock()
    sb.upsert.side_effect = lambda tabela, linhas, conf: (
        [{"id": 7}] if tabela == "licitacoes_externas" else
        [{"id": i + 100, "secao": l["secao"], "arquivo_origem": l["arquivo_origem"],
          "status_processamento": "pendente"} for i, l in enumerate(linhas)])
    from coletor.destino import Armazenamento
    arm = Armazenamento(None, str(tmp_path))
    r = M.coletar_processo(portal, sb, arm, 1, 59, {"processo"}, 10**8, True, False)
    assert r["baixados"] == 1 and r["erros"] == 0
    assert portal.baixar.call_count == 1  # lance não baixado
    assert (tmp_path / "sestsenat/59/1/processo/e.pdf").read_bytes().startswith(b"%PDF")
    linha = sb.upsert.call_args_list[0].args[1]
    assert linha["esclarecimentos"][0]["titulo"] == "PEDIDO DE ESCLARECIMENTO"


def test_html_no_lugar_do_arquivo_vira_erro(tmp_path):
    portal = _portal_fake()
    portal.baixar.return_value = (b"<!DOCTYPE html><html>erro</html>", "text/html")
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 7}] if t == "licitacoes_externas" else [
        {"id": 1, "secao": x["secao"], "arquivo_origem": x["arquivo_origem"], "status_processamento": "pendente"} for x in l]
    from coletor.destino import Armazenamento
    r = M.coletar_processo(portal, sb, Armazenamento(None, str(tmp_path)), 1, 59, {"processo"}, 10**8, True, False)
    assert r["erros"] == 1
    assert sb.atualizar.call_args.args[2]["status_processamento"] == "erro"


def test_arquivo_grande_vira_ignorado(tmp_path):
    from coletor.portal import ArquivoGrande
    portal = _portal_fake()
    portal.baixar.side_effect = ArquivoGrande(90 * 1024 * 1024)
    sb = MagicMock()
    sb.upsert.side_effect = lambda t, l, c: [{"id": 7}] if t == "licitacoes_externas" else [
        {"id": 1, "secao": x["secao"], "arquivo_origem": x["arquivo_origem"], "status_processamento": "pendente"} for x in l]
    from coletor.destino import Armazenamento
    r = M.coletar_processo(portal, sb, Armazenamento(None, str(tmp_path)), 1, 59, {"processo"}, 10**8, True, False)
    assert r["erros"] == 0 and sb.atualizar.call_args.args[2]["status_processamento"] == "ignorado"
    sb.remover_pendentes_exceto.assert_called_once()


def test_filtro_fitness():
    from coletor.portal import no_escopo_fitness as f
    dentro = ["Aquisição de equipamento ergométrico (Esteira profissional elétrica)",
              "fornecimento de EQUIPAMENTOS DE MUSCULAÇÃO, ACESSÓRIOS DE FISIOTERAPIA",
              "REGISTRO DE PREÇO para aquisição de equipamentos para esporte e diversão",
              "Aquisição de materiais de academia e esporte."]
    fora = ["Registro de Preço para futura aquisição de motocicletas",
            "Serviços de hospedagem e alimentação para a Copa SEST SENAT de Futebol 7 Society",
            "Aquisição de uniformes esportivos personalizados",
            "Registro de preços de troféus personalizados para a Copa de Futebol"]
    assert all(f({"sDsObjeto": o}) for o in dentro)
    assert not any(f({"sDsObjeto": o}) for o in fora)


def test_escopo_catmat_7830_com_objetos_reais_do_pncp():
    from coletor.escopo import classificar as c
    dentro = ["Aquisição de Equipamentos para Academia da 2ª Cia PM do 44º BPM-I",
              "Aquisição de equipamentos de academia para a Base Aérea do Galeão",
              "Aquisição de Materiais da área de Educação Física do Campus Ilhéus",
              "Aquisição de Materiais Esportivos para o Programa Revelar Talentos Bahia",
              "Aquisição de tatames e colchonetes"]
    fora = ["Serviços de comunicação visual nas dependências da Academia da Força Aérea",
            "Engenharia para instalação do sistema de aquecimento da piscina",
            "CONSTRUÇÃO DE QUADRA POLIESPORTIVA COBERTA",
            " Aquisição de smartphone, tablete e brinquedos",
            "AQUISIÇÃO DE MATERIAL DE ACONDICIONAMENTO, EMBALAGENS E DESCARTÁVEIS"]
    assert all(c(o) for o in dentro)
    assert not any(c(o) for o in fora)
    assert c("qualquer objeto", classes_catmat={7830}) == "catmat"


def test_escopo_piso_grama_sintetica_e_parque_infantil():
    from coletor.escopo import classificar as c
    for o in ["Aquisição de grama sintética para campo society",
              "Fornecimento e instalação de grama sintética no campo do estádio municipal",
              "Aquisição e instalação de piso emborrachado para playground",
              "Aquisição de piso vinílico esportivo para ginásio"]:
        assert c(o) == "piso", o
    assert c("Aquisição de parque infantil e brinquedos para praças")
    assert c("Aquisição de playground de madeira para escolas")
    for o in ["Aquisição de tapetes e capachos para o prédio sede", "Aquisição de carpete para auditório"]:
        assert c(o) is None, o
    assert c("x", pdms={18481}) == "catmat"
    assert c("x", classes_catmat={7220}) is None   # tapete/carpete da mesma classe não entram


def test_obras_com_grama_e_borracha_granulada():
    from coletor.escopo import classificar as c, interesse_borracha as ib
    assert c("CONSTRUÇÃO DE QUADRA SOCIETY COM GRAMA SINTÉTICA E ALAMBRADO") == "obra_piso"
    assert c("Reforma do campo de futebol com substituição do gramado sintético") == "obra_piso"
    assert c("Implantação de academia ao ar livre com piso emborrachado") == "obra_piso"
    assert c("Aquisição de borracha granulada SBR para reposição do campo sintético") == "borracha"
    assert c("Aquisição de raspa de borracha para manutenção de gramado") == "borracha"
    assert c("CONSTRUÇÃO DE QUADRA POLIESPORTIVA COBERTA") is None
    assert ib("CONSTRUÇÃO DE QUADRA SOCIETY COM GRAMA SINTÉTICA") is True
    assert ib("Aquisição de piso vinílico esportivo para ginásio") is False
    assert c("x", pdms={9461}) == "catmat"
    assert c("Piso vinílico hospitalar", pdms={10779}) is None     # PDM condicional
    assert c("Piso esportivo para quadra", pdms={10779}) == "catmat"

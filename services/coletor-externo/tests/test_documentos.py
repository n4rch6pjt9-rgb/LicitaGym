from unittest.mock import patch
from coletor.destino import sha256
"""Documentos Paradigma -> Supabase Storage (offline). Fluxo do HAR SFIEC PE000652022, sem dados pessoais."""
from unittest.mock import MagicMock

import pytest

from coletor import destino as D
from coletor import documentos_paradigma as DP
from coletor import paradigma as P

DET = {"nCdProcesso": 32, "nCdOrigem": 32, "nCdModulo": 18, "nCdAnexo": 12068, "sNrProcesso": "PE000652022"}
ANEXOS = [  # PesquisarAnexos real (reduzido)
    {"nCdAnexo": 12068, "nSqAnexo": 1, "sDsAnexo": "Aviso Jornal - PE000652022.pdf", "sNmArquivo": "wbc202208011907117200.pdf",
     "tDtAnexo": "/Date(1659391631737)/", "sDsOrigem": "Processo", "sDsParametroCriptografado": "?q=AAA"},
    {"nCdAnexo": 12068, "nSqAnexo": 8, "sDsAnexo": "Relatorio de Justificativa e Anexos - PE000652022.pdf",
     "sNmArquivo": "wbc202209301642207370.pdf", "tDtAnexo": "/Date(1664566940773)/", "sDsOrigem": "Processo",
     "sDsParametroCriptografado": "?q=BBB"},
]
PDF = b"%PDF-1.4 conteudo de teste"
VIS = DP.VisitanteInstitucional("24608949000137", "EMPRESA TESTE LTDA", "contato@empresa.test", "8540000000", "CE")


class Resp:
    def __init__(self, body=PDF, ctype="application/pdf", status=200):
        self.body, self.status_code, self.headers = body, status, {"content-type": ctype}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise D.requests.HTTPError(str(self.status_code))

    def iter_content(self, n):
        yield self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def portal_fake(exige=1, body=PDF, ctype="application/pdf"):
    p = P.PortalParadigma(P.FONTES["sfiec"], sessao=MagicMock(), delay=0)
    chamadas = []

    def ws(metodo, corpo):
        chamadas.append((metodo, corpo))
        return {"PesquisarAnexos": ANEXOS, "ValidarSalvarVisitante": exige, "AnexoExiste": "",
                "SalvarVisitante": {"nCdCodigo": 5209}, "PesquisarProcessoDetalheRelatorio": []}[metodo]
    p._ws = ws
    p.s.get.side_effect = lambda url, **k: Resp(body, ctype)
    return p, chamadas


def sb_fake(existentes=()):
    sb = MagicMock()
    sb.selecionar.side_effect = (
        lambda tabela, **k:
        list(existentes) if tabela == "licitacao_documentos" else []
    )

    def upsert(tabela, linhas, conflito):
        if tabela != "licitacao_documentos":
            return [linhas]

        return [
            {
                **linha,
                "id": 1000 + i,
                "status_processamento": "pendente",
                "sha256": None,
            }
            for i, linha in enumerate(
                linhas if isinstance(linhas, list) else [linhas]
            )
        ]

    sb.upsert.side_effect = upsert
    return sb


def atualizacoes(sb):
    return {c.args[1]: c.args[2] for c in sb.atualizar.call_args_list}



def processar_versao_fake(
    sb, arm, documento_id, caminho_base, secao, conteudo, mime_type
):
    digest = sha256(conteudo)
    return {
        "id": documento_id,
        "documento_id": documento_id,
        "sha256": digest,
        "storage_uri": f"supabase://licitacao-documentos/{documento_id}/{digest}",
        "tamanho_bytes": len(conteudo),
        "mime_type": mime_type,
    }, True






@pytest.fixture(autouse=True)
def mock_versionamento():
    with patch(
        "coletor.versionamento.processar_versao",
        side_effect=processar_versao_fake,
    ):
        yield



def test_baixa_com_visitante_institucional_e_guarda_no_storage():
    p, chamadas = portal_fake()
    sb, arm = sb_fake(), MagicMock()
    arm.salvar.side_effect = lambda caminho, c, t: f"supabase://licitacao-documentos/{caminho}"
    r = DP.DocumentosParadigma(p, sb, arm, VIS).sincronizar(10, DET, "paradigma/sfiec/18/32")
    assert r["documentos"] == 2 and r["novos"] == 2 and r["baixados"] == 2 and r["erros"] == 0
    salvar = [c for c in chamadas if c[0] == "SalvarVisitante"]
    dto = salvar[0][1]["dtoVisitante"]
    assert dto["sDsTipoDocumento"] == "CNPJ" and dto["sDsCnpj"] == "24608949000137" and dto["sDsCpf"] == ""
    assert dto["bFlConsentimentoLGPD"] == 1
    assert salvar[1][1]["dtoVisitante"]["nCdVisitante"] == 5209          # reaproveita o visitante
    up = atualizacoes(sb)[1000]
    assert up["status_processamento"] == "baixado" and up["storage_uri"].startswith("supabase://licitacao-documentos/")
    assert up["sha256"] == D.sha256(PDF) and up["tamanho_bytes"] == len(PDF)
    assert not arm.salvar.called
    assert up["storage_uri"].startswith(
        "supabase://licitacao-documentos/"
    )
    assert up["sha256"] in up["storage_uri"]
    linhas = sb.upsert.call_args_list[0].args[1]
    assert linhas[1]["nome_original"].startswith("Relatorio de Justificativa") and linhas[1]["origem_portal"] == "Processo"
    assert all("sDsParametroCriptografado" not in l["raw"] for l in linhas)
    assert sb.upsert.call_args_list[-1].args[0] == "portal_visitante"
    assert sb.upsert.call_args_list[-1].args[1] == {"fonte": "sfiec", "n_cd_visitante": 5209, "tipo_documento": "CNPJ",
                                                    "cnpj": "24608949000137", "documento_hash": None}


def test_sem_cadastro_configurado_nao_baixa_e_fica_pendente():
    p, chamadas = portal_fake(exige=1)
    sb, arm = sb_fake(), MagicMock()
    r = DP.DocumentosParadigma(p, sb, arm, None).sincronizar(10, DET, "x")
    assert r["aguardando_cadastro"] == 2 and r["baixados"] == 0
    assert not any(c[0] == "SalvarVisitante" for c in chamadas)
    p.s.get.assert_not_called()                                       # não contorna a exigência do portal
    assert all(u["status_processamento"] == "pendente" and "VISITANTE_" in u["erro"] for u in atualizacoes(sb).values())


def test_portal_sem_exigencia_baixa_sem_cadastro():
    p, chamadas = portal_fake(exige=0)
    sb, arm = sb_fake(), MagicMock(salvar=MagicMock(return_value="supabase://b/x"))
    r = DP.DocumentosParadigma(p, sb, arm, None).sincronizar(10, DET, "x")
    assert r["baixados"] == 2 and not any(c[0] == "SalvarVisitante" for c in chamadas)


def test_historico_nao_rebaixa_nem_presume_remocao_do_portal():
    existentes = [
        {"id": 90, "arquivo_origem": "wbc202208011907117200.pdf", "status_processamento": "baixado", "sha256": "abc",
         "removido_do_portal_em": None},
        {"id": 91, "arquivo_origem": "wbc_antigo_errata.pdf", "status_processamento": "baixado", "sha256": "def",
         "removido_do_portal_em": None},
    ]
    p, _ = portal_fake()
    sb, arm = sb_fake(existentes), MagicMock(salvar=MagicMock(return_value="supabase://b/x"))
    r = DP.DocumentosParadigma(p, sb, arm, VIS).sincronizar(10, DET, "x")
    assert r["novos"] == 1 and r["baixados"] == 2 and r["removidos_do_portal"] == 0
    assert 91 not in atualizacoes(sb)  # ausência na coleta não comprova remoção
    sb.remover_pendentes_exceto.assert_not_called()


def test_html_no_lugar_do_arquivo_vira_erro():
    p, _ = portal_fake(exige=0, body=b"<html><body>Erro</body></html>", ctype="text/html")
    sb, arm = sb_fake(), MagicMock()
    r = DP.DocumentosParadigma(p, sb, arm, None).sincronizar(10, DET, "x")
    assert r["erros"] == 2 and r["baixados"] == 0
    arm.salvar.assert_not_called()


def test_arquivo_grande_fica_ignorado():
    p, _ = portal_fake(exige=0, body=b"%PDF" + b"0" * 2000)
    sb, arm = sb_fake(), MagicMock()
    r = DP.DocumentosParadigma(p, sb, arm, None, max_bytes=1000).sincronizar(10, DET, "x")
    assert r["ignorados"] == 2 and all(u["status_processamento"] == "ignorado" for u in atualizacoes(sb).values())


def test_visitante_do_ambiente_exige_cnpj_valido_e_consentimento(monkeypatch):
    for k in ("VISITANTE_CNPJ", "VISITANTE_CONSENTIMENTO_LGPD", "VISITANTE_RAZAO_SOCIAL", "VISITANTE_EMAIL",
              "VISITANTE_TELEFONE", "VISITANTE_UF", "VISITANTE_CONTATO"):
        monkeypatch.setattr(DP, "env", lambda n, padrao=None, obrigatorio=False, _v={}: _v.get(n, padrao))
    base = {"VISITANTE_CNPJ": "24.608.949/0001-37", "VISITANTE_RAZAO_SOCIAL": "EMPRESA TESTE LTDA",
            "VISITANTE_EMAIL": "c@e.test", "VISITANTE_TELEFONE": "(85) 4000-0000", "VISITANTE_UF": "ce"}

    def com(vals):
        monkeypatch.setattr(DP, "env", lambda n, padrao=None, obrigatorio=False: vals.get(n, padrao))
        return DP.VisitanteInstitucional.do_ambiente()

    assert com({}) is None
    with pytest.raises(SystemExit):
        com(base)                                                   # sem consentimento explícito
    with pytest.raises(SystemExit):
        com({**base, "VISITANTE_CONSENTIMENTO_LGPD": "1", "VISITANTE_CNPJ": "24.608.949/0001-38"})
    v = com({**base, "VISITANTE_CONSENTIMENTO_LGPD": "1"})
    assert v.cnpj == "24608949000137" and v.telefone == "8540000000" and v.uf == "CE"


def test_supabase_storage_grava_no_bucket_privado():
    s = MagicMock()
    s.post.return_value = MagicMock(status_code=200)
    st = D.SupabaseStorage("https://x.supabase.co", "chave", "licitacao-documentos", sessao=s)
    uri = st.salvar("paradigma/sfiec/18/32/processo/a.pdf", PDF, "application/pdf")
    assert uri == "supabase://licitacao-documentos/paradigma/sfiec/18/32/processo/a.pdf"
    url = s.post.call_args.args[0]
    h = s.post.call_args.kwargs["headers"]
    assert url == "https://x.supabase.co/storage/v1/object/licitacao-documentos/paradigma/sfiec/18/32/processo/a.pdf"
    assert h["x-upsert"] == "true" and h["Authorization"] == "Bearer chave"
    arm = D.Armazenamento(supabase=st)
    assert arm.dentro_do_saas and arm.salvar("p/a.pdf", PDF, None).startswith("supabase://")
    assert not D.Armazenamento().dentro_do_saas                     # disco local não conta como LicitaGym


def test_dry_run_so_lista():
    p, chamadas = portal_fake()
    r = DP.DocumentosParadigma(p, None, None, None, dry_run=True).sincronizar(None, DET, "x")
    assert r["documentos"] == 2 and [c[0] for c in chamadas] == ["PesquisarAnexos"]


def test_caminho_destino_da_migracao():
    from coletor.migrar_storage import caminho_destino
    assert caminho_destino("/home/fiscalvectracargo/licitagym-coletor-sestsenat/dados/sestsenat/59/10/processo/a.pdf") \
        == "sestsenat/59/10/processo/a.pdf"
    assert caminho_destino("gs://bucket/sestsenat/59/58/processo/b.zip") == "sestsenat/59/58/processo/b.zip"
    with pytest.raises(ValueError):
        caminho_destino("/tmp/solto.pdf")


# ---------------- Visitante por CPF (decisão do Marcelo, 12/11/2026) ----------------
CPF_TESTE = "52998224725"  # CPF de exemplo com dígito verificador válido, usado em documentação de validação
CHAVE_TESTE = "chave-hmac-de-teste-com-32-caracteres!!"
VIS_CPF = DP.VisitanteInstitucional(CPF_TESTE, "PESSOA TESTE", "p@e.test", "8540000000", "CE", tipo="CPF",
                                    chave_hash=CHAVE_TESTE)


def _ambiente(monkeypatch, vals):
    monkeypatch.setattr(DP, "env", lambda n, padrao=None, obrigatorio=False: vals.get(n, padrao))
    return DP.VisitanteInstitucional.do_ambiente()


def test_visitante_do_ambiente_aceita_cpf_valido_com_nome(monkeypatch):
    base = {"VISITANTE_CPF": "529.982.247-25", "VISITANTE_NOME": "PESSOA TESTE", "VISITANTE_EMAIL": "p@e.test",
            "VISITANTE_TELEFONE": "(85) 4000-0000", "VISITANTE_UF": "ce", "VISITANTE_CONSENTIMENTO_LGPD": "1",
            "VISITANTE_HASH_CHAVE": CHAVE_TESTE}
    v = _ambiente(monkeypatch, base)
    assert (v.tipo, v.documento, v.nome) == ("CPF", CPF_TESTE, "PESSOA TESTE")
    with pytest.raises(SystemExit):                                               # sem chave, o hash é reversível
        _ambiente(monkeypatch, {k: x for k, x in base.items() if k != "VISITANTE_HASH_CHAVE"})
    with pytest.raises(SystemExit):                                               # chave curta se adivinha
        _ambiente(monkeypatch, {**base, "VISITANTE_HASH_CHAVE": "123"})
    with pytest.raises(SystemExit):
        _ambiente(monkeypatch, {**base, "VISITANTE_CPF": "529.982.247-24"})          # dígito verificador
    with pytest.raises(SystemExit):
        _ambiente(monkeypatch, {**base, "VISITANTE_CPF": "111.111.111-11"})          # repetido
    with pytest.raises(SystemExit):
        _ambiente(monkeypatch, {k: x for k, x in base.items() if k != "VISITANTE_NOME"})
    with pytest.raises(SystemExit):
        _ambiente(monkeypatch, {k: x for k, x in base.items() if k != "VISITANTE_CONSENTIMENTO_LGPD"})


def test_visitante_com_cnpj_e_cpf_ao_mesmo_tempo_e_ambiguo(monkeypatch):
    with pytest.raises(SystemExit):
        _ambiente(monkeypatch, {"VISITANTE_CNPJ": "24.608.949/0001-37", "VISITANTE_CPF": "529.982.247-25",
                                "VISITANTE_CONSENTIMENTO_LGPD": "1"})


def test_baixa_com_visitante_cpf_preenche_cpf_e_guarda_so_o_hash_no_banco():
    p, chamadas = portal_fake()
    sb, arm = sb_fake(), MagicMock()
    r = DP.DocumentosParadigma(p, sb, arm, VIS_CPF).sincronizar(10, DET, "paradigma/sfiec/18/32")
    assert r["baixados"] == 2 and r["erros"] == 0
    salvar = [c for c in chamadas if c[0] == "SalvarVisitante"]
    dto = salvar[0][1]["dtoVisitante"]
    assert salvar[1][1]["dtoVisitante"]["nCdVisitante"] == 5209     # mesma execução: reaproveita o cadastro
    assert dto["sDsTipoDocumento"] == "CPF" and dto["sDsCpf"] == CPF_TESTE and dto["sDsCnpj"] == ""
    assert dto["sNmVisitante"] == "PESSOA TESTE"
    import hashlib
    import hmac
    esperado = hmac.new(CHAVE_TESTE.encode(), f"cpf:{CPF_TESTE}".encode(), hashlib.sha256).hexdigest()
    consulta = [c for c in sb.selecionar.call_args_list if c.args[0] == "portal_visitante"]
    assert consulta and consulta[0].kwargs["documento_hash"] == f"eq.{esperado}"
    assert "cnpj" not in consulta[0].kwargs
    linha = [c.args[1] for c in sb.upsert.call_args_list if c.args[0] == "portal_visitante"][0]
    assert linha == {"fonte": "sfiec", "n_cd_visitante": 5209, "tipo_documento": "CPF", "cnpj": None,
                     "documento_hash": esperado}
    assert CPF_TESTE not in str(linha)                         # CPF é dado pessoal: no banco, só o HMAC


def test_cadastro_cpf_reaproveitado_entre_execucoes():
    p, chamadas = portal_fake()
    sb = sb_fake()
    sb.selecionar.side_effect = lambda tabela, **k: [{"n_cd_visitante": 77}] if tabela == "portal_visitante" else []
    DP.DocumentosParadigma(p, sb, MagicMock(), VIS_CPF).sincronizar(10, DET, "x")
    assert [c for c in chamadas if c[0] == "SalvarVisitante"][0][1]["dtoVisitante"]["nCdVisitante"] == 77


def test_cpf_nao_aparece_na_representacao_do_visitante():
    assert CPF_TESTE not in repr(VIS_CPF) and CHAVE_TESTE not in repr(VIS_CPF)


def test_erro_do_salvar_visitante_nao_grava_o_corpo_da_resposta():
    """Revisor de segurança, 12/11/2026: o corpo pode ecoar CPF formatado, nome, e-mail; o erro vai para o banco."""
    p, _ = portal_fake()
    p._ws = lambda m, payload: {"ValidarSalvarVisitante": 1}.get(
        m, {"sDsCpf": "529.982.247-25", "sNmVisitante": "PESSOA TESTE"})
    dp = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_CPF)
    with pytest.raises(RuntimeError) as erro:
        dp._identificar({"nCdAnexo": 1, "nSqAnexo": 1}, DET)
    assert "529" not in str(erro.value) and "PESSOA" not in str(erro.value)
    assert "sDsCpf" in str(erro.value)                         # só as chaves, para diagnóstico


def test_erro_do_salvar_visitante_traz_o_motivo_do_portal_sem_dado_pessoal():
    """Run 43324762704 (12/11/2026): o portal recusou o cadastro por CPF e o motivo (sDsConteudo) não chegou ao log.
    O erro passa a trazer nCdCodigo e a mensagem, com os dados do visitante mascarados em qualquer formato."""
    p, _ = portal_fake()
    mensagem = ("Visitante PESSOA TESTE (Pessoa Teste) CPF 529.982.247-25 / 52998224725, p@e.test, "
                "(85) 4000-0000: tipo de documento inválido")
    p._ws = lambda m, payload: {"ValidarSalvarVisitante": 1}.get(m, {"nCdCodigo": -1, "sDsConteudo": mensagem})
    dp = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_CPF)
    with pytest.raises(RuntimeError) as erro:
        dp._identificar({"nCdAnexo": 1, "nSqAnexo": 1}, DET)
    texto = str(erro.value)
    assert "nCdCodigo=-1" in texto and "tipo de documento inválido" in texto
    for dado in ("529", "52998224725", "PESSOA", "Pessoa Teste", "p@e.test", "4000-0000", "8540000000"):
        assert dado not in texto, dado


def test_mascara_do_visitante_pega_nome_parcial_sem_acento_e_comando_do_actions():
    """Revisor de segurança (#534): nome parcial ou sem acento, CPF com outros separadores e quebra de linha que viraria
    comando `::` do Actions."""
    v = DP.VisitanteInstitucional(CPF_TESTE, "JOSÉ DA SILVA", "j@e.test", "8540000000", "BA", tipo="CPF")
    texto = v.mascarar("Jose recusado; silva; CPF 529_982_247,25 / 529 982 247 25\n::stop-commands::x\r::error::y")
    assert "Jose" not in texto and "silva" not in texto and "529" not in texto
    assert "\n" not in texto and "\r" not in texto
    assert "recusado" in texto and "::" in texto                # mensagem preservada, sem a quebra de linha


# ---------------- Download sem cadastro e resumo do processo (HAR FIEB 38191, 12/11/2026) ----------------
MURAL_FIEB = ('<script type="text/javascript">objConfiguracao = JSON.parse(\'{"bFlForumPublico":1,'
              '"bFlForumPublicoCotacao":1,"bFlCadastroParaEfetuarDownloadAnexoAreaPublica":0,'
              '"sCaminhoUpload":"/upload/"}\'); FecharObjeto(objConfiguracao);</script>')
RESUMO_HTML = ("<html><body>COMPRA DIRETA 30921564.2023.CD.4324.SESISE <script>$('#label_1').text(kendo.toString("
               "new Date(1692796800000), 'G'))</script> 1 - Objeto: Aquisição de Tatame</body></html>")


@pytest.mark.parametrize(("html", "esperado"), [
    (MURAL_FIEB, 0),
    (MURAL_FIEB.replace('AreaPublica":0', 'AreaPublica":1'), 1),
    ("<html>sem configuração</html>", None),
])
def test_le_do_mural_se_o_portal_exige_cadastro_para_baixar(html, esperado):
    assert P.cadastro_para_baixar(html) == esperado


def test_portal_le_a_configuracao_ao_abrir_o_mural(monkeypatch):
    sessao = MagicMock()
    sessao.get.return_value = MagicMock(status_code=200, text=MURAL_FIEB)
    monkeypatch.setattr(P.requests, "Session", lambda: sessao)
    assert P.PortalParadigma(P.FONTES["fieb"], delay=0).cadastro_download == 0
    assert P.PortalParadigma(P.FONTES["fieb"], sessao=MagicMock(), delay=0).cadastro_download is None


def test_portal_sem_exigencia_de_cadastro_baixa_direto_sem_visitante():
    """HAR FIEB: ValidarSalvarVisitante devolve 1 ("permite cadastro"), mas com a configuração em 0 o navegador baixa
    direto, sem SalvarVisitante. Antes o coletor deixava os 71 documentos do teste pendentes."""
    p, chamadas = portal_fake(exige=1)
    p.cadastro_download = 0
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), None).sincronizar(10, DET, "paradigma/fieb/19/38191")
    assert r["baixados"] == 2 and r["aguardando_cadastro"] == 0 and r["erros"] == 0
    assert not any(c[0] in ("ValidarSalvarVisitante", "SalvarVisitante") for c in chamadas)


def test_modulo_20_dispensa_cadastro_como_no_portal():
    p, chamadas = portal_fake(exige=1)
    p.cadastro_download = 1
    det = {**DET, "nCdModulo": 20}
    r = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), None).sincronizar(10, det, "x")
    assert r["baixados"] == 2 and not any(c[0] == "SalvarVisitante" for c in chamadas)


def test_portal_que_exige_cadastro_mantem_o_fluxo_do_visitante():
    p, chamadas = portal_fake(exige=1)
    p.cadastro_download = 1
    r = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), None).sincronizar(10, DET, "x")
    assert r["aguardando_cadastro"] == 2 and r["baixados"] == 0


def _portal_com_resumo(resumo=RESUMO_HTML):
    p, chamadas = portal_fake(exige=0)
    ws_original = p._ws

    def ws(metodo, corpo):
        if metodo == "PesquisarResumoEdital":
            chamadas.append((metodo, corpo))
            return resumo
        return ws_original(metodo, corpo)
    p._ws = ws
    return p, chamadas


def test_resumo_do_processo_encerrado_vira_documento_com_o_html_original():
    p, chamadas = _portal_com_resumo()
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), None).sincronizar(10, DET, "paradigma/fieb/18/32", resumo_processo=True)
    assert r["resumos"] == 1 and r["erros"] == 0
    corpo = [c[1] for c in chamadas if c[0] == "PesquisarResumoEdital"][0]
    assert corpo == {"dtoProcesso": {"nCdProcesso": 32, "nCdOrigem": 32, "nCdModulo": 18,
                                     "dtoIdioma": {"nCdIdioma": 1}, "sGMT": "-03:00"}}
    linhas = [ln for c in sb.upsert.call_args_list if c.args[0] == "licitacao_documentos"
              for ln in (c.args[1] if isinstance(c.args[1], list) else [c.args[1]])]
    resumo = [ln for ln in linhas if ln["arquivo_origem"] == DP.ARQUIVO_RESUMO][0]
    assert resumo["nome_original"] == "Resumo do processo" and resumo["origem_portal"] == "Resumo"
    up = [u for u in atualizacoes(sb).values() if u.get("mime_type") == "text/html"][0]
    assert up["status_processamento"] == "baixado" and up["sha256"] == D.sha256(RESUMO_HTML.encode("utf-8"))


def test_resumo_nao_e_pedido_para_processo_aberto():
    p, chamadas = _portal_com_resumo()
    r = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), None).sincronizar(10, DET, "x")
    assert "resumos" not in r or r["resumos"] == 0
    assert not any(c[0] == "PesquisarResumoEdital" for c in chamadas)


def test_resumo_vazio_conta_erro_e_nao_grava_documento_vazio():
    p, _ = _portal_com_resumo(resumo=None)
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), None).sincronizar(10, DET, "x", resumo_processo=True)
    assert r["resumos"] == 0 and r["erros"] == 1
    assert not any(u.get("mime_type") == "text/html" for u in atualizacoes(sb).values())


@pytest.mark.parametrize(("situacao", "esperado"), [
    ("Homologado", True), ("Finalizado com contrato", True), ("Homologado com contrato", True),
    ("Cancelado", False), ("Fracassada", False), ("Em andamento", False), (None, False),
])
def test_resumo_so_para_editais_encerrados_com_resultado(situacao, esperado):
    assert P.quer_resumo_do_processo({"sDsSituacao": situacao}) is esperado


def _resumo_com_geracao(ms):
    return RESUMO_HTML.replace("</body>", f"SALVADOR, <script>$('#frameResumoEdital').contents().find('#label_0').text("
                                           f"kendo.toString(new Date({ms}), 'G'))</script></body>")


def test_resumo_igual_com_data_de_geracao_diferente_tem_o_mesmo_hash():
    """Revisor (#536): a data de geração (label_0) é a hora da consulta; sem zerar, cada coleta viraria versão nova."""
    p, _ = _portal_com_resumo(_resumo_com_geracao(1794527485000))
    dp = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), None)
    a = dp.resumo_html(DET)
    p2, _ = _portal_com_resumo(_resumo_com_geracao(1794600000000))
    b = DP.DocumentosParadigma(p2, sb_fake(), MagicMock(), None).resumo_html(DET)
    assert a == b and "new Date(1692796800000)" in a          # data do processo preservada


def test_resumo_ja_baixado_com_mesmo_conteudo_nao_regrava_nem_conta_novo():
    p, _ = _portal_com_resumo()
    conteudo = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), None).resumo_html(DET).encode("utf-8")
    existente = {"id": 77, "arquivo_origem": DP.ARQUIVO_RESUMO, "status_processamento": "baixado",
                 "sha256": D.sha256(conteudo), "removido_do_portal_em": None}
    sb = sb_fake(existentes=[existente])
    r = DP.DocumentosParadigma(p, sb, MagicMock(), None).sincronizar(10, DET, "x", resumo_processo=True)
    assert r["resumos"] == 1 and r["novos"] == 2                # só os 2 anexos são novos
    assert 77 not in atualizacoes(sb)


def test_falha_no_resumo_ja_confirmado_preserva_o_baixado():
    p, _ = _portal_com_resumo(resumo=None)
    existente = {"id": 77, "arquivo_origem": DP.ARQUIVO_RESUMO, "status_processamento": "baixado",
                 "sha256": "a" * 64, "removido_do_portal_em": None}
    sb = sb_fake(existentes=[existente])
    r = DP.DocumentosParadigma(p, sb, MagicMock(), None).sincronizar(10, DET, "x", resumo_processo=True)
    assert r["erros"] == 1 and 77 not in atualizacoes(sb)


def test_dry_run_nao_pede_o_resumo_ao_portal():
    p, chamadas = _portal_com_resumo()
    r = DP.DocumentosParadigma(p, None, None, None, dry_run=True).sincronizar(None, DET, "x", resumo_processo=True)
    assert r["resumos"] == 0 and not any(c[0] == "PesquisarResumoEdital" for c in chamadas)


# ---------------- Spec 0061, CA-6 (K-13 cadastro completo, K-14 relatórios públicos) ----------------
# Fixture reduzida dos HARs da Firjan (processo 3800, 12/11/2026), sem dado pessoal: documento, nomes, endereço,
# e-mail e telefone trocados por valores de teste; códigos de cidade e UF de teste.
FIRJAN_DET = {"nCdProcesso": 3800, "nCdOrigem": 3800, "nCdModulo": 59, "nCdAnexo": 77001, "sNrProcesso": "SS 99/2026",
              "nIdTipoApuracao": 1, "nCdSituacao": 4, "nCdEmpresa": 2285}
FIRJAN_ANEXOS = [{"nCdAnexo": 77001, "nSqAnexo": 1, "sDsAnexo": "Edital SS 99-2026.pdf", "sNmArquivo": "wbc_teste_1.pdf",
                  "tDtAnexo": "/Date(1762900000000)/", "sDsOrigem": "Processo", "sDsParametroCriptografado": "?q=CCC"}]
PAISES = [{"sCdCodigo": "AR", "sDsRegiao": "Argentina", "tmpTipoRegiao": 0},
          {"sCdCodigo": "BR", "sDsRegiao": "Brasil", "tmpTipoRegiao": 0}]
ESTADOS = [{"sCdCodigo": "RJ", "sDsRegiao": "Rio de Janeiro", "sCdPai": "BR", "tmpTipoRegiao": 1},
           {"sCdCodigo": "SC", "sDsRegiao": "Santa Catarina", "sCdPai": "BR", "tmpTipoRegiao": 1}]
CIDADES_SC = [{"sCdCodigo": "4301", "sDsRegiao": "Blumenau", "sCdPai": "SC", "tmpTipoRegiao": 2},
              {"sCdCodigo": "4375", "sDsRegiao": "Florianópolis", "sCdPai": "SC", "tmpTipoRegiao": 2}]
RELATORIOS = [
    {"nCdItem": 59008, "sNmItem": "Pedidos de Reconsiderações", "sDsArquivoRelatorio": "Recursos", "bExibePublico": 1,
     "uidLicitacao": "00000000-0000-4000-8000-000000003800", "sDsParametroCriptografado": "?q=REL"},
    {"nCdItem": 59009, "sNmItem": "Relatório interno", "sDsArquivoRelatorio": "Interno", "bExibePublico": 0,
     "uidLicitacao": "00000000-0000-4000-8000-000000003800"},
]
PDF_REL = b"%PDF-1.7 relatorio de teste"
VIS_END = DP.VisitanteInstitucional(
    "52998224725", "PESSOA TESTE", "pessoa@teste.test", "48900000000", "SC", "48900000000", "CPF", "k" * 32,
    endereco="RUA DE TESTE", numero="100", bairro="CENTRO TESTE", cep="88000000", cidade="Florianopolis",
    rg="123456789")


def portal_firjan(cidades=CIDADES_SC, relatorios=RELATORIOS, rel_body=PDF_REL):
    p = P.PortalParadigma(P.FONTES["firjan"], sessao=MagicMock(), delay=0)
    chamadas, gets = [], []

    def ws(metodo, corpo):
        chamadas.append((metodo, corpo))
        if metodo == "PesquisarRegiao":
            r = corpo["dtoRegiao"]
            if r["tmpTipoRegiao"] == 0:
                return PAISES
            if r["tmpTipoRegiao"] == 1:
                return ESTADOS if r["sCdCodigo"] == "BR" and r["sCdPais"] == "BR" else []
            return cidades if r["sCdCodigo"] == "SC" and r["sCdPais"] == "BR" else []
        return {"PesquisarAnexos": FIRJAN_ANEXOS, "ValidarSalvarVisitante": 1, "AnexoExiste": "",
                "SalvarVisitante": {"nCdCodigo": 46000, "oComplemento": 137000, "sDsConteudo": ""},
                "PesquisarProcessoDetalheRelatorio": relatorios}[metodo]

    def get(url, **k):
        gets.append((url, k.get("params")))
        if "GetRelatorioAreaExterna" in url:
            return Resp(rel_body, "application/octet-stream")
        return Resp(PDF, "application/pdf")
    p._ws = ws
    p.cadastro_download = 1
    p.s.get.side_effect = get
    return p, chamadas, gets


def test_ca6_cadastro_completo_acha_a_cidade_e_manda_o_endereco():
    """CA-6 (K-13): PesquisarRegiao tipo 1 e 2, nCdCidade da lista, CEP com máscara, endereço e RG preenchidos."""
    p, chamadas, gets = portal_firjan()
    sb, arm = sb_fake(), MagicMock()
    r = DP.DocumentosParadigma(p, sb, arm, VIS_END).sincronizar(10, FIRJAN_DET, "paradigma/firjan/59/3800")
    assert r["baixados"] == 1 and r["erros"] == 0 and r["aguardando_cadastro"] == 0
    regioes = [c[1]["dtoRegiao"] for c in chamadas if c[0] == "PesquisarRegiao"]
    assert {"sCdCodigo": "BR", "tmpTipoRegiao": 1, "sCdPais": "BR"} in regioes
    assert {"sCdCodigo": "SC", "tmpTipoRegiao": 2, "sCdPais": "BR"} in regioes
    dto = [c[1]["dtoVisitante"] for c in chamadas if c[0] == "SalvarVisitante"][0]
    assert dto["nCdCidade"] == "4375" and dto["sCdCep"] == "88.000-000" and dto["sCdEstado"] == "SC"
    assert dto["sDsEndereco"] == "RUA DE TESTE" and dto["sNrEndereco"] == "100" and dto["sNmBairro"] == "CENTRO TESTE"
    assert dto["sDsRg"] == "123456789" and dto["sDsTelefone"] == "48900000000" and dto["sCdPais"] == "BR"
    assert "bFlInteresseCertame" not in dto


def test_ca6_segundo_cadastro_reaproveita_visitante_e_endereco():
    """O portal devolve o código do endereço em oComplemento; o mural manda de volta nos cadastros seguintes."""
    p, chamadas, _ = portal_firjan()
    anexos2 = FIRJAN_ANEXOS + [{**FIRJAN_ANEXOS[0], "nSqAnexo": 2, "sNmArquivo": "wbc_teste_2.pdf",
                                "sDsParametroCriptografado": "?q=DDD"}]
    ws = p._ws
    p._ws = lambda m, c: anexos2 if m == "PesquisarAnexos" else ws(m, c)
    DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    dtos = [c[1]["dtoVisitante"] for c in chamadas if c[0] == "SalvarVisitante"]
    assert len(dtos) == 2 and dtos[1]["nCdVisitante"] == 46000 and dtos[1]["nCdEndereco"] == 137000
    assert sum(1 for c in chamadas if c[0] == "PesquisarRegiao") == 2      # cidade buscada uma vez por execução


def test_ca6_cidade_fora_da_lista_fica_pendente_sem_salvar_visitante():
    """CA-6 (K-13): cidade não achada -> anexo pendente com o motivo, nenhum SalvarVisitante, nada baixado."""
    p, chamadas, gets = portal_firjan(cidades=[CIDADES_SC[0]], relatorios=[])
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    assert r["aguardando_cadastro"] == 1 and r["baixados"] == 0
    assert not any(c[0] == "SalvarVisitante" for c in chamadas)
    assert not any("Download.aspx" in u for u, _ in gets)
    up = atualizacoes(sb)[1000]
    assert up["status_processamento"] == "pendente" and "cidade" in up["erro"] and "SC" in up["erro"]


def test_ca6_relatorio_publico_vira_documento_do_processo():
    """CA-6 (K-14): só o relatório com bExibePublico=1, PDF de GetRelatorioAreaExterna (reportType=1)."""
    p, chamadas, gets = portal_firjan()
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "paradigma/firjan/59/3800")
    assert r["relatorios"] == 1 and r["erros"] == 0
    req = [c[1]["dtoProcesso"] for c in chamadas if c[0] == "PesquisarProcessoDetalheRelatorio"][0]
    assert req["nCdProcesso"] == 3800 and req["nCdEmpresa"] == 2285 and req["nIdTipoApuracao"] == 1
    assert req["nCdSituacao"] == 4 and req["dtoIdioma"] == {"nCdIdioma": 1}
    rel = [(u, q) for u, q in gets if "GetRelatorioAreaExterna" in u]
    assert len(rel) == 1
    url, params = rel[0]
    assert url == "https://portaldecompras.firjan.com.br/licitacao-backend/wbc/GetRelatorioAreaExterna"
    assert params == {"uidLicitacao": "00000000-0000-4000-8000-000000003800", "nCdItem": 59008, "nCdIdioma": 1,
                      "sDsTitulo": "Pedidos de Reconsiderações", "reportType": 1}
    linhas = [l for c in sb.upsert.call_args_list if c.args[0] == "licitacao_documentos" for l in c.args[1]]
    doc = [l for l in linhas if l["arquivo_origem"] == "relatorio_59008.pdf"][0]
    assert doc["nome_original"] == "Pedidos de Reconsiderações" and doc["origem_portal"] == "Relatório"
    assert "sDsParametroCriptografado" not in doc["raw"] and "uidLicitacao" not in doc["raw"]
    ups = [u for u in atualizacoes(sb).values() if u.get("mime_type") == "application/pdf"
           and u.get("sha256") == D.sha256(PDF_REL)]
    assert ups and ups[0]["status_processamento"] == "baixado"


def test_ca6_relatorio_que_volta_html_conta_erro_e_nao_grava():
    html = b"<!DOCTYPE html><html><body>erro</body></html>"
    p, _, _ = portal_firjan(rel_body=html)
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    assert r["relatorios"] == 0 and r["erros"] == 1
    assert not any(u.get("sha256") == D.sha256(html) for u in atualizacoes(sb).values())


def test_ca6_falha_na_lista_de_relatorios_nao_derruba_os_anexos():
    p, _, _ = portal_firjan()
    ws = p._ws

    def falha(m, c):
        if m == "PesquisarProcessoDetalheRelatorio":
            raise D.requests.ConnectionError("portal fora")
        return ws(m, c)
    p._ws = falha
    r = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    assert r["baixados"] == 1 and r["erros"] == 1 and r["relatorios"] == 0


def test_ca6_endereco_do_ambiente_completo_ou_nada(monkeypatch):
    base = {"VISITANTE_CPF": "529.982.247-25", "VISITANTE_NOME": "PESSOA TESTE", "VISITANTE_EMAIL": "p@t.test",
            "VISITANTE_TELEFONE": "(48) 90000-0000", "VISITANTE_UF": "sc", "VISITANTE_CONSENTIMENTO_LGPD": "1",
            "VISITANTE_HASH_CHAVE": "k" * 32}
    endereco = {"VISITANTE_ENDERECO": "RUA DE TESTE", "VISITANTE_NUMERO": "100", "VISITANTE_BAIRRO": "CENTRO",
                "VISITANTE_CEP": "88.000-000", "VISITANTE_CIDADE": "Florianópolis", "VISITANTE_RG": "12.345.678-9"}

    def com(vals):
        monkeypatch.setattr(DP, "env", lambda n, padrao=None, obrigatorio=False: vals.get(n, padrao))
        return DP.VisitanteInstitucional.do_ambiente()

    sem = com(base)
    assert sem.endereco == "" and sem.cidade == ""                         # sem endereço: comportamento antigo
    v = com({**base, **endereco})
    assert v.cep == "88000000" and v.rg == "123456789" and v.cidade == "Florianópolis"
    with pytest.raises(SystemExit, match="VISITANTE_BAIRRO"):
        com({**base, **{k: x for k, x in endereco.items() if k != "VISITANTE_BAIRRO"}})
    with pytest.raises(SystemExit, match="VISITANTE_CEP"):
        com({**base, **endereco, "VISITANTE_CEP": "8800"})
    cnpj = {k: x for k, x in base.items() if k not in ("VISITANTE_CPF", "VISITANTE_NOME", "VISITANTE_HASH_CHAVE")}
    cnpj.update({"VISITANTE_CNPJ": "24.608.949/0001-37", "VISITANTE_RAZAO_SOCIAL": "EMPRESA TESTE LTDA"})
    with pytest.raises(SystemExit, match="VISITANTE_RG"):
        com({**cnpj, **endereco})                                          # RG só com CPF
    assert "RUA" not in repr(v) and "88000000" not in repr(v) and "123456789" not in repr(v)


def test_ca6_mascara_tira_endereco_e_rg_do_motivo_do_portal():
    texto = "Visitante RUA DE TESTE 100 CENTRO TESTE 88.000-000 rg 123456789 recusado"
    m = VIS_END.mascarar(texto)
    assert "TESTE" not in m and "88.000-000" not in m and "123456789" not in m and "recusado" in m


# ---------------- revisores da parte 2 ----------------
def test_ca6_erro_http_do_relatorio_nao_leva_o_uid_para_o_log(caplog):
    """revisor-seguranca: a mensagem do requests traz a URL com o uidLicitacao."""
    p, _, _ = portal_firjan()
    get = p.s.get.side_effect
    p.s.get.side_effect = lambda url, **k: (Resp(b"", "text/html", 404) if "GetRelatorioAreaExterna" in url
                                            else get(url, **k))
    sb = sb_fake()
    r = DP.DocumentosParadigma(p, sb, MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    assert r["erros"] == 1 and r["relatorios"] == 0
    # A falha vem antes de a linha existir: nada no banco; o log leva só o status.
    assert "HTTP 404" in caplog.text and "00000000-0000-4000-8000-000000003800" not in caplog.text
    assert not any("00000000-0000-4000-8000-000000003800" in (u.get("erro") or "") for u in atualizacoes(sb).values())


def test_ca6_relatorio_nao_segue_redirecionamento():
    p, _, gets = portal_firjan()
    kwargs = []
    get = p.s.get.side_effect
    p.s.get.side_effect = lambda url, **k: (kwargs.append(k), get(url, **k))[1]
    DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    rel = [k for k in kwargs if k.get("params") and "uidLicitacao" in k["params"]]
    assert rel and rel[0]["allow_redirects"] is False


def test_ca6_falha_na_lista_de_relatorios_desliga_o_resto_da_execucao():
    """revisor-codigo: portal sem o método não custa retry e erro em cada processo."""
    p, chamadas, _ = portal_firjan()
    ws = p._ws

    def falha(m, c):
        if m == "PesquisarProcessoDetalheRelatorio":
            chamadas.append((m, c))
            raise D.requests.HTTPError("500")
        return ws(m, c)
    p._ws = falha
    docs = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END)
    r1 = docs.sincronizar(10, FIRJAN_DET, "x")
    r2 = docs.sincronizar(11, {**FIRJAN_DET, "nCdProcesso": 3801}, "y")
    assert r1["erros"] == 1 and r2["erros"] == 0 and r2["relatorios_pulados"] == 1
    assert sum(1 for c in chamadas if c[0] == "PesquisarProcessoDetalheRelatorio") == 1


def test_ca6_relatorio_confirmado_de_processo_fechado_nao_e_baixado_de_novo():
    existentes = [{"id": 70, "arquivo_origem": "relatorio_59008.pdf", "status_processamento": "baixado",
                   "sha256": "abc", "removido_do_portal_em": None}]
    p, _, gets = portal_firjan()
    ws = p._ws
    p._ws = lambda m, c: "<html>" + "x" * 60 + "</html>" if m == "PesquisarResumoEdital" else ws(m, c)
    DP.DocumentosParadigma(p, sb_fake(existentes), MagicMock(), VIS_END).sincronizar(
        10, FIRJAN_DET, "x", resumo_processo=True)
    assert not any("GetRelatorioAreaExterna" in u for u, _ in gets)


def test_ca6_rg_com_x_e_rg_curto_mascarado():
    v = DP.VisitanteInstitucional("52998224725", "PESSOA TESTE", "p@t.test", "48900000000", "SC", "", "CPF",
                                  "k" * 32, rg="4123456")
    assert "4.123.456" not in v.mascarar("rg 4.123.456 recusado") and "recusado" in v.mascarar("rg 4.123.456 recusado")
    vx = DP.VisitanteInstitucional("52998224725", "PESSOA TESTE", "p@t.test", "48900000000", "SC", "", "CPF",
                                   "k" * 32, rg="1234567X")
    assert "678-x" not in vx.mascarar("rg 12.345.678-x").lower()


def test_ca6_rg_do_ambiente_mantem_o_x(monkeypatch):
    vals = {"VISITANTE_CPF": "529.982.247-25", "VISITANTE_NOME": "PESSOA TESTE", "VISITANTE_EMAIL": "p@t.test",
            "VISITANTE_TELEFONE": "48900000000", "VISITANTE_UF": "SC", "VISITANTE_CONSENTIMENTO_LGPD": "1",
            "VISITANTE_HASH_CHAVE": "k" * 32, "VISITANTE_RG": "12.345.678-x"}
    monkeypatch.setattr(DP, "env", lambda n, padrao=None, obrigatorio=False: vals.get(n, padrao))
    assert DP.VisitanteInstitucional.do_ambiente().rg == "12345678X"


def test_ca6_cookie_do_visitante_leva_o_endereco():
    p, _, _ = portal_firjan()
    DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    import json as _json
    cookie = [c for c in p.s.post.call_args_list if "SetCookie" in c.args[0]][0]
    valor = _json.loads(_json.loads(cookie.kwargs["data"])["value"])
    assert valor["nCdCidade"] == "4375" and valor["sCdCep"] == "88.000-000" and valor["nCdEndereco"] == 137000


def test_ca6_sem_endereco_dto_antigo_e_sem_pesquisar_regiao():
    p, chamadas = portal_fake()
    DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS).sincronizar(10, DET, "x")
    assert not any(c[0] == "PesquisarRegiao" for c in chamadas)
    dto = [c[1]["dtoVisitante"] for c in chamadas if c[0] == "SalvarVisitante"][0]
    assert dto["nCdCidade"] == "0" and dto["sCdCep"] == "" and dto["nCdEndereco"] == 0
    assert "bFlInteresseCertame" not in dto and dto["sDsRg"] == ""


def test_ca6_falha_na_regiao_nao_repete_por_anexo():
    p, chamadas, _ = portal_firjan(relatorios=[])
    anexos2 = FIRJAN_ANEXOS + [{**FIRJAN_ANEXOS[0], "nSqAnexo": 2, "sNmArquivo": "wbc_teste_2.pdf",
                                "sDsParametroCriptografado": "?q=DDD"}]
    ws = p._ws

    def regiao_quebrada(m, c):
        if m == "PesquisarRegiao":
            chamadas.append((m, c))
            return None
        return anexos2 if m == "PesquisarAnexos" else ws(m, c)
    p._ws = regiao_quebrada
    r = DP.DocumentosParadigma(p, sb_fake(), MagicMock(), VIS_END).sincronizar(10, FIRJAN_DET, "x")
    assert r["erros"] == 2 and sum(1 for c in chamadas if c[0] == "PesquisarRegiao") == 1

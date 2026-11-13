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
                "SalvarVisitante": {"nCdCodigo": 5209}}[metodo]
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

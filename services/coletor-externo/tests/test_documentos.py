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

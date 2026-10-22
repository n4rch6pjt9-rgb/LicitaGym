"""Consumidor da fila de preparação da Triagem (spec 0018, PR 4b). Sem rede: Supabase em memória, PNCP e
indexação falsos."""
import pytest
import requests

from coletor import preparar_triagem as PT

CODIGO = "44892693000140-1-000157/2026"


class SbFalso:
    """Supabase mínimo em memória: filtros eq./is.null/not.is.null, upsert pela chave, rpc registrada."""

    def __init__(self, licitacoes, documentos=(), rpc_respostas=None):
        self.t = {"licitacoes_externas": [dict(x) for x in licitacoes],
                  "licitacao_documentos": [dict(x) for x in documentos]}
        self.rpcs: list[tuple[str, dict]] = []
        self.rpc_respostas = rpc_respostas or {}
        self.prox_id = 1000

    @staticmethod
    def _casa(linha, filtros):
        for campo, f in filtros.items():
            if campo in ("select", "order"):
                continue
            v = linha.get(campo)
            if f == "is.null" and v is not None:
                return False
            if f == "not.is.null" and v is None:
                return False
            if f.startswith("eq.") and str(v) != f[3:]:
                return False
            if f.startswith("in.(") and str(v) not in f[4:-1].split(","):
                return False
        return True

    def selecionar(self, tabela, **filtros):
        return [dict(x) for x in self.t[tabela] if self._casa(x, filtros)]

    def atualizar(self, tabela, id_, campos):
        for x in self.t[tabela]:
            if x["id"] == id_:
                x.update(campos)

    def upsert(self, tabela, linhas, conflito):
        chaves = conflito.split(",")
        for nova in linhas:
            atual = next((x for x in self.t[tabela] if all(x.get(k) == nova[k] for k in chaves)), None)
            if atual:
                atual.update(nova)
            else:
                self.prox_id += 1
                self.t[tabela].append({"id": self.prox_id, "status_processamento": "pendente", "sha256": None,
                                       "storage_uri": None, "secao": "processo", "fornecedor_nome": None, **nova})
        return linhas

    def rpc(self, funcao, params):
        self.rpcs.append((funcao, params))
        r = self.rpc_respostas.get(funcao)
        if funcao == "fila_preparacao_reivindicar" and isinstance(r, list):
            assert params == {"p_limite": 1}, params   # um pedido por vez
            return [r.pop(0)] if r else []
        if isinstance(r, Exception):
            raise r
        if callable(r):
            return r(params)
        return r if r is not None else []


class PncpFalso:
    def __init__(self, arquivos=(), baixar=None):
        self._arquivos = list(arquivos)
        self._baixar = baixar or (lambda url, mx: (b"%PDF-1.4 conteudo", "application/pdf"))

    def arquivos(self, c):
        return self._arquivos

    def baixar(self, url, max_bytes):
        return self._baixar(url, max_bytes)


class ArmFalso:
    dentro_do_saas = True
    caminho = staticmethod(lambda fonte, mod, slug, secao, arq: f"{fonte}/{slug}/{secao}/{arq}")

    def salvar(self, caminho, conteudo, mime):
        return f"supabase://docs/{caminho}"


def lic_pncp(**kw):
    return {"id": 7, "fonte": "pncp", "codigo_externo": CODIGO, "regulamento": None, "orgao_cnpj": "44892693000140",
            "raw": {}, "numero_processo": "P1", "numero_edital": "PE 1", "entidade": None, "orgao_nome": "Órgão", **kw}


def concluiu(sb):
    """Parâmetros do último fila_preparacao_concluir."""
    return [p for n, p in sb.rpcs if n == "fila_preparacao_concluir"][-1]


PEDIDO = {"id": "u1", "tenant_id": 1, "licitacao_id": 7, "fonte": "pncp", "tentativa": 1}
ARQ = {"titulo": "Edital.pdf", "sequencialDocumento": 1, "url": "https://pncp.gov.br/x/1", "statusAtivo": True,
       "tipoDocumentoNome": "Edital", "dataPublicacaoPncp": "2026-10-01T10:00:00"}


@pytest.fixture
def indexa(monkeypatch):
    """indexar_grupo falso: marca o grupo como indexado (como o real faz)."""
    def falso(sb, ia, grupo, lic, com_extracao):
        for d in grupo:
            sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "indexado"})
        return {"status": "indexado", "trechos": 3}
    monkeypatch.setattr(PT, "indexar_grupo", falso)


def _detalhe(monkeypatch, amparo=None, erro=None):
    def falso(pncp, c):
        if erro:
            raise erro
        return {"amparoLegal": amparo} if amparo else {}
    monkeypatch.setattr(PT, "consultar_detalhe", falso)


def test_pncp_grava_amparo_baixa_indexa_reaplica_e_conclui_ok(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021, Art. 28, I"})
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    # o banco deriva o regulamento do amparo_legal (gatilho); aqui o falso imita

    def atualizar(tabela, id_, campos, _orig=sb.atualizar):
        _orig(tabela, id_, campos)
        if tabela == "licitacoes_externas" and campos.get("amparo_legal"):
            _orig(tabela, id_, {"regulamento": "LEI_14133"})
    sb.atualizar = atualizar

    r = PT.consumir(PncpFalso([ARQ]), sb, ArmFalso(), lambda: object())
    assert r["por_resultado"] == {"ok": 1}
    doc = sb.t["licitacao_documentos"][0]
    assert doc["arquivo_origem"] == "pncp-1" and doc["status_processamento"] == "indexado" and doc["sha256"]
    nomes = [n for n, _ in sb.rpcs]
    assert nomes == ["fila_preparacao_reivindicar", "pipeline_tarefas_reaplicar", "fila_preparacao_concluir",
                     "fila_preparacao_reivindicar"]   # a última volta vazia: fila acabou
    assert sb.rpcs[1][1] == {"p_tenant": 1, "p_licitacao": 7, "p_user": None}
    assert concluiu(sb) == {"p_id": "u1", "p_resultado": "ok", "p_erro": None, "p_tentativa": 1}


def test_sem_amparo_na_fonte_conclui_regulamento_nao_informado(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo=None)
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ]), sb, ArmFalso(), lambda: object())
    assert "amparo_legal" not in sb.t["licitacoes_externas"][0]   # ausente não é gravado
    assert concluiu(sb)["p_resultado"] == "regulamento_nao_informado_pela_fonte"


def test_sem_documento_conclui_sem_documento(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([]), sb, ArmFalso(), lambda: object())
    assert concluiu(sb)["p_resultado"] == "sem_documento"


def test_fonte_nao_pncp_nao_chama_pncp_e_usa_documentos_existentes(monkeypatch, indexa):
    _detalhe(monkeypatch, erro=AssertionError("não deveria consultar o PNCP"))
    lic = lic_pncp(fonte=None, codigo_externo=None)   # fonte nula nunca vira PNCP
    doc = {"id": 5, "licitacao_id": 7, "secao": "edital", "nome_original": "e.pdf", "arquivo_origem": "x",
           "fornecedor_nome": None, "sha256": "abc", "storage_uri": "supabase://d/e.pdf",
           "status_processamento": "baixado", "raw": {}}
    sb = SbFalso([lic], [doc], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert concluiu(sb)["p_resultado"] == "ok"


def test_falha_transitoria_reagenda_com_erro_curto_sem_url(monkeypatch, indexa):
    resp = requests.Response()
    resp.status_code = 504
    erro = requests.HTTPError("504 Server Error for url: https://pncp.gov.br/api/segredo?token=abc", response=resp)
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    r = PT.consumir(PncpFalso([ARQ], baixar=lambda u, m: (_ for _ in ()).throw(erro)), sb, ArmFalso(), lambda: object())
    assert r["reagendados"] == 1
    p = concluiu(sb)
    assert p["p_resultado"] is None and p["p_erro"] == "download: HTTP 504"
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "pendente"


def test_falha_definitiva_no_download_marca_erro_e_segue(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ], baixar=lambda u, m: (b"<html>erro</html>", "text/html")), sb, ArmFalso(),
                lambda: object())
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "erro"
    assert concluiu(sb)["p_resultado"] == "sem_documento"


def test_erro_inesperado_vai_ao_card_so_com_a_categoria(monkeypatch):
    def quebra(*a, **k):
        raise KeyError("detalhe interno")
    monkeypatch.setattr(PT, "preparar", quebra)
    sb = SbFalso([], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object())
    assert concluiu(sb)["p_erro"] == "erro interno: KeyError"


def test_pedido_tomado_por_outro_job_p0002_nao_derruba_o_lote(monkeypatch):
    monkeypatch.setattr(PT, "preparar", lambda *a, **k: "ok")
    dois = [PEDIDO, {**PEDIDO, "id": "u2"}]
    chamadas = []

    def concluir(params):
        chamadas.append(params["p_id"])
        if params["p_id"] == "u1":
            raise RuntimeError('Supabase rpc fila_preparacao_concluir: 400 {"code":"P0002"}')
        return "completed"
    sb = SbFalso([], rpc_respostas={"fila_preparacao_reivindicar": dois, "fila_preparacao_concluir": concluir})
    r = PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object())
    assert chamadas == ["u1", "u2"] and r["perdidos"] == 1 and r["concluidos"] == 1


def test_outra_falha_do_banco_ao_concluir_sobe():
    sb = SbFalso([], rpc_respostas={"fila_preparacao_concluir": RuntimeError("Supabase rpc: 500 boom")})
    with pytest.raises(RuntimeError):
        PT._concluir(sb, PEDIDO, "ok", None)


@pytest.mark.parametrize("e, esperado", [
    (requests.Timeout("lento https://x?k=1"), "timeout"),
    (requests.ConnectionError("host interno"), "falha de conexão"),
    (ValueError("qualquer"), "ValueError"),
])
def test_categoria_nunca_leva_a_mensagem(e, esperado):
    assert PT.categoria(e) == esperado


def test_limite_fora_da_faixa_recusa():
    with pytest.raises(SystemExit):
        PT.main(["--limite", "0"])


def _resp(status):
    r = requests.Response()
    r.status_code = status
    return r


DOC_ERRO_DOWNLOAD = {"id": 9, "licitacao_id": 7, "secao": "processo", "nome_original": "Edital.pdf",
                     "arquivo_origem": "pncp-1", "fornecedor_nome": None, "sha256": None, "storage_uri": None,
                     "status_processamento": "erro", "raw": {"url": "https://pncp.gov.br/x/1"},
                     "removido_do_portal_em": None}


def test_documento_em_erro_do_coletor_e_tentado_de_novo_e_conclui_ok(monkeypatch, indexa):
    """Regressão (revisão #331): 504 no coletor diário deixou o Edital em 'erro'; a Triagem baixa de novo."""
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], [DOC_ERRO_DOWNLOAD],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ]), sb, ArmFalso(), lambda: object())
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "indexado"
    assert concluiu(sb)["p_resultado"] == "ok"


def _doc_baixado(id_, sha, status="baixado"):
    return {"id": id_, "licitacao_id": 7, "secao": "edital", "nome_original": f"d{id_}.pdf", "arquivo_origem": f"x{id_}",
            "fornecedor_nome": None, "sha256": sha, "storage_uri": f"supabase://d/{id_}", "status_processamento": status,
            "raw": {}, "removido_do_portal_em": None}


def test_falha_deterministica_num_grupo_marca_erro_e_os_outros_seguem(monkeypatch):
    def indexar(sb, ia, grupo, lic, com_extracao):
        if grupo[0]["sha256"] == "ruim":
            raise ValueError("zip corrompido")
        for d in grupo:
            sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "indexado"})
        return {"status": "indexado"}
    monkeypatch.setattr(PT, "indexar_grupo", indexar)
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "bom"), _doc_baixado(2, "ruim")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    st = {d["id"]: d["status_processamento"] for d in sb.t["licitacao_documentos"]}
    assert st == {1: "indexado", 2: "erro"}
    assert concluiu(sb)["p_resultado"] == "ok"
    assert ("pipeline_tarefas_reaplicar" in [n for n, _ in sb.rpcs])


def test_falha_transitoria_na_indexacao_reagenda(monkeypatch):
    def indexar(sb, ia, grupo, lic, com_extracao):
        raise requests.HTTPError("429 cota", response=_resp(429))
    monkeypatch.setattr(PT, "indexar_grupo", indexar)
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "a")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert concluiu(sb) == {"p_id": "u1", "p_resultado": None, "p_erro": "indexação: HTTP 429", "p_tentativa": 1}
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "baixado"


def test_documento_ignorado_grava_motivo_e_conclui_sem_documento(monkeypatch):
    monkeypatch.setattr(PT, "indexar_grupo",
                        lambda sb, ia, g, lic, c: {"status": "ignorado", "erro": "sem texto aproveitável", "extracao": None})
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "a"), _doc_baixado(2, "a")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert [d["status_processamento"] for d in sb.t["licitacao_documentos"]] == ["ignorado", "ignorado"]
    assert concluiu(sb)["p_resultado"] == "sem_documento"


def test_documento_ja_indexado_conta_sem_reindexar(monkeypatch):
    monkeypatch.setattr(PT, "indexar_grupo", lambda *a, **k: pytest.fail("não deveria reindexar"))
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "a", "indexado")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert concluiu(sb)["p_resultado"] == "ok"


def test_detalhe_pncp_embrulhado_mostra_o_status_http(monkeypatch):
    from coletor.pncp import ConsultaFalhou
    try:
        try:
            raise requests.HTTPError("504 em https://pncp.gov.br/api?x=1", response=_resp(504))
        except requests.HTTPError as interno:
            raise ConsultaFalhou("detalhe falhou https://pncp.gov.br/api?x=1") from interno
    except ConsultaFalhou as e:
        erro = e
    _detalhe(monkeypatch, erro=erro)
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object())
    assert concluiu(sb)["p_erro"] == "detalhe PNCP: HTTP 504"


def test_armazenamento_fora_do_saas_nao_baixa(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})

    class ArmLocal(ArmFalso):
        dentro_do_saas = False
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ]), sb, ArmLocal(), lambda: object())
    assert concluiu(sb)["p_erro"] == "download: RuntimeError"
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "pendente"


@pytest.mark.parametrize("e, esperado", [
    (requests.HTTPError("x", response=_resp(503)), True),
    (requests.HTTPError("x", response=_resp(404)), False),
    (RuntimeError("Supabase storage 500"), True),
    (ValueError("pdf corrompido"), False),
])
def test_transitoria(e, esperado):
    assert PT.transitoria(e) is esperado


def test_reivindica_um_por_vez_e_para_quando_a_fila_esvazia(monkeypatch):
    monkeypatch.setattr(PT, "preparar", lambda *a, **k: "ok")
    fila = [PEDIDO, {**PEDIDO, "id": "u2"}]
    sb = SbFalso([], rpc_respostas={"fila_preparacao_reivindicar": fila})
    r = PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object(), limite=5)
    assert r["pedidos"] == 2
    assert [n for n, _ in sb.rpcs].count("fila_preparacao_reivindicar") == 3   # 2 pedidos + 1 vazio


def test_limite_para_de_reivindicar(monkeypatch):
    monkeypatch.setattr(PT, "preparar", lambda *a, **k: "ok")
    fila = [{**PEDIDO, "id": f"u{i}"} for i in range(5)]
    sb = SbFalso([], rpc_respostas={"fila_preparacao_reivindicar": fila})
    r = PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object(), limite=2)
    assert r["pedidos"] == 2 and len(fila) == 3   # os outros 3 nem saíram de pending


def test_documento_retirado_do_portal_nao_conta_como_indexado(monkeypatch):
    monkeypatch.setattr(PT, "indexar_grupo", lambda *a, **k: pytest.fail("não deveria indexar"))
    doc = {**_doc_baixado(1, "a", "indexado"), "removido_do_portal_em": "2026-10-11T00:00:00Z"}
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [doc], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert concluiu(sb)["p_resultado"] == "sem_documento"


def test_upload_413_do_storage_e_definitivo(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})

    class ArmCheio(ArmFalso):
        def salvar(self, caminho, conteudo, mime):
            raise RuntimeError(f"Supabase Storage {caminho}: 413 Payload too large")
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ]), sb, ArmCheio(), lambda: object())
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "erro"
    assert concluiu(sb)["p_resultado"] == "sem_documento"


@pytest.mark.parametrize("msg, esperado", [
    ("Supabase Storage a/b.pdf: 413 Payload too large", True),
    ("Supabase Storage a/b.pdf: 503 indisponível", False),
    ("Supabase Storage a/b.pdf: 429 calma", False),
])
def test_definitiva_storage(msg, esperado):
    assert PT.definitiva(RuntimeError(msg)) is esperado
    assert PT.transitoria(RuntimeError(msg)) is (not esperado)


@pytest.mark.parametrize("codigo", [401, 403, 404])
def test_gemini_sem_modelo_ou_permissao_falha_a_etapa_sem_marcar_documentos(monkeypatch, codigo):
    """Troca para o 3.8 no endpoint global (22/10): modelo não habilitado vale para todos os documentos. A etapa falha
    à vista no card em vez de marcar cada documento como erro e concluir 'sem documento'."""
    from google.genai import errors

    def indexar(sb, ia, grupo, lic, com_extracao):
        raise errors.ClientError(codigo, {"error": {"code": codigo, "status": "NOT_FOUND", "message": "x"}})
    monkeypatch.setattr(PT, "indexar_grupo", indexar)
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "a")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    fim = concluiu(sb)
    assert fim["p_resultado"] is None and fim["p_erro"] == f"indexação: HTTP {codigo}"
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "baixado"


def test_gen_thinking_invalido_falha_a_etapa_sem_marcar_documentos(monkeypatch):
    from coletor import ia as IA
    monkeypatch.setattr(IA, "GEN_THINKING", "minimal")
    monkeypatch.setattr(PT, "indexar_grupo", lambda *a: pytest.fail("não devia indexar"))
    sb = SbFalso([lic_pncp(fonte="sestsenat")], [_doc_baixado(1, "a")],
                 rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: IA.Gemini(project="p"))
    fim = concluiu(sb)
    assert fim["p_resultado"] is None and fim["p_erro"].startswith("indexação:")
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "baixado"

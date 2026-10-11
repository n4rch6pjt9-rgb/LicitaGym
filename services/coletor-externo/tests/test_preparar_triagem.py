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
    caminho = staticmethod(lambda fonte, mod, slug, secao, arq: f"{fonte}/{slug}/{secao}/{arq}")

    def salvar(self, caminho, conteudo, mime):
        return f"supabase://docs/{caminho}"


def lic_pncp(**kw):
    return {"id": 7, "fonte": "pncp", "codigo_externo": CODIGO, "regulamento": None, "orgao_cnpj": "44892693000140",
            "raw": {}, "numero_processo": "P1", "numero_edital": "PE 1", "entidade": None, "orgao_nome": "Órgão", **kw}


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
    assert nomes == ["fila_preparacao_reivindicar", "pipeline_tarefas_reaplicar", "fila_preparacao_concluir"]
    assert sb.rpcs[1][1] == {"p_tenant": 1, "p_licitacao": 7, "p_user": None}
    assert sb.rpcs[-1][1] == {"p_id": "u1", "p_resultado": "ok", "p_erro": None}


def test_sem_amparo_na_fonte_conclui_regulamento_nao_informado(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo=None)
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ]), sb, ArmFalso(), lambda: object())
    assert "amparo_legal" not in sb.t["licitacoes_externas"][0]   # ausente não é gravado
    assert sb.rpcs[-1][1]["p_resultado"] == "regulamento_nao_informado_pela_fonte"


def test_sem_documento_conclui_sem_documento(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([]), sb, ArmFalso(), lambda: object())
    assert sb.rpcs[-1][1]["p_resultado"] == "sem_documento"


def test_fonte_nao_pncp_nao_chama_pncp_e_usa_documentos_existentes(monkeypatch, indexa):
    _detalhe(monkeypatch, erro=AssertionError("não deveria consultar o PNCP"))
    lic = lic_pncp(fonte=None, codigo_externo=None)   # fonte nula nunca vira PNCP
    doc = {"id": 5, "licitacao_id": 7, "secao": "edital", "nome_original": "e.pdf", "arquivo_origem": "x",
           "fornecedor_nome": None, "sha256": "abc", "storage_uri": "supabase://d/e.pdf",
           "status_processamento": "baixado", "raw": {}}
    sb = SbFalso([lic], [doc], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, None, lambda: object())
    assert sb.rpcs[-1][1]["p_resultado"] == "ok"


def test_falha_transitoria_reagenda_com_erro_curto_sem_url(monkeypatch, indexa):
    resp = requests.Response()
    resp.status_code = 504
    erro = requests.HTTPError("504 Server Error for url: https://pncp.gov.br/api/segredo?token=abc", response=resp)
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp()], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    r = PT.consumir(PncpFalso([ARQ], baixar=lambda u, m: (_ for _ in ()).throw(erro)), sb, ArmFalso(), lambda: object())
    assert r["reagendados"] == 1
    p = sb.rpcs[-1][1]
    assert p["p_resultado"] is None and p["p_erro"] == "download: HTTP 504"
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "pendente"


def test_falha_definitiva_no_download_marca_erro_e_segue(monkeypatch, indexa):
    _detalhe(monkeypatch, amparo={"codigo": 1, "nome": "Lei 14.133/2021"})
    sb = SbFalso([lic_pncp(regulamento="LEI_14133")], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso([ARQ], baixar=lambda u, m: (b"<html>erro</html>", "text/html")), sb, ArmFalso(),
                lambda: object())
    assert sb.t["licitacao_documentos"][0]["status_processamento"] == "erro"
    assert sb.rpcs[-1][1]["p_resultado"] == "sem_documento"


def test_erro_inesperado_vai_ao_card_so_com_a_categoria(monkeypatch):
    def quebra(*a, **k):
        raise KeyError("detalhe interno")
    monkeypatch.setattr(PT, "preparar", quebra)
    sb = SbFalso([], rpc_respostas={"fila_preparacao_reivindicar": [PEDIDO]})
    PT.consumir(PncpFalso(), sb, ArmFalso(), lambda: object())
    assert sb.rpcs[-1][1]["p_erro"] == "erro interno: KeyError"


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

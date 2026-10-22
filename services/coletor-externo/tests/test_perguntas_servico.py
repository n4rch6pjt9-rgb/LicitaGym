"""Spec 0038, K-1: serviço "perguntar ao edital". Servidor real numa porta efêmera; modelo, embedding e Supabase
falsos (nenhum acesso ao Vertex nem ao Supabase)."""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from coletor import perguntas_servico as S

SEGREDO = "segredo-de-teste-0038"

CHUNKS = [
    {"chunk_id": 101, "documento_id": 7, "pagina": 3, "texto": "8.4.2 É obrigatória a realização de visita técnica."},
    {"chunk_id": 102, "documento_id": 7, "pagina": 5, "texto": "O prazo de entrega é de 30 dias corridos."},
    {"chunk_id": 103, "documento_id": 9, "pagina": None, "texto": "A garantia mínima é de 12 meses."},
]


class SbFalso:
    def __init__(self, linhas=None, erro: Exception | None = None):
        self.linhas = CHUNKS if linhas is None else linhas
        self.erro = erro
        self.chamadas = []

    def rpc(self, funcao, params, timeout=None):
        self.chamadas.append((funcao, params))
        self.timeout = timeout
        if self.erro:
            raise self.erro
        return self.linhas


def modelo_falso(*respostas, cortada=False):
    """Devolve as respostas em ordem (a última se repete)."""
    chamadas = []

    def chamar(prompt, timeout_s):
        assert 0 < timeout_s <= S.GERACAO_TIMEOUT_S
        chamadas.append(prompt)
        texto = respostas[min(len(chamadas), len(respostas)) - 1]
        return texto, {"entrada": 100, "saida": 20, "pensamento": 5, "cortada": cortada}

    chamar.chamadas = chamadas
    return chamar


@pytest.fixture
def servico(monkeypatch):
    """servico(sb, modelo) -> (porta, deps). Para o servidor no fim do teste."""
    monkeypatch.setenv(S.ENV_SEGREDO, SEGREDO)
    monkeypatch.setattr(S, "_dormir", lambda s: None)
    servidores = []

    def iniciar(sb=None, modelo=None):
        deps = S.Dependencias(embed=lambda p, t: [0.1] * 768, sb=sb or SbFalso(),
                              modelo=modelo or modelo_falso('{"resposta": null}'), nome_modelo="gemini-falso")
        srv = S.criar_servidor(0, lambda: deps, host="127.0.0.1")
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        servidores.append(srv)
        return srv.server_address[1], deps

    yield iniciar
    for srv in servidores:
        srv.shutdown()
        srv.server_close()


def chamar(porta, metodo="POST", rota=S.ROTA_PERGUNTAR, corpo=None, segredo=SEGREDO, bruto: bytes | None = None):
    dados = bruto if bruto is not None else (None if corpo is None else json.dumps(corpo).encode())
    req = urllib.request.Request(f"http://127.0.0.1:{porta}{rota}", data=dados, method=metodo)
    if segredo is not None:
        req.add_header(S.CABECALHO_SEGREDO, segredo)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def resp(resposta, **apoio):
    """JSON do modelo: resposta e apoio por n (chaves a1, a2... -> "1", "2"...)."""
    return json.dumps({"resposta": resposta, "apoio": {k[1:]: v for k, v in apoio.items()}}, ensure_ascii=False)


PRAZO_OK = resp("O prazo é de 30 dias [2].", a2="O prazo de entrega é de 30 dias corridos")

PERGUNTA = {"licitacao_id": 42, "pergunta": "Precisa de visita técnica?", "k": 5}


def test_saude(servico):
    porta, _ = servico()
    assert chamar(porta, "GET", S.ROTA_SAUDE, segredo=None) == (200, {"ok": True})


def test_sem_segredo_configurado_503(servico, monkeypatch):
    porta, deps = servico()
    monkeypatch.delenv(S.ENV_SEGREDO)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 503 and "error" in corpo
    assert deps.sb.chamadas == []


@pytest.mark.parametrize("segredo", [None, "", "errado", SEGREDO + "x"])
def test_segredo_errado_ou_ausente_401(servico, segredo):
    porta, deps = servico()
    status, corpo = chamar(porta, corpo=PERGUNTA, segredo=segredo)
    assert status == 401 and corpo == {"error": "não autorizado"}
    assert deps.sb.chamadas == []


@pytest.mark.parametrize("corpo", [
    [], {"pergunta": "x"}, {"licitacao_id": 0, "pergunta": "x"}, {"licitacao_id": -3, "pergunta": "x"},
    {"licitacao_id": True, "pergunta": "x"}, {"licitacao_id": "42", "pergunta": "x"},
    {"licitacao_id": 42}, {"licitacao_id": 42, "pergunta": "   "}, {"licitacao_id": 42, "pergunta": 7},
    {"licitacao_id": 42, "pergunta": "x" * 501}, {"licitacao_id": 42, "pergunta": "x", "k": 0},
    {"licitacao_id": 42, "pergunta": "x", "k": 21}, {"licitacao_id": 42, "pergunta": "x", "k": 2.5},
])
def test_corpo_invalido_400(servico, corpo):
    porta, deps = servico()
    status, resp = chamar(porta, corpo=corpo)
    assert status == 400 and resp["error"]
    assert deps.sb.chamadas == []


def test_corpo_nao_json_400(servico):
    porta, _ = servico()
    status, resp = chamar(porta, bruto=b"{nao json")
    assert status == 400 and resp == {"error": "corpo não é JSON válido"}


def test_rota_desconhecida_404(servico):
    porta, _ = servico()
    assert chamar(porta, rota="/outra", corpo=PERGUNTA)[0] == 404


def test_sem_chunks_nao_encontrado_sem_chamar_o_modelo(servico):
    modelo = modelo_falso('{"resposta": "não deveria [1]"}')
    porta, deps = servico(sb=SbFalso(linhas=[]), modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200
    assert corpo == {"resposta": None, "motivo_sem_resposta": "nao_encontrado", "citacoes": [],
                     "modelo": "gemini-falso", "versao_prompt": "0038.2",
                     "uso": {"entrada": 0, "saida": 0, "pensamento": 0}}
    assert modelo.chamadas == []
    funcao, params = deps.sb.chamadas[0]
    assert funcao == "agente_chunks_licitacao"
    assert params["p_licitacao_id"] == 42 and params["p_k"] == 5
    assert params["p_embedding"].startswith("[0.1000000,") and params["p_embedding"].count(",") == 767


def test_k_padrao_8(servico):
    porta, deps = servico(sb=SbFalso(linhas=[]))
    chamar(porta, corpo={"licitacao_id": 42, "pergunta": "x"})
    assert deps.sb.chamadas[0][1]["p_k"] == 8


def test_resposta_valida_devolve_so_os_trechos_citados(servico):
    # apoio com espaços e maiúsculas diferentes do chunk: a citação devolve o trecho original, não o do modelo
    modelo = modelo_falso(resp("A garantia é de 12 meses [3]. A visita técnica é obrigatória [1].",
                               a1="é  OBRIGATÓRIA a realização de visita técnica",
                               a3="A garantia mínima é de 12 meses"))
    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200
    assert corpo["resposta"] == "A garantia é de 12 meses [3]. A visita técnica é obrigatória [1]."
    assert corpo["motivo_sem_resposta"] is None
    assert corpo["citacoes"] == [
        {"n": 1, "chunk_id": 101, "documento_id": 7, "pagina": 3, "texto": CHUNKS[0]["texto"],
         "apoio": "É obrigatória a realização de visita técnica", "apoio_inicio": 6},
        {"n": 3, "chunk_id": 103, "documento_id": 9, "pagina": None, "texto": CHUNKS[2]["texto"],
         "apoio": "A garantia mínima é de 12 meses", "apoio_inicio": 0},
    ]
    assert corpo["modelo"] == "gemini-falso" and corpo["versao_prompt"] == "0038.2"
    assert corpo["uso"] == {"entrada": 100, "saida": 20, "pensamento": 5}
    # trechos numerados no prompt, na ordem da RPC, e a pergunta delimitada
    prompt = modelo.chamadas[0]
    assert "[1] (documento 7, página 3)" in prompt and "[3] (documento 9)\n" in prompt
    assert "<<<Precisa de visita técnica?>>>" in prompt


def test_marcador_fora_dos_trechos_vira_nao_encontrado(servico):
    porta, _ = servico(modelo=modelo_falso('{"resposta": "A visita é obrigatória [1][7]."}'))
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200
    assert corpo["resposta"] is None and corpo["motivo_sem_resposta"] == "nao_encontrado"
    assert corpo["citacoes"] == []


def test_marcador_zero_vira_nao_encontrado(servico):
    porta, _ = servico(modelo=modelo_falso('{"resposta": "A visita é obrigatória [0]."}'))
    assert chamar(porta, corpo=PERGUNTA)[1]["motivo_sem_resposta"] == "nao_encontrado"


def test_resposta_sem_marcador_vira_nao_encontrado(servico):
    porta, _ = servico(modelo=modelo_falso('{"resposta": "A visita técnica é obrigatória."}'))
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200 and corpo["resposta"] is None and corpo["motivo_sem_resposta"] == "nao_encontrado"


def test_modelo_diz_null(servico):
    modelo = modelo_falso('{"resposta": null}')
    porta, _ = servico(modelo=modelo)
    corpo = chamar(porta, corpo=PERGUNTA)[1]
    assert corpo["resposta"] is None and corpo["motivo_sem_resposta"] == "nao_encontrado"
    assert len(modelo.chamadas) == 1


def test_json_invalido_repete_uma_vez_e_aproveita_a_segunda(servico):
    modelo = modelo_falso("isto não é json", PRAZO_OK)
    porta, _ = servico(modelo=modelo)
    corpo = chamar(porta, corpo=PERGUNTA)[1]
    assert len(modelo.chamadas) == 2
    assert corpo["resposta"] == "O prazo é de 30 dias [2]." and [c["n"] for c in corpo["citacoes"]] == [2]
    assert corpo["uso"] == {"entrada": 200, "saida": 40, "pensamento": 10}


def test_json_invalido_duas_vezes_502(servico):
    modelo = modelo_falso("isto não é json", '{"outra": 1}', PRAZO_OK)
    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "resposta do modelo fora do formato"}
    assert len(modelo.chamadas) == 2


def test_apoio_em_formato_invalido_502(servico):
    modelo = modelo_falso('{"resposta": "O prazo é de 30 dias [2].", "apoio": ["frase"]}')
    porta, _ = servico(modelo=modelo)
    assert chamar(porta, corpo=PERGUNTA) == (502, {"error": "resposta do modelo fora do formato"})
    assert len(modelo.chamadas) == 2


def test_resposta_cortada_502_sem_nova_tentativa(servico):
    modelo = modelo_falso('{"resposta": "O prazo é de 30 di', cortada=True)
    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "resposta do modelo cortada no limite de tokens"}
    assert len(modelo.chamadas) == 1


@pytest.mark.parametrize("apoio", [
    "O prazo de entrega é de 45 dias corridos",   # inventado: não está no trecho
    "30 dias corridos",                            # está no trecho, mas tem 16 caracteres (< 20)
    "",
])
def test_apoio_inventado_ou_curto_vira_nao_encontrado(servico, apoio):
    porta, _ = servico(modelo=modelo_falso(resp("O prazo é de 30 dias [2].", a2=apoio)))
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200 and corpo["resposta"] is None and corpo["motivo_sem_resposta"] == "nao_encontrado"
    assert corpo["citacoes"] == []


def test_apoio_com_exatamente_20_caracteres_vale(servico):
    apoio = "é de 30 dias corrido"
    assert len(apoio) == 20
    porta, _ = servico(modelo=modelo_falso(resp("O prazo é de 30 dias [2].", a2=apoio)))
    cit = chamar(porta, corpo=PERGUNTA)[1]["citacoes"]
    assert cit[0]["apoio"] == apoio and cit[0]["apoio_inicio"] == CHUNKS[1]["texto"].index(apoio)


def test_apoio_de_outro_trecho_vira_nao_encontrado(servico):
    """A frase existe, mas no trecho 1, não no 2 citado."""
    porta, _ = servico(modelo=modelo_falso(resp("O prazo é de 30 dias [2].",
                                                a2="É obrigatória a realização de visita técnica")))
    assert chamar(porta, corpo=PERGUNTA)[1]["motivo_sem_resposta"] == "nao_encontrado"


def test_uma_citacao_sem_apoio_derruba_a_resposta(servico):
    porta, _ = servico(modelo=modelo_falso(resp("O prazo é de 30 dias [2]. A garantia é de 12 meses [3].",
                                                a2="O prazo de entrega é de 30 dias corridos")))
    corpo = chamar(porta, corpo=PERGUNTA)[1]
    assert corpo["resposta"] is None and corpo["motivo_sem_resposta"] == "nao_encontrado"


def test_localizar_apoio_recupera_o_original():
    texto = "Item 8.4.2:  É obrigatória\n a realização de VISITA técnica."
    assert S.localizar_apoio("é obrigatória a realização de visita técnica.", texto) == (
        13, "É obrigatória\n a realização de VISITA técnica.")
    assert S.localizar_apoio("é obrigatória a realização", "sem nada") is None


def test_falha_do_supabase_502_sem_vazar_detalhe(servico):
    erro = RuntimeError("Supabase rpc agente_chunks_licitacao: 500 detalhe-interno")
    porta, _ = servico(sb=SbFalso(erro=erro))
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "falha ao buscar os trechos da licitação"}


def test_falha_do_vertex_502(servico):
    def modelo(prompt, t):
        raise ValueError("400 INVALID_ARGUMENT chave=xyz")

    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "falha no modelo de geração"}


def test_falha_do_embedding_502(servico):
    porta, deps = servico()

    def embed(p, t):
        raise RuntimeError("429 RESOURCE_EXHAUSTED")

    deps.embed = embed
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "falha ao gerar o embedding da pergunta"}
    assert deps.sb.chamadas == []


def test_rpc_em_formato_inesperado_502(servico):
    porta, _ = servico(sb=SbFalso(linhas=[{"id": 1, "texto": None, "documento_id": 2}]))
    assert chamar(porta, corpo=PERGUNTA)[0] == 502


def test_log_sem_segredo_e_pergunta_truncada(servico, caplog):
    caplog.set_level("INFO", logger="coletor.perguntas_servico")
    porta, _ = servico(modelo=modelo_falso(PRAZO_OK))
    chamar(porta, corpo={"licitacao_id": 42, "pergunta": "q" * 500})
    linhas = [r.getMessage() for r in caplog.records if "chunks" in r.getMessage()]
    assert len(linhas) == 1
    assert "licitação 42" in linhas[0] and "chunks 3" in linhas[0] and "citados 1" in linhas[0]
    assert "q" * 120 in linhas[0] and "q" * 121 not in linhas[0]
    assert SEGREDO not in caplog.text


def test_marcadores_aceita_lista_com_virgula():
    assert S.marcadores("a [2, 5]. b [2][1].") == [2, 5, 1]


class ErroVertex(Exception):
    def __init__(self, code):
        super().__init__(f"erro {code}")
        self.code = code


def test_vertex_transitorio_repete_uma_vez_com_espera_curta(servico, monkeypatch):
    esperas = []
    monkeypatch.setattr(S, "_dormir", esperas.append)
    respostas = [ErroVertex(503), (PRAZO_OK, {"entrada": 1})]

    def modelo(prompt, t):
        r = respostas.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 200 and corpo["resposta"] == "O prazo é de 30 dias [2]."
    assert esperas == [S.ESPERA_TRANSITORIO_S] and S.ESPERA_TRANSITORIO_S <= 3


def test_vertex_transitorio_duas_vezes_502(servico):
    chamadas = []

    def modelo(prompt, t):
        chamadas.append(t)
        raise ErroVertex(429)

    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "falha no modelo de geração"}
    assert len(chamadas) == 2


def test_vertex_erro_permanente_nao_repete(servico):
    chamadas = []

    def modelo(prompt, t):
        chamadas.append(t)
        raise ErroVertex(400)

    porta, _ = servico(modelo=modelo)
    assert chamar(porta, corpo=PERGUNTA)[0] == 502
    assert len(chamadas) == 1


def test_timeouts_proprios_por_chamada(servico):
    vistos = {}

    def embed(p, t):
        vistos["embed"] = t
        return [0.1] * 768

    porta, deps = servico(modelo=modelo_falso('{"resposta": null}'))
    deps.embed = embed
    chamar(porta, corpo=PERGUNTA)
    assert 0 < vistos["embed"] <= S.EMBED_TIMEOUT_S
    assert 0 < deps.sb.timeout <= S.RPC_TIMEOUT_S


def test_orcamento_estourado_502_sem_nova_tentativa(servico, monkeypatch):
    """A geração consome o que sobra do orçamento e estoura o prazo (TimeoutError é transitório): 502, uma chamada."""
    monkeypatch.setattr(S, "ORCAMENTO_S", 0.6)
    monkeypatch.setattr(S, "TEMPO_MINIMO_S", 0.05)
    chamadas = []

    def modelo(prompt, t):
        chamadas.append(t)
        time.sleep(t)
        raise TimeoutError("prazo da chamada")

    porta, _ = servico(modelo=modelo)
    t0 = time.monotonic()
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "tempo limite da pergunta esgotado"}
    assert len(chamadas) == 1 and chamadas[0] <= 0.6
    assert time.monotonic() - t0 < 2


def test_sem_tempo_para_repetir_json_invalido_502(servico, monkeypatch):
    monkeypatch.setattr(S, "ORCAMENTO_S", 0.5)
    monkeypatch.setattr(S, "TEMPO_MINIMO_S", 0.2)
    chamadas = []

    def modelo(prompt, t):
        chamadas.append(t)
        time.sleep(0.35)
        return "não é json", {}

    porta, _ = servico(modelo=modelo)
    status, corpo = chamar(porta, corpo=PERGUNTA)
    assert status == 502 and corpo == {"error": "tempo limite da pergunta esgotado"}
    assert len(chamadas) == 1

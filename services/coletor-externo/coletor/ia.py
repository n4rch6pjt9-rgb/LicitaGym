"""Chamadas ao Gemini via Vertex AI (cobradas no projeto GCP -> usa os créditos)."""
from __future__ import annotations

import json
import logging
import os
import time
import random

log = logging.getLogger("ia")

# text-multilingual-embedding-002: 768d nativo, bom em português, aceita lotes e tem cota
# maior em projetos novos. gemini-embedding-001 só aceita 1 texto/chamada e bate 429 fácil.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-multilingual-embedding-002")
EMBED_LOTE = int(os.environ.get("EMBED_LOTE", "30"))            # até 250 por chamada
EMBED_MAX_CHARS = int(os.environ.get("EMBED_MAX_CHARS", "45000"))  # ~15 mil tokens (limite: 20 mil)
EMBED_INTERVALO = float(os.environ.get("EMBED_INTERVALO", "12.5"))  # 60s / 5 req = 12s
TIMEOUT_MS = int(os.environ.get("TIMEOUT_MS", "90000"))
# O 2.5-flash foi descontinuado (Marcelo, 22/10/2026). O 3.8 Flash no Vertex fica no endpoint global, e o
# embedding continua regional (GOOGLE_CLOUD_LOCATION): text-multilingual-embedding-002 não é servido no global.
GEN_MODEL = os.environ.get("GEN_MODEL", "gemini-3.8-flash")
GEN_LOCATION = os.environ.get("GEN_LOCATION", "global")
# Pensamento do modelo de geração. "off" = thinking_budget=0 (só a família 2.5-flash aceita); "low", "medium" ou
# "high" = thinking_level (Gemini 3+; o 3.8 Flash recusa "minimal" e não tem "off"); "padrao" = não envia nada.
# Vazio: deduzido do GEN_MODEL (ver pensamento_padrao).
GEN_THINKING = os.environ.get("GEN_THINKING", "").strip().lower()
# Teto de saída do OCR por página. Página A4 densa fica perto de 2 mil tokens; as páginas degeneradas de 09/10/2026
# passaram de 15 mil caracteres. O valor fino se mede nos casos da spec 0016.
OCR_MAX_TOKENS = int(os.environ.get("OCR_MAX_TOKENS", "4096"))
FICHA_MAX_TOKENS = int(os.environ.get("FICHA_MAX_TOKENS", "8192"))
FICHA_TENTATIVAS = int(os.environ.get("FICHA_TENTATIVAS", "3"))
DIM = 768  # mesma dimensão de legislacao_embeddings / licitacao_chunks

TIPOS = ["edital", "aviso", "termo_referencia", "esclarecimento", "impugnacao", "ata_sessao",
         "analise_tecnica", "diligencia", "proposta", "habilitacao", "recurso", "contrarrazoes",
         "decisao_recurso", "adjudicacao", "homologacao", "revogacao", "contrato", "outro"]

PROMPT_EXTRACAO = """Você analisa documentos de licitações públicas brasileiras ({fonte}).
Documento: "{nome}" | seção do portal: {secao} | processo {processo}
Responda SOMENTE um JSON com:
{{
 "tipo_documento": um de {tipos},
 "resumo": "até 600 caracteres, factual",
 "fornecedores": [{{"nome": "...", "cnpj": "só dígitos ou null", "papel": "recorrente|recorrido|vencedor|desclassificado|inabilitado|participante"}}],
 "lotes_itens": ["..."],
 "decisao": "deferido|indeferido|parcialmente_deferido|nao_se_aplica",
 "motivos": ["motivos de desclassificação, inabilitação, deferimento ou indeferimento"],
 "fundamentos_legais": ["artigos, regulamentos, acórdãos citados"],
 "valores": [{{"descricao": "...", "valor": numero}}],
 "pontos_chave": ["até 5 fatos úteis para quem vai disputar licitações parecidas"]
}}
Não invente: use null ou [] quando não houver a informação.

TEXTO:
{texto}"""


def gemini_3_ou_mais(modelo: str) -> bool:
    """Gemini 3+ trocou thinking_budget por thinking_level e descontinuou temperature (guia de migração do 3.8)."""
    try:
        return modelo.startswith("gemini-") and int(modelo.split("-")[1].split(".")[0]) >= 3
    except (IndexError, ValueError):
        return False


def pensamento_padrao(modelo: str) -> str:
    if gemini_3_ou_mais(modelo):
        return "low"       # o menor nível aceito pelo 3.8 Flash; OCR e ficha não precisam de raciocínio
    if "flash" in modelo:
        return "off"       # 2.5-flash: pensamento conta no max_output_tokens e estourava o prazo na ficha
    return "padrao"        # 2.5-pro recusa thinking_budget=0


NIVEIS_PENSAMENTO = ("off", "low", "medium", "high", "padrao")


def nivel_pensamento() -> str:
    """GEN_THINKING validado (ou o padrão do modelo). Valor inválido é erro de configuração do deploy: falha ao criar
    o cliente, antes de tocar documento, para a etapa cair à vista em vez de marcar cada documento como erro."""
    nivel = GEN_THINKING or pensamento_padrao(GEN_MODEL)
    if nivel not in NIVEIS_PENSAMENTO:
        raise ValueError(f"GEN_THINKING inválido: {nivel!r} (use {', '.join(NIVEIS_PENSAMENTO)})")
    return nivel


class FichaIndisponivel(Exception):
    """Falha definitiva da ficha do documento: o indexador segue só com os trechos. `categoria` é o que fica gravado
    em extracao.ficha_erro (sem a mensagem do SDK, que pode trazer texto do modelo)."""

    def __init__(self, categoria: str):
        super().__init__(categoria)
        self.categoria = categoria


def prazo_estourado(e: BaseException) -> bool:
    """504/DEADLINE_EXCEEDED do Vertex ou timeout do cliente HTTP. Classifica pelo tipo e pelo código do erro,
    nunca pelo texto da mensagem."""
    if getattr(e, "code", None) == 504 or getattr(e, "status", None) == "DEADLINE_EXCEEDED":
        return True
    try:
        import httpx
        if isinstance(e, httpx.TimeoutException):
            return True
    except ImportError:  # pragma: no cover
        pass
    return isinstance(e, TimeoutError)


def transitorio(e: BaseException) -> bool:
    """Vale tentar de novo: cota (429), 5xx ou prazo. Erro do SDK é classificado pelo código HTTP, porque a mensagem
    pode trazer texto do modelo (um "429" no meio dela não é cota). Sem código, só o nome do tipo e o texto do erro
    de rede."""
    codigo = getattr(e, "code", None)
    if isinstance(codigo, int):
        return codigo == 429 or 500 <= codigo <= 599
    if prazo_estourado(e):
        return True
    msg = f"{type(e).__name__} {e}"
    return any(c in msg for c in ("RESOURCE_EXHAUSTED", "UNAVAILABLE", "imed out", "Timeout", "DEADLINE"))


def tipo_falha(e: BaseException) -> str:
    """Nome curto da falha transitória para o log e para o resumo: cota, erro do servidor ou prazo. Pelo código, nunca
    pelo texto da mensagem (exceto o erro de rede sem código)."""
    if prazo_estourado(e):
        return "prazo do Vertex estourado (504/timeout)"
    codigo = getattr(e, "code", None)
    if codigo == 429:
        return "cota do Vertex atingida (429)"
    if isinstance(codigo, int) and 500 <= codigo <= 599:
        return f"erro {codigo} do Vertex"
    return f"falha de rede ({type(e).__name__})"


def erro_de_configuracao(e: BaseException) -> bool:
    """401/403/404 do Vertex: modelo não habilitado, endpoint errado ou sem permissão. Vale para todos os documentos,
    então quem chama falha a etapa inteira em vez de marcar cada documento como erro."""
    return getattr(e, "code", None) in (401, 403, 404) and type(e).__name__ == "ClientError"


def motivo_fim(resposta) -> str | None:
    """finish_reason do primeiro candidato como texto ("STOP", "MAX_TOKENS"...), ou None."""
    try:
        fr = resposta.candidates[0].finish_reason
    except (AttributeError, IndexError, TypeError):
        return None
    if fr is None:
        return None
    return getattr(fr, "name", None) or str(fr)


class Gemini:
    def __init__(self, project: str | None = None, location: str | None = None, gen_location: str | None = None,
                 timeout_ms: int | None = None):
        from google import genai
        from google.genai import types
        nivel_pensamento()   # GEN_THINKING inválido falha aqui, fora do laço dos documentos
        self.types = types
        projeto = project or os.environ.get("GOOGLE_CLOUD_PROJECT")
        local_embed = location or os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        local_gen = gen_location or GEN_LOCATION   # `location` é só do embedding: o global não serve o text-*-embedding
        opcoes = types.HttpOptions(timeout=timeout_ms or TIMEOUT_MS)
        # Dois clientes: geração (self.client, GEN_LOCATION) e embedding (self.client_embed, regional).
        self.client_embed = genai.Client(vertexai=True, project=projeto, location=local_embed, http_options=opcoes)
        self.client = (self.client_embed if local_gen == local_embed
                       else genai.Client(vertexai=True, project=projeto, location=local_gen, http_options=opcoes))

    def _retry(self, fn, tentativas: int = 8, esperas: tuple[float, ...] | None = None):
        """Nova tentativa em falha transitória. `esperas` (segundos por tentativa; a última se repete) troca o backoff
        padrão de 5s dobrando até 90s."""
        for i in range(tentativas):
            try:
                return fn()
            except Exception as e:
                if i == tentativas - 1 or not transitorio(e):
                    raise
<<<<<<< HEAD
 chore/higiene-contexto-e-pipeline
                base_espera = min(90, 5 * 2 ** i)
=======
                base_base_base_espera = min(90, 5 * 2 ** i)
                espera = base_espera + random.uniform(0.5, min(5.0, base_espera * 0.2))
                espera = base_espera + random.uniform(0.5, min(5.0, base_espera * 0.2))
>>>>>>> 245663e (fix: corrige indentação em ia.py e isola escopo de negação em detectarExigencias com teste de regressão)
                espera = base_espera + random.uniform(0.5, min(5.0, base_espera * 0.2))
                log.info("    cota do Vertex atingida; aguardando %ss (tentativa %s/%s)", espera, i + 1, tentativas)

                espera = esperas[min(i, len(esperas) - 1)] if esperas else min(90, 5 * 2 ** i)
                log.info("    %s; aguardando %ss (tentativa %s/%s)", tipo_falha(e), espera, i + 1, tentativas)
 main
                time.sleep(espera)

    def _config(self, temperatura: float | None = None, pensamento_minimo: bool = True, **kw):
        """GenerateContentConfig com o pensamento de GEN_THINKING (OCR e ficha) ou o padrão do modelo (resposta do RAG),
        e sem temperature no Gemini 3+ (descontinuada no 3.8: o guia de migração manda remover temperature, top_p e
        top_k)."""
        nivel = nivel_pensamento() if pensamento_minimo else "padrao"
        if nivel == "off":
            pensamento = self.types.ThinkingConfig(thinking_budget=0)
        elif nivel == "padrao":
            pensamento = None
        else:
            pensamento = self.types.ThinkingConfig(thinking_level=nivel.upper())
        if temperatura is not None and not gemini_3_ou_mais(GEN_MODEL):
            kw["temperature"] = temperatura
        return self.types.GenerateContentConfig(thinking_config=pensamento, **kw)

    _proxima_chamada = 0.0

    def embed(self, textos: list[str], tarefa: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
        """Lotes grandes + intervalo fixo entre chamadas, para caber na cota do projeto
        (projetos novos: 5 requisições/min por região para os modelos text-*-embedding)."""
        cfg = self.types.EmbedContentConfig(task_type=tarefa, output_dimensionality=DIM)
        um_por_vez = EMBED_MODEL.startswith("gemini-embedding")
        lotes, atual, chars = [], [], 0
        for t in textos:
            t = t[:6000]
            if atual and (um_por_vez or len(atual) >= EMBED_LOTE or chars + len(t) > EMBED_MAX_CHARS):
                lotes.append(atual)
                atual, chars = [], 0
            atual.append(t)
            chars += len(t)
        if atual:
            lotes.append(atual)

        vetores: list[list[float]] = []
        for n, parte in enumerate(lotes, 1):
            espera = Gemini._proxima_chamada - time.time()
            if espera > 0:
                time.sleep(espera)
            t0 = time.time()
            r = self._retry(lambda: self.client_embed.models.embed_content(
                model=EMBED_MODEL, contents=parte[0] if um_por_vez else parte, config=cfg))
            Gemini._proxima_chamada = time.time() + EMBED_INTERVALO
            vetores += [list(e.values) for e in r.embeddings]
            if len(lotes) > 1:
                log.info("      lote %s/%s (%s trechos) em %.1fs", n, len(lotes), len(parte), time.time() - t0)
        return vetores

    def extrair_campos(self, texto: str, nome: str, secao: str, processo: str, fonte: str = "licitação") -> dict:
        """Ficha do documento (tipo, resumo, campos), com o pensamento no mínimo, como no OCR: em tabela longa de
        preços (licitação 3558) o pensamento estourava o prazo de 90 s em todas as tentativas. Menos tentativas que o
        padrão. Prazo estourado e JSON inválido viram FichaIndisponivel (quem chama segue só com os trechos); cota,
        5xx e erro de configuração (4xx) sobem como estão."""
        prompt = PROMPT_EXTRACAO.format(fonte=fonte, nome=nome, secao=secao, processo=processo,
                                        tipos=TIPOS, texto=texto[:120_000])
        cfg = self._config(temperatura=0, response_mime_type="application/json", max_output_tokens=FICHA_MAX_TOKENS)
        try:
            r = self._retry(lambda: self.client.models.generate_content(model=GEN_MODEL, contents=prompt, config=cfg),
                            tentativas=FICHA_TENTATIVAS)
        except Exception as e:
            if prazo_estourado(e):
                raise FichaIndisponivel("prazo_estourado") from e
            raise
        try:
            return json.loads(r.text)
        except (json.JSONDecodeError, TypeError) as e:
            raise FichaIndisponivel("json_invalido") from e

    def ocr_pagina(self, pdf: bytes) -> tuple[str, str | None]:
        """Transcreve UMA página de PDF escaneado (o indexador separa as páginas). Devolve (texto, finish_reason).
        PDF inteiro numa chamada perdeu o vínculo com a página e degenerou (medição de 09/10/2026, spec 0016);
        `max_output_tokens` corta a degeneração antes de consumir tempo e custo. O pensamento conta nesse limite, por
        isso fica no mínimo (GEN_THINKING)."""
        parte = self.types.Part.from_bytes(data=pdf, mime_type="application/pdf")
        r = self._retry(lambda: self.client.models.generate_content(
            model=GEN_MODEL,
            contents=[parte, "Transcreva integralmente o texto desta página, em português, mantendo a ordem. "
                             "Não resuma e não comente."],
            config=self._config(temperatura=0, max_output_tokens=OCR_MAX_TOKENS)))
        return r.text or "", motivo_fim(r)

    def responder(self, pergunta: str, trechos: list[dict]) -> str:
        # Envelope por nível de confiança (documento_publico × alegacao_de_parte) e regras de dados,
        # ver coletor/rag_contexto.py. Suspeito/bloqueado são descartados de novo aqui.
        from .rag_contexto import montar_prompt
        prompt = montar_prompt(pergunta, trechos)
        r = self._retry(lambda: self.client.models.generate_content(
            model=GEN_MODEL, contents=prompt, config=self._config(temperatura=0.2, pensamento_minimo=False)))
        return r.text or ""

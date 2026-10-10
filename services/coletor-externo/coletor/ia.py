"""Chamadas ao Gemini via Vertex AI (cobradas no projeto GCP -> usa os créditos)."""
from __future__ import annotations

import json
import logging
import os
import time

log = logging.getLogger("ia")

# text-multilingual-embedding-002: 768d nativo, bom em português, aceita lotes e tem cota
# maior em projetos novos. gemini-embedding-001 só aceita 1 texto/chamada e bate 429 fácil.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "text-multilingual-embedding-002")
EMBED_LOTE = int(os.environ.get("EMBED_LOTE", "30"))            # até 250 por chamada
EMBED_MAX_CHARS = int(os.environ.get("EMBED_MAX_CHARS", "45000"))  # ~15 mil tokens (limite: 20 mil)
EMBED_INTERVALO = float(os.environ.get("EMBED_INTERVALO", "12.5"))  # 60s / 5 req = 12s
TIMEOUT_MS = int(os.environ.get("TIMEOUT_MS", "90000"))
GEN_MODEL = os.environ.get("GEN_MODEL", "gemini-2.5-flash")
# Teto de saída do OCR por página. Página A4 densa fica perto de 2 mil tokens; as páginas degeneradas de 09/10/2026
# passaram de 15 mil caracteres. O valor fino se mede nos casos da spec 0016.
OCR_MAX_TOKENS = int(os.environ.get("OCR_MAX_TOKENS", "4096"))
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
    def __init__(self, project: str | None = None, location: str | None = None):
        from google import genai
        from google.genai import types
        self.types = types
        self.client = genai.Client(
            vertexai=True,
            project=project or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            location=location or os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
            http_options=types.HttpOptions(timeout=TIMEOUT_MS),
        )

    def _retry(self, fn, tentativas: int = 8):
        for i in range(tentativas):
            try:
                return fn()
            except Exception as e:
                msg = f"{type(e).__name__} {e}"
                if i == tentativas - 1 or not any(c in msg for c in ("429", "503", "500", "504", "RESOURCE_EXHAUSTED", "UNAVAILABLE", "imed out", "Timeout", "DEADLINE")):
                    raise
                espera = min(90, 5 * 2 ** i)
                log.info("    cota do Vertex atingida; aguardando %ss (tentativa %s/%s)", espera, i + 1, tentativas)
                time.sleep(espera)

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
            r = self._retry(lambda: self.client.models.embed_content(
                model=EMBED_MODEL, contents=parte[0] if um_por_vez else parte, config=cfg))
            Gemini._proxima_chamada = time.time() + EMBED_INTERVALO
            vetores += [list(e.values) for e in r.embeddings]
            if len(lotes) > 1:
                log.info("      lote %s/%s (%s trechos) em %.1fs", n, len(lotes), len(parte), time.time() - t0)
        return vetores

    def extrair_campos(self, texto: str, nome: str, secao: str, processo: str, fonte: str = "licitação") -> dict:
        prompt = PROMPT_EXTRACAO.format(fonte=fonte, nome=nome, secao=secao, processo=processo,
                                        tipos=TIPOS, texto=texto[:120_000])
        r = self._retry(lambda: self.client.models.generate_content(
            model=GEN_MODEL, contents=prompt,
            config=self.types.GenerateContentConfig(response_mime_type="application/json", temperature=0)))
        try:
            return json.loads(r.text)
        except (json.JSONDecodeError, TypeError) as e:
            raise RuntimeError(f"Gemini retornou JSON inválido na extração: {(r.text or '')[:500]}") from e

    def ocr_pagina(self, pdf: bytes) -> tuple[str, str | None]:
        """Transcreve UMA página de PDF escaneado (o indexador separa as páginas). Devolve (texto, finish_reason).
        PDF inteiro numa chamada perdeu o vínculo com a página e degenerou (medição de 09/10/2026, spec 0016);
        `max_output_tokens` corta a degeneração antes de consumir tempo e custo. O pensamento do 2.5-flash conta
        nesse limite, por isso fica desligado no OCR (só no flash: o 2.5-pro recusa thinking_budget=0)."""
        parte = self.types.Part.from_bytes(data=pdf, mime_type="application/pdf")
        pensamento = self.types.ThinkingConfig(thinking_budget=0) if "flash" in GEN_MODEL else None
        r = self._retry(lambda: self.client.models.generate_content(
            model=GEN_MODEL,
            contents=[parte, "Transcreva integralmente o texto desta página, em português, mantendo a ordem. "
                             "Não resuma e não comente."],
            config=self.types.GenerateContentConfig(
                temperature=0, max_output_tokens=OCR_MAX_TOKENS, thinking_config=pensamento)))
        return r.text or "", motivo_fim(r)

    def responder(self, pergunta: str, trechos: list[dict]) -> str:
        # Envelope por nível de confiança (documento_publico × alegacao_de_parte) e regras de dados,
        # ver coletor/rag_contexto.py. Suspeito/bloqueado são descartados de novo aqui.
        from .rag_contexto import montar_prompt
        prompt = montar_prompt(pergunta, trechos)
        r = self._retry(lambda: self.client.models.generate_content(
            model=GEN_MODEL, contents=prompt, config=self.types.GenerateContentConfig(temperature=0.2)))
        return r.text or ""

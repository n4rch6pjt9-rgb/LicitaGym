"""Estado de cada página de OCR e detector de degeneração (função pura, sem rede).

Medição de 09/10/2026 (spec 0016, seção 5): o Gemini com temperature 0, recebendo o PDF escaneado inteiro, perdeu o
vínculo com a página e degenerou em repetição de pontos; página a página, as págs. 2-4 do arquivo 3 do PE 016/2026 de
Baraúna degeneraram depois do conteúdo útil. Texto degenerado não pode virar `extraido` nem chunk do RAG.

Estados da página (mesmos nomes da spec 0016):
- `extraido`: texto aceito, vira chunk;
- `OCR_DEGENERADO`: o texto termina em repetição (ou bateu no limite de saída). O trecho anterior fica em
  `PaginaOcr.texto_parcial`, marcado como parcial, e NÃO vira chunk (só serve para conferir trecho literal). Ainda
  não é gravado: no banco vai só `chars_parcial` (onde guardar o parcial é decisão da issue #299);
- `OCR_REQUIRED`: o OCR não devolveu texto aproveitável; a página continua precisando de OCR.

`licitacao_documentos.status_processamento` ainda não tem esses estados (check da migration 20260923100000); por isso
o estado por página vai em `extracao.ocr_paginas`. O estado no documento é migration própria (issue #299).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

EXTRAIDO = "extraido"
OCR_DEGENERADO = "OCR_DEGENERADO"
OCR_REQUIRED = "OCR_REQUIRED"


@dataclass(frozen=True)
class Limiar:
    """Repetição só conta como degeneração se tiver ao menos `min_rep` repetições seguidas da mesma unidade
    E cobrir ao menos `min_chars` caracteres. Em produção (09/10/2026) nenhum chunk tinha corrida de mesmo
    caractere com 200+ caracteres; linha pontilhada de sumário fica bem abaixo de 300.

    A degeneração do modelo vai até o fim da saída (medido em Baraúna). Por isso, repetição no meio da página, com
    texto depois (formulário ou tabela em branco), só conta se cobrir `min_chars_meio` caracteres; senão ela precisa
    terminar a página, com no máximo `max_cauda` caracteres não-brancos depois."""
    min_chars: int = 300
    min_rep: int = 20
    min_chars_meio: int = 3000
    max_cauda: int = 80
    max_unidade: int = 80      # tamanho máximo da unidade repetida na busca por padrão curto
    min_texto: int = 20        # abaixo disso (sem espaços) a página não tem texto aproveitável

    @classmethod
    def do_ambiente(cls) -> "Limiar":
        def num(nome: str, padrao: int) -> int:
            return int(os.environ.get(nome, padrao))
        return cls(min_chars=num("OCR_DEGENERADO_MIN_CHARS", cls.min_chars),
                   min_rep=num("OCR_DEGENERADO_MIN_REP", cls.min_rep),
                   min_chars_meio=num("OCR_DEGENERADO_MIN_CHARS_MEIO", cls.min_chars_meio),
                   max_cauda=num("OCR_DEGENERADO_MAX_CAUDA", cls.max_cauda))


@dataclass(frozen=True)
class Degeneracao:
    inicio: int        # posição no texto onde a repetição começa
    tamanho: int       # caracteres cobertos pela repetição
    repeticoes: int
    unidade_tam: int   # tamanho da unidade repetida
    unidade_tipo: str  # "pontuacao" (sem letra nem dígito) ou "texto"; o conteúdo do documento não sai daqui

    def descricao(self) -> str:
        return (f"repeticao de unidade {self.unidade_tipo} de {self.unidade_tam} caractere(s) x{self.repeticoes} "
                f"({self.tamanho} caracteres) a partir de {self.inicio}")


def _tipo(unidade: str) -> str:
    return "texto" if any(c.isalnum() for c in unidade) else "pontuacao"


def detectar_degeneracao(texto: str, limiar: Limiar | None = None) -> Degeneracao | None:
    """Primeira repetição longa no texto: mesmo caractere ('.....'), padrão curto ('. . . ', '0,00 ') ou linha
    inteira repetida em sequência, que termina a página ou é longa demais (ver Limiar). Devolve None se não houver."""
    lim = limiar or Limiar()

    def conta(inicio: int, fim: int, rep: int, unidade: str) -> Degeneracao | None:
        tamanho = fim - inicio
        if rep < lim.min_rep or tamanho < lim.min_chars:
            return None
        cauda = len("".join(texto[fim:].split()))
        if cauda > lim.max_cauda and tamanho < lim.min_chars_meio:
            return None
        return Degeneracao(inicio, tamanho, rep, len(unidade), _tipo(unidade))

    achados: list[Degeneracao] = []
    # Unidade de 1 a max_unidade caracteres, começando por não-espaço, repetida min_rep+ vezes seguidas.
    padrao = re.compile(r"(\S.{0,%d}?)\1{%d,}" % (lim.max_unidade - 1, lim.min_rep - 1), re.DOTALL)
    for m in padrao.finditer(texto):
        d = conta(m.start(), m.end(), len(m.group(0)) // len(m.group(1)), m.group(1))
        if d:
            achados.append(d)
            break

    # Linha inteira (de qualquer tamanho) repetida em sequência.
    pos, anterior, ini, fim, rep = 0, None, 0, 0, 0
    for linha in [*texto.splitlines(keepends=True), None]:      # None fecha a última sequência
        chave = linha.strip() if linha is not None else None
        if chave and chave == anterior:
            rep += 1
        else:
            d = conta(ini, fim, rep, anterior) if anterior else None
            if d:
                achados.append(d)
                break
            anterior, ini, rep = (chave or None), pos, 1
        if linha is not None:
            pos += len(linha)
            fim = pos

    return min(achados, key=lambda d: d.inicio) if achados else None


@dataclass(frozen=True)
class PaginaOcr:
    estado: str
    texto: str                 # texto aceito (só quando estado == extraido)
    texto_parcial: str         # conteúdo útil antes da degeneração (parcial, não indexado)
    chars_ocr: int             # tamanho do texto devolvido pelo OCR
    motivo: str | None

    def resumo(self) -> dict:
        """O que vai para `extracao.ocr_paginas` (sem o texto)."""
        return {"estado": self.estado, "chars_ocr": self.chars_ocr,
                "chars_parcial": len(self.texto_parcial), "motivo": self.motivo}


def avaliar_pagina(texto: str | None, truncado: bool = False, limiar: Limiar | None = None) -> PaginaOcr:
    """Decide o estado da página a partir do texto do OCR. `truncado` = o OCR parou no limite de tokens de saída
    (finish_reason MAX_TOKENS): sem repetição detectada, ainda assim a página não é aceita como completa."""
    lim = limiar or Limiar()
    texto = texto or ""
    deg = detectar_degeneracao(texto, lim)
    if deg is not None:
        return PaginaOcr(OCR_DEGENERADO, "", texto[:deg.inicio].rstrip(), len(texto), deg.descricao())
    if truncado:
        return PaginaOcr(OCR_DEGENERADO, "", texto.rstrip(), len(texto), "limite de tokens de saida")
    if len("".join(texto.split())) < lim.min_texto:
        return PaginaOcr(OCR_REQUIRED, "", "", len(texto), "OCR sem texto aproveitavel")
    return PaginaOcr(EXTRAIDO, texto, "", len(texto), None)

"""Regras comuns da API de Dados Abertos do Compras.gov.br usadas pelos coletores de BI (ARP e Pesquisa de Preço).

Comportamento conferido ao vivo em 02/10/2026 (dadosabertos.compras.gov.br):
- Parâmetro obrigatório ausente => HTTP 404 com corpo genérico {"statusCode": 404, "message": "Resource not found"}.
  O corpo não diz qual parâmetro falta, e nunca é "sem resultado".
- Consulta válida sem resultado => HTTP 200 {"resultado": [], "totalRegistros": 0, ...}. Página além da última
  também volta 200 com lista vazia.

Erro ≠ vazio: os parâmetros obrigatórios são validados antes da chamada (ParametroInvalido) e qualquer 404 vira
ErroApiCompras. Lista vazia só sai de um 200 cujo corpo traz "resultado" como lista.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Any

# Limite do upstream para intervalos de datas (dias entre início e fim, inclusive 365).
MAX_DIAS_INTERVALO = 365


class ParametroInvalido(ValueError):
    """Parâmetro obrigatório ausente ou inválido, detectado antes de chamar a API."""


class ErroApiCompras(RuntimeError):
    """Resposta da API que não é resultado válido (HTTP de erro, corpo inválido). Nunca significa 'sem resultado'."""

    def __init__(self, mensagem: str, status: int | None = None, corpo: str | None = None):
        super().__init__(mensagem)
        self.status = status
        self.corpo = corpo


def validar_data(nome: str, valor: Any) -> date:
    if valor in (None, ""):
        raise ParametroInvalido(f"'{nome}' é obrigatório (AAAA-MM-DD)")
    s = str(valor).strip()
    try:
        if len(s) != 10:
            raise ValueError
        return date.fromisoformat(s)
    except ValueError:
        raise ParametroInvalido(f"'{nome}' deve ser uma data AAAA-MM-DD válida (recebido {valor!r})") from None


def validar_intervalo(nome_ini: str, ini: Any, nome_fim: str, fim: Any, max_dias: int = MAX_DIAS_INTERVALO) -> None:
    """A API devolve 0 registros, sem erro, para intervalo invertido e 400 acima de 365 dias: valida antes."""
    d_ini = validar_data(nome_ini, ini)
    d_fim = validar_data(nome_fim, fim)
    if d_fim < d_ini:
        raise ParametroInvalido(f"'{nome_fim}' ({d_fim}) é anterior a '{nome_ini}' ({d_ini}): a API devolveria 0 registros sem erro")
    if (d_fim - d_ini).days > max_dias:
        raise ParametroInvalido(f"intervalo {d_ini}..{d_fim} passa de {max_dias} dias (limite da API)")


def validar_codigo(nome: str, valor: Any) -> int:
    if valor in (None, "") or isinstance(valor, bool):
        raise ParametroInvalido(f"'{nome}' é obrigatório")
    try:
        n = int(valor)
    except (TypeError, ValueError):
        raise ParametroInvalido(f"'{nome}' deve ser inteiro positivo (recebido {valor!r})") from None
    if n <= 0:
        raise ParametroInvalido(f"'{nome}' deve ser inteiro positivo (recebido {valor!r})")
    return n


def corpo_resumido(r: Any, limite: int = 300) -> str:
    try:
        texto = r.text
    except Exception:  # noqa: BLE001 - só para mensagem de erro
        texto = None
    if not isinstance(texto, str):
        try:
            texto = json.dumps(r.json(), ensure_ascii=False)
        except Exception:  # noqa: BLE001
            texto = ""
    return texto[:limite]


def erro_http(r: Any, contexto: str) -> ErroApiCompras:
    """Erro para status que não é sucesso nem retry. 404 ganha explicação própria (é parâmetro faltando, não vazio)."""
    corpo = corpo_resumido(r)
    if r.status_code == 404:
        msg = (f"HTTP 404 em {contexto}: a API do Compras.gov responde 404 quando falta parâmetro obrigatório "
               f"(corpo: {corpo!r}). Não é 'sem resultado': consulta válida vazia volta 200 com resultado=[].")
    else:
        msg = f"HTTP {r.status_code} em {contexto} (corpo: {corpo!r})"
    return ErroApiCompras(msg, status=r.status_code, corpo=corpo)


def corpo_json(r: Any, contexto: str) -> dict[str, Any]:
    """Corpo de um 200: precisa ser objeto JSON com 'resultado' em lista. Qualquer outra coisa é erro, não vazio."""
    try:
        dados = r.json()
    except ValueError as e:  # inclui requests.JSONDecodeError
        raise ErroApiCompras(f"HTTP 200 em {contexto} com corpo que não é JSON: {e}", status=r.status_code,
                             corpo=corpo_resumido(r)) from None
    if not isinstance(dados, dict) or not isinstance(dados.get("resultado"), list):
        raise ErroApiCompras(f"HTTP 200 em {contexto} sem lista 'resultado' no corpo", status=r.status_code,
                             corpo=corpo_resumido(r))
    return dados

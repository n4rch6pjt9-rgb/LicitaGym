"""Cliente do portal de compras SEST SENAT (plataforma Paradigma).

O portal expõe um webservice JSON interno (ASMX) que a própria página usa:
  POST /portal/WebService/Servicos.asmx/<Metodo>   (Content-Type: application/json)
e os arquivos são servidos por
  GET  /portal/Download.aspx<sDsParametroCriptografado>

Mapeado em 23/09/2026 a partir do mural público. Se o portal mudar, ajuste aqui.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

import requests

BASE = "https://compras.sestsenat.org.br/portal"
WS = f"{BASE}/WebService/Servicos.asmx"

# secao -> (sTipoPesquisa, sNmLocalAnexo) para PesquisarAnexosProcessoContratacao
SECOES_CONTRATACAO: dict[str, tuple[str, str]] = {
    "proposta": ("Proposta", "Licitacao/AnexoPropostaComercial/"),
    "lance": ("Lance", "Licitacao/AnexoPropostaComercial/"),
    "negociacao": ("Negociação", "Licitacao/AnexoPropostaComercial/"),
    "habilitacao": ("Habilitação", "Licitacao/AnexoHabilitacao/"),
    "recurso": ("Recurso", "Licitacao/AnexoRecurso/"),
    "contrarrazoes": ("ContraRazoes", "Licitacao/AnexoRecursoContrarrazao/"),
    "parecer": ("Parecer", "Licitacao/AnexoRecursoParecer/"),
}

SITUACOES_ENCERRADAS = {
    "homologado", "revogado", "anulado", "fracassado", "deserto",
    "encerrado", "cancelado", "finalizado", "adjudicado",
}

_DATE_RE = re.compile(r"/Date\((-?\d+)\)/")
_NULO = "\u0013\u0012\u0012\u0013"  # marcador de "vazio" usado pelo Paradigma
_INT_NULO = -2147483648


def parse_data(v: Any) -> str | None:
    """Converte '/Date(1786622400000)/' em ISO-8601. Datas 'zeradas' (negativas) -> None."""
    if not isinstance(v, str):
        return None
    m = _DATE_RE.search(v)
    if not m:
        return None
    ms = int(m.group(1))
    if ms <= 0:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def limpar(v: Any) -> Any:
    """Remove os marcadores de nulo do Paradigma."""
    if v == _NULO or v == _INT_NULO:
        return None
    if isinstance(v, dict):
        return {k: limpar(x) for k, x in v.items()}
    if isinstance(v, list):
        return [limpar(x) for x in v]
    return v


def cnpj_ou_none(v: Any) -> str | None:
    """Só guarda CNPJ (14 dígitos). CPF de pessoa física não é armazenado (LGPD)."""
    if not isinstance(v, str):
        return None
    d = re.sub(r"\D", "", v)
    return d if len(d) == 14 else None


@dataclass
class Arquivo:
    secao: str
    nome_original: str
    arquivo_origem: str
    parametro_download: str | None
    data_documento: str | None
    fornecedor_nome: str | None
    fornecedor_cnpj: str | None
    itens_lote: list[str]
    raw: dict


class RespostaInvalida(RuntimeError):
    """HTTP 200 cujo JSON não corresponde ao envelope esperado do portal."""


class PortalSestSenat:
    def __init__(self, delay: float = 1.0, user_agent: str | None = None, timeout: int = 60):
        self.delay = delay
        self.timeout = timeout
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": user_agent or "LicitaGym-Coletor/1.0 (pesquisa de licitações públicas)",
            "Accept": "application/json, text/plain, */*",
        })
        # Abre o mural uma vez para obter os cookies de sessão do ASP.NET
        self.s.get(f"{BASE}/Mural.aspx", timeout=timeout)

    # ---------------- chamadas base ----------------
    def _ws(self, metodo: str, body: dict | str) -> Any:
        payload = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        for tentativa in range(4):
            try:
                r = self.s.post(
                    f"{WS}/{metodo}",
                    data=payload.encode("utf-8"),
                    headers={"Content-Type": "application/json; charset=utf-8"},
                    timeout=self.timeout,
                )
                time.sleep(self.delay)
            except (requests.ConnectionError, requests.Timeout):
                if tentativa == 3:
                    raise
                time.sleep(2 ** tentativa * 2)
                continue
            if r.status_code == 200:
                try:
                    corpo = r.json()
                except ValueError as e:
                    raise RespostaInvalida(f"{metodo}: JSON inválido") from e
                if not isinstance(corpo, dict) or "d" not in corpo:
                    raise RespostaInvalida(f"{metodo}: envelope ASMX inválido")
                return limpar(corpo["d"])
            if r.status_code in (429, 500, 502, 503, 504) and tentativa < 3:
                time.sleep(2 ** tentativa * 2)
                continue
            r.raise_for_status()
        raise RuntimeError(f"{metodo}: sem resposta válida do portal")

    # ---------------- processo ----------------
    def detalhes(self, id_processo: int, modulo: int = 59) -> dict | None:
        r = self._ws("PesquisarProcessoDetalhes", {"dtoProcesso": {
            "nCdProcesso": id_processo, "nCdModulo": modulo,
            "tmpTipoMuralProcesso": 0, "dtoIdioma": {"nCdIdioma": 1}}})
        if r is not None and not isinstance(r, dict):
            raise RespostaInvalida("PesquisarProcessoDetalhes: payload não é objeto")
        return r

    def esclarecimentos(self, id_processo: int, modulo: int = 59) -> list[dict]:
        r = self._ws("PesquisarProcessoDetalheForum", {"dtoForum": {
            "dtoProcesso": {"nCdProcesso": id_processo, "nCdModulo": modulo},
            "dtoIdioma": {"nCdIdioma": 1}}})
        if not isinstance(r, list):
            raise RespostaInvalida("PesquisarProcessoDetalheForum: payload não é lista")
        return [_msg_forum(m) for m in r]

    def notas(self, id_processo: int, id_edital: int | None, modulo: int = 59) -> list[dict]:
        r = self._ws("PesquisarNota", {"dtoProcesso": {
            "bFlMuralEdital": False, "nCdProcesso": id_processo, "nCdEdital": id_edital or 0,
            "nCdModulo": modulo, "dtoIdioma": {"nCdIdioma": 1}}})
        if not isinstance(r, list):
            raise RespostaInvalida("PesquisarNota: payload não é lista")
        return [{
            "titulo": n.get("sDsTitulo"), "descricao": n.get("sDsDescricao"),
            "situacao": n.get("sDsSituacao"), "data": parse_data(n.get("tDtNota")),
        } for n in r]

    # ---------------- anexos ----------------
    def anexos_processo(self, anexo_raiz: int) -> list[Arquivo]:
        r = self._ws("PesquisarAnexos", {"dtoAnexo": {"nCdAnexo": anexo_raiz}})
        if not isinstance(r, list):
            raise RespostaInvalida("PesquisarAnexos: payload não é lista")
        return _deduplicar("processo", r)

    def anexos_secao(self, secao: str, anexo_raiz: int, id_processo: int, modulo: int = 59) -> list[Arquivo]:
        tipo, local = SECOES_CONTRATACAO[secao]
        r = self._ws("PesquisarAnexosProcessoContratacao", {
            "dtoAnexo": {"nCdAnexo": anexo_raiz, "sNmLocalAnexo": local,
                         "nCdModulo": modulo, "nCdOrigem": id_processo},
            "sTipoPesquisa": tipo, "sParam": ""})
        if not isinstance(r, list):
            raise RespostaInvalida("PesquisarAnexosProcessoContratacao: payload não é lista")
        return _deduplicar(secao, r)

    def baixar(self, parametro: str, max_bytes: int | None = None) -> tuple[bytes, str | None]:
        """Baixa um arquivo em streaming. Retorna (conteúdo, content-type).
        Levanta ArquivoGrande se passar de max_bytes (sem baixar o resto)."""
        url = f"{BASE}/Download.aspx{parametro}"
        with self.s.get(url, stream=True, timeout=(30, 120)) as r:
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip() or None
            partes, total = [], 0
            for bloco in r.iter_content(256 * 1024):
                partes.append(bloco)
                total += len(bloco)
                if max_bytes and total > max_bytes:
                    raise ArquivoGrande(total)
        time.sleep(self.delay)
        return b"".join(partes), ctype


class ArquivoGrande(Exception):
    def __init__(self, bytes_lidos: int):
        super().__init__(f"arquivo acima do limite (>{bytes_lidos // (1024 * 1024)} MB)")
        self.bytes_lidos = bytes_lidos


def _msg_forum(m: dict) -> dict:
    return {
        "id": m.get("nCdMensagem"),
        "id_pai": m.get("nCdMensagemPai"),
        "tipo": m.get("nIdTipo"),
        "titulo": m.get("sDsTitulo"),
        "mensagem": m.get("sDsMensagem"),
        "data": parse_data(m.get("tDtMensagem")),
        "autor_e_comprador": bool(m.get("bFlUsuarioComprador")),
        "anexo_id": m.get("nCdAnexo"),
    }


def _deduplicar(secao: str, itens: Iterable[dict]) -> list[Arquivo]:
    """O portal repete o mesmo documento uma vez por lote — às vezes como cópias físicas
    com nomes internos (sNmArquivo) diferentes. Agrupa por documento lógico:
    mesmo fornecedor + mesmo nome de arquivo + mesmo minuto de envio."""
    por_arquivo: dict[tuple, Arquivo] = {}
    for it in itens:
        data = parse_data(it.get("tDtAnexo")) or ""
        chave = (
            it.get("sNmEmpresa") or it.get("sCdUsuario") or "",
            (it.get("sDsAnexo") or it.get("sNmArquivo") or "").strip().lower(),
            data[:16],  # até o minuto
        )
        if not chave[1]:
            chave = (it.get("sNmArquivo"), f"{it.get('nCdAnexo')}-{it.get('nSqAnexo')}", "")
        lote = it.get("sDsItemLote")
        if chave in por_arquivo:
            if lote and lote not in por_arquivo[chave].itens_lote:
                por_arquivo[chave].itens_lote.append(lote)
            continue
        fornecedor_cnpj = cnpj_ou_none(it.get("sCdUsuario"))
        fornecedor_nome = it.get("sNmEmpresa") if fornecedor_cnpj else None
        campos_raw = {"sDsParametroCriptografado", "sCdUsuario"}
        if not fornecedor_cnpj:
            campos_raw.add("sNmEmpresa")
        por_arquivo[chave] = Arquivo(
            secao=secao,
            nome_original=it.get("sDsAnexo") or chave,
            arquivo_origem=it.get("sNmArquivo") or f"{it.get('nCdAnexo')}-{it.get('nSqAnexo')}",
            parametro_download=it.get("sDsParametroCriptografado"),
            data_documento=parse_data(it.get("tDtAnexo")),
            fornecedor_nome=fornecedor_nome,
            fornecedor_cnpj=fornecedor_cnpj,
            itens_lote=[lote] if lote else [],
            raw={k: v for k, v in it.items() if k not in campos_raw},
        )
    return list(por_arquivo.values())


def processo_para_linha(d: dict, modulo: int) -> dict:
    return {
        "fonte": "sestsenat",
        "modulo": modulo,
        "id_externo": d["nCdProcesso"],
        "numero_processo": d.get("sNrProcesso"),
        "numero_edital": d.get("sNrEdital"),
        "objeto": (d.get("sDsObjeto") or "").strip() or None,
        "unidade_compradora": d.get("sNmEmpresa"),
        "modalidade": d.get("sNmModalidade"),
        "fase": d.get("sDsFase"),
        "situacao": d.get("sDsSituacao"),
        "data_inicio": parse_data(d.get("tDtInicial")),
        "data_fim": parse_data(d.get("tDtFinal")),
        "valor_total": d.get("dVlTotal") if isinstance(d.get("dVlTotal"), (int, float)) and d.get("dVlTotal") > 0 else None,
        "anexo_raiz_id": d.get("nCdAnexo"),
        "raw": d,
    }


# Escopo LicitaGym: academia, musculação, cardio, esportes e lazer esportivo.
def no_escopo_fitness(d: dict) -> bool:
    """Escopo LicitaGym (classe CATMAT 7830) — regras em coletor/escopo.py."""
    from .escopo import classificar
    texto = " ".join(str(d.get(k) or "") for k in ("sDsObjeto", "sDsDescricao"))
    return classificar(texto) is not None


def encerrado(d: dict) -> bool:
    return (d.get("sDsSituacao") or "").strip().lower() in SITUACOES_ENCERRADAS

"""Coletor PNCP — busca nacional por licitações no escopo LicitaGym.

Usa as APIs públicas do Portal Nacional de Contratações Públicas (mapeadas em 24/09/2026):
  GET https://pncp.gov.br/api/search/?q="termo"&tipos_documento=edital&status=...&pagina=&tam_pagina=
  GET https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}   (detalhe: processo e estado)
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos  (-> url de cada arquivo)

Exemplos:
  python -m coletor.pncp --dry-run --paginas 1                       # só mostra o que acharia
  python -m coletor.pncp                                             # leads: recebendo proposta
  python -m coletor.pncp --modo monitorar                            # em julgamento
  python -m coletor.pncp --modo historico --paginas 20               # encerradas: histórico p/ RAG e preço
  python -m coletor.pncp --termos "borracha granulada,raspa de borracha" --baixar-arquivos

licitacoes_externas.prioridade (decisão do owner, 29/09/2026) vem do ESTADO da compra, não do modo:
  leads = recebendo proposta | monitorar = em julgamento | historico = encerrada/homologada/com resultado.
Ver prioridade_da_compra(). Compra homologada não é lead.

Prefeituras normalmente NÃO informam código CATMAT; por isso a busca é textual e cada
compra passa pelo classificador de escopo (coletor/escopo.py) usando objeto + itens.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from .destino import Armazenamento, Supabase, env, parece_html, sha256
from .escopo import TERMOS_BUSCA, classificar, excluir_compra, interesse_borracha
from .portal import cnpj_ou_none

log = logging.getLogger("pncp")
BASE = "https://pncp.gov.br"
MAX_RETRY_AFTER_S = 60


class RespostaInvalida(RuntimeError):
    """HTTP 200 cujo corpo não é o JSON esperado (HTML, JSON inválido, tipo errado)."""


class ConsultaFalhou(RuntimeError):
    """Consulta ao PNCP falhou (timeout, 429/5xx esgotados, resposta inválida).
    Diferente de resposta válida sem o dado: quem recebe não deve gravar nada."""


def _retry_after_s(r) -> float | None:
    try:
        v = float((r.headers or {}).get("Retry-After", ""))
    except (TypeError, ValueError, AttributeError):
        return None
    return max(0.0, min(v, MAX_RETRY_AFTER_S))

# Detalhe da compra e atalho (o edital e a fonte principal): nao gastar 10 min nele.
DETALHE_TIMEOUT = int(os.environ.get("PNCP_DETALHE_TIMEOUT", "20"))
DETALHE_TENTATIVAS = int(os.environ.get("PNCP_DETALHE_TENTATIVAS", "2"))

# Termos padrão: prioriza o interesse comercial (grama/borracha) e o núcleo fitness
TERMOS_PADRAO = [
    "borracha granulada", "raspa de borracha", "granulado de borracha", "grama sintética",
    "campo society", "piso emborrachado", "academia ao ar livre", "equipamentos de academia",
    "equipamentos de musculação", "aparelhos de ginástica", "material esportivo", "parque infantil",
]


class PNCP:
    """Cliente do PNCP. O endpoint de itens é lento e instável (503/timeout intermitentes):
    várias tentativas com espera crescente; uma sessão HTTP por thread."""

    def __init__(self, delay: float = 0.5, timeout: int = 90, tentativas: int = 6):
        self.delay, self.timeout, self.tentativas = delay, timeout, tentativas
        self._local = threading.local()

    @property
    def s(self) -> requests.Session:
        if not hasattr(self._local, "s"):
            self._local.s = requests.Session()
            self._local.s.headers["User-Agent"] = "LicitaGym-Coletor/1.0 (pesquisa de licitações públicas)"
        return self._local.s

    def _get(self, caminho: str, *, _timeout=None, _tentativas=None, **params):
        url = caminho if caminho.startswith("http") else BASE + caminho
        ultimo = None
        for tentativa in range(_tentativas or self.tentativas):
            try:
                r = self.s.get(url, params=params or None, timeout=_timeout or self.timeout)
                time.sleep(self.delay)
                if r.status_code == 204:
                    return []
                if r.status_code in (429, 500, 502, 503, 504):
                    ultimo = requests.HTTPError(f"{r.status_code} do PNCP", response=r)
                    espera = _retry_after_s(r) if r.status_code == 429 else None
                    time.sleep(espera if espera is not None else min(60, 5 * 2 ** tentativa))
                    continue
                r.raise_for_status()
                if "json" not in (r.headers.get("content-type") or ""):
                    raise RespostaInvalida(f"PNCP {url}: HTTP {r.status_code} sem JSON "
                                           f"({r.headers.get('content-type')})")
                try:
                    return r.json()
                except ValueError as e:
                    raise RespostaInvalida(f"PNCP {url}: JSON inválido: {e}") from e
            except (requests.ConnectionError, requests.Timeout) as e:
                ultimo = e
                time.sleep(min(60, 5 * 2 ** tentativa))
        raise ultimo or RuntimeError("PNCP sem resposta")

    def _lista(self, caminho: str, **params) -> list:
        r = self._get(caminho, **params)
        if not isinstance(r, list):
            raise RespostaInvalida(f"PNCP {caminho}: esperava lista, veio {type(r).__name__}")
        return r

    def buscar(self, termo: str, status: str = "todos", pagina: int = 1, tam: int = 100) -> dict:
        r = self._get("/api/search/", q=f'"{termo}"', tipos_documento="edital", ordenacao="-data",
                      pagina=pagina, tam_pagina=tam, status=status)
        if r == []:
            return {"items": [], "total": 0}
        if not isinstance(r, dict) or not isinstance(r.get("items"), list):
            raise RespostaInvalida(f"PNCP busca: envelope inesperado ({type(r).__name__})")
        return r

    @staticmethod
    def base_compra(c: dict) -> str:
        """Itens/arquivos/resultados continuam em /api/pncp/v1."""
        return f"/api/pncp/v1/orgaos/{c['orgao_cnpj']}/compras/{c['ano']}/{c['numero_sequencial']}"

    @staticmethod
    def detalhe_compra(c: dict) -> str:
        """Detalhe da compra: PNCP moveu para /api/consulta/v1 (pncp/v1 responde 301 em JSON)."""
        return f"/api/consulta/v1/orgaos/{c['orgao_cnpj']}/compras/{c['ano']}/{c['numero_sequencial']}"

    def compra(self, c: dict) -> dict:
        """Detalhe da compra: traz o número do PROCESSO ADMINISTRATIVO ('processo'),
        que a busca não devolve. É ele (com o CNPJ do órgão) que identifica o certame fora do PNCP.
        Traz também o estado atual da compra (existeResultado, valorTotalHomologado, situacaoCompraNome,
        dataEncerramentoProposta), que vence o item da busca na prioridade (ver compra_com_detalhe)."""
        r = self._get(self.detalhe_compra(c), _timeout=DETALHE_TIMEOUT, _tentativas=DETALHE_TENTATIVAS)
        # PNCP devolve erro de rota como JSON {status, message} com HTTP 200.
        if isinstance(r, dict) and str(r.get("status", "")).startswith(("3", "4", "5")) and "message" in r:
            raise RuntimeError(f"PNCP detalhe: {r.get('status')} {r.get('message')}")
        if not isinstance(r, dict):
            raise RespostaInvalida(f"PNCP detalhe: esperava objeto, veio {type(r).__name__}")
        return r

    def itens(self, c: dict) -> list[dict]:
        out, pagina, paginas_vistas = [], 1, set()
        while True:
            lote = self._lista(self.base_compra(c) + "/itens", pagina=pagina, tamanhoPagina=100)
            fingerprint = sha256(json.dumps(
                lote, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8"))
            if fingerprint in paginas_vistas:
                raise RespostaInvalida(f"PNCP itens: página repetida durante paginação (página {pagina})")
            paginas_vistas.add(fingerprint)
            out += lote
            if len(lote) < 100:
                return out
            pagina += 1

    def resultados(self, c: dict, numero_item: int) -> list[dict]:
        return self._lista(self.base_compra(c) + f"/itens/{numero_item}/resultados")

    def arquivos(self, c: dict) -> list[dict]:
        return self._lista(self.base_compra(c) + "/arquivos")

    def baixar(self, url: str, max_bytes: int) -> tuple[bytes, str | None]:
        with self.s.get(url, stream=True, timeout=(30, 180)) as r:
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "").split(";")[0] or None
            partes, total = [], 0
            for b in r.iter_content(256 * 1024):
                partes.append(b)
                total += len(b)
                if total > max_bytes:
                    raise ValueError(f"arquivo acima de {max_bytes // 1048576} MB")
        time.sleep(self.delay)
        return b"".join(partes), ctype


def _num(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _valor_positivo(v):
    """Valor monetário da compra: None se ausente, inválido ou <= 0 (PNCP manda 0 em orçamento
    sigiloso). Um 0 gravado pareceria dado real e sobrescreveria um valor bom."""
    n = _num(v)
    return n if n is not None and n > 0 else None


def valor_total_detalhe(det: dict) -> float | None:
    """valor_total da compra a partir do detalhe (/api/consulta/v1/.../compras/{ano}/{seq}).

    Usa só valorTotalEstimado (valor de referência do edital). valorTotalHomologado NÃO entra como
    fallback: é o valor adjudicado depois da disputa — grandeza diferente, e misturar os dois na
    mesma coluna tornaria valor_total incomparável entre compras (e o homologado nem existe em
    editais abertos, que são justamente os que chegam sem valor)."""
    return _valor_positivo((det or {}).get("valorTotalEstimado"))


def _data(v):
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()
    except ValueError:
        return None


def avaliar(compra: dict, itens: list[dict]) -> tuple[str | None, bool, dict[int, tuple[str | None, bool]]]:
    """Classifica a compra pelo objeto e pelos itens. Retorna (categoria, interesse_borracha, por_item)."""
    objeto = compra.get("description") or compra.get("title") or ""
    if excluir_compra(objeto):
        return None, False, {it["numeroItem"]: (None, False) for it in itens}
    por_item = {}
    for it in itens:
        cat = classificar(it.get("descricao") or "")
        por_item[it["numeroItem"]] = (cat, interesse_borracha(it.get("descricao") or "", cat))
    cat_obj = classificar(objeto)
    prioridade = ["borracha", "obra_piso", "piso", "catmat", "forte", "fraco"]
    candidatas = [cat_obj] + [c for c, _ in por_item.values()]
    categoria = next((p for p in prioridade if p in candidatas), None)
    interesse = interesse_borracha(objeto, cat_obj) or any(b for _, b in por_item.values())
    return categoria, interesse, por_item


# Modos de coleta, em ordem de prioridade comercial. O modo só escolhe o filtro `status` da busca;
# a prioridade gravada vem de prioridade_da_compra() (o filtro do PNCP é ruidoso: em 29/09/2026
# status=em_julgamento devolvia compras ainda recebendo proposta, com resultado e anuladas).
MODOS = {
    # certames recebendo proposta -> ainda dá para disputar: são os leads
    "leads": {"status": "recebendo_proposta"},
    # propostas encerradas, sem resultado -> acompanhar até sair o vencedor
    "monitorar": {"status": "em_julgamento"},
    # encerradas (homologadas, com resultado, revogadas, anuladas, desertas...) -> histórico de preço e RAG
    "historico": {"status": "encerradas"},
}

# Valores de licitacoes_externas.prioridade (decisão do owner, 29/09/2026). Compra homologada NÃO é lead.
PRIORIDADES = ("leads", "monitorar", "historico")
# Último recurso quando a compra não tem prazo de proposta nem sinal de encerramento/resultado.
PRIORIDADE_DO_STATUS_BUSCA = {"recebendo_proposta": "leads", "em_julgamento": "monitorar",
                              "encerradas": "historico"}
_SITUACAO_ENCERRADA = re.compile(r"revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|"
                                 r"adjudicad|conclu[ií]d|finalizad", re.I)
_SITUACAO_SUSPENSA = re.compile(r"suspens", re.I)
_ITEM_COM_RESULTADO = re.compile(r"homologad|adjudicad", re.I)
_ITEM_FINAL = re.compile(r"homologad|adjudicad|desert|fracassad|anulad|revogad|cancelad", re.I)
# Datas do PNCP sem fuso (ex.: data_fim_vigencia "2026-10-13T09:30") estão no horário de Brasília.
FUSO_PNCP = timezone(timedelta(hours=-3))


def _instante(v) -> datetime | None:
    if not v:
        return None
    if isinstance(v, datetime):
        d = v
    else:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=FUSO_PNCP)


def _campo(compra: dict, *chaves):
    """Primeiro valor presente entre as chaves, na compra e depois no `raw` gravado (item da busca)."""
    raw = compra.get("raw") if isinstance(compra.get("raw"), dict) else {}
    for fonte in (compra, raw):
        for k in chaves:
            v = fonte.get(k)
            if v not in (None, ""):
                return v
    return None


def _verdadeiro(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "t", "1", "sim"))


def motivo_prioridade(compra: dict, tem_resultado: bool | None = None, *, agora: datetime | None = None,
                      status_busca: str | None = None, itens: list[dict] | None = None) -> tuple[str | None, str]:
    """(prioridade, motivo). Função pura: não consulta nada, só lê os campos recebidos.

    `compra` aceita o item da busca (situacao_nome, tem_resultado, cancelado, data_fim_vigencia), o detalhe
    (situacaoCompraNome, existeResultado, valorTotalHomologado, dataEncerramentoProposta) ou a linha gravada
    em licitacoes_externas (situacao, data_homologacao, data_fim, raw). `tem_resultado=True` = quem chama já
    viu resultado (ex.: /resultados); False/None não anula o que a compra diz. `itens` no formato do PNCP
    (situacaoCompraItemNome, temResultado) ou de licitacao_itens (situacao, tem_resultado).

    Ordem: 1) historico se há homologação/resultado ou a compra está encerrada (revogada, anulada,
    cancelada, deserta, fracassada, todos os itens finalizados); 2) monitorar se suspensa; 3) pelo prazo
    de proposta: aberto -> leads, encerrado sem resultado -> monitorar; 4) sem prazo: o status da busca
    (último recurso); 5) None = indeterminado (quem chama não grava).

    Precedência de chaves (_campo): as do detalhe vêm antes das da busca (existeResultado > tem_resultado,
    situacaoCompraNome > situacao_nome, dataEncerramentoProposta > data_fim_vigencia), então na visão
    compra_com_detalhe() o detalhe vence a busca, que pode estar defasada."""
    agora = agora or datetime.now(timezone.utc)
    if tem_resultado is True:
        return "historico", "resultado consultado"
    if _campo(compra, "data_homologacao"):
        return "historico", "data_homologacao"
    # chaves do detalhe antes das da busca: na visão compra_com_detalhe() o detalhe vence
    if _verdadeiro(_campo(compra, "existeResultado", "tem_resultado")):
        return "historico", "compra com resultado"
    if (_num(_campo(compra, "valorTotalHomologado")) or 0) > 0:
        return "historico", "valor homologado"
    if _verdadeiro(_campo(compra, "cancelado")):
        return "historico", "cancelada"
    situacao = str(_campo(compra, "situacaoCompraNome", "situacao_nome", "situacao") or "")
    if _SITUACAO_ENCERRADA.search(situacao):
        return "historico", f"situação {situacao}"
    if itens:
        sit_itens = [str(it.get("situacaoCompraItemNome") or it.get("situacao") or "") for it in itens]
        if any(_verdadeiro(it.get("temResultado", it.get("tem_resultado"))) for it in itens) or \
                any(_ITEM_COM_RESULTADO.search(s) for s in sit_itens):
            return "historico", "item com resultado"
        if all(_ITEM_FINAL.search(s) for s in sit_itens):
            return "historico", "todos os itens finalizados"
    if _SITUACAO_SUSPENSA.search(situacao):
        return "monitorar", f"situação {situacao}"
    # prazo do PNCP (detalhe, depois raw.data_fim_vigencia) antes do data_fim gravado: o coletor grava o
    # horário sem fuso do PNCP como UTC (_data), 3 h antes do prazo real em Brasília
    fim = _instante(_campo(compra, "dataEncerramentoProposta", "data_fim_vigencia") or _campo(compra, "data_fim"))
    if fim:
        if fim > agora:
            return "leads", "recebendo proposta"
        return "monitorar", "propostas encerradas sem resultado"
    if status_busca in PRIORIDADE_DO_STATUS_BUSCA:
        return PRIORIDADE_DO_STATUS_BUSCA[status_busca], f"sem prazo de proposta; busca status={status_busca}"
    return None, "indeterminado (sem prazo de proposta nem resultado)"


# Campos de estado do detalhe da compra (/api/consulta/v1/...) que motivo_prioridade lê.
ESTADO_DETALHE = ("existeResultado", "valorTotalHomologado", "situacaoCompraNome", "dataEncerramentoProposta")


def compra_com_detalhe(compra: dict, det: dict | None) -> dict:
    """Visão para motivo_prioridade: `compra` (item da busca ou linha gravada) + os campos de estado do
    detalhe. O detalhe é a fonte autoritativa (a busca atrasa: prazo "aberto" e sem resultado numa compra
    já homologada); como motivo_prioridade lê as chaves do detalhe primeiro, ele vence onde tem valor e a
    busca só completa o que o detalhe não traz. Não altera as entradas."""
    if not det:
        return compra
    return {**compra, **{k: det[k] for k in ESTADO_DETALHE if det.get(k) not in (None, "")}}


def prioridade_da_compra(compra: dict, tem_resultado: bool | None = None, *, agora: datetime | None = None,
                         status_busca: str | None = None, itens: list[dict] | None = None) -> str | None:
    """leads | monitorar | historico a partir do estado real da compra (ver motivo_prioridade)."""
    return motivo_prioridade(compra, tem_resultado, agora=agora, status_busca=status_busca, itens=itens)[0]


_trava = threading.Lock()


def _inc(resumo: dict, chave: str, n: int = 1) -> None:
    with _trava:
        resumo[chave] = resumo.get(chave, 0) + n


def _dt(v) -> datetime | None:
    s = _data(v)
    return datetime.fromisoformat(s) if s else None


def coletar(pncp: PNCP, sb: Supabase | None, arm: Armazenamento | None, termos: list[str], status,
            paginas: int, tam: int, com_resultados: bool, baixar_arquivos: bool, max_bytes: int,
            dry_run: bool, modo: str | None = None, agora: datetime | None = None, workers: int = 3,
            pausa_segunda_passada: float = 30) -> dict:
    """Busca `status` para cada termo e grava as compras no escopo. `modo` só vai para o log/resumo:
    a prioridade de cada compra vem de prioridade_da_compra() (estado real, com o status da busca só
    como último recurso). Uma compra encerrada vira historico mesmo que já fosse lead (rebaixa)."""
    agora = agora or datetime.now(timezone.utc)
    status_lista = status if isinstance(status, list) else [status]
    vistos: dict[str, list[str]] = {}
    resumo = {"encontradas": 0, "no_escopo": 0, "interesse_borracha": 0, "fora": 0,
              "gravadas": 0, "erros": 0}
    falhas: list[tuple[dict, str, str]] = []

    def _tentar(c, termo, st):
        try:
            _processar(pncp, sb, arm, c, termo, com_resultados, baixar_arquivos,
                       max_bytes, dry_run, resumo, modo, status_busca=st, agora=agora)
            return c, None
        except Exception as e:
            if "Supabase" in str(e) and (" 401 " in str(e) or " 403 " in str(e)):
                raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY "
                                 "em ~/.licitagym.env e rode de novo. Nada foi perdido.")
            log.warning("  %s: %s (vai para a segunda passada)", c.get("numero_controle_pncp"), str(e)[:120])
            return c, e

    for termo in termos:
        for st in status_lista:
            for pagina in range(1, paginas + 1):
                res = pncp.buscar(termo, st, pagina, tam)
                lote = res.get("items") or []
                log.info('"%s" [%s] pág. %s: %s de %s', termo, st, pagina, len(lote), res.get("total"))
                fila = []
                for c in lote:
                    chave = c.get("numero_controle_pncp")
                    if not chave:
                        continue
                    if chave in vistos:
                        vistos[chave].append(termo)
                        continue
                    vistos[chave] = [termo]
                    resumo["encontradas"] += 1
                    fila.append(c)
                with ThreadPoolExecutor(max_workers=workers) as ex:
                    for c, erro in ex.map(lambda c: _tentar(c, termo, st), fila):
                        if erro:
                            falhas.append((c, termo, st))
                if len(lote) < tam:
                    break

    if falhas:
        log.info("Segunda passada: %s compra(s) que falharam por instabilidade do PNCP", len(falhas))
        time.sleep(pausa_segunda_passada)
        for c, termo, st in falhas:
            _, erro = _tentar(c, termo, st)
            if erro:
                _inc(resumo, "erros")
    return resumo


def _resultados_relevantes(pncp, c, itens, por_item) -> list[tuple[dict, dict]]:
    relevantes = [it for it in itens if it.get("temResultado") is not False and
                  (por_item[it["numeroItem"]][0] or len(itens) <= 5)]
    pares = []
    for it in relevantes:
        for r in pncp.resultados(c, it["numeroItem"]):
            pares.append((it, r))
    return pares


def consultar_detalhe(pncp, c: dict) -> dict:
    """Detalhe da compra (uma consulta por compra: identificação e prioridade usam o mesmo retorno).
    Falha da consulta levanta ConsultaFalhou."""
    try:
        return pncp.compra(c)
    except Exception as e:
        raise ConsultaFalhou(f"detalhe da compra {c.get('numero_controle_pncp')}: {e}") from e


def identificacao_do_detalhe(c: dict, det: dict) -> dict:
    """numero_processo = processo administrativo do órgão (ex.: 00007.20260204/0002-28).
    numero_edital = só rótulo de exibição ('Pregão Eletrônico nº 1/2026' se repete entre órgãos e NÃO identifica nada).
    Identidade: PNCP -> numero_controle_pncp; fora do PNCP -> (CNPJ do órgão, processo administrativo).

    numero_processo None = detalhe respondeu sem processo.

    valor_total (valorTotalEstimado do detalhe; a busca deixa valor_global vazio em editais) só
    entra no dict quando existe: ausente nunca vira NULL gravado por cima de valor bom."""
    proc = (det.get("processo") or "").strip() or None
    num, ano = det.get("numeroCompra"), det.get("anoCompra") or c.get("ano")
    mod = det.get("modalidadeNome") or c.get("modalidade_licitacao_nome")
    edital = f"{mod} nº {num}/{ano}" if num else c.get("title")
    out = {"numero_processo": proc, "numero_edital": edital}
    valor = valor_total_detalhe(det)
    if valor is not None:
        out["valor_total"] = valor
    return out


def identificacao(pncp, c: dict) -> dict:
    """Consulta o detalhe e extrai a identificação (ver identificacao_do_detalhe). Falha da consulta
    levanta ConsultaFalhou: quem chama não grava identificação (não sobrescreve valor bom com NULL)."""
    return identificacao_do_detalhe(c, consultar_detalhe(pncp, c))


def _raw_resultado(r: dict) -> dict:
    campos_sigilosos = {"niFornecedor"}
    if r.get("tipoPessoa") == "PF":
        campos_sigilosos.add("nomeRazaoSocialFornecedor")
    return {k: v for k, v in r.items() if k not in campos_sigilosos}


def _processar(pncp, sb, arm, c, termo, com_resultados, baixar_arquivos, max_bytes, dry_run, resumo,
               modo=None, status_busca=None, agora=None):
    itens = pncp.itens(c)
    categoria, interesse, por_item = avaliar(c, itens)
    rotulo = f"{c.get('municipio_nome')}/{c.get('uf')} | {(c.get('description') or '').strip()[:80]}"
    if not categoria:
        _inc(resumo, "fora")
        log.info("  fora      | %s", rotulo)
        return
    _inc(resumo, "no_escopo")
    _inc(resumo, "interesse_borracha", int(interesse))

    pares = _resultados_relevantes(pncp, c, itens, por_item) if com_resultados else []
    datas = [d for d in (_dt(r.get("dataResultado")) for _, r in pares) if d]
    data_homologacao = max(datas) if datas else None
    tem_resultado = (bool(pares) or data_homologacao is not None) if com_resultados else None

    # Detalhe consultado uma vez: identificação + estado autoritativo da compra (a busca atrasa).
    try:
        det, erro_detalhe = consultar_detalhe(pncp, c), None
    except ConsultaFalhou as e:
        det, erro_detalhe = None, e
    ident = identificacao_do_detalhe(c, det) if det is not None else {}
    prioridade, motivo = motivo_prioridade(compra_com_detalhe(c, det), tem_resultado, agora=agora,
                                           status_busca=status_busca, itens=itens)
    # Fail-closed: sem o detalhe, "leads" vindo só da busca+itens pode ser compra já homologada.
    # Não grava (fica o valor do banco); historico/monitorar pela busca+itens continuam valendo.
    leads_sem_detalhe = det is None and prioridade == "leads"
    if leads_sem_detalhe:
        _inc(resumo, "prioridade_leads_sem_detalhe")
    else:
        _inc(resumo, f"prioridade_{prioridade or 'indeterminada'}")
        if modo and prioridade and prioridade != modo:
            _inc(resumo, "prioridade_diferente_do_modo")

    vencedores = sorted({(r.get("nomeRazaoSocialFornecedor") or "")[:40] for _, r in pares
                         if r.get("tipoPessoa") != "PF" and r.get("nomeRazaoSocialFornecedor")})
    log.info("  %-9s%s | %s | %s (%s)%s%s", categoria, " ★borracha" if interesse else "", rotulo,
             "leads NÃO gravada (sem detalhe)" if leads_sem_detalhe else prioridade or "prioridade ?", motivo,
             f" | homologado {data_homologacao.date()}" if data_homologacao else "",
             f" | vencedor(es): {', '.join(vencedores[:3])}" if vencedores else "")
    if det is not None:
        log.info("            processo %s | %s | órgão %s", ident["numero_processo"] or "?",
                 ident["numero_edital"], c.get("orgao_cnpj"))
    else:
        _inc(resumo, "falha_detalhe")
        log.warning("            detalhe indisponível, identificação não gravada: %s", str(erro_detalhe)[:120])
        if leads_sem_detalhe:
            log.warning("            leads só pela busca+itens, sem o detalhe: prioridade não gravada "
                        "(fica a do banco)")
    if dry_run:
        return

    linha = {
        "fonte": "pncp", "codigo_externo": c["numero_controle_pncp"], **ident,
        "objeto": (c.get("description") or "").strip() or None,
        "unidade_compradora": c.get("unidade_nome"), "orgao_nome": c.get("orgao_nome"),
        "orgao_cnpj": c.get("orgao_cnpj"), "municipio": c.get("municipio_nome"), "uf": c.get("uf"),
        "modalidade": c.get("modalidade_licitacao_nome"), "situacao": c.get("situacao_nome"),
        "data_publicacao": _data(c.get("data_publicacao_pncp")), "data_fim": _data(c.get("data_fim_vigencia")),
        "data_homologacao": data_homologacao.isoformat() if data_homologacao else None,
        "prioridade": prioridade, "categoria_escopo": categoria,
        "interesse_borracha": interesse, "termos_busca": [termo], "raw": c,
    }
    # valor_total: detalhe (valorTotalEstimado, via identificacao_do_detalhe) > valor_global da busca
    # (vazio em editais). Sem nenhum dos dois a chave fica fora: o upsert (merge-duplicates) atualiza
    # toda coluna enviada, e mandar null apagaria um valor já gravado.
    valor_total = ident.get("valor_total") or _valor_positivo(c.get("valor_global"))
    if valor_total is not None:
        linha["valor_total"] = valor_total
    else:
        linha.pop("valor_total", None)
    # O estado derivado vence: encerrada/homologada vira historico mesmo que a linha fosse lead.
    # Só não grava quando não dá para saber (não apaga uma prioridade já gravada com NULL) ou quando
    # seria leads sem o detalhe confirmar (fail-closed: homologada nunca vira lead).
    if prioridade is None or leads_sem_detalhe:
        linha.pop("prioridade")
    if not data_homologacao:
        linha.pop("data_homologacao")
    lic_id = sb.upsert("licitacoes_externas", linha, "fonte,codigo_externo")[0]["id"]
    _inc(resumo, "gravadas")

    if itens:
        sb.upsert("licitacao_itens", [{
            "licitacao_id": lic_id, "numero_item": it["numeroItem"], "descricao": it.get("descricao"),
            "material_ou_servico": it.get("materialOuServicoNome"), "quantidade": _num(it.get("quantidade")),
            "unidade_medida": it.get("unidadeMedida"), "valor_unitario_estimado": _num(it.get("valorUnitarioEstimado")),
            "valor_total_estimado": _num(it.get("valorTotal")),
            "catalogo_codigo_item": str(it["catalogoCodigoItem"]) if it.get("catalogoCodigoItem") else None,
            "situacao": it.get("situacaoCompraItemNome"), "tem_resultado": it.get("temResultado"),
            "categoria_escopo": por_item[it["numeroItem"]][0], "interesse_borracha": por_item[it["numeroItem"]][1],
            "raw": it,
        } for it in itens], "licitacao_id,numero_item")

    linhas = [{
        "licitacao_id": lic_id, "numero_item": it["numeroItem"],
        "sequencial_resultado": r.get("sequencialResultado") or 1,
        "fornecedor_nome": r.get("nomeRazaoSocialFornecedor") if r.get("tipoPessoa") != "PF" else None,
        "fornecedor_cnpj": cnpj_ou_none(r.get("niFornecedor")),
        "porte_fornecedor": r.get("porteFornecedorNome"),
        "quantidade_homologada": _num(r.get("quantidadeHomologada")),
        "valor_unitario_homologado": _num(r.get("valorUnitarioHomologado")),
        "valor_total_homologado": _num(r.get("valorTotalHomologado")),
        "situacao": r.get("situacaoCompraItemResultadoNome"), "data_resultado": _data(r.get("dataResultado")),
        "raw": _raw_resultado(r),
    } for it, r in pares]
    if linhas:
        sb.upsert("licitacao_resultados", linhas, "licitacao_id,numero_item,sequencial_resultado")

    arquivos = pncp.arquivos(c)
    docs = [{
        "licitacao_id": lic_id, "secao": "processo",
        "nome_original": a.get("titulo"), "arquivo_origem": f"pncp-{a.get('sequencialDocumento')}",
        "data_documento": _data(a.get("dataPublicacaoPncp")),
        "raw": {"tipo_documento": a.get("tipoDocumentoNome"), "url": a.get("url") or a.get("uri")},
    } for a in arquivos if a.get("statusAtivo", True)]
    if not docs:
        return
    salvos = sb.upsert("licitacao_documentos", docs, "licitacao_id,secao,arquivo_origem")
    if not baixar_arquivos:
        return
    for d in salvos:
        if d.get("status_processamento") not in ("pendente", "erro"):
            continue
        url = (d.get("raw") or {}).get("url")
        try:
            conteudo, ctype = pncp.baixar(url, max_bytes)
            if parece_html(conteudo, ctype):
                raise RuntimeError("PNCP devolveu HTML em vez do arquivo")
            ext = (d.get("nome_original") or "").rsplit(".", 1)[-1][:5] if "." in (d.get("nome_original") or "") else "bin"
            caminho = arm.caminho("pncp", 0, c["orgao_cnpj"] + "-" + str(c["ano"]) + "-" + str(c["numero_sequencial"]),
                                  "processo", f"{d['arquivo_origem']}.{ext}")
            uri = arm.salvar(caminho, conteudo, ctype)
            sb.atualizar("licitacao_documentos", d["id"], {
                "storage_uri": uri, "mime_type": ctype, "tamanho_bytes": len(conteudo),
                "sha256": sha256(conteudo), "status_processamento": "baixado", "erro": None})
            log.info("    arquivo: %s (%.1f MB)", (d.get("nome_original") or "")[:70], len(conteudo) / 1048576)
        except Exception as e:
            sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "erro", "erro": str(e)[:300]})


def compra_de_codigo(codigo: str | None, **extra) -> dict | None:
    """'44892693000140-1-000157/2026' (numero_controle_pncp) -> chaves do detalhe da compra."""
    m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", codigo or "")
    if not m:
        return None
    return {"orgao_cnpj": m.group(1), "numero_sequencial": int(m.group(2)), "ano": int(m.group(3)),
            "numero_controle_pncp": codigo, **extra}


def corrigir_processos(pncp: PNCP, sb: Supabase) -> dict:
    """Versões até a v12 gravaram o código PNCP em numero_processo. Busca o processo administrativo real.

    Três desfechos por linha: processo encontrado (corrigidas), detalhe válido sem processo
    (sem_processo, grava NULL: o valor antigo era o código PNCP) e falha da consulta
    (falha_consulta, não grava nada). Se o detalhe trouxer valorTotalEstimado, valor_total vai junto
    (nunca NULL: identificacao omite a chave sem valor)."""
    r = {"lidas": 0, "corrigidas": 0, "sem_processo": 0, "falha_consulta": 0}
    linhas = sb.selecionar("licitacoes_externas", fonte="eq.pncp", select="id,codigo_externo,orgao_cnpj,numero_edital")
    for ln in linhas:
        r["lidas"] += 1
        c = compra_de_codigo(ln.get("codigo_externo"), title=ln.get("numero_edital"))
        if not c:
            continue
        try:
            ident = identificacao(pncp, c)
        except ConsultaFalhou as e:
            r["falha_consulta"] += 1
            log.warning("  %s: consulta falhou, nada gravado: %s", ln["codigo_externo"], str(e)[:120])
            continue
        sb.atualizar("licitacoes_externas", ln["id"], ident)
        if ident["numero_processo"]:
            r["corrigidas"] += 1
        else:
            r["sem_processo"] += 1
        log.info("  %s -> processo %s | %s", ln["codigo_externo"], ident["numero_processo"], ident["numero_edital"])
    return r


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Coletor PNCP (escopo LicitaGym)")
    ap.add_argument("--modo", choices=list(MODOS), default="leads",
                    help="leads (padrão): recebendo proposta; monitorar: em julgamento; historico: encerradas. "
                         "Só escolhe o status da busca: a prioridade gravada vem do estado de cada compra")
    # Obsoletos (janela de homologação do antigo modo leads): aceitos para não quebrar agendamentos, sem efeito.
    ap.add_argument("--dias", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--margem-publicacao", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--termos", help="lista separada por vírgula (padrão: TERMOS_PADRAO)")
    ap.add_argument("--todos-termos", action="store_true", help="usa também todos os TERMOS_BUSCA do escopo")
    ap.add_argument("--status", choices=["todos", "recebendo_proposta", "em_julgamento", "encerradas"],
                    help="sobrescreve o status do modo")
    ap.add_argument("--paginas", type=int, help="páginas por termo (padrão: leads 20, outros 3)")
    ap.add_argument("--tam", type=int, default=50, help="resultados por página")
    ap.add_argument("--sem-resultados", action="store_true", help="não consulta vencedores")
    ap.add_argument("--baixar-arquivos", action="store_true", help="baixa edital/anexos (para o RAG)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--corrigir-processos", action="store_true",
                    help="só corrige numero_processo das compras PNCP já gravadas (processo administrativo real)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.corrigir_processos:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        log.info("RESUMO: %s", corrigir_processos(PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5"))), sb))
        return 0

    termos = [t.strip() for t in args.termos.split(",")] if args.termos else list(TERMOS_PADRAO)
    if args.todos_termos:
        termos += [t for t in TERMOS_BUSCA if t not in termos]
    sb = arm = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        arm = Armazenamento.do_ambiente()
    if args.dias is not None or args.margem_publicacao is not None:
        log.warning("--dias/--margem-publicacao não têm mais efeito: leads = recebendo proposta "
                    "(compra homologada não é lead; decisão de 29/09/2026)")
    status = args.status or MODOS[args.modo]["status"]
    paginas = args.paginas or (20 if args.modo == "leads" else 3)
    log.info("modo=%s status=%s termos=%s", args.modo, status, len(termos))
    r = coletar(PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5"))), sb, arm, termos, status, paginas,
                args.tam, not args.sem_resultados, args.baixar_arquivos,
                int(float(env("MAX_MB", "80")) * 1048576), args.dry_run,
                modo=args.modo, workers=int(env("PNCP_WORKERS", "3")))
    log.info("RESUMO: %s", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

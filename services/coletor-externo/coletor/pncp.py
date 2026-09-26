"""Coletor PNCP — busca nacional por licitações no escopo LicitaGym.

Usa as APIs públicas do Portal Nacional de Contratações Públicas (mapeadas em 24/09/2026):
  GET https://pncp.gov.br/api/search/?q="termo"&tipos_documento=edital&status=...&pagina=&tam_pagina=
  GET https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}   (detalhe: processo)
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos  (-> url de cada arquivo)

Exemplos:
  python -m coletor.pncp --dry-run --paginas 1                       # só mostra o que acharia
  python -m coletor.pncp --status recebendo_proposta                 # oportunidades abertas
  python -m coletor.pncp --status encerradas --paginas 20            # histórico p/ RAG e leads
  python -m coletor.pncp --termos "borracha granulada,raspa de borracha" --baixar-arquivos

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
        que a busca não devolve. É ele (com o CNPJ do órgão) que identifica o certame fora do PNCP."""
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


# Modos de coleta, em ordem de prioridade comercial
MODOS = {
    # vencedor já conhecido e ainda vai comprar o material -> principal fonte de leads
    "leads": {"status": "encerradas", "exige_resultado_recente": True},
    # certames abertos/em julgamento -> lista de acompanhamento (vencedor ainda não existe)
    "monitorar": {"status": ["recebendo_proposta", "em_julgamento"], "exige_resultado_recente": False},
    # encerrados antigos -> histórico de preços e RAG
    "historico": {"status": "encerradas", "exige_resultado_recente": False},
}


_trava = threading.Lock()


def _inc(resumo: dict, chave: str, n: int = 1) -> None:
    with _trava:
        resumo[chave] = resumo.get(chave, 0) + n


def _dt(v) -> datetime | None:
    s = _data(v)
    return datetime.fromisoformat(s) if s else None


def coletar(pncp: PNCP, sb: Supabase | None, arm: Armazenamento | None, termos: list[str], status,
            paginas: int, tam: int, com_resultados: bool, baixar_arquivos: bool, max_bytes: int,
            dry_run: bool, modo: str | None = None, dias: int = 120, margem_publicacao: int = 240,
            agora: datetime | None = None, workers: int = 3, pausa_segunda_passada: float = 30) -> dict:
    """modo='leads': só grava compras com resultado (homologação) nos últimos `dias`.
    A busca vem ordenada por data de publicação (mais recente primeiro); a paginação para quando
    o edital foi publicado há mais de `dias + margem_publicacao` dias (não pode ter homologação recente)."""
    agora = agora or datetime.now(timezone.utc)
    corte_resultado = agora - timedelta(days=dias) if modo == "leads" else None
    corte_publicacao = agora - timedelta(days=dias + margem_publicacao) if modo == "leads" else None
    status_lista = status if isinstance(status, list) else [status]
    vistos: dict[str, list[str]] = {}
    resumo = {"encontradas": 0, "no_escopo": 0, "interesse_borracha": 0, "fora": 0,
              "sem_resultado_recente": 0, "gravadas": 0, "erros": 0}
    falhas: list[tuple[dict, str]] = []

    def _tentar(c, termo):
        try:
            _processar(pncp, sb, arm, c, termo, com_resultados or modo == "leads", baixar_arquivos,
                       max_bytes, dry_run, resumo, modo, corte_resultado)
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
                antigas = 0
                fila = []
                for c in lote:
                    chave = c.get("numero_controle_pncp")
                    if not chave:
                        continue
                    if corte_publicacao:
                        pub = _dt(c.get("data_publicacao_pncp"))
                        if pub and pub < corte_publicacao:
                            antigas += 1
                            continue
                        if c.get("tem_resultado") is False:
                            continue
                    if chave in vistos:
                        vistos[chave].append(termo)
                        continue
                    vistos[chave] = [termo]
                    resumo["encontradas"] += 1
                    fila.append(c)
                with ThreadPoolExecutor(max_workers=workers) as ex:
                    for c, erro in ex.map(lambda c: _tentar(c, termo), fila):
                        if erro:
                            falhas.append((c, termo))
                if len(lote) < tam or (lote and antigas == len(lote)):
                    if antigas:
                        log.info("  editais publicados antes de %s: fim da paginação deste termo",
                                 corte_publicacao.date())
                    break

    if falhas:
        log.info("Segunda passada: %s compra(s) que falharam por instabilidade do PNCP", len(falhas))
        time.sleep(pausa_segunda_passada)
        for c, termo in falhas:
            _, erro = _tentar(c, termo)
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


def identificacao(pncp, c: dict) -> dict:
    """numero_processo = processo administrativo do órgão (ex.: 00007.20260204/0002-28).
    numero_edital = só rótulo de exibição ('Pregão Eletrônico nº 1/2026' se repete entre órgãos e NÃO identifica nada).
    Identidade: PNCP -> numero_controle_pncp; fora do PNCP -> (CNPJ do órgão, processo administrativo).

    numero_processo None = detalhe respondeu sem processo. Falha da consulta levanta ConsultaFalhou:
    quem chama não grava identificação (não sobrescreve valor bom com NULL)."""
    try:
        det = pncp.compra(c)
    except Exception as e:
        raise ConsultaFalhou(f"detalhe da compra {c.get('numero_controle_pncp')}: {e}") from e
    proc = (det.get("processo") or "").strip() or None
    num, ano = det.get("numeroCompra"), det.get("anoCompra") or c.get("ano")
    mod = det.get("modalidadeNome") or c.get("modalidade_licitacao_nome")
    edital = f"{mod} nº {num}/{ano}" if num else c.get("title")
    return {"numero_processo": proc, "numero_edital": edital}


def _raw_resultado(r: dict) -> dict:
    campos_sigilosos = {"niFornecedor"}
    if r.get("tipoPessoa") == "PF":
        campos_sigilosos.add("nomeRazaoSocialFornecedor")
    return {k: v for k, v in r.items() if k not in campos_sigilosos}


def _processar(pncp, sb, arm, c, termo, com_resultados, baixar_arquivos, max_bytes, dry_run, resumo,
               modo=None, corte_resultado=None):
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
    if corte_resultado and (not data_homologacao or data_homologacao < corte_resultado):
        _inc(resumo, "sem_resultado_recente")
        log.info("  %-9s | sem homologação recente (%s) | %s", categoria,
                 data_homologacao.date() if data_homologacao else "sem resultado", rotulo)
        return

    vencedores = sorted({(r.get("nomeRazaoSocialFornecedor") or "")[:40] for _, r in pares
                         if r.get("tipoPessoa") != "PF" and r.get("nomeRazaoSocialFornecedor")})
    log.info("  %-9s%s | %s%s%s", categoria, " ★borracha" if interesse else "", rotulo,
             f" | homologado {data_homologacao.date()}" if data_homologacao else "",
             f" | vencedor(es): {', '.join(vencedores[:3])}" if vencedores else "")
    try:
        ident = identificacao(pncp, c)
        log.info("            processo %s | %s | órgão %s", ident["numero_processo"] or "?",
                 ident["numero_edital"], c.get("orgao_cnpj"))
    except ConsultaFalhou as e:
        ident = {}
        _inc(resumo, "falha_detalhe")
        log.warning("            detalhe indisponível, identificação não gravada: %s", str(e)[:120])
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
        "prioridade": modo, "valor_total": _num(c.get("valor_global")), "categoria_escopo": categoria,
        "interesse_borracha": interesse, "termos_busca": [termo], "raw": c,
    }
    if modo not in ("leads", "monitorar"):
        linha.pop("prioridade")   # histórico não rebaixa um lead já gravado
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


def corrigir_processos(pncp: PNCP, sb: Supabase) -> dict:
    """Versões até a v12 gravaram o código PNCP em numero_processo. Busca o processo administrativo real.

    Três desfechos por linha: processo encontrado (corrigidas), detalhe válido sem processo
    (sem_processo, grava NULL: o valor antigo era o código PNCP) e falha da consulta
    (falha_consulta, não grava nada)."""
    r = {"lidas": 0, "corrigidas": 0, "sem_processo": 0, "falha_consulta": 0}
    linhas = sb.selecionar("licitacoes_externas", fonte="eq.pncp", select="id,codigo_externo,orgao_cnpj,numero_edital")
    for ln in linhas:
        r["lidas"] += 1
        m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", ln.get("codigo_externo") or "")
        if not m:
            continue
        c = {"orgao_cnpj": m.group(1), "numero_sequencial": int(m.group(2)), "ano": int(m.group(3)),
             "numero_controle_pncp": ln["codigo_externo"], "title": ln.get("numero_edital")}
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
                    help="leads (padrão): homologados nos últimos --dias; monitorar: abertos; historico: encerrados")
    ap.add_argument("--dias", type=int, default=120, help="leads: janela da homologação (dias)")
    ap.add_argument("--margem-publicacao", type=int, default=240,
                    help="leads: ignora editais publicados há mais de dias+margem (padrão 240)")
    ap.add_argument("--termos", help="lista separada por vírgula (padrão: TERMOS_PADRAO)")
    ap.add_argument("--todos-termos", action="store_true", help="usa também todos os TERMOS_BUSCA do escopo")
    ap.add_argument("--status", choices=["todos", "recebendo_proposta", "em_julgamento", "encerradas"],
                    help="sobrescreve o status do modo")
    ap.add_argument("--paginas", type=int, help="páginas por termo (padrão: leads 20, outros 3)")
    ap.add_argument("--tam", type=int, default=50, help="resultados por página")
    ap.add_argument("--sem-resultados", action="store_true", help="não consulta vencedores (ignorado em leads)")
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
        arm = Armazenamento(env("GCS_BUCKET"))
    status = args.status or MODOS[args.modo]["status"]
    paginas = args.paginas or (20 if args.modo == "leads" else 3)
    log.info("modo=%s status=%s dias=%s termos=%s", args.modo, status, args.dias, len(termos))
    r = coletar(PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5"))), sb, arm, termos, status, paginas,
                args.tam, not args.sem_resultados, args.baixar_arquivos,
                int(float(env("MAX_MB", "80")) * 1048576), args.dry_run,
                modo=args.modo, dias=args.dias, margem_publicacao=args.margem_publicacao,
                workers=int(env("PNCP_WORKERS", "3")))
    log.info("RESUMO: %s", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

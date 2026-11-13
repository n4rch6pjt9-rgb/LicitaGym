"""Consumidor da fila de preparação da Triagem (spec 0018, PR 4b; decisão 12).

Quando uma licitação entra na etapa Triagem do pipeline de uma empresa, o banco enfileira um pedido 'preparar_triagem'
em private.job_queue (migration 20261011160000). Este módulo pega os pedidos (public.fila_preparacao_reivindicar) e,
para cada um:
  1. fonte PNCP: consulta o detalhe da compra e grava amparo_legal (o banco deriva o regulamento; spec 0020);
     lista os documentos da compra (/arquivos), grava em licitacao_documentos e baixa os pendentes;
     outras fontes (ou fonte nula): pula o PNCP e usa os documentos que já existem;
  2. indexa os documentos baixados da licitação (licitacao_chunks; mesmo caminho do indexador). Documento já indexado
     (por outra empresa com a mesma licitação, por exemplo) não é refeito. Documento em 'erro' (do coletor diário ou de
     rodada anterior) é tentado de novo, como no pncp._processar: erro não vira "sem documento";
  3. chama public.pipeline_tarefas_reaplicar (tarefas da lei que dependiam do regulamento);
  4. conclui o pedido com o desfecho: ok | sem_documento | regulamento_nao_informado_pela_fonte.
Falha técnica (PNCP fora do ar, storage, Gemini) não vira desfecho: o pedido volta para a fila com espera crescente
(public.fila_preparacao_concluir com erro). Os agentes NÃO rodam aqui: rodam sob demanda, quando alguém abre a análise.
O erro gravado no pedido vai para o card (api-pipeline): só etapa e categoria (ex.: "download: HTTP 504"), nunca URL,
corpo HTTP ou caminho do storage; o detalhe fica no log do job. Timeout do Cloud Run Job abaixo de 1 h (o banco devolve
à fila o pedido em processing há mais de 1 h).

Uso (Cloud Run Job do coletor, a cada 15 min):
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.preparar_triagem --limite 5
DELAY_SEGUNDOS >= 1 entre chamadas ao PNCP (cliente do coletor, com backoff e Retry-After).
"""
from __future__ import annotations

import argparse
import contextlib
import logging
import re
import sys
from datetime import datetime, timezone

from .destino import Armazenamento, Supabase, env, parece_html, sha256
from .ia import erro_de_configuracao
from .indexador import escolher_canonico, indexar_grupo
from .pncp import (
    PNCP, _compra_slug, _data, _falha_definitiva, _marcar_documentos_removidos, amparo_legal_detalhe,
    compra_de_codigo, consultar_detalhe, tipo_arquivo,
)

log = logging.getLogger("coletor.preparar_triagem")

RESULTADOS = ("ok", "sem_documento", "regulamento_nao_informado_pela_fonte")
HTTP_TRANSITORIO = {408, 429, 500, 502, 503, 504}
_STORAGE_STATUS = re.compile(r"^Supabase Storage [^\n]*?: (\d{3}) ")


def _status_storage(e: BaseException) -> int | None:
    """Status HTTP do RuntimeError de destino.SupabaseStorage.salvar ('Supabase Storage <caminho>: 413 ...')."""
    m = _STORAGE_STATUS.match(str(e)) if isinstance(e, RuntimeError) else None
    return int(m.group(1)) if m else None


def definitiva(e: BaseException) -> bool:
    """Falha de download/gravação que não melhora com nova tentativa: a do pncp._falha_definitiva e, no Storage,
    4xx fora de 408/429 (ex.: 413, arquivo acima do file_size_limit do bucket)."""
    st = _status_storage(e)
    if st is not None:
        return 400 <= st < 500 and st not in HTTP_TRANSITORIO
    return _falha_definitiva(e)
CAMPOS_LIC = "id,fonte,codigo_externo,regulamento,orgao_cnpj,raw,numero_processo,numero_edital,entidade,orgao_nome"
CAMPOS_DOC = "id,licitacao_id,secao,nome_original,arquivo_origem,fornecedor_nome,sha256,storage_uri,status_processamento,raw"


class FalhaPreparacao(RuntimeError):
    """Falha técnica numa etapa da preparação. str() é o texto curto que vai para o card."""

    def __init__(self, etapa: str, causa: BaseException):
        super().__init__(f"{etapa}: {categoria(causa)}")
        self.etapa, self.causa = etapa, causa


def _cadeia(e: BaseException, limite: int = 4):
    """A exceção e as causas dela (ConsultaFalhou embrulha o HTTPError do PNCP)."""
    while e is not None and limite > 0:
        yield e
        e, limite = e.__cause__ or e.__context__, limite - 1


def _status_http(e: BaseException) -> int | None:
    for x in _cadeia(e):
        resp = getattr(x, "response", None)
        status = getattr(resp, "status_code", None) or getattr(x, "status_code", None) or getattr(x, "code", None)
        if isinstance(status, int) and 100 <= status <= 599:
            return status
    return None


def categoria(e: BaseException) -> str:
    """Categoria curta e sem dado sensível: status HTTP, timeout, conexão ou o nome da exceção (nunca a mensagem)."""
    status = _status_http(e)
    if status is not None:
        return f"HTTP {status}"
    for x in _cadeia(e):
        nome = type(x).__name__
        if "Timeout" in nome or "DeadlineExceeded" in nome:
            return "timeout"
        if "Connection" in nome:
            return "falha de conexão"
    return type(e).__name__


def transitoria(e: BaseException) -> bool:
    """Falha que melhora com nova tentativa: 408/429/5xx, timeout, conexão, Supabase (banco/storage)."""
    if _status_http(e) in HTTP_TRANSITORIO:
        return True
    for x in _cadeia(e):
        nome = type(x).__name__
        if any(k in nome for k in ("Timeout", "Connection", "DeadlineExceeded", "ServiceUnavailable", "ServerError",
                                   "ResourceExhausted")):
            return True
        if isinstance(x, RuntimeError) and str(x).startswith("Supabase"):
            st = _status_storage(x)
            return st is None or not (400 <= st < 500) or st in HTTP_TRANSITORIO
    return False


@contextlib.contextmanager
def etapa(nome: str):
    try:
        yield
    except FalhaPreparacao:
        raise
    except Exception as e:
        log.warning("  %s falhou: %s", nome, str(e)[:300])   # detalhe só no log do job
        raise FalhaPreparacao(nome, e) from e


def _documentos_pncp(pncp, sb, c: dict, lic_id: int) -> None:
    """Lista os documentos ativos da compra no PNCP e grava em licitacao_documentos (mesmo formato de pncp._processar)."""
    arquivos = pncp.arquivos(c)
    visto_em = datetime.now(timezone.utc).isoformat()
    docs = [{
        "licitacao_id": lic_id, "secao": "processo",
        "nome_original": a.get("titulo"), "arquivo_origem": f"pncp-{a.get('sequencialDocumento')}",
        "data_documento": _data(a.get("dataPublicacaoPncp")),
        "raw": {"tipo_documento": a.get("tipoDocumentoNome"), "url": a.get("url") or a.get("uri")},
        "last_seen_at": visto_em, "removido_do_portal_em": None,
    } for a in arquivos if a.get("statusAtivo", True)]
    _marcar_documentos_removidos(sb, lic_id, {d["arquivo_origem"] for d in docs}, visto_em, {})
    if docs:
        sb.upsert("licitacao_documentos", docs, "licitacao_id,secao,arquivo_origem")


def _baixar(pncp, sb, arm, lic: dict, max_bytes: int) -> dict:
    """Baixa os documentos pendentes ou com erro de download (sem sha256) da licitação, como o pncp._processar.
    Falha definitiva (HTML, acima do limite, 4xx) marca o documento como erro e segue; falha transitória levanta
    (o pedido volta). Erro de indexação (com sha256) fica para o _indexar."""
    r = {"baixados": 0, "erros": 0}
    pendentes = sb.selecionar("licitacao_documentos", licitacao_id=f"eq.{lic['id']}",
                              status_processamento="in.(pendente,erro)", sha256="is.null",
                              removido_do_portal_em="is.null", order="id", select=CAMPOS_DOC)
    for d in pendentes:
        url = (d.get("raw") or {}).get("url")
        try:
            conteudo, ctype = pncp.baixar(url, max_bytes)
            if parece_html(conteudo, ctype):
                raise ValueError("PNCP devolveu HTML em vez do arquivo")
            ext, mime = tipo_arquivo(conteudo, d.get("nome_original"), ctype)
            caminho = arm.caminho("pncp", 0, _compra_slug(lic), d.get("secao") or "processo", f"{d['arquivo_origem']}.{ext}")
            uri = arm.salvar(caminho, conteudo, mime)
            sb.atualizar("licitacao_documentos", d["id"], {
                "storage_uri": uri, "mime_type": mime, "tamanho_bytes": len(conteudo), "sha256": sha256(conteudo),
                "baixado_em": datetime.now(timezone.utc).isoformat(), "status_processamento": "baixado", "erro": None})
            r["baixados"] += 1
        except Exception as e:
            definitivo = definitiva(e)
            r["erros"] += 1
            log.warning("  doc #%s falha %s ao baixar: %s", d["id"], "definitiva" if definitivo else "transitória",
                        str(e)[:120])
            # transitório: só a categoria (a mensagem pode ter caminho do storage ou corpo HTTP; detalhe no log)
            sb.atualizar("licitacao_documentos", d["id"], {
                "status_processamento": "erro" if definitivo else "pendente",
                "erro": str(e)[:300] if definitivo else categoria(e)})
            if not definitivo:
                raise   # transitório: o pedido volta para a fila em vez de concluir sem o documento
    return r


def _indexar(sb, ia_factory, lic: dict) -> int:
    """Indexa os documentos baixados (ou com erro de indexação anterior) da licitação, um grupo por sha256, como o
    indexador.main: grupo com falha determinística (arquivo corrompido, saída inválida) fica 'erro' e os outros
    seguem; falha transitória (Gemini 429/5xx, storage) levanta e o pedido volta. Devolve quantos foram indexados."""
    docs = sb.selecionar("licitacao_documentos", licitacao_id=f"eq.{lic['id']}",
                         status_processamento="in.(baixado,erro)", sha256="not.is.null", storage_uri="not.is.null",
                         removido_do_portal_em="is.null", order="id", select=CAMPOS_DOC)
    if not docs:
        return 0
    ia = ia_factory()
    grupos: dict[str, list[dict]] = {}
    for d in docs:
        grupos.setdefault(d["sha256"], []).append(d)
    n = 0
    for grupo in grupos.values():
        d0 = escolher_canonico(grupo)
        try:
            r = indexar_grupo(sb, ia, grupo, lic, True)
        except Exception as e:
            # Gemini sem o modelo ou sem permissão (troca para o 3.8 no endpoint global, 22/10): falha a etapa, à vista
            # no card, em vez de marcar todos os documentos como erro e concluir "sem documento".
            if transitoria(e) or erro_de_configuracao(e):
                raise
            log.warning("  ERRO na indexação | %s | %s", (d0.get("nome_original") or "")[:60], str(e)[:200])
            for d in grupo:
                sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "erro", "erro": str(e)[:500]})
            continue
        if r["status"] == "ignorado":
            for d in grupo:
                campos = {"status_processamento": "ignorado", "erro": r["erro"]}
                if r.get("extracao"):
                    campos["extracao"] = r["extracao"]
                sb.atualizar("licitacao_documentos", d["id"], campos)
            log.info("  ignorado | %s | %s", (d0.get("nome_original") or "")[:60], r["erro"][:80])
        else:
            n += 1
    return n


def preparar(pedido: dict, pncp, sb, arm, ia_factory, max_bytes: int = 80 * 1048576) -> str:
    """Prepara uma licitação e devolve o desfecho (um de RESULTADOS). Falha técnica levanta FalhaPreparacao."""
    lic_id, tenant = int(pedido["licitacao_id"]), int(pedido["tenant_id"])
    with etapa("leitura da licitação"):
        linhas = sb.selecionar("licitacoes_externas", id=f"eq.{lic_id}", select=CAMPOS_LIC)
        if not linhas:
            raise LookupError("licitação não encontrada")
    lic = linhas[0]

    # fonte nula ou desconhecida nunca é tratada como PNCP: usa só os documentos que já existem
    if lic.get("fonte") == "pncp":
        with etapa("detalhe PNCP"):
            c = compra_de_codigo(lic.get("codigo_externo"))
            if not c:
                raise ValueError("código PNCP inválido")
            amparo = amparo_legal_detalhe(consultar_detalhe(pncp, c))
            if amparo is not None:
                sb.atualizar("licitacoes_externas", lic_id, {"amparo_legal": amparo})
        with etapa("documentos PNCP"):
            _documentos_pncp(pncp, sb, c, lic_id)
        with etapa("download"):
            if not getattr(arm, "dentro_do_saas", False):
                raise RuntimeError("armazenamento fora do SaaS (disco do container se perde)")
            _baixar(pncp, sb, arm, lic, max_bytes)

    with etapa("indexação"):
        _indexar(sb, ia_factory, lic)
    with etapa("tarefas"):
        sb.rpc("pipeline_tarefas_reaplicar", {"p_tenant": tenant, "p_licitacao": lic_id, "p_user": None})

    with etapa("desfecho"):
        # documento retirado do portal não conta (o agente lê só os ativos)
        indexados = sb.selecionar("licitacao_documentos", licitacao_id=f"eq.{lic_id}",
                                  status_processamento="eq.indexado", removido_do_portal_em="is.null", select="id")
        if not indexados:
            return "sem_documento"
        if lic.get("fonte") == "pncp":
            atual = sb.selecionar("licitacoes_externas", id=f"eq.{lic_id}", select="regulamento")
            if not atual or atual[0].get("regulamento") is None:
                return "regulamento_nao_informado_pela_fonte"
    return "ok"


def _concluir(sb, pedido: dict, resultado: str | None, erro: str | None) -> bool:
    """Grava o desfecho da tentativa deste job (p_tentativa). Pedido que já não está nesta tentativa (devolvido à fila
    após 1 h e pego por outro job: P0002) não derruba o lote: fica com o outro job. Outra falha do banco sobe (o pedido volta à fila em 1 h)."""
    try:
        sb.rpc("fila_preparacao_concluir", {"p_id": pedido["id"], "p_resultado": resultado, "p_erro": erro,
                                            "p_tentativa": pedido.get("tentativa")})
        return True
    except RuntimeError as e:
        if "P0002" in str(e):
            log.warning("pedido %s já não está em processamento (outro job): desfecho descartado", pedido.get("id"))
            return False
        raise


def consumir(pncp, sb, arm, ia_factory, limite: int = 5, max_bytes: int = 80 * 1048576) -> dict:
    """Processa até `limite` pedidos, reivindicando um de cada vez (pedido só fica 'processing' enquanto é
    trabalhado: se o job estourar o tempo, os que não começaram continuam 'pending', sem gastar tentativa).
    Conclui cada um (desfecho ou erro); um pedido que falha não para os outros."""
    resumo = {"pedidos": 0, "concluidos": 0, "reagendados": 0, "perdidos": 0, "por_resultado": {}}
    for _ in range(limite):
        lote = sb.rpc("fila_preparacao_reivindicar", {"p_limite": 1}) or []
        if not lote:
            break
        pedido = lote[0]
        resumo["pedidos"] += 1
        try:
            resultado, erro = preparar(pedido, pncp, sb, arm, ia_factory, max_bytes), None
        except FalhaPreparacao as e:
            resultado, erro = None, str(e)
        except Exception as e:   # erro de programação: o card recebe só a categoria; o detalhe vai para o log
            log.exception("pedido %s (licitação %s): erro inesperado", pedido.get("id"), pedido.get("licitacao_id"))
            resultado, erro = None, f"erro interno: {type(e).__name__}"
        if not _concluir(sb, pedido, resultado, erro):
            resumo["perdidos"] += 1
            continue
        if resultado is None:
            resumo["reagendados"] += 1
            log.warning("pedido %s (licitação %s) falhou: %s", pedido.get("id"), pedido.get("licitacao_id"), erro)
        else:
            resumo["concluidos"] += 1
            resumo["por_resultado"][resultado] = resumo["por_resultado"].get(resultado, 0) + 1
            log.info("pedido %s (licitação %s): %s", pedido.get("id"), pedido.get("licitacao_id"), resultado)
    return resumo


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Consome a fila de preparação da Triagem (spec 0018)")
    ap.add_argument("--limite", type=int, default=5, help="pedidos por execução (1 a 50; padrão 5)")
    ap.add_argument("--max-mb", type=int, default=int(env("MAX_MB", "80")), help="tamanho máximo por arquivo")
    args = ap.parse_args(argv)
    if not 1 <= args.limite <= 50:
        ap.error("--limite precisa ser de 1 a 50")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    delay = float(env("DELAY_SEGUNDOS", "1.0"))
    if delay < 1:
        raise SystemExit("DELAY_SEGUNDOS precisa ser >= 1 (respeito ao PNCP).")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    arm = Armazenamento.do_ambiente()
    if not arm.dentro_do_saas:
        raise SystemExit("Defina SUPABASE_STORAGE_BUCKET (ou GCS_BUCKET): no Cloud Run o disco local se perde.")

    def ia_factory():
        from .ia import Gemini
        return Gemini()

    resumo = consumir(PNCP(delay=delay), sb, arm, ia_factory, args.limite, args.max_mb * 1048576)
    log.info("RESUMO: %s", resumo)
    return 0


if __name__ == "__main__":
    sys.exit(main())

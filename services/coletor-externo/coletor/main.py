"""Coletor SEST SENAT -> Supabase + Cloud Storage.

Uso (piloto em 5 processos, sem gravar nada, só listar):
    python -m coletor.main --ids 1,10,30,41,81 --dry-run

Uso (Cloud Run Job, varre IDs 1..120 e grava tudo):
    python -m coletor.main --de 1 --ate 120

Variáveis de ambiente:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (obrigatórias fora do --dry-run)
    GCS_BUCKET                                (opcional; sem ela salva em ./dados)
    SECOES_DOWNLOAD   seções cujos arquivos são baixados (padrão abaixo)
    DELAY_SEGUNDOS    pausa entre requisições ao portal (padrão 1.5)
    MAX_MB            ignora arquivos maiores que isso (padrão 80)
"""
from __future__ import annotations

import argparse
import logging
import sys

from .destino import Armazenamento, Supabase, env, parece_html, sha256
from .portal import (SECOES_CONTRATACAO, ArquivoGrande, PortalSestSenat, encerrado, no_escopo_fitness,
                     processo_para_linha)

log = logging.getLogger("coletor")

# Alto valor para o RAG e baixo volume. Proposta/lance/negociação/habilitação geram
# centenas de arquivos por processo (certidões, atestados) — os metadados são sempre
# registrados, mas o download fica desligado até o piloto medir custo e utilidade.
SECOES_DOWNLOAD_PADRAO = "processo,recurso,contrarrazoes,parecer"


def coletar_processo(portal: PortalSestSenat, sb: Supabase | None, arm: Armazenamento | None,
                     id_proc: int, modulo: int, secoes_download: set[str], max_bytes: int,
                     somente_encerrados: bool, dry_run: bool, escopo: str = "fitness") -> dict:
    resumo = {"id": id_proc, "status": "", "docs": 0, "baixados": 0, "erros": 0}
    d = portal.detalhes(id_proc, modulo)
    if not d or not d.get("nCdProcesso"):
        resumo["status"] = "inexistente"
        return resumo
    if escopo == "fitness" and not no_escopo_fitness(d):
        resumo["status"] = f"fora do escopo ({(d.get('sDsObjeto') or '').strip()[:60]})"
        return resumo
    if somente_encerrados and not encerrado(d):
        resumo["status"] = f"ignorado ({d.get('sDsSituacao')})"
        return resumo

    linha = processo_para_linha(d, modulo)
    linha["esclarecimentos"] = portal.esclarecimentos(id_proc, modulo)
    linha["notas"] = portal.notas(id_proc, d.get("nCdEdital"), modulo)

    anexo_raiz = d.get("nCdAnexo")
    arquivos = portal.anexos_processo(anexo_raiz) if anexo_raiz else []
    coleta_incompleta = False
    for secao in SECOES_CONTRATACAO:
        try:
            arquivos += portal.anexos_secao(secao, anexo_raiz, id_proc, modulo)
        except Exception as e:  # uma seção com erro não derruba o processo
            coleta_incompleta = True
            log.warning("proc %s seção %s: %s", id_proc, secao, e)

    resumo["docs"] = len(arquivos)
    por_secao: dict[str, int] = {}
    for a in arquivos:
        por_secao[a.secao] = por_secao.get(a.secao, 0) + 1
    resumo["por_secao"] = por_secao
    resumo["status"] = f"{d.get('sNrProcesso')} | {d.get('sDsSituacao')}"

    if dry_run:
        return resumo

    lic = sb.upsert("licitacoes_externas", linha, "fonte,modulo,id_externo")[0]
    lic_id = lic["id"]

    linhas_docs = [{
        "licitacao_id": lic_id, "secao": a.secao, "nome_original": a.nome_original,
        "arquivo_origem": a.arquivo_origem, "itens_lote": a.itens_lote or None,
        "fornecedor_nome": a.fornecedor_nome, "fornecedor_cnpj": a.fornecedor_cnpj,
        "data_documento": a.data_documento, "raw": a.raw,
    } for a in arquivos]
    salvos = []
    for i in range(0, len(linhas_docs), 200):
        salvos += sb.upsert("licitacao_documentos", linhas_docs[i:i + 200], "licitacao_id,secao,arquivo_origem")
    ids = {(s["secao"], s["arquivo_origem"]): s for s in salvos}
    # Remove linhas pendentes de execuções antigas que não correspondem mais a nenhum documento
    if coleta_incompleta:
        log.warning("proc %s: coleta incompleta; limpeza de pendentes ignorada", id_proc)
    else:
        sb.remover_pendentes_exceto(lic_id, [s["id"] for s in salvos])

    fila = [a for a in arquivos if a.secao in secoes_download and a.parametro_download
            and ids.get((a.secao, a.arquivo_origem), {}).get("status_processamento") in ("pendente", "erro")]
    log.info("proc %s %s: %s documentos registrados, %s arquivos para baixar",
             id_proc, d.get("sNrProcesso"), len(arquivos), len(fila))
    ja_salvos: dict[str, str] = {}  # sha256 -> uri (mesmo arquivo em seções diferentes)

    for n, a in enumerate(fila, 1):
        doc = ids[(a.secao, a.arquivo_origem)]
        try:
            conteudo, ctype = portal.baixar(a.parametro_download, max_bytes)
            if parece_html(conteudo, ctype):
                raise RuntimeError("portal devolveu HTML em vez do arquivo")
            h = sha256(conteudo)
            uri = ja_salvos.get(h)
            if not uri:
                caminho = arm.caminho("sestsenat", modulo, id_proc, a.secao, a.arquivo_origem)
                uri = arm.salvar(caminho, conteudo, ctype)
                ja_salvos[h] = uri
            sb.atualizar("licitacao_documentos", doc["id"], {
                "storage_uri": uri, "mime_type": ctype, "tamanho_bytes": len(conteudo),
                "sha256": h, "status_processamento": "baixado", "erro": None})
            resumo["baixados"] += 1
            log.info("  [%s/%s] %s | %s (%.1f MB)", n, len(fila), a.secao,
                     a.nome_original[:70], len(conteudo) / 1048576)
        except ArquivoGrande as e:
            log.info("  [%s/%s] %s | %s: ignorado (%s)", n, len(fila), a.secao, a.nome_original[:70], e)
            sb.atualizar("licitacao_documentos", doc["id"], {
                "status_processamento": "ignorado", "erro": str(e)})
        except Exception as e:
            resumo["erros"] += 1
            log.warning("proc %s arquivo %s: %s", id_proc, a.nome_original, e)
            sb.atualizar("licitacao_documentos", doc["id"], {
                "status_processamento": "erro", "erro": str(e)[:500]})
    resumo["coleta_incompleta"] = coleta_incompleta
    return resumo


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Coletor de licitações do portal SEST SENAT")
    ap.add_argument("--ids", help="lista de nCdProcesso separados por vírgula")
    ap.add_argument("--de", type=int, default=1)
    ap.add_argument("--ate", type=int, default=120)
    ap.add_argument("--modulo", type=int, default=59, help="59 = pregão eletrônico")
    ap.add_argument("--todos", action="store_true", help="inclui processos ainda em andamento")
    ap.add_argument("--escopo", default="fitness", choices=["fitness", "tudo"],
                    help="fitness (padrão) = só academia/esporte; tudo = qualquer objeto")
    ap.add_argument("--parar-apos-vazios", type=int, default=15,
                    help="encerra a varredura após N IDs inexistentes seguidos")
    ap.add_argument("--dry-run", action="store_true", help="só consulta o portal; não grava nada")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    secoes = {s.strip() for s in (env("SECOES_DOWNLOAD", SECOES_DOWNLOAD_PADRAO) or "").split(",") if s.strip()}
    max_bytes = int(float(env("MAX_MB", "80")) * 1024 * 1024)
    portal = PortalSestSenat(delay=float(env("DELAY_SEGUNDOS", "1.5")))

    sb = arm = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        arm = Armazenamento(env("GCS_BUCKET"))

    ids = [int(x) for x in args.ids.split(",")] if args.ids else list(range(args.de, args.ate + 1))
    vazios = 0
    falhas_operacionais = 0
    for id_proc in ids:
        try:
            r = coletar_processo(portal, sb, arm, id_proc, args.modulo, secoes, max_bytes,
                                 somente_encerrados=not args.todos, dry_run=args.dry_run, escopo=args.escopo)
        except Exception as e:
            log.error("proc %s falhou: %s", id_proc, e)
            falhas_operacionais += 1
            continue
        log.info("proc %s -> %s", id_proc, r)
        if r.get("coleta_incompleta") or r.get("erros"):
            falhas_operacionais += 1
        vazios = vazios + 1 if r["status"] == "inexistente" else 0
        if not args.ids and vazios >= args.parar_apos_vazios:
            log.info("%s IDs vazios seguidos; fim da varredura.", vazios)
            break
    return 1 if falhas_operacionais else 0


if __name__ == "__main__":
    sys.exit(main())

"""Indexador: arquivos baixados -> texto -> campos estruturados (Gemini) -> embeddings -> licitacao_chunks.

    python -m coletor.indexador                 # processa tudo que está 'baixado'
    python -m coletor.indexador --limite 5      # só 5 arquivos únicos (teste)
    python -m coletor.indexador --sem-extracao  # só embeddings, sem o resumo/JSON do Gemini

Cada arquivo físico (sha256) é processado UMA vez; as cópias recebem o mesmo resultado.
"""
from __future__ import annotations

import argparse
import logging
import re
import sys
from pathlib import Path

from .destino import Supabase, env
from .textos import Pagina, dividir, extrair, limpar_texto

log = logging.getLogger("indexador")

# Quando o mesmo arquivo aparece em várias seções, fica com a mais específica
PRIORIDADE = ["parecer", "recurso", "contrarrazoes", "habilitacao", "negociacao",
              "lance", "proposta", "processo"]


def ler_arquivo(uri: str) -> bytes:
    if uri.startswith("gs://"):
        from google.cloud import storage
        bucket, _, caminho = uri[5:].partition("/")
        return storage.Client().bucket(bucket).blob(caminho).download_as_bytes()
    return Path(uri).read_bytes()


OCR_PAGINAS = int(env("OCR_PAGINAS", "8") or 8)


def partes_pdf(pdf: bytes, n: int) -> list[tuple[int, bytes]]:
    """Divide um PDF em pedaços de n páginas (OCR de documento inteiro estoura tempo/saída)."""
    import io
    from pypdf import PdfReader, PdfWriter
    try:
        leitor = PdfReader(io.BytesIO(pdf))
        total = len(leitor.pages)
    except Exception:
        return [(0, pdf)]
    if total <= n:
        return [(0, pdf)]
    partes = []
    for ini in range(0, total, n):
        w = PdfWriter()
        for i in range(ini, min(ini + n, total)):
            w.add_page(leitor.pages[i])
        buf = io.BytesIO()
        w.write(buf)
        partes.append((ini, buf.getvalue()))
    return partes


def paginas_do_ocr(texto: str, origem: str) -> list[Pagina]:
    partes = re.split(r"\[\[P[ÁA]GINA\s*(\d+)\]\]", texto)
    if len(partes) == 1:
        return [Pagina(origem, None, texto)]
    out = []
    for i in range(1, len(partes), 2):
        out.append(Pagina(origem, int(partes[i]), partes[i + 1]))
    return out


def escolher_canonico(docs: list[dict]) -> dict:
    return sorted(docs, key=lambda d: (PRIORIDADE.index(d["secao"]) if d["secao"] in PRIORIDADE else 99, d["id"]))[0]


def vetor_pg(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


def indexar_grupo(sb: Supabase, ia, docs: list[dict], lic: dict, com_extracao: bool) -> dict:
    doc = escolher_canonico(docs)
    nome, secao = doc["nome_original"] or doc["arquivo_origem"], doc["secao"]
    processo = f"{lic.get('numero_edital') or ''} ({lic['numero_processo']})".strip()

    conteudo = ler_arquivo(doc["storage_uri"])
    res = extrair(conteudo, nome)
    paginas = list(res.paginas)
    for origem, pdf in res.pdfs_escaneados:
        for inicio, parte in partes_pdf(pdf, OCR_PAGINAS):
            if len(parte) > 19 * 1024 * 1024:
                res.ignorados.append(f"{origem} (págs. {inicio + 1}+ escaneadas > 19 MB)")
                continue
            log.info("    OCR com Gemini: %s (a partir da pág. %s)", origem, inicio + 1)
            for p in paginas_do_ocr(ia.ocr_pdf(parte), origem):
                p.numero = (p.numero or 1) + inicio
                paginas.append(p)

    texto_total = limpar_texto("\n".join(p.texto for p in paginas))
    if len(texto_total) < 50:
        return {"status": "ignorado", "erro": f"sem texto aproveitável; ignorados: {res.ignorados[:5]}"}

    extracao = {}
    if com_extracao:
        log.info("    %s: %s caracteres -> ficha com Gemini", nome[:60], len(texto_total))
        extracao = ia.extrair_campos(texto_total, nome, secao, processo)
    tipo = extracao.get("tipo_documento") or secao
    fornecedor = f" — {doc['fornecedor_nome']}" if doc.get("fornecedor_nome") else ""
    cabecalho = f"SEST SENAT {processo} — {tipo.replace('_', ' ').upper()}{fornecedor} — {nome}"

    trechos = dividir(paginas, cabecalho)
    if extracao.get("resumo"):
        trechos.insert(0, {"texto": f"{cabecalho} — RESUMO\n\n{extracao['resumo']}", "pagina": None, "origem": nome})
    log.info("    %s: %s trechos -> embeddings", nome[:60], len(trechos))
    vetores = ia.embed([t["texto"] for t in trechos])

    sb.remover_chunks(doc["id"])
    linhas = [{
        "documento_id": doc["id"], "licitacao_id": doc["licitacao_id"], "secao": secao,
        "ordem": i, "pagina": t["pagina"], "texto": t["texto"], "embedding": vetor_pg(v),
        "metadados": {"tipo_documento": tipo, "origem": t["origem"], "numero_processo": lic["numero_processo"],
                      "numero_edital": lic.get("numero_edital"), "fornecedor": doc.get("fornecedor_nome"),
                      "chunk_kind": "resumo" if (i == 0 and extracao.get("resumo")) else "trecho"},
    } for i, (t, v) in enumerate(zip(trechos, vetores))]
    for i in range(0, len(linhas), 100):
        sb.upsert("licitacao_chunks", linhas[i:i + 100], "documento_id,ordem")

    if res.ignorados:
        extracao["arquivos_ignorados"] = res.ignorados[:50]
    sb.atualizar("licitacao_documentos", doc["id"], {"status_processamento": "indexado", "extracao": extracao, "erro": None})
    for copia in docs:
        if copia["id"] != doc["id"]:
            sb.atualizar("licitacao_documentos", copia["id"], {
                "status_processamento": "indexado", "erro": None,
                "extracao": {**extracao, "copia_de_documento_id": doc["id"]}})
    return {"status": "indexado", "trechos": len(linhas), "tipo": tipo, "doc": doc["id"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Indexa documentos baixados no RAG (licitacao_chunks)")
    ap.add_argument("--limite", type=int, default=0, help="máximo de arquivos únicos nesta execução")
    ap.add_argument("--sem-extracao", action="store_true", help="não gera resumo/JSON estruturado")
    ap.add_argument("--reprocessar-erros", action="store_true")
    ap.add_argument("--refazer", action="store_true",
                    help="reindexa também o que já foi indexado (ex.: após trocar EMBED_MODEL)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for ruidoso in ("httpx", "google_genai", "google_genai.models"):
        logging.getLogger(ruidoso).setLevel(logging.WARNING)

    from .ia import Gemini
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    ia = Gemini()

    status = ("in.(baixado,erro,indexado)" if args.refazer
              else "in.(baixado,erro)" if args.reprocessar_erros else "eq.baixado")
    docs = sb.selecionar("licitacao_documentos", status_processamento=status, sha256="not.is.null",
                         storage_uri="not.is.null", order="id",
                         select="id,licitacao_id,secao,nome_original,arquivo_origem,fornecedor_nome,sha256,storage_uri")
    lics = {l["id"]: l for l in sb.selecionar("licitacoes_externas", select="id,numero_processo,numero_edital")}

    grupos: dict[tuple, list[dict]] = {}
    for d in docs:
        grupos.setdefault((d["licitacao_id"], d["sha256"]), []).append(d)
    fila = list(grupos.values())[: args.limite or None]
    log.info("%s registros baixados -> %s arquivos únicos para indexar", len(docs), len(fila))

    ok = erros = 0
    for n, grupo in enumerate(fila, 1):
        d0 = escolher_canonico(grupo)
        try:
            r = indexar_grupo(sb, ia, grupo, lics[d0["licitacao_id"]], not args.sem_extracao)
            if r["status"] == "ignorado":
                for d in grupo:
                    sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "ignorado", "erro": r["erro"]})
                log.info("[%s/%s] ignorado | %s | %s", n, len(fila), d0["nome_original"][:60], r["erro"][:80])
            else:
                ok += 1
                log.info("[%s/%s] %s trechos | %s | %s (+%s cópias)", n, len(fila), r["trechos"],
                         r["tipo"], d0["nome_original"][:60], len(grupo) - 1)
        except Exception as e:
            erros += 1
            log.warning("[%s/%s] ERRO %s: %s", n, len(fila), d0["nome_original"][:60], e)
            for d in grupo:
                sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "erro", "erro": str(e)[:500]})
    log.info("Fim: %s indexados, %s erros.", ok, erros)
    return 0


if __name__ == "__main__":
    sys.exit(main())

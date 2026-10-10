"""Indexador: arquivos baixados -> texto -> campos estruturados (Gemini) -> embeddings -> licitacao_chunks.

    python -m coletor.indexador                 # processa tudo que está 'baixado'
    python -m coletor.indexador --limite 5      # só 5 arquivos únicos (teste)
    python -m coletor.indexador --sem-extracao  # só embeddings, sem o resumo/JSON do Gemini

Cada arquivo físico (sha256) é processado UMA vez; as cópias recebem o mesmo resultado.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from . import ia as ia_mod
from .destino import Supabase, env
from .ocr import EXTRAIDO, OCR_DEGENERADO, Limiar, avaliar_pagina
from .textos import Pagina, dividir, extrair, limpar_texto

log = logging.getLogger("indexador")

# Quando o mesmo arquivo aparece em várias seções, fica com a mais específica
PRIORIDADE = ["parecer", "recurso", "contrarrazoes", "habilitacao", "negociacao",
              "lance", "proposta", "processo"]


def ler_arquivo(uri: str) -> bytes:
    if uri.startswith("supabase://"):
        from .destino import SupabaseStorage
        bucket = uri.removeprefix("supabase://").split("/", 1)[0]
        return SupabaseStorage(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True),
                               bucket).ler(uri)
    if uri.startswith("gs://"):
        from google.cloud import storage
        bucket, _, caminho = uri[5:].partition("/")
        return storage.Client().bucket(bucket).blob(caminho).download_as_bytes()
    return Path(uri).read_bytes()


def paginas_pdf(pdf: bytes) -> list[tuple[int | None, bytes]]:
    """Separa o PDF escaneado em PDFs de UMA página, com o número da página (1-based). OCR do documento inteiro
    perdeu o vínculo com a página e degenerou (medição de 09/10/2026, spec 0016). Se o pypdf não abre o
    arquivo, devolve o PDF inteiro sem número de página."""
    import io
    from pypdf import PdfReader, PdfWriter
    try:
        leitor = PdfReader(io.BytesIO(pdf))
        total = len(leitor.pages)
    except Exception:
        return [(None, pdf)]
    if total <= 1:
        return [(1, pdf)]
    out = []
    for i in range(total):
        w = PdfWriter()
        w.add_page(leitor.pages[i])
        buf = io.BytesIO()
        w.write(buf)
        out.append((i + 1, buf.getvalue()))
    return out


def ocr_escaneados(ia, pdfs_escaneados: list[tuple[str, bytes]], ignorados: list[str],
                   limiar: Limiar | None = None) -> tuple[list[Pagina], list[dict]]:
    """OCR página a página. Só página `extraido` vira Pagina (e depois chunk); `OCR_DEGENERADO` e `OCR_REQUIRED`
    ficam no relatório por página, sem texto."""
    lim = limiar or Limiar.do_ambiente()
    paginas: list[Pagina] = []
    relatorio: list[dict] = []
    for origem, pdf in pdfs_escaneados:
        for numero, parte in paginas_pdf(pdf):
            rotulo = f"pág. {numero}" if numero else "documento inteiro"
            if len(parte) > 19 * 1024 * 1024:
                ignorados.append(f"{origem} ({rotulo} escaneada > 19 MB)")
                continue
            log.info("    OCR com Gemini: %s (%s)", origem, rotulo)
            texto, fim = ia.ocr_pagina(parte)
            av = avaliar_pagina(texto, truncado=(fim == "MAX_TOKENS"), limiar=lim)
            relatorio.append({"origem": origem, "pagina": numero, "finish_reason": fim, **av.resumo()})
            if av.estado == EXTRAIDO:
                paginas.append(Pagina(origem, numero, av.texto))
            else:
                log.warning("    %s %s: %s (%s)", origem, rotulo, av.estado, av.motivo)
    return paginas, relatorio


def escolher_canonico(docs: list[dict]) -> dict:
    return sorted(docs, key=lambda d: (PRIORIDADE.index(d["secao"]) if d["secao"] in PRIORIDADE else 99, d["id"]))[0]


def rotulo_fonte(lic: dict) -> str:
    """Rótulo da fonte para o cabeçalho dos trechos (antes era sempre "SEST SENAT")."""
    fonte = (lic.get("fonte") or "").strip().lower()
    if fonte == "pncp":
        orgao = (lic.get("orgao_nome") or "").strip()
        return f"PNCP {orgao}".strip()
    if lic.get("entidade"):
        return lic["entidade"].strip()
    from .paradigma import FONTES
    if fonte in FONTES:
        return FONTES[fonte].entidade
    return fonte.upper() or "LICITAÇÃO"


def vetor_pg(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


def indexar_grupo(sb: Supabase, ia, docs: list[dict], lic: dict, com_extracao: bool) -> dict:
    doc = escolher_canonico(docs)
    nome, secao = doc["nome_original"] or doc["arquivo_origem"], doc["secao"]
    processo = f"{lic.get('numero_edital') or ''} ({lic['numero_processo']})".strip()

    conteudo = ler_arquivo(doc["storage_uri"])
    res = extrair(conteudo, nome)
    paginas = list(res.paginas)
    paginas_ocr, ocr_paginas = ocr_escaneados(ia, res.pdfs_escaneados, res.ignorados)
    paginas += paginas_ocr
    nao_aceitas = [p for p in ocr_paginas if p["estado"] != EXTRAIDO]

    texto_total = limpar_texto("\n".join(p.texto for p in paginas))
    if len(texto_total) < 50:
        degeneradas = [p["pagina"] for p in nao_aceitas if p["estado"] == OCR_DEGENERADO]
        # Sem estado próprio em status_processamento (issue #299): o motivo vai no começo do erro.
        erro = (f"{OCR_DEGENERADO}: páginas {degeneradas}; nenhuma página aceita" if degeneradas
                else f"sem texto aproveitável; ignorados: {res.ignorados[:5]}")
        return {"status": "ignorado", "erro": erro,
                "extracao": {"ocr_paginas": ocr_paginas} if ocr_paginas else None}

    extracao = {}
    if com_extracao:
        log.info("    %s: %s caracteres -> ficha com Gemini", nome[:60], len(texto_total))
        extracao = ia.extrair_campos(texto_total, nome, secao, processo, rotulo_fonte(lic))
    tipo = extracao.get("tipo_documento") or secao
    fornecedor = f" — {doc['fornecedor_nome']}" if doc.get("fornecedor_nome") else ""
    cabecalho = f"{rotulo_fonte(lic)} {processo} — {tipo.replace('_', ' ').upper()}{fornecedor} — {nome}"

    trechos = dividir(paginas, cabecalho)
    if extracao.get("resumo"):
        trechos.insert(0, {"texto": f"{cabecalho} — RESUMO\n\n{extracao['resumo']}", "pagina": None, "origem": nome})
    log.info("    %s: %s trechos -> embeddings", nome[:60], len(trechos))
    vetores = ia.embed([t["texto"] for t in trechos])

    sb.remover_chunks(doc["id"])
    # Modelo que gerou os vetores (coluna licitacao_chunks.embedding_model, migration 20261002200000).
    # Vetores de modelos diferentes não são comparáveis: a busca precisa usar o mesmo modelo na pergunta.
    modelo = ia_mod.EMBED_MODEL
    linhas = [{
        "documento_id": doc["id"], "licitacao_id": doc["licitacao_id"], "secao": secao,
        "ordem": i, "pagina": t["pagina"], "texto": t["texto"], "embedding": vetor_pg(v),
        "embedding_model": modelo,
        "metadados": {"tipo_documento": tipo, "fonte": lic.get("fonte"), "origem": t["origem"], "numero_processo": lic["numero_processo"],
                      "numero_edital": lic.get("numero_edital"), "fornecedor": doc.get("fornecedor_nome"),
                      "chunk_kind": "resumo" if (i == 0 and extracao.get("resumo")) else "trecho"},
    } for i, (t, v) in enumerate(zip(trechos, vetores))]
    for i in range(0, len(linhas), 100):
        sb.upsert("licitacao_chunks", linhas[i:i + 100], "documento_id,ordem")

    if res.ignorados:
        extracao["arquivos_ignorados"] = res.ignorados[:50]
    if ocr_paginas:
        extracao["ocr_paginas"] = ocr_paginas
        extracao["ocr_incompleto"] = bool(nao_aceitas)
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
    lics = {l["id"]: l for l in sb.selecionar("licitacoes_externas", select="id,numero_processo,numero_edital,fonte,entidade,orgao_nome")}

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
                    campos = {"status_processamento": "ignorado", "erro": r["erro"]}
                    if r.get("extracao"):
                        campos["extracao"] = r["extracao"]
                    sb.atualizar("licitacao_documentos", d["id"], campos)
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

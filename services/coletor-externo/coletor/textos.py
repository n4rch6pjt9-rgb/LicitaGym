"""Extração de texto de arquivos baixados (PDF, ZIP, DOCX, XLSX, TXT) e divisão em trechos.

O tipo é decidido pelos bytes (assinatura), não pela extensão: o PNCP entrega anexos como
application/octet-stream, com títulos sem extensão ("21 - Edital") ou gravados como .bin.
A extensão só decide os formatos de texto puro (txt, csv, html, htm, xml).
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree


@dataclass
class Pagina:
    origem: str      # nome do arquivo (ou arquivo dentro do zip)
    numero: int | None
    texto: str


@dataclass
class Resultado:
    paginas: list[Pagina]
    pdfs_escaneados: list[tuple[str, bytes]]   # PDFs sem camada de texto -> OCR com Gemini
    ignorados: list[str]                        # não suportados (rar, 7z, pptx, doc/xls antigos, imagens...)


def tipo_por_bytes(conteudo: bytes) -> str | None:
    """Tipo real pelo conteúdo (o PNCP entrega muitos anexos sem extensão ou como .bin)."""
    if conteudo[:5] == b"%PDF-":
        return "pdf"
    if conteudo[:2] == b"PK":
        try:
            nomes = zipfile.ZipFile(io.BytesIO(conteudo)).namelist()
        except zipfile.BadZipFile:
            return None
        if "word/document.xml" in nomes:
            return "docx"
        if any(n.startswith("xl/") for n in nomes):
            return "xlsx"
        if any(n.startswith("ppt/") for n in nomes):
            return "pptx"
        return "zip"
    if conteudo[:4] == b"Rar!":
        return "rar"
    if conteudo[:6] == b"7z\xbc\xaf\x27\x1c":
        return "7z"
    if conteudo[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        return "ole"   # .doc/.xls antigos
    if b"%PDF-" in conteudo[:1024]:   # PDF com lixo antes do cabeçalho (o leitor tolera)
        return "pdf"
    return None


def extrair(conteudo: bytes, nome: str, profundidade: int = 0) -> Resultado:
    res = Resultado([], [], [])
    ext = nome.lower().rsplit(".", 1)[-1] if "." in nome else ""
    tipo = tipo_por_bytes(conteudo)
    if tipo == "pdf":
        _pdf(conteudo, nome, res)
    elif tipo == "zip":
        _zip(conteudo, nome, res, profundidade)
    elif tipo == "docx":
        _docx(conteudo, nome, res)
    elif tipo == "xlsx":
        _xlsx(conteudo, nome, res)
    elif tipo is not None:
        res.ignorados.append(nome)   # rar, 7z, pptx, doc/xls antigos
    elif ext in ("txt", "csv", "html", "htm", "xml"):
        texto = conteudo.decode("utf-8", errors="ignore")
        if ext in ("html", "htm"):
            texto = re.sub(r"<[^>]+>", " ", texto)
        res.paginas.append(Pagina(nome, None, texto))
    else:
        # inclui ".pdf" que não é PDF (ex.: página de erro HTML): não manda para OCR
        res.ignorados.append(nome)
    return res


def _nome_zip(info: zipfile.ZipInfo) -> str:
    """Nome da entrada do ZIP. Sem o bit 11 (UTF-8) o zipfile decodifica como cp437; zips gerados no
    Windows pt-BR usam cp850 ("Preg╞o" vira "Pregão") e alguns gravam UTF-8 sem marcar o bit."""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        bruto = info.filename.encode("cp437")
    except UnicodeEncodeError:
        return info.filename
    for codificacao in ("utf-8", "cp850"):
        try:
            return bruto.decode(codificacao)
        except UnicodeDecodeError:
            continue
    return info.filename


def _pdf(conteudo: bytes, nome: str, res: Resultado) -> None:
    from pypdf import PdfReader
    try:
        leitor = PdfReader(io.BytesIO(conteudo))
        paginas = [Pagina(nome, i + 1, (p.extract_text() or "")) for i, p in enumerate(leitor.pages)]
    except Exception:
        res.pdfs_escaneados.append((nome, conteudo))
        return
    total = sum(len(p.texto.strip()) for p in paginas)
    # PDF escaneado: quase nenhum texto por página
    if not paginas or total < 80 * len(paginas):
        res.pdfs_escaneados.append((nome, conteudo))
    else:
        res.paginas += [p for p in paginas if p.texto.strip()]


def _zip(conteudo: bytes, nome: str, res: Resultado, profundidade: int) -> None:
    if profundidade > 2:
        res.ignorados.append(nome)
        return
    try:
        z = zipfile.ZipFile(io.BytesIO(conteudo))
    except zipfile.BadZipFile:
        res.ignorados.append(nome)
        return
    for info in z.infolist():
        if info.is_dir() or info.file_size > 60 * 1024 * 1024:
            continue
        interno = f"{nome}/{_nome_zip(info)}"
        sub = extrair(z.read(info), interno, profundidade + 1)
        res.paginas += sub.paginas
        res.pdfs_escaneados += sub.pdfs_escaneados
        res.ignorados += sub.ignorados


def _docx(conteudo: bytes, nome: str, res: Resultado) -> None:
    try:
        xml = zipfile.ZipFile(io.BytesIO(conteudo)).read("word/document.xml")
        ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
        paragrafos = ["".join(t.text or "" for t in p.iter(f"{ns}t"))
                      for p in ElementTree.fromstring(xml).iter(f"{ns}p")]
        res.paginas.append(Pagina(nome, None, "\n".join(paragrafos)))
    except Exception:
        res.ignorados.append(nome)


XLSX_MAX_CHARS = 200_000   # planilha maior que isso (base de dados, não anexo de edital) é cortada


def _xlsx(conteudo: bytes, nome: str, res: Resultado) -> None:
    """Texto simples de XLSX: uma linha por linha da planilha, células com valor separadas por " | ".
    Usa o valor gravado (cache de fórmula incluído). Não interpreta datas (ficam como número serial),
    estilos, células mescladas nem gráficos. Uma Pagina por aba, com origem "arquivo.xlsx#Aba"."""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    try:
        z = zipfile.ZipFile(io.BytesIO(conteudo))
        nomes = set(z.namelist())
        compartilhadas: list[str] = []
        if "xl/sharedStrings.xml" in nomes:
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{ns}si"):
                compartilhadas.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
        abas: list[tuple[str, str]] = []
        if "xl/workbook.xml" in nomes and "xl/_rels/workbook.xml.rels" in nomes:
            alvos = {r.get("Id"): r.get("Target", "")
                     for r in ElementTree.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
            for sh in ElementTree.fromstring(z.read("xl/workbook.xml")).iter(f"{ns}sheet"):
                alvo = alvos.get(sh.get(rel), "").lstrip("/")
                abas.append((sh.get("name") or "", alvo if alvo.startswith("xl/") else f"xl/{alvo}"))
        if not abas:
            abas = [(n.rsplit("/", 1)[-1], n) for n in sorted(nomes)
                    if n.startswith("xl/worksheets/") and n.endswith(".xml")]
        total, antes = 0, len(res.paginas)
        for aba, caminho in abas:
            if caminho not in nomes or total >= XLSX_MAX_CHARS:
                continue
            linhas = []
            for row in ElementTree.fromstring(z.read(caminho)).iter(f"{ns}row"):
                celulas = []
                for c in row.iter(f"{ns}c"):
                    t = c.get("t")
                    if t == "inlineStr":
                        v = "".join(x.text or "" for x in c.iter(f"{ns}t"))
                    else:
                        el = c.find(f"{ns}v")
                        v = el.text if el is not None and el.text else ""
                        if t == "s" and v.isdigit() and int(v) < len(compartilhadas):
                            v = compartilhadas[int(v)]
                        elif t in (None, "n") and v:
                            try:   # 57.800000000000004 -> 57.8 (ruído de ponto flutuante do Excel)
                                v = format(float(v), ".15g")
                            except ValueError:
                                pass
                    if v.strip():
                        celulas.append(v.strip())
                if celulas:
                    linhas.append(" | ".join(celulas))
            texto = "\n".join(linhas)[: XLSX_MAX_CHARS - total]
            total += len(texto)
            if texto.strip():
                res.paginas.append(Pagina(f"{nome}#{aba}" if aba else nome, None, texto))
        if len(res.paginas) == antes:
            res.ignorados.append(nome)   # planilha vazia ou estrutura que este leitor simples não entende
    except Exception:
        res.ignorados.append(nome)


def limpar_texto(t: str) -> str:
    # CPF e CNPJ em editais são dados públicos: não mascarar (decisão do Marcelo, 01/10/2026).
    t = t.replace("\x00", " ")
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def dividir(paginas: list[Pagina], cabecalho: str, tamanho: int = 1800, sobreposicao: int = 200) -> list[dict]:
    """Divide em trechos de ~tamanho caracteres, respeitando parágrafos quando possível.
    Cada trecho recebe o cabeçalho (processo/documento) no início, como na legislação."""
    trechos: list[dict] = []
    for pg in paginas:
        texto = limpar_texto(pg.texto)
        inicio = 0
        while inicio < len(texto):
            fim = min(inicio + tamanho, len(texto))
            if fim < len(texto):
                quebra = texto.rfind("\n", inicio + tamanho // 2, fim)
                if quebra == -1:
                    quebra = texto.rfind(". ", inicio + tamanho // 2, fim)
                if quebra != -1:
                    fim = quebra + 1
            corpo = texto[inicio:fim].strip()
            if len(corpo) > 40:
                trechos.append({
                    "texto": f"{cabecalho}\n\n{corpo}",
                    "pagina": pg.numero,
                    "origem": pg.origem,
                })
            if fim >= len(texto):
                break
            inicio = max(fim - sobreposicao, inicio + 1)
    return trechos

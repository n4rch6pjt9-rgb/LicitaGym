"""Extração de texto de arquivos baixados (PDF, ZIP, DOCX, TXT) e divisão em trechos."""
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
    ignorados: list[str]                        # formatos não suportados (rar, imagens...)


def extrair(conteudo: bytes, nome: str, profundidade: int = 0) -> Resultado:
    res = Resultado([], [], [])
    ext = nome.lower().rsplit(".", 1)[-1] if "." in nome else ""
    if conteudo[:5] == b"%PDF-" or ext == "pdf":
        _pdf(conteudo, nome, res)
    elif conteudo[:2] == b"PK" and ext in ("zip", ""):
        _zip(conteudo, nome, res, profundidade)
    elif ext == "docx":
        _docx(conteudo, nome, res)
    elif ext in ("txt", "csv", "html", "htm", "xml"):
        texto = conteudo.decode("utf-8", errors="ignore")
        if ext in ("html", "htm"):
            texto = re.sub(r"<[^>]+>", " ", texto)
        res.paginas.append(Pagina(nome, None, texto))
    else:
        res.ignorados.append(nome)
    return res


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
        interno = f"{nome}/{info.filename}"
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


_CPF_FORMATADO = re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b")
_CPF_ROTULADO = re.compile(r"(CPF\s*(?:n[º°o.]*\s*)?[:\-]?\s*)\d{11}\b", re.IGNORECASE)


def mascarar_dados_pessoais(t: str) -> str:
    """LGPD: remove CPFs (formatados, ou 11 dígitos logo após 'CPF'). CNPJs são mantidos."""
    t = _CPF_FORMATADO.sub("***.***.***-**", t)
    return _CPF_ROTULADO.sub(r"\1***********", t)


def limpar_texto(t: str) -> str:
    t = mascarar_dados_pessoais(t.replace("\x00", " "))
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

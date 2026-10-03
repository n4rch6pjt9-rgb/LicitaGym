"""Extração de texto de arquivos baixados (PDF, ZIP, DOCX, XLSX, TXT) e divisão em trechos.

O tipo é decidido pelos bytes (assinatura), não pela extensão: o PNCP entrega anexos como
application/octet-stream, com títulos sem extensão ("21 - Edital") ou gravados como .bin.
A extensão só decide os formatos de texto puro (txt, csv, html, htm, xml).
"""
from __future__ import annotations

import io
import logging
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree

# Teto de bytes descompactados: entrada de ZIP maior que isso é pulada; XLSX cujas partes XML somam
# mais que isso vira erro (zip bomb). O file_size declarado limita a leitura: o zipfile não entrega
# mais que isso e acusa erro de CRC se os dados reais forem maiores.
ZIP_MAX_DESCOMPACTADO = 60 * 1024 * 1024

log = logging.getLogger("textos")


class ErroExtracao(ValueError):
    """Arquivo reconhecido (pela assinatura) mas inválido ou acima dos limites de leitura.
    Propaga até o indexador, que grava status_processamento = 'erro' com a mensagem (o mesmo caminho
    de qualquer exceção na indexação de PDF) e o documento volta em --reprocessar-erros.
    Exceção: dentro de um ZIP, o _zip captura o erro, pula só aquele arquivo, registra o motivo em
    Resultado.ignorados (vai para extracao.arquivos_ignorados) e segue com o resto do ZIP."""


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
        if info.is_dir() or info.file_size > ZIP_MAX_DESCOMPACTADO:
            continue
        interno = f"{nome}/{_nome_zip(info)}"
        try:
            sub = extrair(z.read(info), interno, profundidade + 1)
        except ErroExtracao as e:
            # Uma planilha inválida dentro do ZIP não derruba o ZIP inteiro (decisão do Marcelo,
            # 03/10/2026): pula só ela, registra o motivo e indexa o resto. XLSX avulso continua 'erro'.
            motivo = str(e)[:300]
            log.warning("arquivo do ZIP pulado: %s", motivo)
            res.ignorados.append(motivo)
            continue
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
XLSX_MAX_LINHAS = 100_000      # linhas <row> lidas no arquivo inteiro antes do corte por caracteres
XLSX_MAX_CELULAS = 1_000_000   # células lidas, contando as lacunas preenchidas pela referência "r"
XLSX_MAX_COLUNAS = 16_384      # última coluna do Excel (XFD)


def _coluna_da_referencia(ref: str) -> int | None:
    """Número da coluna (1 = A) a partir da referência da célula ("C5" -> 3). None se não houver letras."""
    m = re.match(r"([A-Za-z]{1,3})\d*$", ref or "")
    if not m:
        return None
    n = 0
    for ch in m.group(1).upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def _xlsx(conteudo: bytes, nome: str, res: Resultado) -> None:
    """Texto simples de XLSX: uma linha por linha da planilha, células separadas por " | ".
    Cada célula vai para a coluna da sua referência "r" (C5 -> 3ª coluna); lacunas viram campos vazios,
    para uma célula vazia não deslocar as seguintes. Usa o texto gravado no XML sem conversão (números
    como "12345678901234567890" ou "0,10" saem intactos; cache de fórmula incluído; datas ficam como
    número serial). Não interpreta estilos, células mescladas nem gráficos. Uma Pagina por aba, com
    origem "arquivo.xlsx#Aba".

    Limites (zip bomb): as partes XML somadas não passam de ZIP_MAX_DESCOMPACTADO (checado pelo
    file_size antes de ler qualquer coisa); as abas são lidas em streaming até XLSX_MAX_CHARS, e
    XLSX_MAX_LINHAS / XLSX_MAX_CELULAS / XLSX_MAX_COLUNAS barram estruturas patológicas.
    XLSX inválido ou acima dos limites levanta ErroExtracao; só planilha válida e vazia fica ignorada."""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

    def erro(motivo: str) -> ErroExtracao:
        return ErroExtracao(f"XLSX inválido ({nome}): {motivo}")

    def teto(lidos: int) -> ErroExtracao:
        return erro(f"partes XML somam {lidos} bytes descompactados, acima do teto de "
                    f"{ZIP_MAX_DESCOMPACTADO} bytes (possível zip bomb)")

    try:
        z = zipfile.ZipFile(io.BytesIO(conteudo))
        infos = {i.filename: i for i in z.infolist() if not i.is_dir()}
        nomes = set(infos)
        xml_total = sum(i.file_size for n, i in infos.items() if n.endswith((".xml", ".rels")))
        if xml_total > ZIP_MAX_DESCOMPACTADO:
            raise teto(xml_total)
        compartilhadas: list[str] = []
        if "xl/sharedStrings.xml" in nomes:
            for si in ElementTree.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{ns}si"):
                compartilhadas.append("".join(t.text or "" for t in si.iter(f"{ns}t")))
        abas: list[tuple[str, str]] = []
        if "xl/workbook.xml" in nomes:
            livro = ElementTree.fromstring(z.read("xl/workbook.xml"))
            if "xl/_rels/workbook.xml.rels" in nomes:
                alvos = {r.get("Id"): r.get("Target", "")
                         for r in ElementTree.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
                for sh in livro.iter(f"{ns}sheet"):
                    alvo = alvos.get(sh.get(rel), "").lstrip("/")
                    abas.append((sh.get("name") or "", alvo if alvo.startswith("xl/") else f"xl/{alvo}"))
        if not abas:
            abas = [(n.rsplit("/", 1)[-1], n) for n in sorted(nomes)
                    if n.startswith("xl/worksheets/") and n.endswith(".xml")]
        if not abas:
            raise erro("nenhuma aba (xl/worksheets/*.xml) encontrada")
        total, antes, n_linhas, n_celulas = 0, len(res.paginas), 0, 0
        for aba, caminho in abas:
            if total >= XLSX_MAX_CHARS:
                break
            if caminho not in nomes:
                raise erro(f"a aba '{aba}' aponta para '{caminho}', que não existe no arquivo")
            if not caminho.endswith((".xml", ".rels")):   # fora da soma inicial: entra agora
                xml_total += infos[caminho].file_size
                if xml_total > ZIP_MAX_DESCOMPACTADO:
                    raise teto(xml_total)
            linhas: list[str] = []
            tamanho = 0
            pilha: list[ElementTree.Element] = []
            with z.open(caminho) as arquivo:
                for evento, el in ElementTree.iterparse(arquivo, events=("start", "end")):
                    if evento == "start":
                        pilha.append(el)
                        continue
                    pilha.pop()
                    if el.tag != f"{ns}row":
                        continue
                    n_linhas += 1
                    if n_linhas > XLSX_MAX_LINHAS:
                        raise erro(f"mais de {XLSX_MAX_LINHAS} linhas")
                    celulas: list[str] = []
                    for c in el.iter(f"{ns}c"):
                        t = c.get("t")
                        if t == "inlineStr":
                            v = "".join(x.text or "" for x in c.iter(f"{ns}t"))
                        else:
                            v_el = c.find(f"{ns}v")
                            v = v_el.text if v_el is not None and v_el.text else ""
                            if t == "s" and v.isdigit() and int(v) < len(compartilhadas):
                                v = compartilhadas[int(v)]
                            # números (t ausente ou "n"): texto do XML como está, sem float()
                        coluna = _coluna_da_referencia(c.get("r", ""))
                        if coluna is None:
                            coluna = len(celulas) + 1   # sem "r": logo após a anterior
                        if coluna > XLSX_MAX_COLUNAS:
                            raise erro(f"referência de célula fora do limite do Excel: {c.get('r')!r}")
                        if coluna > len(celulas):
                            n_celulas += coluna - len(celulas)
                            celulas.extend([""] * (coluna - len(celulas)))
                        if n_celulas > XLSX_MAX_CELULAS:
                            raise erro(f"mais de {XLSX_MAX_CELULAS} células")
                        celulas[coluna - 1] = v.strip()
                    if pilha:
                        pilha[-1].remove(el)   # libera a linha já lida (streaming)
                    while celulas and not celulas[-1]:
                        celulas.pop()
                    if celulas:
                        linha = " | ".join(celulas)
                        linhas.append(linha)
                        tamanho += len(linha) + 1
                        if total + tamanho >= XLSX_MAX_CHARS:
                            break   # o resto seria cortado: não lê
            texto = "\n".join(linhas)[: XLSX_MAX_CHARS - total]
            total += len(texto)
            if texto.strip():
                res.paginas.append(Pagina(f"{nome}#{aba}" if aba else nome, None, texto))
        if len(res.paginas) == antes:
            res.ignorados.append(nome)   # planilha válida, mas sem nenhuma célula com valor
    except ErroExtracao:
        raise
    except Exception as e:   # XML quebrado, ZIP corrompido, CRC errado...
        raise erro(f"{type(e).__name__}: {e}") from e


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

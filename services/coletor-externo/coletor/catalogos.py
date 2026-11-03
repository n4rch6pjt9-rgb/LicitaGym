"""Catálogos dos fabricantes (MOVEMENT, LION, TOTAL HEALTH, MACSPORT, FLEX) para o LicitaGym.

Duas saídas:
  1. Ficha estruturada por produto (tabela catalogo_produtos): marca, linha, código, nome, nó da taxonomia, carga
     máxima/inicial, peso da placa, peso e medidas — é o "gabarito" para ler o modelo ofertado nas licitações e para
     comparar com as referências do edital (Anexo II).
  2. PDFs de catálogo/manual guardados no bucket privado `catalogos-fabricantes` (histórico por sha256, nada é
     apagado) e depois indexados no RAG (catalogo_chunks) pelo mesmo pipeline do indexador.

Regras de coleta: respeita robots.txt de cada site, 1 requisição a cada `--intervalo` segundos, User-Agent identificado.
Uso:
  python -m coletor.catalogos --marca MOVEMENT --limite 20 --saida fichas.jsonl        # só fichas (HTML)
  python -m coletor.catalogos --marca MOVEMENT --pdf                                  # também baixa os PDFs
"""
from __future__ import annotations

import argparse
import html as html_lib
import json
import re
import sys
import time
from pathlib import Path
from urllib import robotparser
from urllib.parse import urljoin, urlparse

import requests

from .destino import Armazenamento, sha256
from .modelos import decompor_modelo
from .perfil_item import normalizar_marca, perfil_item

MANIFESTO = Path(__file__).resolve().parent / "data" / "catalogos_fabricantes.json"
UA = "LicitaGymBot/0.1 (catalogo de fabricantes; contato via site LicitaGym)"
BUCKET = "catalogos-fabricantes"


def manifesto() -> dict:
    return json.loads(MANIFESTO.read_text(encoding="utf-8"))["fabricantes"]


# --------------------------------------------------------------------------------------------- ficha do produto
_SPEC = {  # rótulo inteiro da ficha (sem a unidade entre parênteses) -> campo
    "carga_maxima_kg": r"CARGA M[AÁ]XIMA|CARGA",
    "carga_inicial_kg": r"CARGA INICIAL",
    "peso_placa_kg": r"PESO UNIT[AÁ]RIO DA PLACA|PESO DA PLACA",
    "peso_equipamento_kg": r"PESO DO EQUIPAMENTO|PESO L[IÍ]QUIDO|PESO TOTAL|PESO",
    "comprimento_cm": r"COMPRIMENTO",
    "largura_cm": r"LARGURA",
    "altura_cm": r"ALTURA",
}


def _num(v: str) -> float | None:
    m = re.search(r"\d+(?:[.,]\d+)?", v or "")
    return float(m.group(0).replace(".", "").replace(",", ".")) if m and "," in m.group(0) else \
        float(m.group(0)) if m else None


def texto_visivel(h: str) -> str:
    h = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", h)
    t = html_lib.unescape(re.sub(r"<[^>]+>", "\n", h))
    return "\n".join(x.strip() for x in t.splitlines() if x.strip())


def specs_da_ficha(texto: str) -> dict:
    """Ficha técnica em pares 'RÓTULO\\nVALOR' (padrão dos sites WordPress/WooCommerce dos fabricantes)."""
    linhas = texto.splitlines()
    out: dict = {}
    for i, rot in enumerate(linhas[:-1]):
        r = re.sub(r"\s*\(.*?\)\s*$", "", rot).strip().rstrip(":").upper()
        prox = linhas[i + 1].strip()
        if re.fullmatch(r"C[OÓ]DIGO|REF(ER[EÊ]NCIA)?|SKU|MODELO", r) and "codigo" not in out \
                and re.fullmatch(r"[A-Z0-9][A-Z0-9_./-]{2,20}", prox.upper()) and re.search(r"\d", prox):
            out["codigo"] = prox.upper()
            continue
        if re.fullmatch(r"DIMENS(Õ|O)ES|MEDIDAS", r) and "comprimento_cm" not in out:
            d = re.findall(r"\d+(?:[.,]\d+)?", prox)
            if len(d) == 3:
                out["comprimento_cm"], out["largura_cm"], out["altura_cm"] = (float(x.replace(",", ".")) for x in d)
            continue
        for campo, rx in _SPEC.items():
            if campo not in out and re.fullmatch(rf"(?:{rx})", r) and re.search(r"\d", prox):
                v = _num(prox)
                if v is not None:
                    out[campo] = v
                break
    return out


def norm_simples(t: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (t or "").upper())


def _limpa_carga(titulo: str, m: re.Match) -> str:
    return re.sub(r"\s{2,}", " ", titulo[:m.start()] + titulo[m.end():]).strip()


def extrair_ficha(h: str, url: str, marca: str) -> dict:
    """HTML da página do produto -> ficha estruturada."""
    def meta(p):
        m = re.search(rf'<meta[^>]+property="og:{p}"[^>]+content="([^"]*)"', h) or \
            re.search(rf'<meta[^>]+content="([^"]*)"[^>]+property="og:{p}"', h)
        return html_lib.unescape(m.group(1)).strip() if m else None
    h1 = re.search(r"(?is)<h1[^>]*>(.*?)</h1>", h)
    h1 = html_lib.unescape(re.sub(r"<[^>]+>", " ", h1.group(1))).strip() if h1 else ""
    titulo = meta("title") or (re.search(r"(?is)<title>(.*?)</title>", h) or [None, None])[1] or ""
    titulo = re.split(r"\s+[|–-]\s+(?=[^|–-]*$)", html_lib.unescape(titulo).strip())[0].strip()
    if h1 and (not titulo or norm_simples(titulo) == norm_simples(marca) or len(h1) > 3 and norm_simples(marca) in
               norm_simples(titulo) and norm_simples(h1) not in norm_simples(titulo)):
        titulo = h1  # sites que repetem o nome da empresa no og:title (Macsport)
    titulo = re.sub(r"\s+", " ", titulo)
    # carga no nome ("Flexora Deitada (a partir de 60 KG)", "Tríceps Máquina (80 KG)") -> coluna, fora do nome
    carga_nome = re.search(r"\(\s*(?:a partir de\s*)?(\d+(?:[.,]\d+)?)\s*kg\s*\)", titulo, re.I)
    if carga_nome:
        titulo = _limpa_carga(titulo, carga_nome)
    categorias = []
    for bloco in re.findall(r'(?s)<script type="application/ld\+json"[^>]*>(.*?)</script>', h):
        try:
            d = json.loads(bloco)
        except ValueError:
            continue
        for g in (d.get("@graph") or [d]) if isinstance(d, dict) else []:
            if g.get("@type") == "BreadcrumbList":
                nomes = []
                for e in g.get("itemListElement", []):
                    it = e.get("item")
                    nomes.append((it.get("name") if isinstance(it, dict) else None) or e.get("name"))
                categorias = [n for n in nomes[1:-1] if n]
    m = normalizar_marca(marca)
    partes = decompor_modelo(m, titulo)
    if not partes["linha"]:  # linha no caminho da URL (Macsport: /loja/shop/cromus/...)
        caminho = urlparse(url).path.upper().replace("-", " ")
        achou = decompor_modelo(m, caminho)
        partes["linha"] = achou["linha"]
    perfil = perfil_item(titulo)
    specs = specs_da_ficha(texto_visivel(h))
    if carga_nome and "carga_maxima_kg" not in specs:
        specs["carga_maxima_kg"] = float(carga_nome.group(1).replace(",", "."))
    codigo_ficha = specs.pop("codigo", None)
    if codigo_ficha and not partes["codigo"]:
        partes["codigo"] = codigo_ficha
        if m == "TOTAL HEALTH":  # 505RRF -> linha RRF
            partes["linha"] = partes["linha"] or decompor_modelo(m, codigo_ficha)["linha"]
    return {"marca": m, "url": url, "titulo": titulo, "linha": partes["linha"], "codigo": partes["codigo"],
            "nome": partes["nome"], "descricao": meta("description"), "categorias": categorias,
            "no_taxonomia": perfil["no_taxonomia"], "produto_padronizado": perfil["produto_padronizado"],
            "familia_equipamento": perfil["familia_equipamento"], **specs}


# --------------------------------------------------------------------------------------------- coleta educada
class Coletor:
    def __init__(self, intervalo: float = 2.0, sessao: requests.Session | None = None):
        self.s = sessao or requests.Session()
        self.s.headers["User-Agent"] = UA
        self.intervalo = intervalo
        self._robots: dict[str, robotparser.RobotFileParser] = {}
        self._ultimo = 0.0

    def permitido(self, url: str) -> bool:
        base = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if base not in self._robots:
            rp = robotparser.RobotFileParser()
            try:
                r = self.s.get(base + "/robots.txt", timeout=20)
                rp.parse(r.text.splitlines() if r.status_code == 200 else [])
            except requests.RequestException:
                rp.parse([])
            self._robots[base] = rp
        return self._robots[base].can_fetch(UA, url)

    def get(self, url: str, **kw) -> requests.Response:
        if not self.permitido(url):
            raise PermissionError(f"robots.txt não permite: {url}")
        espera = self.intervalo - (time.monotonic() - self._ultimo)
        if espera > 0:
            time.sleep(espera)
        self._ultimo = time.monotonic()
        r = self.s.get(url, timeout=kw.pop("timeout", 60), **kw)
        r.raise_for_status()
        return r

    def urls_de_produto(self, cfg: dict, limite: int | None = None) -> list[str]:
        p = cfg["produtos"]
        rx = re.compile(p["padrao_url"])
        urls: list[str] = []
        if p.get("sitemap"):
            urls = re.findall(r"<loc>([^<]+)</loc>", self.get(p["sitemap"]).text)
        for indice in p.get("paginas_indice", []):
            try:
                h = self.get(indice).text
            except (requests.RequestException, PermissionError) as e:
                print(f"  índice {indice}: {e}", file=sys.stderr)
                continue
            urls += [urljoin(indice, u) for u in re.findall(r'href="([^"#?]+)"', h)]
            # sites em Next.js/React trazem os links no payload JS, não em href
            urls += [urljoin(indice, "/" + u) for u in re.findall(r'["\'(/](produto/[a-z0-9-]+(?:/[a-z0-9-]+)?)', h)]
        vistos, out = set(), []
        for u in urls:
            if rx.search(u) and u not in vistos and not u.startswith("javascript"):
                vistos.add(u)
                out.append(u)
        return out[:limite] if limite else out

    def fichas(self, marca: str, limite: int | None = None) -> list[dict]:
        cfg = manifesto()[marca]
        out = []
        for u in self.urls_de_produto(cfg, None if cfg["produtos"].get("exige_codigo") else limite):
            if limite and len(out) >= limite:
                break
            try:
                f = extrair_ficha(self.get(u).text, u, marca)
                if cfg["produtos"].get("exige_codigo") and not f["codigo"]:
                    continue  # página de categoria/institucional, não é produto
                out.append(f)
            except (requests.RequestException, PermissionError) as e:
                print(f"  {u}: {e}", file=sys.stderr)
        return out

    def baixar_pdfs(self, marca: str, armazenamento: Armazenamento) -> list[dict]:
        """PDFs do manifesto -> bucket catalogos-fabricantes/<marca>/<sha256>.pdf (mesmo arquivo não duplica)."""
        out = []
        for p in manifesto()[marca].get("pdfs", []):
            r = self.get(p["url"], timeout=300)
            if "pdf" not in r.headers.get("content-type", "") and not r.content.startswith(b"%PDF"):
                print(f"  {p['url']}: não é PDF", file=sys.stderr)
                continue
            h = sha256(r.content)
            pasta = re.sub(r"[^A-Z0-9]+", "-", marca).strip("-").lower()
            uri = armazenamento.salvar(f"{pasta}/{h}.pdf", r.content, "application/pdf")
            out.append({"marca": marca, "titulo": p["titulo"], "url_origem": p["url"], "ano": p.get("ano"),
                        "sha256": h, "tamanho_bytes": len(r.content), "storage_uri": uri})
        return out


_COLS_PRODUTO = ("marca", "linha", "codigo", "nome", "no_taxonomia", "produto_padronizado", "familia_equipamento",
                 "carga_maxima_kg", "carga_inicial_kg", "peso_placa_kg", "peso_equipamento_kg", "comprimento_cm",
                 "largura_cm", "altura_cm", "categorias", "descricao", "url")


def linha_produto(f: dict) -> dict:
    """Ficha -> linha de catalogo_produtos (last_seen_at atualizado a cada coleta)."""
    from datetime import datetime, timezone
    return {**{k: f.get(k) for k in _COLS_PRODUTO}, "titulo_original": f.get("titulo"),
            "last_seen_at": datetime.now(timezone.utc).isoformat()}


def _adaptador_efetivo(marca: str, modo: str) -> str | None:
    if modo == "generico":
        return "generico"
    return manifesto()[marca].get("adaptador")


def _rodar_adaptadores(a, plano: list[tuple[str, str]]) -> int:
    """Motor novo. Não abre o Supabase: --gravar/--pdf já foram recusados antes."""
    from .catalogo.executar import executar_marca
    from .catalogo.motor import Limites
    intervalo = a.intervalo if a.intervalo > 2.0 else 2.5
    limites = Limites(max_requisicoes=a.max_requisicoes, max_produtos=a.max_produtos or a.limite or 4000)
    if a.limite:
        limites.max_produtos = a.limite
    pior = 0
    with open(a.saida, "w", encoding="utf-8") as fh:
        for marca, ad in plano:
            cfg = dict(manifesto()[marca])
            cfg["adaptador"] = ad
            estado = a.estado
            if estado and len(plano) > 1:
                base = Path(estado)
                estado = str(base.with_name(f"{base.stem}-{marca}{base.suffix or '.json'}"))
            resultado = executar_marca(
                marca, cfg, intervalo=intervalo, limites=limites, saida=fh, estado_path=estado,
            )
            extra = f", {resultado['motivo']}" if resultado.get("motivo") else ""
            print(f"{marca}: {len(resultado['produtos'])} produtos ({resultado['status']}{extra})")
            if resultado["status"] == "bloqueada":
                pior = 2
            elif resultado["status"] == "parcial" and pior < 2:
                pior = 1
    return pior


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--marca", choices=list(manifesto()), action="append")
    ap.add_argument("--limite", type=int)
    ap.add_argument("--intervalo", type=float, default=2.0)
    ap.add_argument("--saida", default="catalogo_fichas.jsonl")
    ap.add_argument("--pdf", action="store_true", help="baixar também os PDFs do manifesto para o bucket")
    ap.add_argument("--gravar", action="store_true", help="gravar fichas/PDFs no Supabase (catalogo_produtos/_documentos)")
    ap.add_argument("--adaptador", choices=("auto", "generico"), default="auto",
                    help="auto usa o adaptador do manifesto; generico força sitemap/índice + extrair_ficha")
    ap.add_argument("--estado", help="checkpoint JSON para retomar a coleta do adaptador")
    ap.add_argument("--max-requisicoes", type=int, default=4000)
    ap.add_argument("--max-produtos", type=int, default=4000)
    a = ap.parse_args(argv)
    marcas = a.marca or list(manifesto())
    plano = [(m, _adaptador_efetivo(m, a.adaptador)) for m in marcas]
    novos = [f"{m} ({ad})" for m, ad in plano if ad]
    if novos and a.gravar:
        print(
            f"erro: --gravar recusado para {', '.join(novos)}. "
            "A fase 1 não grava no banco e não há migration.",
            file=sys.stderr,
        )
        return 2
    if novos and a.pdf:
        print(
            f"erro: --pdf recusado para {', '.join(novos)}. A fase 1 não baixa PDF nem imagem.",
            file=sys.stderr,
        )
        return 2
    if any(ad for _, ad in plano) and any(ad is None for _, ad in plano):
        print("erro: não misture marca com adaptador e marca da coleta antiga na mesma execução.", file=sys.stderr)
        return 2
    if any(ad for _, ad in plano):
        return _rodar_adaptadores(a, [(m, ad) for m, ad in plano if ad])
    sb = None
    if a.gravar or a.pdf:
        from .destino import Supabase, env
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    c = Coletor(a.intervalo)
    marcas = a.marca or list(manifesto())
    with open(a.saida, "w", encoding="utf-8") as fh:
        for m in marcas:
            fs = c.fichas(m, a.limite)
            for f in fs:
                fh.write(json.dumps(f, ensure_ascii=False) + "\n")
            if sb and a.gravar and fs:
                sb.upsert("catalogo_produtos", [linha_produto(f) for f in fs], "url")
            print(f"{m}: {len(fs)} fichas")
    if a.pdf:
        from .destino import SupabaseStorage, env
        arm = Armazenamento(supabase=SupabaseStorage(env("SUPABASE_URL", obrigatorio=True),
                                                     env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True), BUCKET))
        for m in marcas:
            for d in c.baixar_pdfs(m, arm):
                sb.upsert("catalogo_documentos", d, "sha256")
                print(f"{m}: {d['titulo']} -> {d['storage_uri']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Completa o PROCESSO ADMINISTRATIVO a partir do texto do edital (PNCP).

Muitos municípios informam ao PNCP só um número curto no campo 'processo' ("4", "38"),
sem ano, o que não identifica o certame. O número completo costuma estar na capa/preâmbulo
do edital ("PROCESSO ADMINISTRATIVO Nº 137/2026"). Este módulo:
  1. seleciona as compras PNCP com processo fraco (vazio, ou sem ano e com menos de 5 dígitos);
  2. procura primeiro no título/objeto/informação complementar (grátis);
  3. depois baixa os arquivos da compra (Edital primeiro; ZIPs são abertos) e lê as primeiras páginas;
  4. registra o candidato em raw.processo_extraido (valor, fonte, arquivo, peso, trecho, versão).

Por padrão NÃO altera numero_processo: o valor do PNCP é o dado oficial e o extraído é derivado
(regras 5 e 6 do licitagym-core). Com --gravar-numero-processo, também substitui numero_processo,
mas só quando o candidato tem peso >= PESO_MIN_GRAVAR (ex.: "Processo Administrativo nº ..."),
guardando o original em raw.processo_pncp.

Regra de identificação: o número do edital/pregão é rótulo, nunca processo. Candidato igual ao
número do edital com peso baixo é descartado e contado em 'bloqueado_edital'.

Falha (detalhe, lista de arquivos ou todos os downloads) NÃO é "não encontrado": vai para 'falha'
e o comando termina com código 2 (execução parcial).

  python3 -m coletor.processo_edital --dry-run        # só mostra o que acharia
  python3 -m coletor.processo_edital                  # grava em raw.processo_extraido
  python3 -m coletor.processo_edital --gravar-numero-processo   # também troca numero_processo (peso alto)
  python3 -m coletor.processo_edital --todos          # reavalia também os que já parecem bons
PDF escaneado (sem texto) é ignorado e contado em 'escaneados'.
"""
from __future__ import annotations

import argparse
import logging
import re
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone

from .destino import Supabase, env
from .pncp import PNCP
from .textos import extrair

log = logging.getLogger("processo_edital")

VERSAO = "v16"

# Sinal de vida: a cada 20 s loga o que está fazendo (para saber se travou ou só está lento)
_estado = {"etapa": "iniciando", "desde": time.time()}


def _etapa(texto: str) -> None:
    _estado.update(etapa=texto, desde=time.time())
    log.info("    %s", texto)


def _batimento(parar: threading.Event, intervalo: int = 20) -> None:
    while not parar.wait(intervalo):
        log.info("    ... ainda em: %s (%ds)", _estado["etapa"], int(time.time() - _estado["desde"]))

PAGINAS_POR_ARQUIVO = 6          # capa + preâmbulo bastam
MAX_BYTES = 40 * 1024 * 1024
MAX_ARQUIVOS = 4
PESO_MIN_GRAVAR = 4              # só "Administrativo", "SEI" ou "Licitatório" podem substituir numero_processo
PESO_MIN_IGUAL_EDITAL = 4        # abaixo disso, candidato igual ao nº do edital é descartado
TRECHO_CHARS = 90

# Qualificador -> peso (maior = mais confiável como processo administrativo)
_QUALIF = [
    (r"ADMINISTRATIVO", 5),
    (r"SEI", 5),
    (r"LICITATORIO", 4),
    (r"DE\s+COMPRAS?", 3),
    (r"INTERNO", 3),
    (r"DE\s+CONTRATACAO", 3),
    (r"", 1),                     # "Processo nº 137/2026" puro
]
_NUM = r"(\d[\d.\-/]{0,40}\d|\d)"
_NO = r"(?:N\s*[ºO°\.]*\s*|NUMERO\s*|NRO\.?\s*)?"
_PADROES = [
    (re.compile(rf"\bPROCESSO\s+{q}\s*{_NO}[:\-–]?\s*{_NUM}" if q else rf"\bPROCESSO\s*{_NO}[:\-–]?\s*{_NUM}"), peso)
    for q, peso in _QUALIF
]
_ANO = re.compile(r"(?<!\d)(19|20)\d{2}(?!\d)")


@dataclass
class Candidato:
    numero: str
    peso: int
    trecho: str


@dataclass
class Achado:
    """Resultado da busca numa compra. status: 'encontrado' | 'nao_encontrado' | 'falha'."""
    status: str
    processo: str | None = None
    fonte: str = ""               # 'metadados' | 'edital'
    arquivo: str | None = None
    peso: int = 0
    trecho: str = ""
    motivo: str = ""              # detalhe da falha, quando houver


def _normalizar(t: str) -> str:
    t = unicodedata.normalize("NFKD", t or "")
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    return re.sub(r"[ \t ]+", " ", t.upper())


def digitos(v: str | None) -> str:
    return re.sub(r"\D", "", v or "")


def tem_ano(v: str | None) -> bool:
    return bool(_ANO.search(v or ""))


def fraco(v: str | None) -> bool:
    """Processo que não identifica o certame: vazio, ou sem ano e com menos de 5 dígitos."""
    d = digitos(v)
    return not d or (not tem_ano(v) and len(d) < 5)


def _grupos(v: str | None) -> list[str]:
    """Grupos numéricos sem zeros à esquerda: '004/2026' -> ['4', '2026']."""
    return [g.lstrip("0") or "0" for g in re.findall(r"\d+", v or "")]


def igual_ao_edital(numero: str, edital: str | None) -> bool:
    """O candidato é o próprio número do edital/pregão? ('004/2026' x 'PE nº 4/2026' -> True).
    Se o rótulo do edital não tem ano ('Pregão nº 4'), compara só o primeiro grupo."""
    ge, gn = _grupos(edital), _grupos(numero)
    if not ge or not gn:
        return False
    if ge == gn:
        return True
    return len(ge) == 1 and gn[0] == ge[0]


def candidatos_ctx(texto: str) -> list[Candidato]:
    """Candidatos com peso e o trecho do texto onde foram achados, na ordem de aparição."""
    t = _normalizar(texto)
    achados: list[tuple[int, Candidato]] = []
    for rx, peso in _PADROES:
        for m in rx.finditer(t):
            num = m.group(1).strip(".-/")
            if num:
                trecho = re.sub(r"\s+", " ", t[m.start(): m.start() + TRECHO_CHARS]).strip()
                achados.append((m.start(), Candidato(num, peso, trecho)))
    # um mesmo trecho casa com o padrão específico e com o genérico: fica o de maior peso
    por_pos: dict[int, Candidato] = {}
    for pos, c in achados:
        if pos not in por_pos or c.peso > por_pos[pos].peso:
            por_pos[pos] = c
    return [por_pos[p] for p in sorted(por_pos)]


def candidatos(texto: str) -> list[tuple[str, int]]:
    """Lista (numero, peso) encontrados no texto, na ordem de aparição."""
    return [(c.numero, c.peso) for c in candidatos_ctx(texto)]


def escolher_ctx(cands: list[Candidato], atual: str | None, edital: str | None = None,
                 resumo: Counter | None = None) -> Candidato | None:
    """Melhor candidato forte (com ano ou >= 5 dígitos). Prioriza peso, depois compatibilidade com o
    número curto do PNCP (ex.: '4' combina com '004/2026'), depois frequência.
    Candidato igual ao número do edital com peso < PESO_MIN_IGUAL_EDITAL é descartado."""
    fortes = []
    for c in cands:
        if fraco(c.numero):
            continue
        if edital and c.peso < PESO_MIN_IGUAL_EDITAL and igual_ao_edital(c.numero, edital):
            if resumo is not None:
                resumo["bloqueado_edital"] += 1
            log.info("    descartado (igual ao nº do edital '%s'): %s | %s", edital, c.numero, c.trecho)
            continue
        fortes.append(c)
    if not fortes:
        return None
    freq = Counter(digitos(c.numero) for c in fortes)
    d_atual = digitos(atual).lstrip("0")

    def nota(c: Candidato):
        d = digitos(c.numero)
        compat = 1 if d_atual and d.lstrip("0").startswith(d_atual) else 0
        return (c.peso, compat, freq[d], tem_ano(c.numero))

    return max(fortes, key=nota)


def escolher(cands: list[tuple[str, int]], atual: str | None, edital: str | None = None) -> str | None:
    c = escolher_ctx([Candidato(n, p, "") for n, p in cands], atual, edital)
    return c.numero if c else None


def _ordem_arquivos(arqs: list[dict]) -> list[dict]:
    def prio(a):
        tipo = _normalizar(a.get("tipoDocumentoNome") or "")
        nome = _normalizar(a.get("titulo") or "")
        if "EDITAL" in tipo or "EDITAL" in nome:
            return 0
        if "AVISO" in tipo or "AVISO" in nome or "CAPA" in nome:
            return 1
        if "TERMO DE REFERENCIA" in tipo or "TERMO" in nome:
            return 2
        return 3
    return sorted([a for a in arqs if a.get("statusAtivo", True)], key=prio)


def processo_do_edital(pncp: PNCP, c: dict, atual: str | None, resumo: Counter,
                       edital: str | None = None) -> Achado:
    """Procura o processo nos metadados e depois nos arquivos da compra.
    Nunca transforma falha em 'nao_encontrado' (regra 1 do licitagym-core)."""
    _etapa("consultando detalhe da compra no PNCP")
    try:
        det = pncp.compra(c)
    except Exception as e:
        # o detalhe só enriquece; seguimos para os arquivos, mas a falha fica registrada
        log.warning("    detalhe indisponível: %s", e)
        resumo["falha_detalhe"] += 1
        det = {}
    meta = " \n".join(str(det.get(k) or "") for k in ("objetoCompra", "informacaoComplementar")) + " \n" + (c.get("title") or "")
    cand = escolher_ctx(candidatos_ctx(meta), atual, edital, resumo)
    if cand:
        return Achado("encontrado", cand.numero, "metadados", None, cand.peso, cand.trecho)

    _etapa("listando arquivos da compra")
    try:
        arqs = _ordem_arquivos(pncp.arquivos(c))
    except Exception as e:
        log.warning("    arquivos indisponíveis: %s", e)
        resumo["falha_arquivos"] += 1
        return Achado("falha", motivo=f"arquivos: {e}")
    if not arqs:
        return Achado("nao_encontrado", motivo="compra sem arquivos ativos")

    baixados = 0
    for a in arqs[:MAX_ARQUIVOS]:
        url, nome = a.get("url") or a.get("uri"), a.get("titulo") or "arquivo"
        _etapa(f"baixando {nome[:60]}")
        try:
            conteudo, _ = pncp.baixar(url, MAX_BYTES)
        except Exception as e:
            log.warning("    falha ao baixar %s: %s", nome[:60], e)
            resumo["falha_download"] += 1
            continue
        baixados += 1
        _etapa(f"lendo {nome[:50]} ({len(conteudo) / 1048576:.1f} MB)")
        res = extrair(conteudo, nome)
        resumo["escaneados"] += len(res.pdfs_escaneados)
        # primeiras páginas de cada arquivo (em ZIP, cada PDF interno conta separado)
        vistos: Counter = Counter()
        texto = []
        for pg in res.paginas:
            if vistos[pg.origem] < PAGINAS_POR_ARQUIVO:
                texto.append(pg.texto)
                vistos[pg.origem] += 1
        cand = escolher_ctx(candidatos_ctx("\n".join(texto)), atual, edital, resumo)
        if cand:
            return Achado("encontrado", cand.numero, "edital", nome, cand.peso, cand.trecho)
    if baixados == 0:
        return Achado("falha", motivo="nenhum arquivo pôde ser baixado")
    return Achado("nao_encontrado", motivo=f"{baixados} arquivo(s) lidos sem processo forte")


def _registro(ach: Achado, atual: str | None) -> dict:
    return {
        "valor": ach.processo, "fonte": ach.fonte, "arquivo": ach.arquivo, "peso": ach.peso,
        "trecho": ach.trecho, "processo_pncp": atual, "versao": VERSAO,
        "em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="não grava; só mostra")
    ap.add_argument("--todos", action="store_true", help="avalia também compras com processo que já parece completo")
    ap.add_argument("--limite", type=int, help="máximo de compras a processar")
    ap.add_argument("--gravar-numero-processo", action="store_true",
                    help=f"também substitui numero_processo quando o peso do candidato for >= {PESO_MIN_GRAVAR}")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    pncp = PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5")))
    linhas = sb.selecionar("licitacoes_externas", fonte="eq.pncp", select="id,codigo_externo,numero_processo,numero_edital,raw")
    alvo = [ln for ln in linhas if a.todos or fraco(ln.get("numero_processo"))]
    if a.limite:
        alvo = alvo[: a.limite]
    log.info("%s | %d compras PNCP, %d com processo fraco a verificar", VERSAO, len(linhas), len(alvo))

    resumo: Counter = Counter(lidas=0, encontrados=0, nao_encontrado=0, falha=0, codigo_invalido=0,
                              gravado_raw=0, gravado_numero_processo=0, revisar_peso_baixo=0)
    parar = threading.Event()
    threading.Thread(target=_batimento, args=(parar,), daemon=True).start()
    for i, ln in enumerate(alvo, 1):
        resumo["lidas"] += 1
        log.info("[%d/%d] %s (processo PNCP: %s | edital: %s)", i, len(alvo), ln.get("codigo_externo"),
                 ln.get("numero_processo"), ln.get("numero_edital"))
        m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", ln.get("codigo_externo") or "")
        if not m:
            resumo["codigo_invalido"] += 1
            log.warning("  código externo fora do padrão PNCP: %r", ln.get("codigo_externo"))
            continue
        c = {"orgao_cnpj": m.group(1), "numero_sequencial": int(m.group(2)), "ano": int(m.group(3)),
             "numero_controle_pncp": ln["codigo_externo"], "title": ln.get("numero_edital")}
        atual = ln.get("numero_processo")
        ach = processo_do_edital(pncp, c, atual, resumo, edital=ln.get("numero_edital"))
        if ach.status == "falha":
            resumo["falha"] += 1
            log.warning("  %s: FALHA (%s) — não é 'não encontrado'", ln["codigo_externo"], ach.motivo)
            continue
        if ach.status != "encontrado" or digitos(ach.processo) == digitos(atual):
            resumo["nao_encontrado"] += 1
            log.info("  %s: PNCP=%s -> nada melhor no edital (%s)", ln["codigo_externo"], atual, ach.motivo or "igual ao PNCP")
            continue
        resumo["encontrados"] += 1
        pode_trocar = ach.peso >= PESO_MIN_GRAVAR
        if not pode_trocar:
            resumo["revisar_peso_baixo"] += 1
        log.info("  %s: PNCP=%s -> %s (peso %d, %s%s)%s", ln["codigo_externo"], atual, ach.processo, ach.peso,
                 ach.fonte, f": {ach.arquivo[:60]}" if ach.arquivo else "",
                 "" if pode_trocar else "  [REVISAR: peso baixo]")
        log.info("      trecho: \"%s\"", ach.trecho)
        if a.dry_run:
            continue
        raw = dict(ln.get("raw") or {})
        raw["processo_extraido"] = _registro(ach, atual)
        campos: dict = {"raw": raw}
        if a.gravar_numero_processo and pode_trocar:
            raw.setdefault("processo_pncp", atual)
            campos["numero_processo"] = ach.processo
            resumo["gravado_numero_processo"] += 1
        sb.atualizar("licitacoes_externas", ln["id"], campos)
        resumo["gravado_raw"] += 1
    parar.set()

    soma = resumo["encontrados"] + resumo["nao_encontrado"] + resumo["falha"] + resumo["codigo_invalido"]
    if soma != resumo["lidas"]:
        log.error("contagem inconsistente: lidas=%d, soma dos resultados=%d", resumo["lidas"], soma)
    log.info("RESUMO%s: %s", " (dry-run)" if a.dry_run else "", dict(resumo))
    return 2 if resumo["falha"] or soma != resumo["lidas"] else 0


if __name__ == "__main__":
    raise SystemExit(main())

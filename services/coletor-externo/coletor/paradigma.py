"""Adaptador genérico para portais de compras na plataforma Paradigma (Sistema S).

Os portais Paradigma expõem o mesmo webservice JSON interno que a página do mural usa:
  POST <base>/WebService/Servicos.asmx/<Metodo>   (Content-Type: application/json)

Validado em 24/09/2026 (só leitura, conteúdo público, sem login):
  - SEST SENAT  compras.sestsenat.org.br/portal          (coletor original, portal.py)
  - FIESC       portaldecompras.fiesc.com.br/portal      (SESI/SC, SENAI/SC, IEL/SC)

Métodos usados (todos públicos no mural):
  PesquisarProcessos                         lista/busca por texto do objeto (paginada)
  PesquisarProcessoDetalhes                  detalhe (usar nCdOrigem da listagem como nCdProcesso)
  PesquisarProcessoDetalheItemProduto        itens (nCdLote=0): descrição, qtd, unidade, valor de referência, situação
  PesquisarProcessoDetalheItemProdutoLance   lances por item (ranking, empresa+CNPJ, marca, modelo, valor, troféu
                                             bFlVencedor). Fonte principal de resultado; pregão (ex.: SFIEC módulo 18)
                                             só responde aqui. Exige nCdTipoModalidade=0 (null -> HTTP 500).
  PesquisarProcessoClassificacaoItemLoteEmpresas  classificação por item/lote (seleção/credenciamento, ex.: FIESC m59);
                                             fallback quando não há lances. Em pregão devolve HTTP 500.
  PesquisarCatalogoProdutoClasses / PesquisarCatalogoProdutos  catálogo do portal (filtro Categoria + Tipo)
  PesquisarAnexos / PesquisarAnexosProcessoContratacao  anexos (reaproveita portal.py)

Portais Paradigma hospedados em paradigmabs.com.br (Sesc SP, Sesc/Senac RS) declaram no robots.txt
que não aceitam acesso automatizado: o adaptador recusa essas fontes (ver FONTES).

Paginação (regra de 03/10/2026): cada faixa pede no máximo 100 itens (`nPaginaDe`/`nPaginaAte`).
A resposta observada do webservice é uma lista, sem total de registros. Página curta não encerra.
Sem total, a coleta segue até uma página vazia. Com a faixa alinhada, `totalRegistros`,
`total`, `totalPaginas` ou `paginasRestantes` encerram quando confirmam o fim. Depois de uma
página curta intermediária, `totalPaginas` e `paginasRestantes` deixam de encerrar: vale
`totalRegistros`/`total` ou a página vazia. Há um limite de segurança
de MAX_PAGINAS_SEGURANCA páginas (e detecção de página repetida); os dois param com aviso no log
e não contam como fim confirmado. `--paginas` é teto opcional; omitido, coleta até o fim.
CPF e CNPJ de documento de licitação ficam íntegros (decisão de 01/10/2026): não se mascaram.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .paginacao import TAMANHO_PAGINA_MAX, avaliar_pagina, clamp_tamanho, pagina_repetida
from .perfil_item import normalizar_marca, perfil_item, texto_do_item
from .escopo import ITEM_FORA, classificar, contexto_academia, e_peca, classificar_texto_item, interesse_borracha, normalizar
from .portal import cnpj_ou_none, limpar, parse_data

log = logging.getLogger("coletor.paradigma")

UA = "LicitaGym-Coletor/1.1 (pesquisa de licitações públicas)"


@dataclass(frozen=True)
class Fonte:
    slug: str
    entidade: str
    uf: str | None
    base: str
    coleta_automatica: bool  # False = robots.txt proíbe; usar aviso de fornecedor/manual


FONTES: dict[str, Fonte] = {
    "sestsenat": Fonte("sestsenat", "SEST SENAT", None, "https://compras.sestsenat.org.br/portal", True),
    "fiesc": Fonte("fiesc", "FIESC (SESI/SC, SENAI/SC, IEL/SC)", "SC", "https://portaldecompras.fiesc.com.br/portal", True),
    "sescsp": Fonte("sescsp", "Sesc SP", "SP", "https://scr360.paradigmabs.com.br/sescsp/portal", False),
    "sesc_senac_rs": Fonte("sesc_senac_rs", "Sesc/Senac RS", "RS", "https://egov.paradigmabs.com.br/sesc_senac_rs/portal", False),
    # Tenants self-hosted testados ao vivo em 26/09/2026 (webservice público; robots.txt ausente/404)
    "firjan": Fonte("firjan", "Firjan (SESI/RJ, SENAI/RJ, IEL/RJ)", "RJ", "https://portaldecompras.firjan.com.br/portal", True),
    "fiergs": Fonte("fiergs", "FIERGS (SESI/RS, SENAI/RS, IEL/RS)", "RS", "https://compras.sistemafiergs.org.br/portal", True),
    "findes": Fonte("findes", "Findes (SESI/ES, SENAI/ES, IEL/ES)", "ES", "https://portaldecompras.findes.org.br/portal", True),
    "fieb": Fonte("fieb", "FIEB (SESI/BA, SENAI/BA, IEL/BA)", "BA", "https://compras.fieb.org.br/portal", True),
    "fiems": Fonte("fiems", "FIEMS (SESI/MS, SENAI/MS)", "MS", "https://compras.fiems.com.br/portal", True),
    "fiemt": Fonte("fiemt", "FIEMT (SESI/MT, SENAI/MT)", "MT", "https://compras.sfiemt.ind.br/portal", True),
    "sfiec": Fonte("sfiec", "SFIEC (SESI/CE, SENAI/CE, IEL/CE)", "CE", "https://portaldecompras.sfiec.org.br/portal", True),
    # FIEMG: Cloudflare recusa cliente automatizado (403 no webservice para Python; navegador passa). Não contornar.
    "fiemg": Fonte("fiemg", "FIEMG (SESI/MG, SENAI/MG, IEL/MG)", "MG", "https://compras.fiemg.com.br/portal", False),
    # SaaS paradigmabs.com.br: robots.txt proíbe acesso automatizado
    "sescdn": Fonte("sescdn", "Sesc Departamento Nacional", None, "https://egov-br.paradigmabs.com.br/sescdn/portal", False),
    "sescrj": Fonte("sescrj", "Sesc RJ", "RJ", "https://egov.paradigmabs.com.br/SESCRJ/portal", False),
    "sescba": Fonte("sescba", "Sesc BA", "BA", "https://egov.paradigmabs.com.br/sescba/portal", False),
}

# Decisão de 05/10/2026: robots.txt desses hosts não impede a coleta. O webservice
# público do mural entra com o mesmo intervalo do adaptador. FIEMG fica de fora (WAF).
FONTES_MURAL_AUTORIZADO = frozenset({"sescsp", "sesc_senac_rs", "sescdn", "sescrj", "sescba"})


def autorizado_para_coleta(fonte: Fonte) -> bool:
    """Override explícito do bloqueio de robots.txt. Não cobre bloqueio de WAF."""
    return fonte.slug in FONTES_MURAL_AUTORIZADO

MODULO_PADRAO = 59

# Filtro "Tipo" do catálogo (CatalogoProdutos.aspx: Todos / Produto / Serviço)
TIPOS_CATALOGO = {"todos": 0, "produto": 1, "servico": 2}
# Filtro "Categoria" já mapeado (catálogo SFIEC, 26/09/2026): AI03 = EQUIPAMENTOS ESPORTIVOS; NE53 e MC06 = ESPORTIVO.
# Casamento por nome exato (normalizado), porque o autocomplete devolve várias classes por prefixo.
CATEGORIAS_MAPEADAS = ["EQUIPAMENTOS ESPORTIVOS", "ESPORTIVO"]
# Regra de 03/10/2026: no máximo 100 itens por página.
TAMANHO_PAGINA = TAMANHO_PAGINA_MAX
# Teto contra laço infinito quando a API não devolve página vazia nem total.
# 1000 páginas × 100 itens = 100_000 registros pedidos por consulta. Ao atingir, para com aviso.
MAX_PAGINAS_SEGURANCA = 1000
DELAY_MINIMO = 1.0
_CHAVES_TOTAL = ("totalRegistros", "totalPaginas", "paginasRestantes", "total")


def modulo_de(x: dict | None) -> int:
    """nCdModulo vindo do portal (listagem/detalhe). Alguns tenants usam 18 (ex.: FIEMS, SFIEC); 59 é o padrão."""
    m = (x or {}).get("nCdModulo")
    return m if isinstance(m, int) and not isinstance(m, bool) and m > 0 else MODULO_PADRAO


def _intervalo(pagina_de: int, pagina_ate: int) -> tuple[int, int]:
    """Faixa inclusiva de no máximo 100 itens. Pedido maior é cortado e registrado."""
    de = max(1, int(pagina_de))
    ate = int(pagina_ate)
    if ate < de:
        ate = de
    pedido = ate - de + 1
    tamanho = clamp_tamanho(pedido, padrao=TAMANHO_PAGINA, minimo=1, maximo=TAMANHO_PAGINA_MAX)
    if tamanho != pedido:
        log.warning("intervalo %s–%s pedia %s itens; limitado a %s", de, ate, pedido, tamanho)
    return de, de + tamanho - 1


def _trecho_resposta(resp: Any, limite: int = 200) -> str:
    """Trecho curto do corpo para a mensagem de erro. Não despeja a página inteira."""
    try:
        texto = json.dumps(resp, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        texto = repr(resp)
    if len(texto) <= limite:
        return texto
    return texto[:limite] + "…"


def _itens_e_total(resp: Any, *, rotulo: str) -> tuple[list, dict]:
    """Separa a lista e o total, se a API informar.

    Página vazia só com lista (`[]` inclusive) ou com objeto cuja chave reconhecida
    (`resultado`, `itens`, `lista` ou `d`) seja uma lista, ainda que vazia. HTTP 200
    com `d` nulo, string, ou objeto sem essa lista não é fim: levanta erro.
    O webservice observado devolve `d` como lista, sem total. Se o objeto trouxer
    `totalRegistros`, `totalPaginas`, `paginasRestantes` ou `total`, o total entra
    na decisão de parada.
    """
    if isinstance(resp, list):
        return resp, {}
    if isinstance(resp, dict):
        corpo = {k: resp[k] for k in _CHAVES_TOTAL if k in resp}
        for chave in ("resultado", "itens", "lista", "d"):
            if isinstance(resp.get(chave), list):
                return resp[chave], corpo
    raise RuntimeError(
        f"{rotulo}: resposta sem lista reconhecida; não é fim de coleta ({_trecho_resposta(resp)})")


def paginar_intervalo(buscar, *, tamanho: int = TAMANHO_PAGINA, max_paginas: int | None = None,
                      max_itens: int | None = None, rotulo: str = "paradigma") -> tuple[list, list[str]]:
    """Percorre faixas inclusivas de no máximo 100 itens.

    `buscar(de, ate)` devolve a página. Sem total, só uma página vazia encerra; página
    curta não. Lista vazia, ou objeto com lista reconhecida vazia, é página vazia.
    Envelope sem essa lista (nulo, string, objeto só com mensagem) levanta erro.
    Com a faixa ainda alinhada, `avaliar_pagina` encerra quando o total confirma o fim.
    Depois de uma página curta intermediária a faixa deixa de coincidir com o número
    da página: `totalPaginas` e `paginasRestantes` não encerram mais. Segue
    `totalRegistros`/`total` (pelo acumulado) ou uma página vazia.
    `max_paginas` e `max_itens` são tetos opcionais (avisam se cortarem antes do fim).
    Sem eles, o corte é `MAX_PAGINAS_SEGURANCA` ou página de conteúdo repetido: os dois
    param com aviso e não são fim confirmado. A faixa seguinte começa depois do último
    item recebido, para uma página curta não pular o que a API não devolveu.
    """
    tamanho = clamp_tamanho(tamanho, padrao=TAMANHO_PAGINA, minimo=1, maximo=TAMANHO_PAGINA_MAX)
    if max_paginas is not None and max_paginas < 1:
        raise ValueError("max_paginas deve ser >= 1")
    if max_itens is not None and max_itens < 1:
        raise ValueError("max_itens deve ser >= 1")
    out: list = []
    avisos: list[str] = []
    vistas: set[str] = set()
    de = 1
    pagina = 1
    # Página curta intermediária avança `de` por len(itens), não por uma página cheia.
    # A partir daí o contador `pagina` não é o número de página da API.
    desalinhada = False
    avisou_desalinhada = False

    def _aviso(msg: str) -> None:
        avisos.append(msg)
        log.warning("%s", msg)

    while True:
        if pagina > MAX_PAGINAS_SEGURANCA:
            _aviso(f"{rotulo}: limite de segurança de {MAX_PAGINAS_SEGURANCA} páginas "
                   f"(até {MAX_PAGINAS_SEGURANCA * tamanho} itens pedidos); interrompendo")
            break
        if max_paginas is not None and pagina > max_paginas:
            _aviso(f"{rotulo}: teto opcional de {max_paginas} páginas atingido sem o total confirmar o fim")
            break
        if max_itens is not None and len(out) >= max_itens:
            _aviso(f"{rotulo}: teto opcional de {max_itens} itens atingido sem o total confirmar o fim")
            break
        falta = None if max_itens is None else max_itens - len(out)
        pedido = tamanho if falta is None else min(tamanho, falta)
        ate = de + pedido - 1
        resp = buscar(de, ate)
        itens, corpo = _itens_e_total(resp, rotulo=f"{rotulo} página {pagina}")
        if pagina_repetida(itens, vistas) and itens:
            _aviso(f"{rotulo} página {pagina} ({de}–{ate}): conteúdo repetido; "
                   "interrompendo para não laçar (não é fim confirmado)")
            break
        out.extend(itens)
        corpo_decisao = corpo
        if desalinhada:
            corpo_decisao = {k: v for k, v in corpo.items() if k not in ("totalPaginas", "paginasRestantes")}
            if not avisou_desalinhada and any(k in corpo for k in ("totalPaginas", "paginasRestantes")):
                if any(k in corpo_decisao for k in ("totalRegistros", "total")):
                    texto = ("faixa desalinhada após página curta; totalPaginas/paginasRestantes "
                             "ignorados; parada por totalRegistros/total ou página vazia")
                else:
                    texto = ("faixa desalinhada após página curta; totalPaginas/paginasRestantes "
                             "não encerram; seguindo até página vazia")
                _aviso(f"{rotulo}: {texto}")
                avisou_desalinhada = True
        decisao = avaliar_pagina(
            itens, tamanho=pedido, pagina=pagina, corpo=corpo_decisao, acumulado=len(out))
        if decisao.aviso:
            _aviso(f"{rotulo} página {pagina}: {decisao.aviso}")
        if decisao.encerrar or not itens:
            break
        if len(itens) < pedido:
            desalinhada = True
        de += len(itens)
        pagina += 1
    return out, avisos


# Paradigma usa System.Decimal.MinValue como "vazio" em campos monetários
_DECIMAL_NULO_LIMITE = -1e20
_ITEM_SEQ = re.compile(r"^\s*(\d+)\s*-\s*")


def valor(v: Any) -> float | None:
    """Valores monetários: sentinela (Decimal.MinValue), zero ou negativos -> None."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 and v > _DECIMAL_NULO_LIMITE:
        return float(v)
    return None


def status_normalizado(situacao: str | None) -> str:
    s = normalizar(situacao or "")
    if not s:
        return "desconhecida"
    if "homolog" in s and "parcial" in s:
        return "homologada"
    if any(k in s for k in ("fracass", "desert")):
        return "sem_vencedor"
    if "homolog" in s:
        return "homologada"
    if any(k in s for k in ("cancel", "revog", "anul", "suspens")):
        return "cancelada" if "suspens" not in s else "suspensa"
    if any(k in s for k in ("julg", "analis", "habilit", "negocia", "disputa", "lance")):
        return "em_julgamento"
    if any(k in s for k in ("andamento", "public", "recebend", "aberto", "abert")):
        return "aberta"
    if any(k in s for k in ("encerr", "finaliz", "adjudic", "conclu")):
        return "encerrada"
    return "desconhecida"


FUSO_BRASILIA = timezone(timedelta(hours=-3))


def prioridade_da_compra(status_norm: str, data_fim_iso: str | None, agora: datetime | None = None) -> tuple[str | None, str]:
    """(prioridade, motivo) pelo estado da compra, alinhado à semântica do PNCP e à view de prioridade efetiva:
    - leads: compra aberta e recebendo proposta (prazo data_fim futuro);
    - monitorar: em julgamento, suspensa, ou aberta com prazo de proposta vencido;
    - historico: encerrada, homologada, cancelada, sem vencedor (fracassada/deserta);
    - None (desconhecida): padrão conservador, não vira lead, registra aviso no log."""
    if status_norm in ("encerrada", "homologada", "cancelada", "sem_vencedor"):
        return "historico", f"status {status_norm}"
    if status_norm in ("em_julgamento", "suspensa"):
        return "monitorar", f"status {status_norm}"
    if status_norm == "aberta":
        if not data_fim_iso:
            return "monitorar", "aberta sem prazo de proposta"
        agora = agora or datetime.now(timezone.utc)
        fim = datetime.fromisoformat(data_fim_iso.replace("Z", "+00:00"))
        if fim.tzinfo is None:
            fim = fim.replace(tzinfo=FUSO_BRASILIA)
        if fim > agora:
            return "leads", "recebendo proposta"
        return "monitorar", "prazo de proposta vencido"
    log.warning("Situação desconhecida do portal não mapeada para lead: status=%s", status_norm)
    return None, f"status {status_norm} desconhecido"


def acionabilidade(status: str, data_fim_iso: str | None, agora: datetime | None = None) -> str:
    """ACTIONABLE só com prazo oficial futuro e status aberto. Sem prazo -> UNRESOLVED (regra do PRD)."""
    if status in ("homologada", "cancelada", "sem_vencedor", "encerrada"):
        return "NOT_ACTIONABLE"
    if status == "aberta" and data_fim_iso:
        agora = agora or datetime.now(timezone.utc)
        return "ACTIONABLE" if datetime.fromisoformat(data_fim_iso) > agora else "NOT_ACTIONABLE"
    return "ACTIONABILITY_UNRESOLVED"


def partes_item(s_ds_item: str | None) -> dict:
    """'1 - Categoria\\r\\nVariação: X\\r\\nDescrição: ...' -> {sequencial, categoria, variacao, descricao}."""
    texto = (s_ds_item or "").replace("\r\n", "\n").strip()
    linhas = [l.strip() for l in texto.split("\n")]
    primeira = linhas[0] if linhas else ""
    m = _ITEM_SEQ.match(primeira)
    seq = int(m.group(1)) if m else None
    categoria = _ITEM_SEQ.sub("", primeira).strip() or None
    variacao = None
    for l in linhas[1:]:
        if normalizar(l).startswith("variacao:"):
            variacao = l.split(":", 1)[1].strip() or None
            break
    return {"sequencial": seq, "categoria": categoria, "variacao": variacao, "descricao": texto or None}


def e_servico(categoria: str | None, descricao: str | None) -> bool:
    t = normalizar(f"{categoria or ''} {(descricao or '')[:200]}")
    return bool(re.search(r"\bservicos?\b|manutencao|instalacao e|locacao|assistencia tecnica|consultoria|credenciamento", t))


def classificar_item_detalhe(it: dict, produtos: dict[int, dict] | None = None,
                             contexto: bool = False) -> tuple[str | None, bool, str, str]:
    """(categoria_escopo, interesse_borracha, material_ou_servico, escopo_metodo) para um item Paradigma.
    `produtos`: nCdProduto -> produto do catálogo filtrado por Tipo+Categoria (ver PortalParadigma.produtos_escopo).
    Ordem: serviço (gate) > ITEM_FORA (balança etc., mesmo estando na categoria) > catálogo > regras de texto."""
    p = partes_item(it.get("sDsItem"))
    texto = " ".join(x for x in (p["categoria"], p["variacao"], p["descricao"]) if x)
    ms = "S" if e_servico(p["categoria"], p["descricao"]) else "M"
    if ms == "S":
        return None, False, ms, "regra"  # gate MATERIAL_SCOPE: serviço não é oportunidade de material
    if produtos and it.get("nCdProduto") in produtos:
        if ITEM_FORA.search(normalizar(texto)):
            return None, False, ms, "catalogo"
        cat = "manutencao" if e_peca(normalizar(texto)) else "forte"  # ex.: MOLA PARA TRAMPOLIM (peça)
        return cat, interesse_borracha(texto, cat), ms, "catalogo"
    cat, metodo = classificar_texto_item(texto, contexto)
    return cat, interesse_borracha(texto, cat), ms, metodo


def classificar_item(it: dict, produtos: dict[int, dict] | None = None, contexto: bool = False) -> tuple[str | None, bool, str]:
    """(categoria_escopo, interesse_borracha, material_ou_servico) para um item Paradigma."""
    return classificar_item_detalhe(it, produtos, contexto)[:3]


class PortalParadigma:
    def __init__(self, fonte: Fonte, delay: float = 1.5, timeout: int = 60, autorizado: bool = False,
                 sessao: requests.Session | None = None):
        if not fonte.coleta_automatica and not autorizado:
            raise PermissionError(
                f"{fonte.slug}: o host proíbe coleta automatizada (robots.txt ou WAF). "
                "Use aviso de fornecedor/coleta manual, ou passe autorizado=True com autorização formal da entidade.")
        self.fonte = fonte
        if delay < DELAY_MINIMO:
            log.warning("delay %s s abaixo do mínimo de %s s; usando %s s", delay, DELAY_MINIMO, DELAY_MINIMO)
            delay = DELAY_MINIMO
        self.delay = delay
        self._sem_classificacao: set[int] = set()  # módulos em que a aba Classificação não existe (500)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
        if sessao is None:
            self.s.get(f"{fonte.base}/Mural.aspx", timeout=timeout)  # cookies de sessão ASP.NET

    def _ws(self, metodo: str, body: dict) -> Any:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        for tentativa in range(4):
            try:
                r = self.s.post(f"{self.fonte.base}/WebService/Servicos.asmx/{metodo}", data=payload,
                                headers={"Content-Type": "application/json; charset=utf-8"}, timeout=self.timeout)
                time.sleep(self.delay)
                if r.status_code == 200:
                    return limpar(r.json().get("d"))
                if r.status_code >= 500 and tentativa < 3:
                    time.sleep(2 ** tentativa * 2)
                    continue
                r.raise_for_status()
            except requests.RequestException:
                if tentativa == 3:
                    raise
                time.sleep(2 ** tentativa * 2)
        raise RuntimeError(f"{metodo}: sem resposta após 4 tentativas")  # nunca devolve vazio em silêncio

    # ------------ listagem ------------
    def listar(self, texto: str = "", pagina_de: int = 1, pagina_ate: int = TAMANHO_PAGINA) -> list[dict]:
        pagina_de, pagina_ate = _intervalo(pagina_de, pagina_ate)
        r = self._ws("PesquisarProcessos", {"dtoProcesso": {
            "nAnoFinalizacao": 0, "tmpTipoMuralProcesso": 2, "nCdModulo": 0, "nCdModalidade": 0,
            "nCdModalidadeFase": 0, "nCdTipoModalidade": 0, "tmpTipoMuralVisao": 0, "nCdSituacao": 0,
            "nCdTipoProcesso": 0, "nCdEmpresa": 0, "sNrProcesso": "", "nCdProcesso": 0, "sDsObjeto": texto,
            "sDtPeriodoDe": "", "sDtPeriodoAte": "", "sOrdenarPor": "NCDPROCESSO", "sOrdenarPorDirecao": "DESC",
            "dtoPaginacao": {"nPaginaDe": pagina_de, "nPaginaAte": pagina_ate}, "dtoIdioma": {"nCdIdioma": 1}}})
        if r is None:
            raise RuntimeError("PesquisarProcessos devolveu null")
        return r

    def listar_encerrados(self, texto: str, ano: int, pagina_de: int = 1, pagina_ate: int = TAMANHO_PAGINA) -> list[dict]:
        """Mural estatístico (processos finalizados por ano). Traz dVlEstimado/dVlNegociado/dVlEconomia e
        tDtEncerrado, que o detalhe não traz. Corpo igual ao capturado no HAR do portal SFIEC (26/09/2026)."""
        pagina_de, pagina_ate = _intervalo(pagina_de, pagina_ate)
        r = self._ws("PesquisarProcessosMuralEstatistico", {"dtoProcesso": {
            "nAnoFinalizacao": ano, "tmpTipoMuralProcesso": 1, "nCdModulo": 0, "nCdModalidade": 0,
            "nCdModalidadeFase": 0, "nCdTipoModalidade": 0, "tmpTipoMuralVisao": 0, "nCdSituacao": 0,
            "nCdTipoProcesso": 0, "nCdEmpresa": 0, "sNrProcesso": "", "nCdProcesso": 0, "sDsObjeto": texto,
            "sDtPeriodoDe": "", "sDtPeriodoAte": "", "sOrdenarPor": "TDTINICIAL", "sOrdenarPorDirecao": "DESC",
            "dtoPaginacao": {"nPaginaDe": pagina_de, "nPaginaAte": pagina_ate}, "dtoIdioma": {"nCdIdioma": 1}}})
        if r is None:
            raise RuntimeError("PesquisarProcessosMuralEstatistico devolveu null")
        return r

    # ------------ processo ------------
    def detalhes(self, id_processo: int, modulo: int = 59) -> dict | None:
        return self._ws("PesquisarProcessoDetalhes", {"dtoProcesso": {
            "nCdProcesso": id_processo, "nCdModulo": modulo, "tmpTipoMuralProcesso": 0,
            "dtoIdioma": {"nCdIdioma": 1}}})

    def itens(self, d: dict) -> list[dict]:
        r = self._ws("PesquisarProcessoDetalheItemProduto", {"dtoProcesso": {
            "nCdProcesso": d["nCdProcesso"], "nCdModulo": modulo_de(d), "sNrProcesso": d.get("sNrProcesso"),
            "nCdSituacao": d.get("nCdSituacao"), "tmpTipoMuralProcesso": 0, "nCdLote": 0,
            "dtoIdioma": {"nCdIdioma": 1}}})
        return r or []

    def ranking(self, id_item_lote: int, tipo_apuracao: int, modulo: int = 59) -> list[dict]:
        """Aba Classificação (seleção/credenciamento). Em pregão o portal responde HTTP 500."""
        r = self._ws("PesquisarProcessoClassificacaoItemLoteEmpresas", {"dtoProcesso": {
            "nCdItemLote": id_item_lote, "nIdTipoApuracao": tipo_apuracao, "nCdModulo": modulo,
            "tmpTipoMuralProcesso": 0, "dtoIdioma": {"nCdIdioma": 1}}})
        return r or []

    def lances(self, d: dict, it: dict) -> list[dict]:
        """Grade de lances do item (a mesma que o mural mostra ao expandir o item). Corpo igual ao do JS do portal;
        nCdTipoModalidade tem que ser 0 (o JS manda undefined; null no JSON derruba o webservice com 500)."""
        r = self._ws("PesquisarProcessoDetalheItemProdutoLance", {"dtoProcesso": {
            "nCdItem": it["nCdItem"], "nCdProcesso": d["nCdProcesso"], "nCdModulo": modulo_de(d),
            "nCdSituacao": d.get("nCdSituacao") or 0, "nIdEstilo": d.get("nIdEstilo") or 0,
            "nCdTipoModalidade": d.get("nCdTipoModalidade") or 0, "nCdLote": it.get("nCdLote") or 0,
            "tmpTipoMuralProcesso": 0, "dtoIdioma": {"nCdIdioma": 1}, "sNrProcesso": d.get("sNrProcesso")}})
        return r or []

    def resultado_item(self, d: dict, it: dict) -> list[dict]:
        """Lances primeiro; se o item não tiver lance ranqueado, tenta a aba Classificação."""
        try:
            ls = self.lances(d, it)
        except requests.RequestException as e:
            log.info("%s %s item %s: lances indisponíveis (%s)", self.fonte.slug, d.get("nCdProcesso"), it.get("nCdItem"), e)
            ls = []
        if any(_rank(x) for x in ls):
            return ls
        mod = modulo_de(d)
        if d.get("nIdTipoApuracao") is None or mod in self._sem_classificacao:
            return ls
        try:
            return self.ranking(it["nCdItem"], d["nIdTipoApuracao"], mod) or ls
        except (requests.RequestException, RuntimeError):
            # Pregão (ex.: SFIEC m18/m19) não tem aba Classificação: o portal responde 500. Não insiste nos demais itens.
            self._sem_classificacao.add(mod)
            return ls

    # ------------ catálogo (filtros Categoria + Tipo) ------------
    def classes_catalogo(self, nome: str) -> list[dict]:
        """Categorias do catálogo cujo nome é exatamente `nome` (o autocomplete do portal casa por prefixo)."""
        r = self._ws("PesquisarCatalogoProdutoClasses", {"dtoProduto": {"sDsProduto": nome, "dtoIdioma": {"nCdIdioma": 1}}}) or []
        alvo = normalizar(nome).strip()
        return [c for c in r if normalizar(c.get("sDsClasse") or "").strip() == alvo]

    def catalogo(self, classe: dict | None = None, tipo: str = "produto", descricao: str = "",
                 codigo: str = "") -> list[dict]:
        """PesquisarCatalogoProdutos com os filtros da tela Catálogo, em faixas de até 100."""
        def buscar(de: int, ate: int) -> Any:
            return self._ws("PesquisarCatalogoProdutos", {"dtoProduto": {
                "sCdProduto": codigo, "sDsProduto": descricao, "nCdTipo": TIPOS_CATALOGO[tipo],
                "nCdClasse": (classe or {}).get("nCdClasse") or 0, "sDsClasse": (classe or {}).get("sDsClasse") or "",
                "sOrdenarPor": "SCDPRODUTOEMPRESA", "sOrdenarPorDirecao": "ASC",
                "dtoPaginacao": {"nPaginaDe": de, "nPaginaAte": ate},
                "dtoIdioma": {"nCdIdioma": 1}}})
        itens, _avisos = paginar_intervalo(buscar, tamanho=TAMANHO_PAGINA, rotulo=f"catálogo {self.fonte.slug}")
        return itens

    def produtos_escopo(self, categorias: list[str] | None = None, tipo: str = "produto") -> dict[int, dict]:
        """nCdProduto -> {codigo, descricao, categoria, tipo} para as categorias mapeadas, filtradas por Tipo."""
        produtos: dict[int, dict] = {}
        for nome in categorias or CATEGORIAS_MAPEADAS:
            for c in self.classes_catalogo(nome):
                for x in self.catalogo(c, tipo):
                    if isinstance(x.get("nCdProduto"), int):
                        produtos[x["nCdProduto"]] = {"codigo": x.get("sCdProdutoEmpresa"), "descricao": x.get("sDsProduto"),
                                                     "categoria": x.get("sDsClasse"), "id_categoria": x.get("nCdClasse"),
                                                     "tipo": x.get("sDsProdutoTipo")}
        return produtos


# ---------------- mapeamento para o schema (licitacoes_externas / licitacao_itens / licitacao_resultados) ----------------
def linha_licitacao(fonte: Fonte, d: dict, categoria: str | None, borracha: bool, agora: datetime | None = None,
                    listagem: dict | None = None) -> dict:
    d = limpar(d)
    est = limpar(listagem or {})
    if est.get("nAnoFinalizacao"):  # veio do mural estatístico: guarda os totais do certame
        d = {**d, "mural_estatistico": {k: est.get(k) for k in (
            "dVlEstimado", "dVlNegociado", "dVlEconomia", "dPcEconomia", "tDtEncerrado", "nAnoFinalizacao")}}
    st = status_normalizado(d.get("sDsSituacao"))
    fim = parse_data(d.get("tDtFinal"))
    prio, _ = prioridade_da_compra(st, fim, agora)
    modalidade = (d.get("sNmModalidadeTipo") or d.get("sNmModalidade") or "").strip() or None
    row = {
        "fonte": fonte.slug,
        "modulo": d.get("nCdModulo") or 59,
        "id_externo": d["nCdProcesso"],
        "codigo_externo": str(d["nCdProcesso"]),
        "numero_processo": d.get("sNrProcesso"),
        "numero_edital": d.get("sNrEdital"),
        "objeto": (d.get("sDsObjeto") or "").strip() or None,
        "unidade_compradora": d.get("sNmEmpresa"),
        "orgao_nome": d.get("sNmEmpresa"),
        "entidade": fonte.entidade,
        "uf": fonte.uf,
        "modalidade": modalidade,
        "regulamento": "RCA" if modalidade and re.search(r"sele[cç][aã]o", modalidade, re.I) else None,
        "fase": d.get("sDsFase"),
        "situacao": d.get("sDsSituacao"),
        "status_normalizado": st,
        "acionabilidade": acionabilidade(st, fim, agora),
        "data_inicio": parse_data(d.get("tDtInicial")),
        "data_fim": fim,
        "data_homologacao": parse_data(d.get("tDtHomologacao")),
        "valor_total": valor(d.get("dVlTotal")) or valor(est.get("dVlEstimado")),
        "anexo_raiz_id": d.get("nCdAnexo"),
        "categoria_escopo": categoria,
        "interesse_borracha": borracha,
        "escopo_estado": "CLASSIFICATION_CANDIDATE" if categoria else "OUT_OF_SCOPE",
        "raw": d,
    }
    if prio is not None:
        row["prioridade"] = prio
    return row


# perfil_item devolve campos de BI que licitacao_itens não tem. PostgREST recusa a linha inteira.
_PERFIL_FORA_DA_TABELA = ("cinematica", "produto_padronizado")


def _perfil_gravavel(descricao: str | None) -> dict:
    perfil = perfil_item(descricao)
    for chave in _PERFIL_FORA_DA_TABELA:
        perfil.pop(chave, None)
    return perfil


def linhas_itens(lic_id: int | None, itens: list[dict], produtos: dict[int, dict] | None = None,
                 contexto: bool = False) -> list[dict]:
    out = []
    for it in itens:
        p = partes_item(it.get("sDsItem"))
        cat, borr, ms, metodo = classificar_item_detalhe(it, produtos, contexto)
        prod = (produtos or {}).get(it.get("nCdProduto")) or {}
        m_cod = _COD_CATALOGO.match(p["descricao"] or "")
        qtd = it.get("dQtItem") if isinstance(it.get("dQtItem"), (int, float)) and it.get("dQtItem") > 0 else None
        vref = valor(it.get("dVlReferencia"))
        out.append({
            "licitacao_id": lic_id,
            "numero_item": it.get("nCdItemSequencial") or p["sequencial"],
            "id_item_externo": it.get("nCdItem"),
            "descricao": p["descricao"],
            "categoria_fornecedor": p["categoria"],
            "variacao": p["variacao"],
            "material_ou_servico": ms,
            "quantidade": qtd,
            "unidade_medida": it.get("sDsUnidadeMedida"),
            "valor_unitario_estimado": vref,
            "valor_total_estimado": round(vref * qtd, 2) if vref and qtd else None,
            "catalogo_codigo_item": prod.get("codigo") or (m_cod.group(1) if m_cod else None),
            **_perfil_gravavel(p["descricao"]),
            "situacao": it.get("sStItem"),
            "categoria_escopo": cat,
            "interesse_borracha": borr,
            "escopo_estado": "CLASSIFICATION_CANDIDATE" if cat else "OUT_OF_SCOPE",
            "escopo_metodo": metodo,
            "raw": it,
        })
    return out


class ResultadoInvalido(ValueError):
    """Item encerrado com resultado incoerente (0 ou >1 vencedor). Não grava; conta como alerta."""


_SEM_VENCEDOR = re.compile(r"revog|cancel|fracass|desert|anul|suspens")
_EMPRESA_CNPJ = re.compile(r"^(.*?)\s*-\s*(\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2})\s*$")
_COD_CATALOGO = re.compile(r"^\s*([A-Z]{2}\d{7})\s*-")


def _rank(r: dict) -> int | None:
    n = r.get("nNrRanking")
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else None


def brl(v: float | None) -> str:
    """R$ no padrão brasileiro para logs: 4674.5 -> 'R$ 4.674,50'."""
    if v is None:
        return "-"
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def empresa_cnpj(s: str | None) -> tuple[str | None, str | None]:
    """'J&A E-COMMERCE LTDA - 24.608.949/0001-37' -> ('J&A E-COMMERCE LTDA', '24608949000137').

    CPF no nome fica como veio: documento de licitação é público (decisão de 01/10/2026).
    """
    s = (s or "").strip() or None
    m = _EMPRESA_CNPJ.match(s or "")
    if not m:
        return s, None
    return (m.group(1).strip() or None), cnpj_ou_none(m.group(2))


def linhas_resultados(lic_id: int | None, numero_item: int, ranking: list[dict], data_resultado: str | None,
                      situacao_item: str | None = None, quantidade: float | None = None) -> list[dict]:
    """Lances/classificação Paradigma -> licitacao_resultados.

    - Só entra linha com posição no ranking (> 0). Lance sem posição é histórico da disputa
      (inclui lances-âncora de R$ 100 mil/500 mil) e não é resultado.
    - Ranking é por fornecedor dentro do item: cada fornecedor tem 1 posição por item e pode aparecer em
      vários itens (isso é mantido). Só sai a linha idêntica repetida pelo portal (mesmo nCdLance).
    - Valor do lance é UNITÁRIO: valor × quantidade do item = valor adjudicado (conferido com o Relatório
      Final do PE000652022: 9 vencedores e total R$ 377.233,50 batem no centavo).
    - Vencedor: troféu (bFlVencedor=1) na grade de lances; na aba Classificação, menor posição com
      status Classificada ou vazio.
    - situacao: 'vencedor' | status do portal | 'perdida' quando vem vazio.
    - Regra: item encerrado com ranking tem exatamente 1 vencedor; senão ResultadoInvalido.
      Itens revogados/cancelados/fracassados/desertos podem ter 0.
    """
    vistos: set = set()
    validos = []
    for r in sorted((r for r in ranking if _rank(r)), key=lambda r: (_rank(r), -(r.get("bFlVencedor") or 0))):
        chave = r.get("nCdLance") or (r.get("sNmEmpresa"), r.get("dVlLanceMoeda") or r.get("dVlProposta"),
                                      r.get("tDtLance"), _rank(r))
        chave2 = (r.get("sNmEmpresa"), r.get("dVlLanceMoeda") or r.get("dVlProposta"), r.get("tDtLance"), _rank(r))
        if chave in vistos or chave2 in vistos:
            continue
        vistos.update({chave, chave2})
        validos.append(r)

    # Troféu (bFlVencedor 0/1) no pregão. Na "Contratação ou aquisição (disputa aberta)" (regulamento novo, 2025+)
    # o campo vem nulo e vale a classificação: menor posição com proposta Classificada (ou sem status).
    tem_trofeu = any(isinstance(r.get("bFlVencedor"), int) and not isinstance(r.get("bFlVencedor"), bool)
                     for r in validos)
    if tem_trofeu:
        venc_ids = {id(r) for r in validos if r.get("bFlVencedor") == 1}
    else:
        def _st(r):
            return normalizar((r.get("sDsStatus") or r.get("sDsSituacaoProposta") or "").strip())
        aptos = [r for r in validos if _st(r) == "" or _st(r).startswith("classificad")]
        melhor = min((_rank(r) for r in aptos), default=None)
        venc_ids = {id(r) for r in aptos if _rank(r) == melhor}

    sit_item = normalizar(situacao_item or "")
    if validos and not _SEM_VENCEDOR.search(sit_item) and len(venc_ids) != 1:
        raise ResultadoInvalido(f"item {numero_item}: {len(venc_ids)} vencedores em {len(validos)} linhas ranqueadas "
                                f"(situação do item: {situacao_item!r})")
    if _SEM_VENCEDOR.search(sit_item):
        venc_ids = set()

    out = []
    for seq, r in enumerate(validos, 1):
        nome, cnpj = empresa_cnpj(r.get("sNmEmpresa"))
        venc = id(r) in venc_ids
        status = (r.get("sDsStatus") or r.get("sDsSituacaoProposta") or "").strip()
        v = valor(r.get("dVlLanceMoeda") if r.get("dVlLanceMoeda") is not None else r.get("dVlProposta"))
        out.append({
            "licitacao_id": lic_id,
            "numero_item": numero_item,
            "sequencial_resultado": seq,
            "fornecedor_nome": nome,
            "fornecedor_cnpj": cnpj_ou_none(r.get("sNrCnpj")) or cnpj,
            "ranking": _rank(r),
            "vencedor": venc,
            "valor_proposta": v,
            "valor_unitario_homologado": v if venc else None,
            "quantidade_homologada": quantidade if venc and quantidade else None,
            "valor_total_homologado": round(v * quantidade, 2) if venc and v and quantidade else None,
            "marca": (r.get("sDsMarca") or "").strip() or None,
            "marca_normalizada": normalizar_marca(r.get("sDsMarca")),
            "modelo": (r.get("sDsModelo") or "").strip() or None,
            "situacao": "vencedor" if venc else (status or "perdida"),
            "data_resultado": data_resultado,
            "raw": dict(r),
        })
    return out


def avaliar_processo(d: dict, itens: list[dict], produtos: dict[int, dict] | None = None) -> tuple[str | None, bool]:
    """Categoria da compra: melhor categoria entre objeto e itens (itens mandam; objeto de cotação é genérico)."""
    ordem = ["catmat", "borracha", "obra_piso", "piso", "forte", "fraco", "manutencao"]
    ctx = contexto_academia(d.get("sDsObjeto"))
    cats = [classificar_item(it, produtos, ctx)[0] for it in itens]
    cat_obj = classificar(d.get("sDsObjeto") or "")
    candidatas = [c for c in cats + [cat_obj] if c]
    if not candidatas:
        return None, False
    cats_itens = {c for c in cats if c}
    # Compra só de peças ("CABO DE AÇO ... PARA EQUIPAMENTO DE ACADEMIA"): o objeto cita academia, mas os itens mandam.
    melhor = "manutencao" if cats_itens == {"manutencao"} else min(candidatas, key=ordem.index)
    borr = any(classificar_item(it, produtos, ctx)[1] for it in itens) or interesse_borracha(d.get("sDsObjeto") or "", cat_obj)
    return melhor, borr


# ---------------- execução ----------------
TERMOS_SISTEMA_S = [
    "academia", "esporte e lazer", "musculação", "ginástica", "pilates", "tatame", "esteira",
    "halter", "grama sintética", "piso emborrachado", "piso esportivo", "quadra", "borracha granulada",
]


def processar_processo(portal: "PortalParadigma", sb, pid: int, mod: int, resumo: dict, dry_run: bool,
                       com_resultados: bool, produtos: dict[int, dict] | None, fornecedores=None,
                       forcar: bool = False, listagem: dict | None = None, documentos=None) -> None:
    d = portal.detalhes(pid, mod)
    if not d or not d.get("nCdProcesso"):
        return
    resumo["processos"] += 1
    its = portal.itens(d)
    cat, borr = avaliar_processo(d, its, produtos)
    if not cat and not forcar:
        return
    resumo["no_escopo"] += bool(cat)
    li = linhas_itens(None, its, produtos, contexto_academia(d.get("sDsObjeto")))
    resumo["itens_escopo"] += sum(1 for i in li if i["categoria_escopo"])
    resumo["itens_catalogo"] += sum(1 for i in li if i["escopo_metodo"] == "catalogo" and i["categoria_escopo"])
    st = status_normalizado(d.get("sDsSituacao"))
    fim = parse_data(d.get("tDtFinal"))
    prio, _ = prioridade_da_compra(st, fim)
    prio_tag = f" | {prio}" if prio else ""
    print(("★ " if borr else "  ") + f"{portal.fonte.slug} {pid}/m{mod} | {d.get('sNrEdital')} | {cat} | "
          f"{d.get('sDsSituacao')}{prio_tag} | {(d.get('sDsObjeto') or '')[:80]}")
    lic = None
    if not dry_run:
        lic = sb.upsert("licitacoes_externas", linha_licitacao(portal.fonte, d, cat, borr, listagem=listagem),
                        "fonte,modulo,id_externo")[0]
        for i in li:
            i["licitacao_id"] = lic["id"]
        if li:
            sb.upsert("licitacao_itens", li, "licitacao_id,numero_item")
    if documentos is not None:
        # Todos os anexos do processo (aberto ou fechado) ficam registrados e guardados no LicitaGym.
        try:
            r = documentos.sincronizar(lic["id"] if lic else None, d,
                                       f"paradigma/{portal.fonte.slug}/{modulo_de(d)}/{d['nCdProcesso']}")
            for k, v in r.items():
                resumo[f"docs_{k}"] = resumo.get(f"docs_{k}", 0) + v
        except Exception as e:
            resumo["erros"] += 1
            log.warning("%s %s documentos: %s", portal.fonte.slug, pid, e)
    if not com_resultados:
        return
    homolog = parse_data(d.get("tDtHomologacao"))
    cnpjs: list[str] = []
    for it, linha in zip(its, li):
        if not it.get("nCdItem"):
            continue
        if not linha["categoria_escopo"]:
            # Item fora do escopo não gera resultado, mas os participantes dele são fornecedores do certame.
            if fornecedores is not None:
                try:
                    cnpjs += [c for c in (empresa_cnpj(r.get("sNmEmpresa"))[1] for r in portal.resultado_item(d, it)) if c]
                except requests.RequestException as e:
                    log.info("%s %s item %s: participantes indisponíveis (%s)", portal.fonte.slug, pid, it["nCdItem"], e)
            continue
        brutos = portal.resultado_item(d, it)
        # Todos os participantes do item (inclusive sem posição/desclassificados) vão para o cadastro de fornecedores.
        cnpjs += [c for c in (empresa_cnpj(r.get("sNmEmpresa"))[1] for r in brutos) if c]
        try:
            res = linhas_resultados(lic["id"] if lic else None, linha["numero_item"],
                                    brutos, homolog, it.get("sStItem"), linha["quantidade"])
        except ResultadoInvalido as e:
            resumo["alertas"] += 1
            log.warning("%s %s: %s", portal.fonte.slug, pid, e)
            continue
        resumo["resultados"] += len(res)
        resumo["itens_com_vencedor"] += any(r["vencedor"] for r in res)
        if dry_run:
            for r in res:
                if r["vencedor"]:
                    ref = linha.get("valor_unitario_estimado")
                    desc = f" | ref {brl(ref)} ({r['valor_proposta'] / ref - 1:+.0%} vs ref)" if ref else ""
                    familia = (linha.get("familia_equipamento") or "-").split(".")[-1]
                    print(f"      item {linha['numero_item']:>3} | {linha.get('catalogo_codigo_item') or '-':9} | "
                          f"{texto_do_item(linha['descricao'])[:32]:32} | {familia:12} | {r['fornecedor_nome'][:30]:30} | "
                          f"{r['marca_normalizada'] or '-'} {r['modelo'] or ''} | {brl(r['valor_proposta'])}{desc} | "
                          f"{len(res)} ranqueados")
        elif res:
            sb.upsert("licitacao_resultados", res, "licitacao_id,numero_item,sequencial_resultado")
    if fornecedores is not None and cnpjs:
        resumo["participantes"] += len(set(cnpjs))
        f = fornecedores.cadastrar(cnpjs)
        for k in ("consultados", "em_cache", "erros"):
            resumo[f"fornecedores_{k}"] += f[k]
        if dry_run:
            for l in f["linhas"]:
                print(f"      fornecedor {l['cnpj']} | {l.get('razao_social')} | {l.get('porte')} | "
                      f"{l.get('uf')}/{l.get('municipio')} | CNAE {l.get('cnae_principal')}")


def coletar(portal: "PortalParadigma", sb, termos: list[str], paginas: int | None, dry_run: bool,
            com_resultados: bool = True, produtos: dict[int, dict] | None = None, fornecedores=None,
            processos: list[tuple[int, int]] | None = None, anos: list[int] | None = None, documentos=None) -> dict:
    resumo = {"listados": 0, "processos": 0, "no_escopo": 0, "itens_escopo": 0, "itens_catalogo": 0,
              "resultados": 0, "itens_com_vencedor": 0, "alertas": 0, "erros": 0,
              "participantes": 0, "fornecedores_consultados": 0, "fornecedores_em_cache": 0,
              "fornecedores_erros": 0, "paginacao_avisos": []}
    vistos: dict[tuple[int, int], dict] = {}
    if processos:
        vistos = {p: {} for p in processos}
    else:
        buscas = [(t, a) for t in termos for a in (anos or [None])]
        for t, ano in buscas:
            def buscar(de: int, ate: int, t: str = t, ano: int | None = ano) -> Any:
                if ano:
                    return portal.listar_encerrados(t, ano, de, ate)
                return portal.listar(t, de, ate)
            lote, avisos = paginar_intervalo(
                buscar, tamanho=TAMANHO_PAGINA, max_paginas=paginas,
                rotulo=f"{portal.fonte.slug} termo {t!r} ano={ano}")
            resumo["paginacao_avisos"].extend(avisos)
            resumo["listados"] += len(lote)
            for x in lote:
                pid = x.get("nCdOrigem")
                if isinstance(pid, int) and pid > 0:
                    vistos.setdefault((pid, modulo_de(x)), x)
    for (pid, mod), x in vistos.items():
        try:
            processar_processo(portal, sb, pid, mod, resumo, dry_run, com_resultados, produtos, fornecedores,
                               forcar=bool(processos), listagem=x, documentos=documentos)
        except Exception as e:  # um processo com erro não derruba a coleta, mas é contado
            resumo["erros"] += 1
            log.warning("%s %s: %s", portal.fonte.slug, pid, e)
    return resumo


def main(argv: list[str] | None = None) -> int:
    from .destino import Supabase, drenar_licitacao_match, env
    from .fornecedores import CadastroFornecedores

    ap = argparse.ArgumentParser(description="Coletor Paradigma (Sistema S)")
    ap.add_argument("--fonte", required=True, choices=sorted(FONTES))
    ap.add_argument("--termos", help="termos separados por ';' (padrão: TERMOS_SISTEMA_S)")
    ap.add_argument("--paginas", type=int, default=None,
                    help="teto opcional de páginas de até 100 itens por termo; omitido, coleta até o fim")
    ap.add_argument("--processo", action="append", metavar="ID[/MODULO]",
                    help="coleta só este processo (nCdOrigem), ex.: 32/18; pode repetir")
    ap.add_argument("--anos", help="busca no Mural estatístico (encerrados) destes anos, ex.: 2022,2023")
    ap.add_argument("--categorias", help="filtro Categoria do catálogo, separado por ';' "
                                         f"(padrão: {'; '.join(CATEGORIAS_MAPEADAS)})")
    ap.add_argument("--tipo", choices=sorted(TIPOS_CATALOGO), default="produto", help="filtro Tipo do catálogo")
    ap.add_argument("--sem-catalogo", action="store_true", help="não usa o catálogo do portal (só regras de texto)")
    ap.add_argument("--sem-resultados", action="store_true")
    ap.add_argument("--sem-fornecedores", action="store_true", help="não consulta CNPJ dos participantes")
    ap.add_argument("--sem-documentos", action="store_true", help="não registra/baixa os anexos do processo")
    ap.add_argument("--dry-run", action="store_true", help="não grava; mostra vencedores e fornecedores consultados")
    args = ap.parse_args(argv)
    if args.paginas is not None and args.paginas < 1:
        ap.error("--paginas deve ser >= 1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    fonte = FONTES[args.fonte]
    portal = PortalParadigma(
        fonte, delay=float(env("DELAY_SEGUNDOS", "1.5")), autorizado=autorizado_para_coleta(fonte))
    sb = None if args.dry_run else Supabase(env("SUPABASE_URL", obrigatorio=True),
                                            env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    termos = [t.strip() for t in args.termos.split(";")] if args.termos else TERMOS_SISTEMA_S
    produtos = None
    if not args.sem_catalogo:
        cats = [c.strip() for c in args.categorias.split(";")] if args.categorias else None
        try:
            produtos = portal.produtos_escopo(cats, args.tipo)
            log.info("catálogo %s: %d produtos (tipo=%s, categorias=%s)", args.fonte, len(produtos), args.tipo,
                     cats or CATEGORIAS_MAPEADAS)
        except requests.RequestException as e:  # tenant sem catálogo público: segue só com regras de texto
            log.warning("catálogo %s indisponível: %s", args.fonte, e)
    processos = None
    if args.processo:
        processos = [(int(p.split("/")[0]), int(p.split("/")[1]) if "/" in p else MODULO_PADRAO) for p in args.processo]
    forn = None if args.sem_fornecedores or args.sem_resultados else CadastroFornecedores(sb, dry_run=args.dry_run)
    anos = [int(a) for a in args.anos.split(",")] if args.anos else None
    docs = None
    if not args.sem_documentos:
        from .destino import Armazenamento
        from .documentos_paradigma import DocumentosParadigma, VisitanteInstitucional
        arm = None if args.dry_run else Armazenamento.do_ambiente()
        if arm is not None and not arm.dentro_do_saas:
            raise SystemExit("Defina SUPABASE_STORAGE_BUCKET: os documentos precisam ficar dentro do LicitaGym.")
        visitante = VisitanteInstitucional.do_ambiente()
        if visitante is None:
            log.warning("VISITANTE_* não configurado: documentos que exigem cadastro ficam registrados como pendentes")
        docs = DocumentosParadigma(portal, sb, arm, visitante, int(float(env("MAX_MB", "50")) * 1048576), args.dry_run)
    r = coletar(portal, sb, termos, args.paginas, args.dry_run, not args.sem_resultados, produtos, forn, processos, anos,
                docs)
    drenar_licitacao_match(sb)  # recorte CATMAT por texto: zera a pendência de licitacao_match (sem efeito no dry-run)
    print(json.dumps(r, ensure_ascii=False))
    return 1 if r["erros"] and not r["no_escopo"] else 0


if __name__ == "__main__":
    sys.exit(main())

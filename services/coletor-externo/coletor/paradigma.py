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

Acesso (decisão de 05/10/2026, confirmada em 09/11/2026): egov.paradigmabs.com.br (Sesc/Senac RS, Sesc RJ, Sesc BA)
e scr360.paradigmabs.com.br (Sesc SP) têm `Disallow: /` no robots.txt; o dono decidiu que isso não impede a coleta do
webservice público do mural, com o mesmo intervalo do adaptador (FONTES_MURAL_AUTORIZADO; o CLI passa autorizado=True
só nelas). egov-br.paradigmabs.com.br (Sesc DN) não tem robots.txt (404, conferido em 09/11/2026) e coleta como os
self-hosted. Cadastro de visitante (VISITANTE_*) liberado em
09/11/2026 nas fontes que coletam; captcha só por pessoa na UI. 401/403 de qualquer host para a coleta na hora, sem nova tentativa; 429 respeita Retry-After. Bloqueio de WAF continua respeitado: a FIEMG (403 do Cloudflare para cliente
automatizado) fica de fora e não se contorna.

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
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .paginacao import TAMANHO_PAGINA_MAX, avaliar_pagina, clamp_tamanho, pagina_repetida
from .perfil_item import normalizar_marca, perfil_item, texto_do_item
from .escopo import ITEM_FORA, academia_ar_livre, brinquedo_infantil, classificar, contexto_academia, e_peca, classificar_texto_item, interesse_borracha, interesse_borracha_item, normalizar, piso_item_fora, CATEGORIAS_PISO_VETAVEL
from .pncp import CATEGORIAS_SO_MATERIAL, fornece_produto
from .portal import cnpj_ou_none, limpar, parse_data
from .proveniencia import ORIGENS, campos_proveniencia
from .retry import retry_after_s

log = logging.getLogger("coletor.paradigma")


class TempoEsgotado(BaseException):
    """SIGTERM do limite da etapa (timeout interno do workflow). BaseException: nenhum `except Exception` da coleta a
    engole, e main fecha o registro como `incompleta`."""

UA = "LicitaGym-Coletor/1.1 (pesquisa de licitações públicas)"


@dataclass(frozen=True)
class Fonte:
    slug: str
    entidade: str
    uf: str | None
    base: str
    # False = o host bloqueia acesso automatizado (robots.txt ou WAF). Só coleta se a fonte estiver em
    # FONTES_MURAL_AUTORIZADO (decisão de 05/10/2026, confirmada em 09/11/2026); WAF (FIEMG) nunca.
    coleta_automatica: bool


FONTES: dict[str, Fonte] = {
    "sestsenat": Fonte("sestsenat", "SEST SENAT", None, "https://compras.sestsenat.org.br/portal", True),
    "fiesc": Fonte("fiesc", "FIESC (SESI/SC, SENAI/SC, IEL/SC)", "SC", "https://portaldecompras.fiesc.com.br/portal", True),
    # scr360.paradigmabs.com.br e egov.paradigmabs.com.br: robots.txt `Disallow: /`; coletam por FONTES_MURAL_AUTORIZADO.
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
    # SaaS egov-br.paradigmabs.com.br: sem robots.txt (404, conferido em 09/11/2026), sem X-Robots-Tag
    "sescdn": Fonte("sescdn", "Sesc Departamento Nacional", None, "https://egov-br.paradigmabs.com.br/sescdn/portal", True),
    # SaaS egov.paradigmabs.com.br: robots.txt `Disallow: /`; coletam por FONTES_MURAL_AUTORIZADO.
    "sescrj": Fonte("sescrj", "Sesc RJ", "RJ", "https://egov.paradigmabs.com.br/SESCRJ/portal", False),
    "sescba": Fonte("sescba", "Sesc BA", "BA", "https://egov.paradigmabs.com.br/sescba/portal", False),
}

# Decisão de 05/10/2026, confirmada em 09/11/2026: o robots.txt desses hosts não impede a coleta do webservice público
# do mural. sescdn saiu do conjunto em 09/11/2026: o host dele não tem robots.txt (coleta_automatica=True).
# FIEMG fica de fora (WAF).
FONTES_MURAL_AUTORIZADO = frozenset({"sescsp", "sesc_senac_rs", "sescrj", "sescba"})


def autorizado_para_coleta(fonte: Fonte) -> bool:
    """Override explícito do bloqueio de robots.txt. Não cobre bloqueio de WAF."""
    return fonte.slug in FONTES_MURAL_AUTORIZADO

MODULO_PADRAO = 59

# Filtro "Tipo" do catálogo (CatalogoProdutos.aspx: Todos / Produto / Serviço)
TIPOS_CATALOGO = {"todos": 0, "produto": 1, "servico": 2}
# Filtro "Categoria" já mapeado (catálogo SFIEC, 26/09/2026): AI03 = EQUIPAMENTOS ESPORTIVOS; NE53 e MC06 = ESPORTIVO.
# Casamento por nome exato (normalizado), porque o autocomplete devolve várias classes por prefixo.
CATEGORIAS_MAPEADAS = ["EQUIPAMENTOS ESPORTIVOS", "ESPORTIVO"]
# Portais cujo catálogo usa outros nomes. Todos os nomes abaixo foram devolvidos pelo autocomplete
# PesquisarCatalogoProdutoClasses (termo "ESPORT") no estudo dos murais, 08/11/2026 (spec 0051): fiems classe 20;
# fiemt classes 9, 91, 172 e 191 (com e sem o prefixo "25 -" são classes distintas). Decisão do Marcelo (09/11/2026):
# sem gate, entra o que vier dessas categorias (material esportivo inclusive). Premiação (fiemt 456) fica de fora.
# fieb: autocomplete com o termo "ACADEMIA" (09/11/2026) devolveu a classe 226, com 123 produtos. Decisão do Marcelo
# (09/11/2026): só a 226; a 192 MATERIAL ESPORTIVO (1.031 produtos) fica fora. A lista fixa sai com a spec 0052.
CATEGORIAS_POR_FONTE: dict[str, list[str]] = {
    "fieb": ["EQUIPAMENTOS PARA ACADEMIA"],
    "fiems": ["MATERIAIS ESPORTIVOS"],
    "fiemt": ["25 - EQUIPAMENTOS ESPORTIVOS, ARTISTICOS E DE RECREACAO", "25 - MATERIAL ESPORTIVO E DE RECREACAO",
              "EQUIPAMENTOS ESPORTIVOS, ARTISTICOS E DE RECREACAO", "MATERIAL ESPORTIVO E DE RECREACAO"],
}


def categorias_da_fonte(slug: str) -> list[str]:
    """Categorias do catálogo usadas por padrão na fonte (sem --categorias)."""
    return CATEGORIAS_POR_FONTE.get(slug, CATEGORIAS_MAPEADAS)
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
                      max_itens: int | None = None, rotulo: str = "paradigma",
                      limite_seguranca: int | None = None) -> tuple[list, list[str]]:
    """Percorre faixas inclusivas de no máximo 100 itens.

    `buscar(de, ate)` devolve a página. Sem total, só uma página vazia encerra; página
    curta não. Lista vazia, ou objeto com lista reconhecida vazia, é página vazia.
    Envelope sem essa lista (nulo, string, objeto só com mensagem) levanta erro.
    Com a faixa ainda alinhada, `avaliar_pagina` encerra quando o total confirma o fim.
    Depois de uma página curta intermediária a faixa deixa de coincidir com o número
    da página: `totalPaginas` e `paginasRestantes` não encerram mais. Segue
    `totalRegistros`/`total` (pelo acumulado) ou uma página vazia.
    `max_paginas` e `max_itens` são tetos opcionais (avisam se cortarem antes do fim).
    Sem eles, o corte é `limite_seguranca` (padrão `MAX_PAGINAS_SEGURANCA`) ou página de conteúdo repetido: os dois
    param com aviso e não são fim confirmado. A faixa seguinte começa depois do último
    item recebido, para uma página curta não pular o que a API não devolveu.
    """
    tamanho = clamp_tamanho(tamanho, padrao=TAMANHO_PAGINA, minimo=1, maximo=TAMANHO_PAGINA_MAX)
    limite_seguranca = limite_seguranca or MAX_PAGINAS_SEGURANCA
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
        if pagina > limite_seguranca:
            _aviso(f"{rotulo}: limite de segurança de {limite_seguranca} páginas "
                   f"(até {limite_seguranca * tamanho} itens pedidos); interrompendo")
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


def cadastro_para_baixar(html: str | None) -> int | None:
    """bFlCadastroParaEfetuarDownloadAnexoAreaPublica do objConfiguracao do Mural.aspx: 0 = o portal libera o download
    de anexo sem cadastro de visitante (FIEB, HAR de 12/11/2026); >0 = exige; None = não encontrado."""
    if not isinstance(html, str):
        return None
    m = re.search(r'"bFlCadastroParaEfetuarDownloadAnexoAreaPublica"\s*:\s*(\d+)', html)
    return int(m.group(1)) if m else None


def quer_resumo_do_processo(d: dict) -> bool:
    """Resumo do processo (PesquisarResumoEdital) só de edital encerrado com resultado: num edital aberto ele ainda
    pode mudar, e cancelado ou fracassado não tem resultado para analisar."""
    return status_normalizado(d.get("sDsSituacao")) in ("homologada", "encerrada")


def status_normalizado(situacao: str | None) -> str:
    s = normalizar(situacao or "")
    if not s:
        return "desconhecida"
    # "Aguardando homologação" (nCdSituacao 23) ainda não foi homologada: em julgamento, nunca histórico (12/11/2026).
    if "aguard" in s and "homolog" in s:
        return "em_julgamento"
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


# Item que só nomeia uma atividade de serviço, sem produto (09/11/2026, FIEB): "GINASTICA LABORAL", "ATENDIMENTO DE
# GINÁSTICA LABORAL" (aula/atendimento sob demanda) e "REINSTALAÇÃO DE UMA ESTEIRA ..." saíam material e "forte".
# Só o item que COMEÇA pela atividade: "BOLA ... PARA GINÁSTICA LABORAL" continua material.
ITEM_ATIVIDADE_SERVICO = re.compile(
    r"^\W*((atendimentos?|aulas?|sess(ao|oes))\s+(de|em)\s+)?ginastica\s+laboral\b|^\W*reinstalac", re.I)


# Objeto de serviço que cita piso/borracha/grama não passa pela trava de compra só de serviço (avaliar_processo): a
# regra de piso/borracha decide sozinha. Ex.: SESC SP 1248/m18 "Substituição do piso de madeira por placas de
# borracha da sala de Ginástica" (itens "EXECUÇÃO SERVIÇOS CIVIS") continua como estava.
OBJETO_CITA_PISO = re.compile(r"\bpisos?\b|borracha|emborrachad|\bgram(a|ado)s?\b", re.I)


def e_servico(categoria: str | None, descricao: str | None) -> bool:
    t = normalizar(f"{categoria or ''} {(descricao or '')[:200]}")
    return bool(re.search(r"\bservicos?\b|manutencao|instalacao e|locacao|assistencia tecnica|consultoria|credenciamento", t)
                or ITEM_ATIVIDADE_SERVICO.search(normalizar(categoria or "")))


def classificar_item_detalhe(it: dict, produtos: dict[int, dict] | None = None,
                             contexto: bool = False) -> tuple[str | None, bool, str, str]:
    """(categoria_escopo, interesse_borracha, material_ou_servico, escopo_metodo) para um item Paradigma.
    `produtos`: nCdProduto -> produto do catálogo filtrado por Tipo+Categoria (ver PortalParadigma.produtos_escopo).
    Ordem: serviço (gate) > ITEM_FORA (balança etc., mesmo estando na categoria) > catálogo > regras de texto.
    Academia ao ar livre e brinquedo infantil não entram pelo catálogo: o texto do item decide (regra de negócio; uma
    classe genérica como "EQUIPAMENTOS PARA ACADEMIA", da FIEB, pode ter ATI cadastrado)."""
    p = partes_item(it.get("sDsItem"))
    texto = " ".join(x for x in (p["categoria"], p["variacao"], p["descricao"]) if x)
    ms = "S" if e_servico(p["categoria"], p["descricao"]) else "M"
    if ms == "S":
        return None, False, ms, "regra"  # gate MATERIAL_SCOPE: serviço não é oportunidade de material
    if produtos and it.get("nCdProduto") in produtos and not (academia_ar_livre(texto) or brinquedo_infantil(texto)):
        if ITEM_FORA.search(normalizar(texto)):
            return None, False, ms, "catalogo"
        cat = "manutencao" if e_peca(normalizar(texto)) else "forte"  # ex.: MOLA PARA TRAMPOLIM (peça)
        return cat, interesse_borracha_item(texto, cat), ms, "catalogo"
    cat, metodo = classificar_texto_item(texto, contexto)
    # #390: piso de borracha de outro produto (escada, balança, cera) ou piso fino de obra não é piso da linha
    if cat in CATEGORIAS_PISO_VETAVEL and piso_item_fora(texto):
        cat = None
    return cat, interesse_borracha_item(texto, cat), ms, metodo


def classificar_item(it: dict, produtos: dict[int, dict] | None = None, contexto: bool = False) -> tuple[str | None, bool, str]:
    """(categoria_escopo, interesse_borracha, material_ou_servico) para um item Paradigma."""
    return classificar_item_detalhe(it, produtos, contexto)[:3]


def _recusar_bloqueio(fonte: Fonte, status: int) -> None:
    """401/403 = o host recusou o cliente (WAF, desafio, login): não se contorna nem se repete."""
    if status in (401, 403):
        raise PermissionError(f"{fonte.slug}: o host recusou o acesso (HTTP {status}); bloqueio não se contorna.")


class PortalParadigma:
    def __init__(self, fonte: Fonte, delay: float = 1.5, timeout: int = 60, autorizado: bool = False,
                 sessao: requests.Session | None = None):
        # autorizado=True só vale para FONTES_MURAL_AUTORIZADO; bloqueio de WAF (FIEMG) nunca se libera
        if not fonte.coleta_automatica and not (autorizado and fonte.slug in FONTES_MURAL_AUTORIZADO):
            raise PermissionError(
                f"{fonte.slug}: o host bloqueia coleta automatizada (robots.txt ou WAF) e a fonte não está em "
                "FONTES_MURAL_AUTORIZADO. Bloqueio de WAF não se contorna; use aviso de fornecedor ou coleta manual.")
        self.fonte = fonte
        if delay < DELAY_MINIMO:
            log.warning("delay %s s abaixo do mínimo de %s s; usando %s s", delay, DELAY_MINIMO, DELAY_MINIMO)
            delay = DELAY_MINIMO
        self.delay = delay
        self._sem_classificacao: set[int] = set()  # módulos em que a aba Classificação não existe (500)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
        # Configuração pública do portal (objConfiguracao do Mural.aspx): None = não lida, e aí o fluxo de documentos
        # segue o conservador (pergunta ao portal e cadastra o visitante se ele permitir).
        self.cadastro_download: int | None = None
        if sessao is None:
            r = self.s.get(f"{fonte.base}/Mural.aspx", timeout=timeout)  # cookies de sessão ASP.NET
            _recusar_bloqueio(self.fonte, r.status_code)
            self.cadastro_download = cadastro_para_baixar(getattr(r, "text", None))

    def _ws(self, metodo: str, body: dict) -> Any:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        for tentativa in range(4):
            try:
                r = self.s.post(f"{self.fonte.base}/WebService/Servicos.asmx/{metodo}", data=payload,
                                headers={"Content-Type": "application/json; charset=utf-8"}, timeout=self.timeout)
                time.sleep(self.delay)
                if r.status_code == 200:
                    return limpar(r.json().get("d"))
                _recusar_bloqueio(self.fonte, r.status_code)   # 401/403: bloqueio do host, sem nova tentativa
                if r.status_code == 429 and tentativa < 3:
                    espera = retry_after_s(r)
                    espera = espera if espera is not None else 2 ** tentativa * 2
                    self._avisar_tentativa(metodo, tentativa, f"HTTP {r.status_code}", espera)
                    time.sleep(espera)
                    continue
                if r.status_code >= 500 and tentativa < 3:
                    self._avisar_tentativa(metodo, tentativa, f"HTTP {r.status_code}", 2 ** tentativa * 2)
                    time.sleep(2 ** tentativa * 2)
                    continue
                r.raise_for_status()
            except requests.HTTPError:
                raise   # 4xx definitivo (o 429 e o 5xx esgotados também chegam aqui só na última tentativa)
            except requests.RequestException as e:
                if tentativa == 3:
                    raise
                self._avisar_tentativa(metodo, tentativa, type(e).__name__, 2 ** tentativa * 2)
                time.sleep(2 ** tentativa * 2)
        raise RuntimeError(f"{metodo}: sem resposta após 4 tentativas")  # nunca devolve vazio em silêncio

    def _avisar_tentativa(self, metodo: str, tentativa: int, motivo: str, espera: float) -> None:
        # 12/11/2026: sem esta linha, uma hora de espera do WAF ou do portal não deixava rastro no log.
        log.warning("%s %s: tentativa %s/4 falhou (%s), nova em %ss", self.fonte.slug, metodo, tentativa + 1, motivo,
                    espera)

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
        itens, _avisos = self.catalogo_com_avisos(classe, tipo, descricao, codigo)
        return itens

    def catalogo_com_avisos(self, classe: dict | None = None, tipo: str = "produto", descricao: str = "",
                            codigo: str = "", limite_seguranca: int | None = None) -> tuple[list[dict], list[str]]:
        """Como `catalogo`, mais os avisos de paginação (página repetida, limite de segurança): com aviso, a lista pode
        estar cortada e o fim não foi confirmado. `limite_seguranca` sobe só para o catálogo inteiro (FIEB tem ~1.400
        páginas de 100)."""
        def buscar(de: int, ate: int) -> Any:
            return self._ws("PesquisarCatalogoProdutos", {"dtoProduto": {
                "sCdProduto": codigo, "sDsProduto": descricao, "nCdTipo": TIPOS_CATALOGO[tipo],
                "nCdClasse": (classe or {}).get("nCdClasse") or 0, "sDsClasse": (classe or {}).get("sDsClasse") or "",
                "sOrdenarPor": "SCDPRODUTOEMPRESA", "sOrdenarPorDirecao": "ASC",
                "dtoPaginacao": {"nPaginaDe": de, "nPaginaAte": ate},
                "dtoIdioma": {"nCdIdioma": 1}}})
        return paginar_intervalo(buscar, tamanho=TAMANHO_PAGINA, rotulo=f"catálogo {self.fonte.slug}",
                                 limite_seguranca=limite_seguranca)

    def produtos_escopo(self, categorias: list[str] | None = None, tipo: str = "produto") -> dict[int, dict]:
        """nCdProduto -> {codigo, descricao, categoria, tipo} para as categorias mapeadas, filtradas por Tipo."""
        produtos: dict[int, dict] = {}
        for nome in categorias or categorias_da_fonte(self.fonte.slug):
            classes = self.classes_catalogo(nome)
            if not classes:
                # Categoria renomeada ou removida no portal: sem aviso, o catálogo encolhe calado (FIEMS/FIEMT
                # ficaram meses com 0 produtos assim).
                log.warning("catálogo %s: categoria %r sem classe de nome exato no portal", self.fonte.slug, nome)
            for c in classes:
                for x in self.catalogo(c, tipo):
                    if isinstance(x.get("nCdProduto"), int):
                        produtos[x["nCdProduto"]] = {"codigo": x.get("sCdProdutoEmpresa"), "descricao": x.get("sDsProduto"),
                                                     "categoria": x.get("sDsClasse"), "id_categoria": x.get("nCdClasse"),
                                                     "tipo": x.get("sDsProdutoTipo")}
        return produtos


# ---------------- mapeamento para o schema (licitacoes_externas / licitacao_itens / licitacao_resultados) ----------------
def linha_licitacao(fonte: Fonte, d: dict, categoria: str | None, borracha: bool, agora: datetime | None = None,
                    listagem: dict | None = None, origem: str = "manual") -> dict:
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
        **campos_proveniencia(d, origem, agora),  # spec 0023
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
    classes = [classificar_item(it, produtos, ctx) for it in itens]
    cats = [c[0] for c in classes]
    cat_obj = classificar(d.get("sDsObjeto") or "")
    # Compra só de serviço (todos os itens 'S'): o objeto ("prestação de serviços de manutenção dos equipamentos de
    # musculação", "serviço de ginástica laboral") não vira forte/fraco sem fornecer o produto. Mesma trava do PNCP
    # (pncp.avaliar, 02/10/2026); piso/obra_piso/borracha seguem valendo (interesse na borracha). FIEB, 09/11/2026.
    t_obj = normalizar(d.get("sDsObjeto") or "")
    if (classes and all(c[2] == "S" for c in classes) and cat_obj in CATEGORIAS_SO_MATERIAL
            and not fornece_produto(t_obj) and not OBJETO_CITA_PISO.search(t_obj)):
        cat_obj = None
    candidatas = [c for c in cats + [cat_obj] if c]
    if not candidatas:
        return None, False
    cats_itens = {c for c in cats if c}
    # Compra só de peças ("CABO DE AÇO ... PARA EQUIPAMENTO DE ACADEMIA"): o objeto cita academia, mas os itens mandam.
    melhor = "manutencao" if cats_itens == {"manutencao"} else min(candidatas, key=ordem.index)
    borr = any(c[1] for c in classes) or interesse_borracha(d.get("sDsObjeto") or "", cat_obj)
    return melhor, borr


# ---------------- execução ----------------
TERMOS_SISTEMA_S = [
    "academia", "esporte e lazer", "musculação", "ginástica", "pilates", "tatame", "esteira",
    "halter", "grama sintética", "piso emborrachado", "piso esportivo", "quadra", "borracha granulada",
]


def processar_processo(portal: "PortalParadigma", sb, pid: int, mod: int, resumo: dict, dry_run: bool,
                       com_resultados: bool, produtos: dict[int, dict] | None, fornecedores=None,
                       forcar: bool = False, listagem: dict | None = None, documentos=None,
                       origem: str = "manual") -> None:
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
        lic = sb.upsert("licitacoes_externas",
                        linha_licitacao(portal.fonte, d, cat, borr, listagem=listagem, origem=origem),
                        "fonte,modulo,id_externo")[0]
        for i in li:
            i["licitacao_id"] = lic["id"]
        if li:
            sb.upsert("licitacao_itens", li, "licitacao_id,numero_item")
    if documentos is not None:
        # Todos os anexos do processo (aberto ou fechado) ficam registrados e guardados no LicitaGym.
        try:
            r = documentos.sincronizar(lic["id"] if lic else None, d,
                                       f"paradigma/{portal.fonte.slug}/{modulo_de(d)}/{d['nCdProcesso']}",
                                       resumo_processo=quer_resumo_do_processo(d))
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
            processos: list[tuple[int, int]] | None = None, anos: list[int] | None = None, documentos=None,
            origem: str = "manual", resumo: dict | None = None) -> dict:
    """`resumo`, quando vem de quem chama, é preenchido no lugar: interrompida pelo limite da etapa (SIGTERM), a
    coleta ainda deixa os contadores do que já gravou."""
    base = {"listados": 0, "processos": 0, "no_escopo": 0, "itens_escopo": 0, "itens_catalogo": 0,
            "resultados": 0, "itens_com_vencedor": 0, "alertas": 0, "erros": 0,
            "participantes": 0, "fornecedores_consultados": 0, "fornecedores_em_cache": 0,
            "fornecedores_erros": 0, "paginacao_avisos": []}
    if resumo is None:
        resumo = base
    else:
        for chave, valor in base.items():
            resumo.setdefault(chave, valor)
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
                               forcar=bool(processos), listagem=x, documentos=documentos, origem=origem)
        except Exception as e:  # um processo com erro não derruba a coleta, mas é contado
            resumo["erros"] += 1
            log.warning("%s %s: %s", portal.fonte.slug, pid, e)
    return resumo


def modo_registro(anos: list[int] | None, processos: list[tuple[int, int]] | None) -> str:
    """Modo gravado em private.coleta_externa_run (vocabulário da constraint da tabela)."""
    if anos:
        return "historico"
    if processos:
        return "monitorar"
    return "leads"


def status_final(resumo: dict) -> str:
    """Status gravado em coleta_externa_run; 'falhou' é também o critério do código de saída 1.

    Erro sem nada no escopo é falha. Aviso de paginação (teto de segurança ou página repetida) não é fim confirmado
    da listagem: a coleta conta como concluída com erros, nunca como concluída limpa."""
    if resumo.get("erros") and not resumo.get("no_escopo"):
        return "falhou"
    if resumo.get("erros") or resumo.get("paginacao_avisos"):
        return "concluida_com_erros"
    return "concluida"


_SEGREDOS = re.compile(r"(?i)(bearer\s+)\S+|eyJ[\w-]+\.[\w-]+\.[\w-]*|((?:apikey|api_key|token|key)=)[^&\s]+")


def mascarar_segredos(texto: str) -> str:
    """Mascara token Bearer, JWT e chave em query string antes de gravar mensagem de erro no banco."""
    return _SEGREDOS.sub(lambda m: (m.group(1) or m.group(2) or "") + "***", texto)


class RegistroColeta:
    """Registra a execução em private.coleta_externa_run pelas RPCs coleta_externa_iniciar/finalizar.

    É o dado que a saúde operacional (coleta_externa_dias_sem_sucesso) lê. Falha ao registrar não derruba a
    coleta: vira aviso no log. Sem cliente (dry-run), não registra nada."""

    def __init__(self, sb, fonte: str, modo: str, termos: list[str] | None):
        self.sb = sb
        self.id: int | None = None
        if sb is None:
            return
        try:
            self.id = int(sb.rpc("coleta_externa_iniciar", {"p_fonte": fonte, "p_modo": modo, "p_termos": termos}))
        except Exception as e:  # noqa: BLE001 - registro é observabilidade, não pode parar a coleta
            log.warning("coleta_externa_run: não abriu o registro da execução (%s)", e)

    def finalizar(self, status: str, resumo: dict | None = None, erro: str | None = None) -> None:
        if self.sb is None or self.id is None:
            return
        r = resumo or {}
        detalhe: dict[str, Any] = {}
        if erro:
            detalhe["erro"] = mascarar_segredos(erro)[:500]
        if r.get("paginacao_avisos"):
            detalhe["paginacao_avisos"] = [str(a)[:200] for a in r["paginacao_avisos"][:20]]
        try:
            self.sb.rpc("coleta_externa_finalizar", {
                "p_id": self.id, "p_status": status,
                "p_listados": int(r.get("listados", 0)), "p_processos": int(r.get("processos", 0)),
                "p_no_escopo": int(r.get("no_escopo", 0)), "p_itens_escopo": int(r.get("itens_escopo", 0)),
                "p_erros": int(r.get("erros", 0) or (1 if erro else 0)),
                "p_detalhe_erros": detalhe or None,
            })
        except Exception as e:  # noqa: BLE001
            log.warning("coleta_externa_run: não fechou o registro %s (%s)", self.id, e)


def main(argv: list[str] | None = None) -> int:
    from .destino import Supabase, env
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
                                         f"(padrão: {'; '.join(CATEGORIAS_MAPEADAS)}; fieb, fiems e fiemt têm "
                                         "nomes próprios em CATEGORIAS_POR_FONTE)")
    ap.add_argument("--tipo", choices=sorted(TIPOS_CATALOGO), default="produto", help="filtro Tipo do catálogo")
    ap.add_argument("--sem-catalogo", action="store_true", help="não usa o catálogo do portal (só regras de texto)")
    ap.add_argument("--sem-resultados", action="store_true")
    ap.add_argument("--sem-fornecedores", action="store_true", help="não consulta CNPJ dos participantes")
    ap.add_argument("--sem-documentos", action="store_true", help="não registra/baixa os anexos do processo")
    ap.add_argument("--dry-run", action="store_true", help="não grava; mostra vencedores e fornecedores consultados")
    ap.add_argument("--origem", choices=list(ORIGENS), default="manual",
                    help="origem da ingestão gravada em cada linha (spec 0023): cron ou manual (padrão)")
    args = ap.parse_args(argv)
    if args.paginas is not None and args.paginas < 1:
        ap.error("--paginas deve ser >= 1")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    fonte = FONTES[args.fonte]
    portal = PortalParadigma(
        fonte, delay=float(env("DELAY_SEGUNDOS", "1.5")), autorizado=autorizado_para_coleta(fonte))
    # O Sistema S adota regulamento próprio (RCA) e não acompanha CATMAT federal (drenar_catmat=False).
    sb = None if args.dry_run else Supabase(env("SUPABASE_URL", obrigatorio=True),
                                            env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True),
                                            drenar_catmat=False)
    termos = [t.strip() for t in args.termos.split(";")] if args.termos else TERMOS_SISTEMA_S
    processos = None
    if args.processo:
        processos = [(int(p.split("/")[0]), int(p.split("/")[1]) if "/" in p else MODULO_PADRAO) for p in args.processo]
    anos = [int(a) for a in args.anos.split(",")] if args.anos else None
    # Só a coleta agendada (origem cron) entra em coleta_externa_run: é ela que a saúde acompanha
    # (coleta_externa_dias_sem_sucesso, pior fonte). Disparo manual de uma fonte fora do lote agendado deixaria a
    # métrica crítica para sempre. Fonte bloqueada no construtor do portal (ex.: fiemg) nem chega aqui.
    registro = RegistroColeta(sb if args.origem == "cron" else None, fonte.slug, modo_registro(anos, processos), termos)
    # Limite da etapa (timeout interno do workflow) manda SIGTERM: vira TempoEsgotado e o registro fecha como
    # `incompleta`, com os contadores do que já foi gravado, em vez de ficar aberto ou zerado como falha.
    parcial: dict = {}

    def _tempo_esgotado(_sig, _frame):
        raise TempoEsgotado()

    sigterm_anterior = signal.signal(signal.SIGTERM, _tempo_esgotado)
    try:
        try:
            r = _executar(args, fonte, portal, sb, termos, processos, anos, CadastroFornecedores, resumo=parcial)
        except TempoEsgotado:
            registro.finalizar("incompleta", parcial, erro="interrompida por SIGTERM (limite da etapa)")
            raise SystemExit(143) from None
        except KeyboardInterrupt:
            registro.finalizar("cancelada", erro="interrompida (KeyboardInterrupt)")
            raise
        except BaseException as e:
            registro.finalizar("falhou", erro=f"{type(e).__name__}: {e}")
            raise
        status = status_final(r)
        registro.finalizar(status, r)
    finally:
        # Só depois de fechar o registro: um SIGTERM durante a RPC final não pode matar o processo com ele aberto.
        signal.signal(signal.SIGTERM, sigterm_anterior)
    print(json.dumps(r, ensure_ascii=False))
    return 1 if status == "falhou" else 0


def _executar(args, fonte: Fonte, portal: "PortalParadigma", sb, termos: list[str],
              processos: list[tuple[int, int]] | None, anos: list[int] | None, cadastro_fornecedores,
              resumo: dict | None = None) -> dict:
    from .destino import env

    produtos = None
    if not args.sem_catalogo:
        cats = [c.strip() for c in args.categorias.split(";")] if args.categorias else None
        try:
            produtos = portal.produtos_escopo(cats, args.tipo)
            log.info("catálogo %s: %d produtos (tipo=%s, categorias=%s)", args.fonte, len(produtos), args.tipo,
                     cats or categorias_da_fonte(args.fonte))
        except requests.RequestException as e:  # tenant sem catálogo público: segue só com regras de texto
            log.warning("catálogo %s indisponível: %s", args.fonte, e)
    forn = None if args.sem_fornecedores or args.sem_resultados else cadastro_fornecedores(sb, dry_run=args.dry_run)
    docs = None
    if not args.sem_documentos:
        from .destino import Armazenamento
        from .documentos_paradigma import DocumentosParadigma, VisitanteInstitucional
        arm = None if args.dry_run else Armazenamento.do_ambiente()
        if arm is not None and not arm.dentro_do_saas:
            raise SystemExit("Defina SUPABASE_STORAGE_BUCKET: os documentos precisam ficar dentro do LicitaGym.")
        # Decisão de 09/11/2026 (revoga a de 11/10): o cadastro de visitante (dados da empresa, informados na UI) vale
        # em toda fonte que coleta. Sem VISITANTE_*, documento que exige cadastro fica pendente.
        visitante = VisitanteInstitucional.do_ambiente()
        if visitante is None:
            log.warning("VISITANTE_* não configurado: documentos que exigem cadastro ficam registrados como pendentes")
        docs = DocumentosParadigma(portal, sb, arm, visitante, int(float(env("MAX_MB", "50")) * 1048576), args.dry_run)
    return coletar(portal, sb, termos, args.paginas, args.dry_run, not args.sem_resultados, produtos, forn, processos,
                   anos, docs, origem=args.origem, resumo=resumo)


if __name__ == "__main__":
    sys.exit(main())

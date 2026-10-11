"""Coletor PNCP — busca nacional por licitações no escopo LicitaGym.

Usa as APIs públicas do Portal Nacional de Contratações Públicas (mapeadas em 24/09/2026):
  GET https://pncp.gov.br/api/search/?q="termo"&tipos_documento=edital&status=...&pagina=&tam_pagina=
  GET https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}   (detalhe: processo e estado)
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados
  GET https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos  (-> url de cada arquivo)

Exemplos:
  python -m coletor.pncp --dry-run --paginas 1                       # só mostra o que acharia
  python -m coletor.pncp                                             # leads: recebendo proposta
  python -m coletor.pncp --modo monitorar                            # em julgamento
  python -m coletor.pncp --modo historico --paginas 20               # encerradas: histórico p/ RAG e preço
  python -m coletor.pncp --termos "borracha granulada,raspa de borracha" --baixar-arquivos

licitacoes_externas.prioridade (decisão do owner, 29/09/2026) vem do ESTADO da compra, não do modo:
  leads = recebendo proposta | monitorar = em julgamento | historico = encerrada/homologada/com resultado.
Ver prioridade_da_compra(). Compra homologada não é lead.

Metadados de origem e versão (migration 20261002230000_pncp_link_origem_atualizacao_anexos):
  licitacoes_externas.link_sistema_origem = linkSistemaOrigem do detalhe (portal onde a disputa acontece);
  licitacoes_externas.pncp_data_atualizacao[_global] = dataAtualizacao[Global] do detalhe, gravadas só no FIM de
  uma coleta completa (metadados + itens + resultados + lista de arquivos); recoletar_atualizadas() recoleta
  a compra quando o PNCP mostra outro valor (python -m coletor.pncp --recoletar-atualizadas).
  Anexo com statusAtivo=false não é gravado; o que já existia ganha removido_do_portal_em (mesmo critério do #134).

Prefeituras normalmente NÃO informam código CATMAT; por isso a busca é textual e cada
compra passa pelo classificador de escopo (coletor/escopo.py) usando objeto + itens.
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
import unicodedata
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import requests

from .arquivo_raw import ArquivoRaw, ArquivoRawErro, fechar_todos
from .destino import Armazenamento, Supabase, drenar_licitacao_match, env, parece_html, sha256
from .paginacao import TAMANHO_PAGINA_MAX, avaliar_pagina, clamp_tamanho
from . import escopo as _escopo
from .catmat_codigo import (
    LeituraMapaCatmat,
    MapaCatmat,
    MapaCatmatIndisponivel,
    carregar_mapa_catmat_se_houver_banco,
    catalogo_id,
    categoria_por_codigo,
)
from .escopo import (
    PRODUTO,
    TERMOS_ESCOPO_COMPLETO,
    academia_ar_livre,
    classificar,
    excluir_compra,
    interesse_borracha,
    normalizar,
    obra_ou_construcao,
    piso_item_fora,
    servico_sem_material,
    so_tatame,
)
from .portal import cnpj_ou_none
from .retry import MAX_RETRY_AFTER_S, retry_after_s as _retry_after_s  # noqa: F401 (reexport)

log = logging.getLogger("pncp")
BASE = "https://pncp.gov.br"
CATEGORIAS_PADRAO_DOWNLOAD = "catmat,forte,borracha,piso,obra_piso"
PRIORIDADES_VALIDAS = frozenset({"leads", "monitorar", "historico"})
# Downloads só de https nestes hosts (match exato, sem subdomínio). A URL vem do banco
# (licitacao_documentos.raw.url): sem a allowlist o coletor buscaria qualquer endereço (SSRF).
PNCP_HOSTS_PERMITIDOS = tuple(h.strip().lower() for h in
                              os.environ.get("PNCP_HOSTS_PERMITIDOS", "pncp.gov.br").split(",") if h.strip())
MAX_REDIRECTS = 5
_REDIRECTS = (301, 302, 303, 307, 308)


class RespostaInvalida(RuntimeError):
    """HTTP 200 cujo corpo não é o JSON esperado (HTML, JSON inválido, tipo errado)."""


class ArquivoRecusado(ValueError):
    """Download recusado de forma definitiva (host fora da allowlist, HTML no lugar do arquivo).
    Repetir não adianta: o documento vai para status 'erro'."""


def url_permitida(url: str | None, hosts: tuple[str, ...] | None = None) -> bool:
    """https, host exato da allowlist, porta padrão e sem credenciais na URL."""
    hosts = PNCP_HOSTS_PERMITIDOS if hosts is None else hosts
    try:
        p = urlsplit(url or "")
        porta = p.port
    except ValueError:
        return False
    return (p.scheme == "https" and (p.hostname or "").lower() in hosts and porta in (None, 443)
            and not p.username and not p.password)


class ConsultaFalhou(RuntimeError):
    """Consulta ao PNCP falhou (timeout, 429/5xx esgotados, resposta inválida).
    Diferente de resposta válida sem o dado: quem recebe não deve gravar nada."""


class CompraExcluida(ConsultaFalhou):
    """O detalhe respondeu HTTP 410 (Gone): a compra foi excluída do PNCP (evento "Exclusão – Contratação";
    ex.: id 1315 em 02/10/2026 09:05 BRT). Subclasse de ConsultaFalhou para quem só trata falha continuar igual;
    o coletor e o reclassificador usam o sinal para gravar historico/"Excluída do PNCP" (não é Oportunidade)."""


def validar_prioridades(prioridades: list[str] | set[str] | str | None) -> set[str] | None:
    """Valida e normaliza o conjunto de prioridades permitidas.
    Aceita lista, conjunto ou string separada por vírgula (case-insensitive, ignora espaços).
    Retorna set[str] normalizado em minúsculas ou None se prioridades for None.
    Levanta ValueError se contiver valor inválido ou se resultar em lista vazia quando fornecido."""
    if prioridades is None:
        return None
    if isinstance(prioridades, str):
        itens = [p.strip().lower() for p in prioridades.split(",")]
        # Remove vazios mas confere se sobrou algo
        candidatos = [p for p in itens if p]
    else:
        candidatos = [p.strip().lower() if isinstance(p, str) else str(p).lower() for p in prioridades if str(p).strip()]

    if not candidatos:
        permitidas = ", ".join(sorted(PRIORIDADES_VALIDAS))
        raise ValueError(f"Nenhuma prioridade válida informada. Valores permitidos: {permitidas}")

    invalidos = [c for c in candidatos if c not in PRIORIDADES_VALIDAS]
    if invalidos:
        permitidas = ", ".join(sorted(PRIORIDADES_VALIDAS))
        invalidos_str = ", ".join(sorted(set(invalidos)))
        raise ValueError(f"Prioridade(s) inválida(s): {invalidos_str}. Valores permitidos: {permitidas}")

    return set(candidatos)

# Detalhe da compra e atalho (o edital e a fonte principal): nao gastar 10 min nele.
DETALHE_TIMEOUT = int(os.environ.get("PNCP_DETALHE_TIMEOUT", "20"))
DETALHE_TENTATIVAS = int(os.environ.get("PNCP_DETALHE_TENTATIVAS", "2"))
# /atas da compra (pncp-integracao-v3): tamanhoPagina >= 10; família atas aceita até 500.
TAMANHO_PAGINA_ATAS = 100
ATAS_PAGINAS_MAX = 20

# Termos padrão: prioriza o interesse comercial (grama/borracha) e o núcleo fitness
TERMOS_PADRAO = [
    "borracha granulada", "raspa de borracha", "granulado de borracha", "grama sintética",
    "campo society", "piso emborrachado", "academia ao ar livre", "equipamentos de academia",
    "equipamentos de musculação", "aparelhos de ginástica", "material esportivo", "parque infantil",
]


class PNCP:
    """Cliente do PNCP. O endpoint de itens é lento e instável (503/timeout intermitentes):
    várias tentativas com espera crescente; uma sessão HTTP por thread."""

    def __init__(self, delay: float = 0.5, timeout: int = 90, tentativas: int = 6):
        self.delay, self.timeout, self.tentativas = delay, timeout, tentativas
        self._local = threading.local()

    @property
    def s(self) -> requests.Session:
        if not hasattr(self._local, "s"):
            self._local.s = requests.Session()
            self._local.s.headers["User-Agent"] = "LicitaGym-Coletor/1.0 (pesquisa de licitações públicas)"
        return self._local.s

    def _get(self, caminho: str, *, _timeout=None, _tentativas=None, **params):
        url = caminho if caminho.startswith("http") else BASE + caminho
        ultimo = None
        for tentativa in range(_tentativas or self.tentativas):
            try:
                r = self.s.get(url, params=params or None, timeout=_timeout or self.timeout)
                time.sleep(self.delay)
                if r.status_code == 204:
                    return []
                if r.status_code in (429, 500, 502, 503, 504):
                    ultimo = requests.HTTPError(f"{r.status_code} do PNCP", response=r)
                    espera = _retry_after_s(r) if r.status_code == 429 else None
                    time.sleep(espera if espera is not None else min(60, 5 * 2 ** tentativa))
                    continue
                r.raise_for_status()
                if "json" not in (r.headers.get("content-type") or ""):
                    raise RespostaInvalida(f"PNCP {url}: HTTP {r.status_code} sem JSON "
                                           f"({r.headers.get('content-type')})")
                try:
                    return r.json()
                except ValueError as e:
                    raise RespostaInvalida(f"PNCP {url}: JSON inválido: {e}") from e
            except (requests.ConnectionError, requests.Timeout) as e:
                ultimo = e
                time.sleep(min(60, 5 * 2 ** tentativa))
        raise ultimo or RuntimeError("PNCP sem resposta")

    def _lista(self, caminho: str, **params) -> list:
        r = self._get(caminho, **params)
        if not isinstance(r, list):
            raise RespostaInvalida(f"PNCP {caminho}: esperava lista, veio {type(r).__name__}")
        return r

    def buscar(self, termo: str, status: str = "todos", pagina: int = 1, tam: int = 100) -> dict:
        tam = clamp_tamanho(tam, padrao=100, minimo=1, maximo=TAMANHO_PAGINA_MAX)
        r = self._get("/api/search/", q=f'"{termo}"', tipos_documento="edital", ordenacao="-data",
                      pagina=pagina, tam_pagina=tam, status=status)
        if r == []:
            return {"items": [], "total": 0}
        if not isinstance(r, dict) or not isinstance(r.get("items"), list):
            raise RespostaInvalida(f"PNCP busca: envelope inesperado ({type(r).__name__})")
        return r

    @staticmethod
    def base_compra(c: dict) -> str:
        """Itens/arquivos/resultados continuam em /api/pncp/v1."""
        return f"/api/pncp/v1/orgaos/{c['orgao_cnpj']}/compras/{c['ano']}/{c['numero_sequencial']}"

    @staticmethod
    def detalhe_compra(c: dict) -> str:
        """Detalhe da compra: PNCP moveu para /api/consulta/v1 (pncp/v1 responde 301 em JSON)."""
        return f"/api/consulta/v1/orgaos/{c['orgao_cnpj']}/compras/{c['ano']}/{c['numero_sequencial']}"

    def compra(self, c: dict) -> dict:
        """Detalhe da compra: traz o número do PROCESSO ADMINISTRATIVO ('processo'),
        que a busca não devolve. É ele (com o CNPJ do órgão) que identifica o certame fora do PNCP.
        Traz também o estado atual da compra (existeResultado, valorTotalHomologado, situacaoCompraNome,
        dataEncerramentoProposta), que vence o item da busca na prioridade (ver compra_com_detalhe)."""
        r = self._get(self.detalhe_compra(c), _timeout=DETALHE_TIMEOUT, _tentativas=DETALHE_TENTATIVAS)
        # PNCP devolve erro de rota como JSON {status, message} com HTTP 200.
        if isinstance(r, dict) and str(r.get("status", "")).startswith(("3", "4", "5")) and "message" in r:
            raise RuntimeError(f"PNCP detalhe: {r.get('status')} {r.get('message')}")
        if not isinstance(r, dict):
            raise RespostaInvalida(f"PNCP detalhe: esperava objeto, veio {type(r).__name__}")
        return r

    def itens(self, c: dict) -> list[dict]:
        """Itens da compra. O corpo é uma lista, sem total: segue até a página vazia.

        Página curta não encerra. Página repetida ou HTTP 404 não são fim de coleta.
        """
        out, pagina, paginas_vistas = [], 1, set()
        while True:
            try:
                lote = self._lista(
                    self.base_compra(c) + "/itens", pagina=pagina, tamanhoPagina=TAMANHO_PAGINA_MAX,
                )
            except requests.HTTPError as e:
                status = getattr(getattr(e, "response", None), "status_code", None)
                if status == 404:
                    log.warning("PNCP itens: HTTP 404 na página %s; não é fim de coleta", pagina)
                raise
            fingerprint = sha256(json.dumps(
                lote, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8"))
            if fingerprint in paginas_vistas:
                raise RespostaInvalida(f"PNCP itens: página repetida durante paginação (página {pagina})")
            paginas_vistas.add(fingerprint)
            out += lote
            # Sem total no corpo: só a página vazia encerra.
            if not lote:
                return out
            pagina += 1

    def resultados(self, c: dict, numero_item: int) -> list[dict]:
        return self._lista(self.base_compra(c) + f"/itens/{numero_item}/resultados")

    def arquivos(self, c: dict) -> list[dict]:
        return self._lista(self.base_compra(c) + "/arquivos")

    def atas(self, c: dict) -> list[dict]:
        """Atas de registro de preço da compra: GET /api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/atas
        (pncp-integracao-v3, PaginaRetornoAtaRegistroPrecoDTO: {data, totalPaginas, numeroPagina,
        paginasRestantes, empty}; tamanhoPagina mínimo 10, família atas até 500). HTTP 204 = sem atas.
        Envelope inesperado, página repetida ou erro HTTP levantam: quem chama trata como "sem informação",
        nunca como "sem ata"."""
        out, pagina, vistas = [], 1, set()
        while True:
            r = self._get(self.base_compra(c) + "/atas", pagina=pagina, tamanhoPagina=TAMANHO_PAGINA_ATAS)
            if r == []:   # 204
                return out
            if not isinstance(r, dict) or not isinstance(r.get("data"), list):
                raise RespostaInvalida(f"PNCP atas: envelope inesperado ({type(r).__name__})")
            lote = r["data"]
            impressao = sha256(json.dumps(lote, ensure_ascii=False, sort_keys=True).encode("utf-8"))
            if lote and impressao in vistas:
                raise RespostaInvalida(f"PNCP atas: página repetida (página {pagina})")
            vistas.add(impressao)
            out += lote
            restantes = r.get("paginasRestantes")
            if not lote or not isinstance(restantes, int) or restantes <= 0:
                return out
            if pagina >= ATAS_PAGINAS_MAX:
                raise RespostaInvalida(f"PNCP atas: mais de {ATAS_PAGINAS_MAX} páginas")
            pagina += 1

    def _abrir(self, url: str):
        """GET em streaming sem redirecionamento automático: cada salto passa pela allowlist."""
        atual = url
        for _ in range(MAX_REDIRECTS + 1):
            if not url_permitida(atual):
                raise ArquivoRecusado(f"URL fora dos hosts permitidos ({', '.join(PNCP_HOSTS_PERMITIDOS)}): "
                                      f"{str(atual)[:120]}")
            r = self.s.get(atual, stream=True, timeout=(30, 180), allow_redirects=False)
            if r.status_code in _REDIRECTS:
                destino = (r.headers or {}).get("Location")
                r.close()
                if not destino:
                    raise RespostaInvalida(f"PNCP {atual}: redirecionamento sem Location")
                atual = urljoin(atual, destino)
                continue
            return r
        raise RespostaInvalida(f"PNCP {url}: mais de {MAX_REDIRECTS} redirecionamentos")

    def baixar(self, url: str, max_bytes: int) -> tuple[bytes, str | None]:
        ultimo = None
        for tentativa in range(self.tentativas):
            try:
                with self._abrir(url) as r:
                    if r.status_code == 429:
                        ultimo = requests.HTTPError(f"{r.status_code} do PNCP", response=r)
                        espera = _retry_after_s(r)
                        time.sleep(espera if espera is not None else min(60, 5 * 2 ** tentativa))
                        continue
                    if r.status_code in (500, 502, 503, 504):
                        ultimo = requests.HTTPError(f"{r.status_code} do PNCP", response=r)
                        time.sleep(min(60, 5 * 2 ** tentativa))
                        continue
                    r.raise_for_status()
                    ctype = (r.headers.get("content-type") or "").split(";")[0] or None
                    partes, total = [], 0
                    for b in r.iter_content(256 * 1024):
                        partes.append(b)
                        total += len(b)
                        if total > max_bytes:
                            raise ValueError(f"arquivo acima de {max_bytes // 1048576} MB")
                    time.sleep(self.delay)
                    return b"".join(partes), ctype
            except (requests.ConnectionError, requests.Timeout) as e:
                ultimo = e
                time.sleep(min(60, 5 * 2 ** tentativa))
        raise ultimo or RuntimeError("PNCP sem resposta")


def _num(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _valor_positivo(v):
    """Valor monetário da compra: None se ausente, inválido ou <= 0 (PNCP manda 0 em orçamento
    sigiloso). Um 0 gravado pareceria dado real e sobrescreveria um valor bom."""
    n = _num(v)
    return n if n is not None and n > 0 else None


def valor_total_detalhe(det: dict) -> float | None:
    """valor_total da compra a partir do detalhe (/api/consulta/v1/.../compras/{ano}/{seq}).

    Usa só valorTotalEstimado (valor de referência do edital). valorTotalHomologado NÃO entra como
    fallback: é o valor adjudicado depois da disputa — grandeza diferente, e misturar os dois na
    mesma coluna tornaria valor_total incomparável entre compras (e o homologado nem existe em
    editais abertos, que são justamente os que chegam sem valor)."""
    return _valor_positivo((det or {}).get("valorTotalEstimado"))


def _link_http(v) -> str | None:
    """URL http(s) ou None (o link vai para a interface: nada de javascript:, data: etc.)."""
    if not isinstance(v, str):
        return None
    v = v.strip()
    try:
        p = urlsplit(v)
    except ValueError:
        return None
    return v if p.scheme in ("http", "https") and p.netloc else None


def link_sistema_origem(c: dict, det: dict | None) -> str | None:
    """Portal onde a disputa acontece: linkSistemaOrigem do detalhe > link_sistema_origem do item da busca."""
    return _link_http((det or {}).get("linkSistemaOrigem")) or _link_http(c.get("link_sistema_origem"))


# Colunas de versão da compra no PNCP (licitacoes_externas) e as chaves do detalhe de onde vêm.
DATAS_ATUALIZACAO = (("pncp_data_atualizacao", "dataAtualizacao"),
                     ("pncp_data_atualizacao_global", "dataAtualizacaoGlobal"))


def datas_atualizacao(det: dict | None) -> dict:
    """{coluna: ISO com fuso} das datas de atualização do detalhe (sem fuso = Brasília). Só as que vieram:
    ausente nunca vira NULL gravado por cima de valor bom."""
    out = {}
    for coluna, chave in DATAS_ATUALIZACAO:
        d = _instante((det or {}).get(chave))
        if d:
            out[coluna] = d.isoformat()
    return out


def mudou_no_pncp(guardado: dict, det: dict | None) -> str | None:
    """Motivo para recoletar a compra, ou None se as datas do PNCP batem com as guardadas.
    `guardado` = linha de licitacoes_externas (pncp_data_atualizacao[_global]). Compara instantes, não texto.
    Sem nenhuma data no detalhe não dá para decidir: None (quem chama conta como sem_data_pncp)."""
    atuais = datas_atualizacao(det)
    if not atuais:
        return None
    if not any(guardado.get(coluna) for coluna, _ in DATAS_ATUALIZACAO):
        return "sem valor guardado"
    for coluna, chave in DATAS_ATUALIZACAO:
        if coluna in atuais and _instante(guardado.get(coluna)) != _instante(atuais[coluna]):
            return f"{chave} mudou"
    return None


# licitacao_itens.material_ou_servico só aceita 'M' ou 'S' (CHECK licitem_ms_chk, migration 20260925120000).
# O PNCP manda o código em materialOuServico ("M"/"S") e o nome em materialOuServicoNome ("Material"/"Serviço").
# Em 30/09/2026 o coletor gravava o nome: todo insert de item falhava com 23514 e, como a exceção interrompe
# _processar, nenhum item, resultado ou documento das compras era gravado.
_MS_NOMES = {"m": "M", "material": "M", "materiais": "M", "s": "S", "servico": "S", "servicos": "S"}


def material_ou_servico(it: dict) -> str | None:
    """'M' | 'S' | None para um item do PNCP: o código (materialOuServico) vence o nome; o nome é comparado sem
    caixa e sem acento. Valor desconhecido vira None (o CHECK aceita NULL; o insert do item não falha)."""
    for chave in ("materialOuServico", "materialOuServicoNome"):
        v = it.get(chave)
        if v is None:
            continue
        chave_norm = unicodedata.normalize("NFKD", str(v)).encode("ascii", "ignore").decode().strip().lower()
        if chave_norm in _MS_NOMES:
            return _MS_NOMES[chave_norm]
    return None


def _data(v):
    if not v:
        return None
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat()
    except ValueError:
        return None


# Categorias de equipamento/material de academia: item marcado como serviço ('S') no PNCP não conta nelas
# (piso/obra_piso/borracha continuam: execução de piso ou gramado interessa pela borracha do vencedor).
CATEGORIAS_SO_MATERIAL = ("forte", "fraco", "catmat")
# Texto que FORNECE produto (parte explícita de escopo.PRODUTO, sem os substantivos soltos "equipamento",
# "aparelho", "material", "kit", que aparecem em "manutenção de aparelhos" e "locação de equipamentos", e sem
# "peças", que é manutenção). Só vale para compra só de serviço (compra_so_de_servico).
FORNECE_PRODUTO = re.compile(
    r"aquisic|\bcompras?\s+de\b|\binsumos?\b|fornecimento\s+(e\s+instalacao\s+)?(de\s+)?(materia|equipament|aparelh|"
    r"produt|kits?|brinquedo|piso|grama|borracha)|com\s+fornecimento\s+de\s+(materia|equipament|aparelh)", re.I)
# "Fornecimento [, instalação | e montagem | e entrega ...] de <X>" também fornece produto quando <X> é o próprio
# produto nomeado ("Fornecimento de halteres para academia", "Fornecimento e instalação de esteiras ergométricas",
# "Fornecimento e montagem de equipamentos de musculação"; Copilot, PR #134). Só é consultado quando o classificador
# já deu forte/fraco/catmat ao texto, então <X> não precisa ser listado. Não vale (a) quando <X> é peça, mão de obra,
# pessoal/profissionais/instrutores/oficineiros, serviço, manutenção ou reposição, nem (b) quando o próprio texto é
# de manutenção/reparo/troca/locação/credenciamento: "MANUTENÇÃO EM DECK DE ESTEIRA COM FORNECIMENTO DAS RESPECTIVAS
# PEÇAS" (2032, 2048) e "Reparo de aparelho ... incluído fornecimento e instalação de acolchoamento" (2064) seguem
# serviço (dry-run de 02/10/2026).
_FORNECIMENTO_NOMEADO = re.compile(
    r"\bfornecimento(\s*(,|e|com)\s*(a\s+|o\s+)?(respectiva\s+)?(instalacao|montagem|entrega|assentamento|implantacao|"
    r"transporte))*\s+(de|do|da|dos|das)\s+"
    r"(?!((todo|toda)s?\s+)?((o|a)s?\s+)?(respectiv\w*\s+)?(pecas?\b|componentes\s+de\s+reposicao|mao\s+de\s+obra|"
    r"pessoal\b|profissiona|instrutor|oficineir|professor|servic|manutenc|reposic|tecnicos?\b|equipe\b))\w", re.I)
_SERVICO_SOBRE_PRODUTO = re.compile(
    r"manutenc|\breparos?\b|\bconsert|\btrocas?\s+de\b|substituic|credenciament|recuperac|\brevisao", re.I)
# Locação/aluguel/comodato nunca é aquisição do equipamento ("Fornecimento de aparelhos de musculação em regime de
# locação mensal"; Copilot, PR #134, 2ª rodada).
_LOCACAO = re.compile(r"\blocac|\baluguel|\balugar\b|comodato", re.I)
# O sinal de produto cujo objeto é peça, mão de obra ou o próprio serviço ("aquisição de peças de reposição",
# "fornecimento das respectivas peças", "Aquisição de serviços de manutenção preventiva de aparelhos", "compra de
# serviço de instalação"; Copilot, PR #134, 3ª rodada) não é aquisição do equipamento.
_NAO_PRODUTO_DEPOIS = re.compile(
    r"^\w*\s+(de|do|da|dos|das)\s+((todo|toda)s?\s+)?((o|a)s?\s+)?(respectiv\w*\s+)?(novas?\s+)?"
    r"(pecas?\b|componentes\s+de\s+reposicao|mao\s+de\s+obra|servic|prestac|manutenc|contratac|empresa\b|"
    r"pessoa\s+juridica)", re.I)

# Aquisição efetiva de equipamento/aparelho vale mesmo depois do serviço ("serviços de revitalização, manutenção e
# recuperação de equipamentos de academia ... bem como aquisição de novos equipamentos", 1894): não é peça. Só
# quando o objeto da aquisição É o equipamento: "aquisição de [novos|outros|demais] equipamentos/aparelhos" logo em
# seguida (não "aquisição de serviços ... de aparelhos", nem "aquisição de peças de equipamentos"), e não
# equipamento de proteção/segurança/EPI/informática/limpeza (insumo do serviço).
_AQUISICAO_DE_EQUIPAMENTO = re.compile(
    r"\b(aquisic\w*|compras?)\s+(de|do|da|dos|das)\s+((novos?|novas?|outros?|demais)\s+)?(equipament|aparelh)[a-z]*\b"
    r"(?!\s+(de\s+|para\s+)?(protecao|seguranca|epis?\b|informatica|limpeza|medicao))", re.I)


def _inicio_do_produto(t: str) -> int | None:
    """Posição do primeiro sinal de fornecimento de produto (FORNECE_PRODUTO ou _FORNECIMENTO_NOMEADO) que não seja
    de peça/mão de obra; None = nenhum."""
    pos = [m.start() for m in FORNECE_PRODUTO.finditer(t) if not _NAO_PRODUTO_DEPOIS.search(t[m.start():])]
    m = _FORNECIMENTO_NOMEADO.search(t)
    if m:
        pos.append(m.start())
    return min(pos) if pos else None


def fornece_produto(texto: str | None) -> bool:
    """O texto (já normalizado) fornece produto? Ver FORNECE_PRODUTO e _FORNECIMENTO_NOMEADO, com a mesma trava de
    serviço nos dois ramos (Copilot, PR #134, 2ª rodada):
    - locação/aluguel/comodato no texto: não é aquisição;
    - fornecimento/aquisição de peças, mão de obra ou serviço ("Aquisição de serviços de manutenção"): não conta;
    - manutenção/reparo/troca/substituição/credenciamento/recuperação/revisão ANTES do sinal de produto: o texto é o
      serviço e o produto é acessório ("Manutenção de aparelhos com aquisição de peças", "Reparo ... incluído
      fornecimento de acolchoamento"); DEPOIS do sinal, a manutenção é acessória da compra e o produto vale
      ("Aquisição de esteiras ergométricas com manutenção preventiva durante a garantia"). Exceção: aquisição
      explícita de equipamento/aparelho (o objeto da aquisição é o equipamento) vale em qualquer posição
      (_AQUISICAO_DE_EQUIPAMENTO)."""
    t = texto or ""
    if _LOCACAO.search(t):
        return False
    inicio = _inicio_do_produto(t)
    if inicio is None:
        return False
    servico = _SERVICO_SOBRE_PRODUTO.search(t)
    return servico is None or inicio < servico.start() or bool(_AQUISICAO_DE_EQUIPAMENTO.search(t))


def compra_so_de_servico(itens: list[dict] | None) -> bool:
    """Compra com itens e TODOS marcados como serviço ('S') no PNCP."""
    return bool(itens) and all(material_ou_servico(it) == "S" for it in itens)


# Categorias que a regra do forte ancorado não toca (vêm do piso/borracha/obra ou do código CATMAT)
_FORA_DA_REGRA_ANCORADA = ("borracha", "obra_piso", "piso", "catmat")


def forte_ancorado(cat: str | None, descricao: str, ancoras) -> tuple[str | None, dict | None]:
    """Regra do forte ancorado (Marcelo, 03/10/2026 19:00 BRT, modo núcleo; coletor/catmat_ancoras.py).
    `cat` é a categoria do texto do item (escopo.classificar). Retorna (categoria, motivo):
    - piso, obra_piso, borracha e catmat: ficam como estão;
    - item que casa âncora de PDM ou de item incluído no catálogo: "forte"; se uma lista fixa de fora veta o texto
      (escopo.veto_lista_fixa), "fraco";
    - sem âncora: "forte" das listas fixas cai para "fraco"; "fraco" e None ficam.
    motivo (None quando nada muda): {"ancora", "pdm", "origem", "item_origem", "veto"}."""
    if cat in _FORA_DA_REGRA_ANCORADA:
        return cat, None
    hits = ancoras.casar(descricao)
    if hits:
        a = hits[0]
        veto = _escopo.veto_lista_fixa(descricao)
        motivo = {"ancora": a.ancora, "pdm": a.codigo_pdm, "origem": a.origem, "item_origem": a.codigo_item_origem,
                  "veto": veto}
        return ("fraco" if veto else "forte"), motivo
    if cat == "forte":
        return "fraco", {"ancora": None, "pdm": None, "origem": None, "item_origem": None, "veto": None}
    return cat, None


def avaliar(compra: dict, itens: list[dict], mapa_catmat: MapaCatmat | None = None,
            motivos: dict | None = None,
            ) -> tuple[str | None, bool, dict[int, tuple[str | None, bool]]]:
    """Classifica a compra pelo objeto e pelos itens. Retorna (categoria, interesse_borracha, por_item).

    Só o TEXTO do objeto e dos itens classifica: o termo de busca que achou a compra não entra (30/09/2026:
    id 229 tinha termos_busca ["treinamento funcional"] e virou "forte" pelos itens de oficineiro, não pelo termo).
    Compra cujo objeto é só serviço de pessoas (credenciamento de oficineiros, aulas, instrutores, vagas em
    academia) fica fora inteira; item marcado como serviço ('S') sem fornecimento de material no texto não conta
    como equipamento. Compra de academia ao ar livre (ATI) só entra pelo piso/grama/borracha.
    Compra de mobiliário, brinquedos, material de expediente ou material hospitalar (escopo.objeto_passagem) só fica
    "forte" com item core de equipamento (escopo.item_core); sem core, o forte cai para "fraco" (02/10/2026).
    Compra só de serviço (todos os itens 'S'; ex.: manutenção, locação, tapeçaria, orientação técnica) não vira
    forte/fraco/catmat pelo texto do objeto nem por item que só cita o aparelho ("manutenção de aparelhos de
    musculação"): só conta item ou objeto que fornece o produto (FORNECE_PRODUTO). Piso/obra_piso/borracha de
    item de obra seguem valendo (decisão de 30/09/2026) (02/10/2026).

    Código antes do texto (03/10/2026; coletor/catmat_codigo.py): com `mapa_catmat`, item de material com código do
    Catálogo do Compras.gov.br (catalogo.id = 1) presente no mapa CATMAT é classificado pelo código: PDM no catálogo
    efetivo da empresa -> "catmat", fora -> None. Sem código desse catálogo (Outros = código do órgão, CATSER) ou com
    código fora do mapa, vale o texto, como antes. As travas abaixo (obra, ar livre, passagem...) valem igual.
    `mapa_catmat` None = só texto (sem banco nenhum, testes antigos); com banco e RPC fora do ar, main aborta.

    Forte ancorado (03/10/2026, Marcelo: modo núcleo): com `mapa_catmat.ancoras`, item que o código não decidiu só
    é "forte" quando casa uma âncora do catálogo (forte_ancorado); as listas fixas só rebaixam para "fraco". O
    objeto da compra não tem âncora: "forte" do objeto vira "fraco". As travas acima continuam valendo depois
    (âncora não é item core da compra de passagem). `motivos` (opcional) recebe {numeroItem: motivo} dos itens em
    que a regra decidiu, para o relatório do reclassificador."""
    ancoras = mapa_catmat.ancoras if mapa_catmat is not None else None
    objeto = compra.get("description") or compra.get("title") or ""
    if excluir_compra(objeto) or servico_sem_material(objeto):
        return None, False, {it["numeroItem"]: (None, False) for it in itens}
    so_servico = compra_so_de_servico(itens)
    # Academia ao ar livre (ATI) está fora do escopo: numa compra dessas só o piso/grama/borracha conta;
    # "LEG PRESS DUPLO" ou "SIMULADOR DE CAVALGADA" de uma ATI não fazem a compra virar "forte".
    ar_livre = academia_ar_livre(objeto)
    # Terceira rodada (01/10/2026): obra/construção no objeto limita o que os itens valem; creche no objeto tira o
    # tatame de EVA; piso de borracha de outro produto/fino de obra não é piso.
    obra = obra_ou_construcao(objeto)
    predial = _escopo.manutencao_predial(objeto)
    creche = bool(_escopo.CRECHE_OBJETO.search(normalizar(objeto)))
    # Quarta rodada (02/10/2026): compra de passagem (móveis, brinquedos, expediente, hospitalar) só é "forte" com
    # item core; em compra também de material esportivo o tatame conta como core.
    passagem = bool(_escopo.objeto_passagem(objeto))
    esportivo = passagem and _escopo.objeto_esportivo(objeto)
    tem_core = False
    por_item = {}
    for it in itens:
        desc = it.get("descricao") or ""
        decidido, cat_codigo = categoria_por_codigo(it, mapa_catmat, material_ou_servico(it))
        cat = cat_codigo if decidido else classificar(desc)
        if ancoras is not None and not decidido:
            cat, motivo = forte_ancorado(cat, desc, ancoras)
            if motivo is not None and motivos is not None:
                motivos[it["numeroItem"]] = motivo
        # "Fornecimento de halteres"/"Fornecimento e instalação de esteiras" também fornecem produto (fornece_produto;
        # PRODUTO só conhece os substantivos genéricos)
        servico = material_ou_servico(it) == "S" and not PRODUTO.search(normalizar(desc)) and \
            not fornece_produto(normalizar(desc))
        # serviço ('S') nunca é core, nem quando o texto cita o aparelho ("manutenção de esteira ergométrica")
        if passagem and not tem_core and material_ou_servico(it) != "S" and not ar_livre and not obra and not predial:
            tem_core = _escopo.item_core(desc, esportivo)
        if cat in CATEGORIAS_SO_MATERIAL and servico:
            cat = None
        if so_servico and cat in CATEGORIAS_SO_MATERIAL and not fornece_produto(normalizar(desc)):
            cat = None
        if ar_livre and cat in CATEGORIAS_SO_MATERIAL:
            cat = None
        if cat in ("piso", "obra_piso") and piso_item_fora(desc):
            cat = None
        if obra and cat in CATEGORIAS_SO_MATERIAL:
            cat = None
        if creche and cat == "forte" and so_tatame(desc):
            cat = None
        if predial:   # manutenção predial: só o objeto decide (nem o piso da planilha SINAPI conta)
            por_item[it["numeroItem"]] = (None, False)
            continue
        por_item[it["numeroItem"]] = (cat, interesse_borracha(desc, cat))
    cat_obj = classificar(objeto)
    if ancoras is not None and cat_obj == "forte":   # o objeto não tem âncora: as listas fixas só dão "fraco"
        cat_obj = "fraco"
    # pncp.py:388-391 antes de 02/10/2026: o objeto sozinho ("manutenção de equipamentos de musculação") fazia
    # forte numa compra sem nenhum item de material.
    if so_servico and cat_obj in CATEGORIAS_SO_MATERIAL and not fornece_produto(normalizar(objeto)):
        cat_obj = None
    if passagem and not tem_core:   # item de passagem (tatame, bola, banco, puxador...) não segura o forte
        por_item = {n: ("fraco" if c == "forte" else c, b) for n, (c, b) in por_item.items()}
        cat_obj = "fraco" if cat_obj == "forte" else cat_obj
    prioridade = ["borracha", "obra_piso", "piso", "catmat", "forte", "fraco"]
    candidatas = [cat_obj] + [c for c, _ in por_item.values()]
    categoria = next((p for p in prioridade if p in candidatas), None)
    interesse = interesse_borracha(objeto, cat_obj) or any(b for _, b in por_item.values())
    return categoria, interesse, por_item


# Modos de coleta, em ordem de prioridade comercial. O modo só escolhe o filtro `status` da busca;
# a prioridade gravada vem de prioridade_da_compra() (o filtro do PNCP é ruidoso: em 29/09/2026
# status=em_julgamento devolvia compras ainda recebendo proposta, com resultado e anuladas).
MODOS = {
    # certames recebendo proposta -> ainda dá para disputar: são os leads
    "leads": {"status": "recebendo_proposta"},
    # propostas encerradas, sem resultado -> acompanhar até sair o vencedor
    "monitorar": {"status": "em_julgamento"},
    # encerradas (homologadas, com resultado, revogadas, anuladas, desertas...) -> histórico de preço e RAG
    "historico": {"status": "encerradas"},
}

# Valores de licitacoes_externas.prioridade (decisão do owner, 29/09/2026). Compra homologada NÃO é lead.
PRIORIDADES = ("leads", "monitorar", "historico")
# Último recurso quando a compra não tem prazo de proposta nem sinal de encerramento/resultado.
PRIORIDADE_DO_STATUS_BUSCA = {"recebendo_proposta": "leads", "em_julgamento": "monitorar",
                              "encerradas": "historico"}
_SITUACAO_ENCERRADA = re.compile(r"revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|"
                                 r"adjudicad|conclu[ií]d|finalizad", re.I)
_SITUACAO_SUSPENSA = re.compile(r"suspens", re.I)
_ITEM_COM_RESULTADO = re.compile(r"homologad|adjudicad", re.I)
_ITEM_FINAL = re.compile(r"homologad|adjudicad|desert|fracassad|anulad|revogad|cancelad", re.I)
# Datas do PNCP sem fuso (ex.: data_fim_vigencia "2026-10-13T09:30") estão no horário de Brasília.
FUSO_PNCP = timezone(timedelta(hours=-3))
# Prazo de proposta além disto é data inválida, não lead (02/10/2026): id 129 com 2604-04-16, credenciamento
# "contínuo" com 9999-12-31, id 126 com 2029. Fica monitorar ("Prazo inválido") até alguém conferir, salvo quando
# normalizacao_prazo (09/10/2026) corrige o ano ou um fato (ata, resultado) limita o prazo.
PRAZO_PROPOSTA_MAXIMO = timedelta(days=730)


def _instante(v) -> datetime | None:
    if not v:
        return None
    if isinstance(v, datetime):
        d = v
    else:
        try:
            d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=FUSO_PNCP)


def _campo(compra: dict, *chaves):
    """Primeiro valor presente entre as chaves, na compra e depois no `raw` gravado (item da busca)."""
    raw = compra.get("raw") if isinstance(compra.get("raw"), dict) else {}
    for fonte in (compra, raw):
        for k in chaves:
            v = fonte.get(k)
            if v not in (None, ""):
                return v
    return None


def _verdadeiro(v) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in ("true", "t", "1", "sim"))


def motivo_prioridade(compra: dict, tem_resultado: bool | None = None, *, agora: datetime | None = None,
                      status_busca: str | None = None, itens: list[dict] | None = None,
                      prazo_normalizado: str | None = None) -> tuple[str | None, str]:
    """(prioridade, motivo). Função pura: não consulta nada, só lê os campos recebidos.

    `compra` aceita o item da busca (situacao_nome, tem_resultado, cancelado, data_fim_vigencia), o detalhe
    (situacaoCompraNome, existeResultado, valorTotalHomologado, dataEncerramentoProposta) ou a linha gravada
    em licitacoes_externas (situacao, data_homologacao, data_fim, raw). `tem_resultado=True` = quem chama já
    viu resultado (ex.: /resultados); False/None não anula o que a compra diz. `itens` no formato do PNCP
    (situacaoCompraItemNome, temResultado) ou de licitacao_itens (situacao, tem_resultado).

    Ordem: 1) historico se há homologação/resultado ou a compra está encerrada (revogada, anulada,
    cancelada, deserta, fracassada, todos os itens finalizados); 2) monitorar se suspensa; 3) pelo prazo
    de proposta: aberto -> leads, encerrado sem resultado -> monitorar, além de PRAZO_PROPOSTA_MAXIMO
    (2604, 9999) -> monitorar (data inválida não é lead); 4) sem prazo: o status da busca (último recurso);
    5) None = indeterminado (quem chama não grava). Documentos da compra e exclusão do PNCP: fase_da_compra.

    Precedência de chaves (_campo): as do detalhe vêm antes das da busca (existeResultado > tem_resultado,
    situacaoCompraNome > situacao_nome, dataEncerramentoProposta > data_fim_vigencia), então na visão
    compra_com_detalhe() o detalhe vence a busca, que pode estar defasada.
    `prazo_normalizado`: prazo de proposta normalizado (normalizacao_prazo) que substitui o bruto implausível na
    decisão; o bruto continua no raw."""
    agora = agora or datetime.now(timezone.utc)
    if tem_resultado is True:
        return "historico", "resultado consultado"
    if _campo(compra, "data_homologacao"):
        return "historico", "data_homologacao"
    # sinal POSITIVO de resultado vence de qualquer fonte (fail-closed: homologada nunca vira lead).
    # A busca atrasa no sentido de "sem resultado"; um existeResultado=False do detalhe não apaga o
    # tem_resultado=True da busca/raw.
    if any(_verdadeiro(_campo(compra, k)) for k in ("existeResultado", "tem_resultado")):
        return "historico", "compra com resultado"
    if (_num(_campo(compra, "valorTotalHomologado")) or 0) > 0:
        return "historico", "valor homologado"
    if _verdadeiro(_campo(compra, "cancelado")):
        return "historico", "cancelada"
    situacao = str(_campo(compra, "situacaoCompraNome", "situacao_nome", "situacao") or "")
    if _SITUACAO_ENCERRADA.search(situacao):
        return "historico", f"situação {situacao}"
    if itens:
        sit_itens = [str(it.get("situacaoCompraItemNome") or it.get("situacao") or "") for it in itens]
        if any(_verdadeiro(it.get("temResultado", it.get("tem_resultado"))) for it in itens) or \
                any(_ITEM_COM_RESULTADO.search(s) for s in sit_itens):
            return "historico", "item com resultado"
        if all(_ITEM_FINAL.search(s) for s in sit_itens):
            return "historico", "todos os itens finalizados"
    if _SITUACAO_SUSPENSA.search(situacao):
        return "monitorar", f"situação {situacao}"
    # prazo do PNCP (detalhe, depois raw.data_fim_vigencia) antes do data_fim gravado: o coletor grava o
    # horário sem fuso do PNCP como UTC (_data), 3 h antes do prazo real em Brasília
    fim = _instante(prazo_normalizado) or \
        _instante(_campo(compra, "dataEncerramentoProposta", "data_fim_vigencia") or _campo(compra, "data_fim"))
    if fim:
        if fim > agora + PRAZO_PROPOSTA_MAXIMO:
            return "monitorar", f"prazo de proposta implausível ({fim.date().isoformat()})"
        if fim > agora:
            return "leads", "recebendo proposta"
        return "monitorar", "propostas encerradas sem resultado"
    if status_busca in PRIORIDADE_DO_STATUS_BUSCA:
        return PRIORIDADE_DO_STATUS_BUSCA[status_busca], f"sem prazo de proposta; busca status={status_busca}"
    return None, "indeterminado (sem prazo de proposta nem resultado)"


# Fase real da compra (02/10/2026; regra P0-P10 de DIAG-SITUACAO-MATCH.md). O PNCP não muda situacaoCompraId
# quando o órgão só publica o documento: em 02/10/2026, 135 e 492 tinham aviso de suspensão e 1458/1530 termo de
# homologação, todos ainda "Divulgada no PNCP" com existeResultado=false. Documento de contrato/ata não conta: o
# "Extrato de Suspensão de Contrato" do id 229 suspende um contrato, não a compra.
# Só contrato/ata/empenho: "contratação" é a própria compra ("Termo de homologação da contratação", "Aviso de
# suspensão da contratação" contam; Copilot, PR #134).
_DOC_DE_CONTRATO = re.compile(r"\bcontratos?\b|\bcontratua\w*|\bata\s+de\s+registro|\barp\b|\baditiv\w*|\bempenho")
# \b na frente: "granulada" contém "anula" (borracha granulada é o produto do Marcelo).
_DOC_HOMOLOGACAO = re.compile(r"\bhomologa|\badjudica")
# "Resultado" só com título conclusivo do certame (Copilot, PR #134): "Resultado da impugnação", "Resultado de
# esclarecimento", "Resultado preliminar" e "Resultado da amostra" não encerram a compra.
_DOC_RESULTADO_FINAL = re.compile(r"\baviso\s+de\s+resultado\b|\bresultado\s+(final|definitivo|do\s+julgamento|"
                                  r"da\s+licitacao|do\s+certame|do\s+pregao|da\s+concorrencia|da\s+dispensa)\b")
# Filtro ÚNICO de etapa / documento não conclusivo (pedido do Marcelo; Copilot, PR #134, 2ª e 3ª rodadas), aplicado
# a TODOS os sinais documentais (homologação, adjudicação, resultado, revogação, anulação e suspensão): pedido,
# solicitação, requerimento, recurso, impugnação, esclarecimento, preliminar, provisório, amostra, contrarrazões,
# minuta, indeferimento, intenção, "proposta de", parecer e despacho não são o ato ("Pedido de revogação",
# "Minuta do termo de revogação", "Pedido de suspensão", "Indeferimento do pedido de suspensão", "Parecer de
# revogação", "Recurso contra a homologação"). Os radicais aceitam o nome de arquivo do PNCP sem os acentos
# ("SOLICITAO_DE_REVOGAO_PARCIAL"). Despacho que É o ato ("DESPACHO DE SUSPENSAO PE 0262026", "Despacho de
# Adjudicação e Homologação") continua valendo: só o "despacho" sozinho é etapa (_DOC_DESPACHO_ATO).
_DOC_ETAPA = re.compile(
    r"\bpedido|\bsolicita(c|o\b)|requeriment|\brecurso|impugna|esclarec|preliminar|\bprovis(o)?ri|amostra|contrarraz|"
    r"\bminuta|indefer|\binten(c|ao\b|o\b)|\bproposta\s+de\b|\bparecer|\bdespacho")
_DOC_DESPACHO_ATO = re.compile(r"\bdespacho\s+((de|da|do)\s+)?(homologa|adjudica|revoga|anula|suspens)|"
                               r"\bdespacho\s+homologatori")
# Além do filtro único, por sinal: resultado de habilitação ou parcial não encerra a compra; revogação/anulação e
# suspensão parciais (de um lote) também não. "Termo de homologação e habilitação" é ato conclusivo.
_DOC_RESULTADO_NAO_FINAL = re.compile(r"habilitac|parcial")
_DOC_REVOGACAO = re.compile(r"\brevoga|\banula")
_DOC_SUSPENSAO = re.compile(r"\bsuspens")
# Fim da suspensão não é suspensão nem revogação da compra ("Revogação da suspensão", "Aviso de reabertura após
# suspensão", "Retomada do certame suspenso", "Levantamento da suspensão").
_DOC_FIM_SUSPENSAO = re.compile(r"\b(revoga|anula)\w*\s+((de|da|do)\s+)?((ato|aviso|termo|decisao)\s+(de\s+)?)?suspens|"
                                r"\breabert|\bretomad|\blevantament\w*\s+((de|da|do)\s+)?suspens|"
                                r"\bsuspens\w*\s+(revogad|anulad|sem\s+efeito|cancelad)")


def documento_de_etapa(texto: str | None) -> bool:
    """O título (já normalizado) é de etapa/documento não conclusivo? Ver _DOC_ETAPA."""
    return bool(_DOC_ETAPA.search(_DOC_DESPACHO_ATO.sub(" ", texto or "")))

# Suspensão publicada até 10 min antes da última retificação da compra ainda vale (o PNCP grava os dois juntos,
# ex.: 135); retificação depois dela reabriu a compra (77: suspensa em agosto, retificada em 24/09 com prazo novo).
TOLERANCIA_RETIFICACAO = timedelta(minutes=10)
_CHAVES_TEXTO_DOC = ("titulo", "nome_original", "tipoDocumentoNome", "tipo_documento")
_CHAVES_DATA_DOC = ("dataPublicacaoPncp", "data_documento", "data")

FASE_EXCLUIDA = "Excluída do PNCP"
FASE_RESULTADO = "Homologada / com resultado"
FASE_RESULTADO_DOC = "Homologada (documento)"
FASE_REVOGADA_DOC = "Revogada/Anulada (documento)"
FASE_SUSPENSA = "Suspensa"
FASE_SUSPENSA_DOC = "Suspensa (documento)"
FASE_ITENS_FINALIZADOS = "Encerrada (itens finalizados)"
FASE_RECEBENDO = "Recebendo propostas"
FASE_JULGAMENTO = "Em julgamento"
FASE_PRAZO_INVALIDO = "Prazo inválido"
FASE_REGISTRO_PRECO = "Registro de Preço"

# Republicação do edital (09/10/2026, caso 135): documento ATIVO do tipo Edital com "republica" no título.
_DOC_REPUBLICACAO = re.compile(r"\brepublica")
_TIPO_EDITAL = re.compile(r"^\s*edital\s*$")


def _texto_doc(d: dict) -> str:
    # nome de arquivo usa "_" como espaço ("AVISO_SUSPENSAO_P_E_35_2026.pdf"), e "_" é letra para o \b
    return normalizar(" ".join(str(d.get(k) or "") for k in _CHAVES_TEXTO_DOC)).replace("_", " ").strip()


def _data_doc(d: dict) -> datetime | None:
    return _instante(next((d[k] for k in _CHAVES_DATA_DOC if d.get(k)), None))


def _republicacao(d: dict) -> datetime | None:
    """Data do documento se ele é a republicação do edital (tipo Edital + "republica" no título), senão None."""
    tipo = normalizar(str(d.get("tipoDocumentoNome") or d.get("tipo_documento") or "")).replace("_", " ")
    titulo = normalizar(" ".join(str(d.get(k) or "") for k in ("titulo", "nome_original"))).replace("_", " ")
    if not _TIPO_EDITAL.search(tipo) or not _DOC_REPUBLICACAO.search(titulo) or documento_de_etapa(titulo):
        return None
    return _data_doc(d)


def analise_documental(documentos: list[dict] | None, retificada_em=None) -> tuple[str | None, bool]:
    """(sinal, republicada): o sinal de sinal_documental e se uma suspensão foi neutralizada pela republicação do
    edital. Republicação = documento ativo do tipo Edital com "republica" no título (normalizado, sem acento, "_"
    vira espaço) publicado em data >= (última suspensão - TOLERANCIA_RETIFICACAO). Caso 135 (Baraúna/RN): edital de
    republicação 14:18:51, ata de suspensão 14:18:52 e retificação 14:18:52 do mesmo upload; dataPublicacaoPncp é a
    data do upload, então a ordem dentro do mesmo minuto não diz o que veio antes no processo."""
    resultado = revogacao = False
    ultima_suspensao = ultima_republicacao = None
    for d in documentos or []:
        if d.get("statusAtivo") is False:
            continue
        rep = _republicacao(d)
        if rep and (ultima_republicacao is None or rep > ultima_republicacao):
            ultima_republicacao = rep
        t = _texto_doc(d)
        if not t or _DOC_DE_CONTRATO.search(t) or documento_de_etapa(t):
            continue
        fim_suspensao = bool(_DOC_FIM_SUSPENSAO.search(t))
        if _DOC_HOMOLOGACAO.search(t) or (_DOC_RESULTADO_FINAL.search(t) and not _DOC_RESULTADO_NAO_FINAL.search(t)):
            resultado = True
        if _DOC_REVOGACAO.search(t) and "parcial" not in t and not fim_suspensao:
            revogacao = True
        if _DOC_SUSPENSAO.search(t) and "parcial" not in t and not fim_suspensao:
            dt = _data_doc(d)
            if dt and (ultima_suspensao is None or dt > ultima_suspensao):
                ultima_suspensao = dt
    if resultado:
        return "resultado", False
    if revogacao:
        return "revogacao", False
    retificacao = _instante(retificada_em)
    if ultima_suspensao and (retificacao is None or ultima_suspensao >= retificacao - TOLERANCIA_RETIFICACAO):
        if ultima_republicacao and ultima_republicacao >= ultima_suspensao - TOLERANCIA_RETIFICACAO:
            return None, True
        return "suspensao", False
    return None, False


def sinal_documental(documentos: list[dict] | None, retificada_em=None) -> str | None:
    """'resultado' | 'revogacao' | 'suspensao' | None, pelos títulos dos documentos DA COMPRA.
    Aceita /arquivos do PNCP (titulo, tipoDocumentoNome, dataPublicacaoPncp) e licitacao_documentos
    (nome_original, tipo_documento, data_documento). Documento com statusAtivo False (inativo no PNCP ou removido
    do portal) não conta. Resultado só com título conclusivo (homologação, adjudicação, resultado final/do
    julgamento/da licitação/do certame, aviso de resultado). Documento de etapa ou não conclusivo (documento_de_etapa:
    pedido, minuta, recurso, indeferimento, parecer...) não conta para NENHUM sinal; resultado de habilitação/parcial,
    revogação/suspensão parcial e fim de suspensão (revogação da suspensão, reabertura) também não;
    contrato/ata/aditivo/empenho não contam (contratação sim);
    suspensão só vale se não houve retificação da compra depois dela (retificada_em: dataAtualizacao do detalhe
    ou data_atualizacao_pncp da busca, horário de Brasília) nem republicação do edital depois dela
    (analise_documental)."""
    return analise_documental(documentos, retificada_em)[0]


def _fase_do_motivo(prioridade: str | None, motivo: str) -> str | None:
    if motivo.startswith("prazo de proposta implausível"):
        return FASE_PRAZO_INVALIDO
    if motivo == "recebendo proposta":
        return FASE_RECEBENDO
    if motivo == "propostas encerradas sem resultado":
        return FASE_JULGAMENTO
    if motivo == "todos os itens finalizados":
        return FASE_ITENS_FINALIZADOS
    if motivo == "cancelada":
        return "Cancelada"
    if motivo.startswith("situação "):   # situação oficial: Revogada, Anulada, Suspensa, Deserta...
        return motivo[len("situação "):].strip() or None
    if prioridade == "historico" and not motivo.startswith("sem prazo"):
        return FASE_RESULTADO   # resultado consultado, data_homologacao, valor homologado, item com resultado
    return None   # sem prazo (status da busca) ou indeterminado: fica a situação oficial


def atas_nao_canceladas(atas: list[dict] | None) -> list[dict]:
    """Atas de registro de preço (formato AtaRegistroPrecoDTO do PNCP) que não estão canceladas: cancelado != true e
    sem dataCancelamento."""
    return [a for a in atas or [] if isinstance(a, dict) and not _verdadeiro(a.get("cancelado"))
            and not a.get("dataCancelamento")]


def _fim_do_dia_se_data(v, d: datetime) -> datetime:
    """Data sem hora ("2024-05-10") vale até o fim do dia (Brasília)."""
    return d + timedelta(days=1, seconds=-1) if len(str(v)) == 10 else d


def _limite_dos_fatos(compra: dict, atas: list[dict] | None) -> tuple[datetime | None, str | None]:
    """(data, regra): o fato mais antigo que prova que as propostas já tinham fechado: assinatura de ata de registro
    de preço não cancelada (limitado_por_ata) ou homologação/resultado gravado (limitado_por_resultado)."""
    fatos = []
    for a in atas_nao_canceladas(atas):
        v = a.get("dataAssinatura") or a.get("dataVigenciaInicio")
        d = _instante(v)
        if d:
            fatos.append((_fim_do_dia_se_data(v, d), "limitado_por_ata"))
    v = _campo(compra, "data_homologacao")
    d = _instante(v)
    if d:
        fatos.append((_fim_do_dia_se_data(v, d), "limitado_por_resultado"))
    return min(fatos, key=lambda f: f[0]) if fatos else (None, None)


def normalizar_prazo_proposta(original, *, abertura=None, publicacao=None, limite: datetime | None = None,
                              regra_limite: str | None = None) -> dict | None:
    """Normaliza o prazo de proposta IMPLAUSÍVEL (quem chama decide que é implausível). Função pura.
    Prazo = FIM DO RECEBIMENTO DE PROPOSTAS (dataEncerramentoProposta; licitacoes_externas.data_fim), não a abertura
    da sessão (decisão do dono, 09/10/2026).

    a) troca o ano pelo da abertura e depois pelo da publicação; aceita só se piso <= corrigido <= teto, com piso = a
       abertura (sem ela, a publicação) e teto = `limite` (fato: ata/resultado/homologação) ou, sem fato,
       publicação + PRAZO_PROPOSTA_MAXIMO (730 dias). Regra "ano_da_abertura" / "ano_da_publicacao".
    b) se não fechar e houver fato (`limite` + `regra_limite`), o prazo fica limitado por ele: normalizado None e
       regra = regra_limite ("limitado_por_ata": a ata assinada prova que as propostas fecharam antes dela).
    c) senão None: nada normalizado (fica "Prazo inválido").
    Ano 9999 é sentinela (credenciamento "contínuo"), não erro de digitação: não normaliza.
    Saída: {campo: "data_fim", original (texto bruto do PNCP), normalizado (ISO com fuso ou None), regra,
    origem: "inferido"}. O bruto nunca é alterado: continua em raw."""
    fim = _instante(original)
    if fim is None or fim.year >= 9999:
        return None
    ini, pub, teto = _instante(abertura), _instante(publicacao), limite
    piso = ini or pub
    if teto is None and pub is not None:
        teto = pub + PRAZO_PROPOSTA_MAXIMO

    def _saida(normalizado: datetime | None, regra: str) -> dict:
        return {"campo": "data_fim", "original": str(original),
                "normalizado": normalizado.isoformat() if normalizado else None,
                "regra": regra, "origem": "inferido"}

    if piso is not None and teto is not None:
        for base, regra in ((ini, "ano_da_abertura"), (pub, "ano_da_publicacao")):
            if base is None or base.year == fim.year:
                continue
            try:
                corrigido = fim.replace(year=base.year)
            except ValueError:   # 29/02 em ano não bissexto
                continue
            if piso <= corrigido <= teto:
                return _saida(corrigido, regra)
    if limite is not None and regra_limite:
        return _saida(None, regra_limite)
    return None


def normalizacao_prazo(compra: dict, *, agora: datetime | None = None, atas: list[dict] | None = None) -> dict | None:
    """Normalização do prazo de proposta da compra (normalizar_prazo_proposta) quando ele é implausível (além de
    agora + PRAZO_PROPOSTA_MAXIMO), senão None. Lê o prazo como motivo_prioridade (detalhe, busca, gravado), a
    abertura (dataAberturaProposta / data_inicio_vigencia / data_inicio), a publicação (dataPublicacaoPncp /
    data_publicacao_pncp / data_publicacao) e o limite dos fatos (_limite_dos_fatos). Caso 129: 2604-04-16 com
    abertura 2024-04-26 não fecha com troca de ano; a ata 39/2024 assinada em 2024-05-10 limita -> limitado_por_ata."""
    agora = agora or datetime.now(timezone.utc)
    original = _campo(compra, "dataEncerramentoProposta", "data_fim_vigencia") or _campo(compra, "data_fim")
    fim = _instante(original)
    if fim is None or fim <= agora + PRAZO_PROPOSTA_MAXIMO:
        return None
    limite, regra = _limite_dos_fatos(compra, atas)
    return normalizar_prazo_proposta(
        original, abertura=_campo(compra, "dataAberturaProposta", "data_inicio_vigencia", "data_inicio"),
        publicacao=_campo(compra, "dataPublicacaoPncp", "data_publicacao_pncp", "data_publicacao"),
        limite=limite, regra_limite=regra)


def visao_para_prazo(visao: dict, data_homologacao: datetime | None) -> dict:
    """A visão da compra para normalizacao_prazo com a homologação recém-lida dos resultados (a mesma que a coleta
    grava em data_homologacao). Sem ela, limitado_por_resultado não é alcançável na coleta: a visão vem do detalhe e da
    busca, que não trazem essa data, e a linha gravada não é relida. Data já presente na visão prevalece."""
    if data_homologacao is None or _campo(visao, "data_homologacao"):
        return visao
    return {**visao, "data_homologacao": data_homologacao.isoformat()}


def decisao_oficial(prioridade: str | None, motivo: str) -> bool:
    """A decisão de motivo_prioridade é por sinal OFICIAL (P1-P4: resultado, encerramento, itens finalizados,
    Suspensa oficial), que vence ata, documentos e prazo?"""
    if motivo.startswith("sem prazo de proposta; busca"):
        return False
    return prioridade == "historico" or (prioridade == "monitorar" and motivo.startswith("situação "))


def fase_da_compra(compra: dict, tem_resultado: bool | None = None, *, agora: datetime | None = None,
                   status_busca: str | None = None, itens: list[dict] | None = None,
                   documentos: list[dict] | None = None, retificada_em=None,
                   excluida: bool = False, atas: list[dict] | None = None) -> tuple[str | None, str | None, str]:
    """(fase, prioridade, motivo): a fase real da compra, gravada em licitacoes_externas.fase (coluna que a
    view e a API já expõem; `situacao` continua sendo a oficial do PNCP). Função pura. Precedência (o primeiro
    que casar vence):
      P0 excluída do PNCP (detalhe HTTP 410)                        -> Excluída do PNCP          / historico
      P1-P4 motivo_prioridade: resultado/homologação, encerramento oficial, itens finalizados, Suspensa oficial
      P4a ata de registro de preço não cancelada (/atas da compra)    -> Registro de Preço         / historico
      P5 documento da compra de homologação/adjudicação/resultado     -> Homologada (documento)    / historico
      P6 documento da compra de revogação/anulação (não parcial)      -> Revogada/Anulada (doc.)   / historico
      P7 documento de suspensão sem retificação nem republicação do edital posterior
                                                                      -> Suspensa (documento)      / monitorar
      P8-P10 prazo (o normalizado quando o bruto é implausível e normalizacao_prazo corrige o ano): aberto -> leads;
             vencido -> Em julgamento; implausível sem normalização -> Prazo inválido (monitorar)
    `atas` None = não consultadas ou falha na consulta (sem informação): P4a não se aplica, e quem chama decide se
    pode gravar (o coletor não grava fase/prioridade de compra SRP com /atas indisponível). Suspensão neutralizada
    pela republicação do edital acrescenta "(suspensão anterior; republicado)" ao motivo.
    `fase` None = sem rótulo melhor que a situação oficial (quem chama não grava)."""
    if excluida:
        return FASE_EXCLUIDA, "historico", "compra excluída do PNCP (HTTP 410)"
    norm = normalizacao_prazo(compra, agora=agora, atas=atas)
    prioridade, motivo = motivo_prioridade(compra, tem_resultado, agora=agora, status_busca=status_busca,
                                           itens=itens, prazo_normalizado=(norm or {}).get("normalizado"))
    # Só sinal oficial retorna antes da ata e dos documentos: o último recurso "sem prazo; status da busca" (P10) fica
    # depois da análise documental (Copilot, PR #134, 2ª rodada: busca "encerradas" + aviso de suspensão = monitorar).
    if decisao_oficial(prioridade, motivo):
        return _fase_do_motivo(prioridade, motivo), prioridade, motivo
    validas = atas_nao_canceladas(atas)
    if validas:
        a = min(validas, key=lambda x: str(x.get("dataAssinatura") or "9999"))
        return FASE_REGISTRO_PRECO, "historico", (
            f"ata de registro de preço {a.get('numeroAtaRegistroPreco') or '?'} assinada em "
            f"{a.get('dataAssinatura') or '?'} (não cancelada)")
    sinal, republicada = analise_documental(documentos, retificada_em)
    if sinal == "resultado":
        return FASE_RESULTADO_DOC, "historico", "documento de homologação/adjudicação/resultado da compra"
    if sinal == "revogacao":
        return FASE_REVOGADA_DOC, "historico", "documento de revogação/anulação da compra"
    if sinal == "suspensao":
        return FASE_SUSPENSA_DOC, "monitorar", "documento de suspensão da compra sem retificação posterior"
    fase = _fase_do_motivo(prioridade, motivo)
    if republicada:
        motivo = f"{motivo} (suspensão anterior; republicado)"
    return fase, prioridade, motivo


# Campos de estado do detalhe da compra (/api/consulta/v1/...) que motivo_prioridade lê.
ESTADO_DETALHE = ("existeResultado", "valorTotalHomologado", "situacaoCompraNome", "dataEncerramentoProposta",
                  "dataAberturaProposta", "dataPublicacaoPncp")


def compra_com_detalhe(compra: dict, det: dict | None) -> dict:
    """Visão para motivo_prioridade: `compra` (item da busca ou linha gravada) + os campos de estado do
    detalhe. O detalhe é a fonte autoritativa (a busca atrasa: prazo "aberto" e sem resultado numa compra
    já homologada); como motivo_prioridade lê as chaves do detalhe primeiro, ele vence onde tem valor e a
    busca só completa o que o detalhe não traz. Não altera as entradas."""
    if not det:
        return compra
    return {**compra, **{k: det[k] for k in ESTADO_DETALHE if det.get(k) not in (None, "")}}


def prioridade_da_compra(compra: dict, tem_resultado: bool | None = None, *, agora: datetime | None = None,
                         status_busca: str | None = None, itens: list[dict] | None = None) -> str | None:
    """leads | monitorar | historico a partir do estado real da compra (ver motivo_prioridade)."""
    return motivo_prioridade(compra, tem_resultado, agora=agora, status_busca=status_busca, itens=itens)[0]


_trava = threading.Lock()


def _inc(resumo: dict, chave: str, n: int = 1) -> None:
    with _trava:
        resumo[chave] = resumo.get(chave, 0) + n


def _dt(v) -> datetime | None:
    s = _data(v)
    return datetime.fromisoformat(s) if s else None


def coletar(pncp: PNCP, sb: Supabase | None, arm: Armazenamento | None, termos: list[str], status,
            paginas: int, tam: int, com_resultados: bool, baixar_arquivos: bool, max_bytes: int,
            dry_run: bool, modo: str | None = None, agora: datetime | None = None, workers: int = 3,
            pausa_segunda_passada: float = 30, mapa_catmat: MapaCatmat | None = None) -> dict:
    """Busca `status` para cada termo e grava as compras no escopo. `modo` só vai para o log/resumo:
    a prioridade de cada compra vem de prioridade_da_compra() (estado real, com o status da busca só
    como último recurso). Uma compra encerrada vira historico mesmo que já fosse lead (rebaixa).
    `mapa_catmat`: código CATMAT antes do texto em avaliar (None = só texto)."""
    agora = agora or datetime.now(timezone.utc)
    tam = clamp_tamanho(tam, padrao=50, minimo=1, maximo=TAMANHO_PAGINA_MAX)
    status_lista = status if isinstance(status, list) else [status]
    vistos: dict[str, list[str]] = {}
    resumo = {"encontradas": 0, "no_escopo": 0, "interesse_borracha": 0, "fora": 0,
              "gravadas": 0, "erros": 0}
    falhas: list[tuple[dict, str, str]] = []
    # dry-run volta antes do upsert: a chave natural do item inclui licitacao_id, que só existe depois.
    arquivos_raw = None if dry_run else _abrir_arquivos_pncp(str(uuid.uuid4()))

    def _tentar(c, termo, st):
        try:
            _processar(pncp, sb, arm, c, termo, com_resultados, baixar_arquivos,
                       max_bytes, dry_run, resumo, modo, status_busca=st, agora=agora, mapa_catmat=mapa_catmat,
                       arquivos_raw=arquivos_raw)
            return c, None
        except ArquivoRawErro:
            raise
        except Exception as e:
            if "Supabase" in str(e) and (" 401 " in str(e) or " 403 " in str(e)):
                raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY "
                                 "em ~/.licitagym.env e rode de novo. Nada foi perdido.")
            log.warning("  %s: %s (vai para a segunda passada)", c.get("numero_controle_pncp"), str(e)[:120])
            return c, e

    try:
        for termo in termos:
            for st in status_lista:
                lidos = 0
                for pagina in range(1, paginas + 1):
                    try:
                        res = pncp.buscar(termo, st, pagina, tam)
                    except Exception as e:
                        # Uma busca que esgotou as tentativas (429/5xx/timeout) não derruba os outros termos;
                        # fica no resumo e o processo sai com código 1 (ver main).
                        _inc(resumo, "falha_busca")
                        with _trava:
                            resumo.setdefault("termos_com_falha", []).append(f"{termo} [{st}] pág. {pagina}")
                        log.error('"%s" [%s] pág. %s: busca falhou, segue para o próximo termo: %s',
                                  termo, st, pagina, str(e)[:160])
                        break
                    if not isinstance(res, dict) or not isinstance(res.get("items"), list):
                        _inc(resumo, "falha_busca")
                        log.warning('"%s" [%s] pág. %s: resposta inesperada; não é fim de coleta', termo, st, pagina)
                        break
                    lote = res.get("items") or []
                    log.info('"%s" [%s] pág. %s: %s de %s', termo, st, pagina, len(lote), res.get("total"))
                    fila = []
                    for c in lote:
                        chave = c.get("numero_controle_pncp")
                        if not chave:
                            continue
                        if chave in vistos:
                            vistos[chave].append(termo)
                            continue
                        vistos[chave] = [termo]
                        resumo["encontradas"] += 1
                        fila.append(c)
                    with ThreadPoolExecutor(max_workers=workers) as ex:
                        for c, erro in ex.map(lambda c: _tentar(c, termo, st), fila):
                            if erro:
                                falhas.append((c, termo, st))
                    lidos += len(lote)
                    decisao = avaliar_pagina(lote, tamanho=tam, pagina=pagina, corpo=res, acumulado=lidos)
                    if decisao.aviso:
                        log.warning('"%s" [%s] pág. %s: %s', termo, st, pagina, decisao.aviso)
                    if decisao.encerrar:
                        break
                else:
                    log.warning('"%s" [%s]: parou no teto de %s páginas sem o total confirmar o fim',
                                termo, st, paginas)

        if falhas:
            log.info("Segunda passada: %s compra(s) que falharam por instabilidade do PNCP", len(falhas))
            time.sleep(pausa_segunda_passada)
            for c, termo, st in falhas:
                _, erro = _tentar(c, termo, st)
                if erro:
                    _inc(resumo, "erros")
        return resumo
    finally:
        if arquivos_raw is not None:
            resumo["arquivo_raw"] = fechar_todos(list(arquivos_raw.values()))


def _resultados_relevantes(pncp, c, itens, por_item) -> list[tuple[dict, dict]]:
    relevantes = [it for it in itens if it.get("temResultado") is not False and
                  (por_item[it["numeroItem"]][0] or len(itens) <= 5)]
    pares = []
    for it in relevantes:
        for r in pncp.resultados(c, it["numeroItem"]):
            pares.append((it, r))
    return pares


def consultar_detalhe(pncp, c: dict) -> dict:
    """Detalhe da compra (uma consulta por compra: identificação e prioridade usam o mesmo retorno).
    Falha da consulta levanta ConsultaFalhou."""
    try:
        return pncp.compra(c)
    except Exception as e:
        if compra_excluida_do_erro(e):
            raise CompraExcluida(f"detalhe da compra {c.get('numero_controle_pncp')}: excluída do PNCP ({e})") from e
        raise ConsultaFalhou(f"detalhe da compra {c.get('numero_controle_pncp')}: {e}") from e


def compra_excluida_do_erro(e: BaseException) -> bool:
    """HTTP 410 (Gone) no detalhe, venha como status HTTP (raise_for_status) ou como JSON {status: 410} em 200."""
    resp = getattr(e, "response", None)
    if getattr(resp, "status_code", None) == 410:
        return True
    return str(e).startswith("PNCP detalhe: 410")


def identificacao_do_detalhe(c: dict, det: dict) -> dict:
    """numero_processo = processo administrativo do órgão (ex.: 00007.20260204/0002-28).
    numero_edital = só rótulo de exibição ('Pregão Eletrônico nº 1/2026' se repete entre órgãos e NÃO identifica nada).
    Identidade: PNCP -> numero_controle_pncp; fora do PNCP -> (CNPJ do órgão, processo administrativo).

    numero_processo None = detalhe respondeu sem processo.

    valor_total (valorTotalEstimado do detalhe; a busca deixa valor_global vazio em editais) só
    entra no dict quando existe: ausente nunca vira NULL gravado por cima de valor bom."""
    proc = (det.get("processo") or "").strip() or None
    num, ano = det.get("numeroCompra"), det.get("anoCompra") or c.get("ano")
    mod = det.get("modalidadeNome") or c.get("modalidade_licitacao_nome")
    edital = f"{mod} nº {num}/{ano}" if num else c.get("title")
    out = {"numero_processo": proc, "numero_edital": edital}
    valor = valor_total_detalhe(det)
    if valor is not None:
        out["valor_total"] = valor
    return out


def identificacao(pncp, c: dict) -> dict:
    """Consulta o detalhe e extrai a identificação (ver identificacao_do_detalhe). Falha da consulta
    levanta ConsultaFalhou: quem chama não grava identificação (não sobrescreve valor bom com NULL)."""
    return identificacao_do_detalhe(c, consultar_detalhe(pncp, c))


def _raw_resultado(r: dict) -> dict:
    campos_sigilosos = {"niFornecedor"}
    if r.get("tipoPessoa") == "PF":
        campos_sigilosos.add("nomeRazaoSocialFornecedor")
    return {k: v for k, v in r.items() if k not in campos_sigilosos}


def _abrir_arquivos_pncp(execucao_id: str) -> dict[str, ArquivoRaw]:
    """Um id por execução, as duas tabelas cujo raw sai do banco. licitacoes_externas fica de fora."""
    return {
        "licitacao_itens": ArquivoRaw("licitacao_itens", "pncp", execucao_id=execucao_id),
        "licitacao_resultados": ArquivoRaw("licitacao_resultados", "pncp", execucao_id=execucao_id),
    }


def _enviar_raw(arquivos_raw: dict[str, ArquivoRaw] | None, tabela: str, chave: dict, bruto: dict) -> None:
    """Com o dict da execução, acumula o lote. Sem ele (chamada avulsa), grava e fecha na hora."""
    if arquivos_raw is None:
        avulso = ArquivoRaw(tabela, "pncp")
        avulso.adicionar(chave, bruto)
        avulso.fechar()
        return
    arquivos_raw[tabela].adicionar(chave, bruto)


def _processar(pncp, sb, arm, c, termo, com_resultados, baixar_arquivos, max_bytes, dry_run, resumo,
               modo=None, status_busca=None, agora=None, det=None, mapa_catmat=None,
               arquivos_raw: dict[str, ArquivoRaw] | None = None):
    """Coleta completa de uma compra: itens, resultados, detalhe e lista de arquivos do PNCP, gravados em
    licitacoes_externas, licitacao_itens, licitacao_resultados e licitacao_documentos.
    `det` = detalhe já consultado (recoletar_atualizadas); None consulta aqui.
    `termo` None (recoleta) mantém termos_busca do banco. As datas de atualização do PNCP só são gravadas
    no fim, depois da lista de arquivos (marcação/upsert): se algo falhar no meio, a próxima recoleta tenta
    de novo. Compra excluída (HTTP 410) não grava a versão."""
    try:
        itens = pncp.itens(c)
    except Exception as e:
        if _excluida_sem_hidratacao(pncp, sb, c, e, dry_run, resumo):
            return
        raise
    categoria, interesse, por_item = avaliar(c, itens, mapa_catmat)
    rotulo = f"{c.get('municipio_nome')}/{c.get('uf')} | {(c.get('description') or '').strip()[:80]}"
    if not categoria:
        _inc(resumo, "fora")
        log.info("  fora      | %s", rotulo)
        return
    _inc(resumo, "no_escopo")
    _inc(resumo, "interesse_borracha", int(interesse))

    try:
        pares = _resultados_relevantes(pncp, c, itens, por_item) if com_resultados else []
    except Exception as e:
        if _excluida_sem_hidratacao(pncp, sb, c, e, dry_run, resumo):
            return
        raise
    datas = [d for d in (_dt(r.get("dataResultado")) for _, r in pares) if d]
    data_homologacao = max(datas) if datas else None
    tem_resultado = (bool(pares) or data_homologacao is not None) if com_resultados else None

    # Detalhe consultado uma vez: identificação + estado autoritativo da compra (a busca atrasa).
    # `det` já consultado (recoleta) não dispara outro GET. Sem ele, 410 vira CompraExcluida.
    excluida = False
    erro_detalhe = None
    if det is None:
        try:
            det = consultar_detalhe(pncp, c)
        except CompraExcluida as e:
            det, erro_detalhe, excluida = None, e, True
            _inc(resumo, "excluidas_do_pncp")
        except ConsultaFalhou as e:
            det, erro_detalhe = None, e
    ident = identificacao_do_detalhe(c, det) if det is not None else {}
    # Documentos da compra antes da prioridade: homologação/revogação/suspensão publicadas só como documento
    # (o status oficial do PNCP não acompanha) mudam a fase. Sem a lista de documentos a decisão não é tomada nem
    # gravada (Copilot/Codex, PR #134): decidir pela ausência de documentos devolveria a leads/"Recebendo propostas"
    # uma compra suspensa ou homologada por documento. A compra vai para a segunda passada e o banco fica como
    # está. Exceção: 410 confirmado no detalhe já decide (historico/"Excluída do PNCP") sem documento.
    try:
        arquivos, erro_arquivos = pncp.arquivos(c), None
    except Exception as e:
        arquivos, erro_arquivos = None, e
    if erro_arquivos is not None and not excluida:
        _inc(resumo, "falha_arquivos")
        raise ConsultaFalhou(f"documentos da compra {c.get('numero_controle_pncp')} indisponíveis, nada decidido "
                             f"nem gravado: {erro_arquivos}") from erro_arquivos
    # Atas de registro de preço só em compra SRP (detalhe.srp). Falha na consulta = sem informação (atas None), nunca
    # "sem ata": a fase/prioridade que a ata poderia mudar não é gravada (fica a do banco).
    atas, atas_indisponiveis = None, False
    if det is not None and det.get("srp") is True and not excluida:
        try:
            atas = pncp.atas(c)
            if not isinstance(atas, list):
                raise RespostaInvalida(f"PNCP atas: esperava lista, veio {type(atas).__name__}")
        except Exception as e:
            atas, atas_indisponiveis = None, True
            _inc(resumo, "falha_atas")
            log.warning("            atas da compra %s indisponíveis (sem informação): %s",
                        c.get("numero_controle_pncp"), str(e)[:120])
    visao = compra_com_detalhe(c, det)
    fase, prioridade, motivo = fase_da_compra(
        visao, tem_resultado, agora=agora, status_busca=status_busca, itens=itens,
        documentos=arquivos if isinstance(arquivos, list) else None,
        retificada_em=atualizacao_da_compra(det, c), excluida=excluida, atas=atas)
    normalizacao = normalizacao_prazo(visao_para_prazo(visao, data_homologacao), agora=agora, atas=atas)
    # SRP com /atas indisponível: só a decisão oficial (P0-P4) é gravada; ata, documentos e prazo ficam para a
    # próxima coleta (a ata venceria todos eles).
    sem_atas = atas_indisponiveis and not excluida and not decisao_oficial(
        *motivo_prioridade(visao, tem_resultado, agora=agora, status_busca=status_busca, itens=itens))
    if sem_atas:
        _inc(resumo, "prioridade_nao_gravada_sem_atas")
    # Fail-closed: sem o detalhe, "leads" vindo só da busca+itens pode ser compra já homologada.
    # Não grava (fica o valor do banco); historico/monitorar pela busca+itens continuam valendo.
    leads_sem_detalhe = det is None and prioridade == "leads"
    if leads_sem_detalhe:
        _inc(resumo, "prioridade_leads_sem_detalhe")
    else:
        _inc(resumo, f"prioridade_{prioridade or 'indeterminada'}")
        if modo and prioridade and prioridade != modo:
            _inc(resumo, "prioridade_diferente_do_modo")

    vencedores = sorted({(r.get("nomeRazaoSocialFornecedor") or "")[:40] for _, r in pares
                         if r.get("tipoPessoa") != "PF" and r.get("nomeRazaoSocialFornecedor")})
    log.info("  %-9s%s | %s | %s (%s; fase %s)%s%s", categoria, " ★borracha" if interesse else "", rotulo,
             "leads NÃO gravada (sem detalhe)" if leads_sem_detalhe else prioridade or "prioridade ?", motivo,
             fase or "oficial",
             f" | homologado {data_homologacao.date()}" if data_homologacao else "",
             f" | vencedor(es): {', '.join(vencedores[:3])}" if vencedores else "")
    if det is not None:
        log.info("            processo %s | %s | órgão %s", ident["numero_processo"] or "?",
                 ident["numero_edital"], c.get("orgao_cnpj"))
    else:
        _inc(resumo, "falha_detalhe")
        log.warning("            detalhe indisponível, identificação não gravada: %s", str(erro_detalhe)[:120])
        if leads_sem_detalhe:
            log.warning("            leads só pela busca+itens, sem o detalhe: prioridade não gravada "
                        "(fica a do banco)")
    if dry_run:
        return

    raw = raw_com_prazo_do_detalhe(c, det)
    linha = {
        "fonte": "pncp", "codigo_externo": c["numero_controle_pncp"], **ident,
        "objeto": (c.get("description") or "").strip() or None,
        "unidade_compradora": c.get("unidade_nome"), "orgao_nome": c.get("orgao_nome"),
        "orgao_cnpj": c.get("orgao_cnpj"), "municipio": c.get("municipio_nome"), "uf": c.get("uf"),
        "modalidade": c.get("modalidade_licitacao_nome"), "situacao": c.get("situacao_nome"), "fase": fase,
        "data_publicacao": _data(c.get("data_publicacao_pncp")), "data_fim": _data(raw.get("data_fim_vigencia")),
        "data_homologacao": data_homologacao.isoformat() if data_homologacao else None,
        "prioridade": prioridade, "categoria_escopo": categoria,
        "interesse_borracha": interesse, "termos_busca": [termo], "raw": raw,
    }
    # valor_total: detalhe (valorTotalEstimado, via identificacao_do_detalhe) > valor_global da busca
    # (vazio em editais). Sem nenhum dos dois a chave fica fora: o upsert (merge-duplicates) atualiza
    # toda coluna enviada, e mandar null apagaria um valor já gravado.
    valor_total = ident.get("valor_total") or _valor_positivo(c.get("valor_global"))
    if valor_total is not None:
        linha["valor_total"] = valor_total
    else:
        linha.pop("valor_total", None)
    # O estado derivado vence: encerrada/homologada vira historico mesmo que a linha fosse lead.
    # Só não grava quando não dá para saber (não apaga uma prioridade já gravada com NULL) ou quando
    # seria leads sem o detalhe confirmar (fail-closed: homologada nunca vira lead).
    # Prazo de proposta implausível normalizado (normalizacao_prazo): data_fim recebe o normalizado (None quando o
    # prazo é só limitado por um fato, ex. limitado_por_ata) e normalizacoes.data_fim guarda {campo, original,
    # normalizado, regra, origem: "inferido"}. O bruto continua em raw.data_fim_vigencia. Sem normalização,
    # normalizacoes = null (o PNCP pode ter corrigido a data).
    if not sem_atas:
        linha["normalizacoes"] = {"data_fim": normalizacao} if normalizacao else None
        if normalizacao:
            linha["data_fim"] = normalizacao["normalizado"]
    if prioridade is None or leads_sem_detalhe or sem_atas:
        linha.pop("prioridade")
    # fase None = sem rótulo melhor que a situação oficial; fase de leads sem detalhe também não grava
    if fase is None or leads_sem_detalhe or sem_atas:
        linha.pop("fase")
    if not data_homologacao:
        linha.pop("data_homologacao")
    if termo is None:   # recoleta: não troca os termos que acharam a compra
        linha.pop("termos_busca")
    link = link_sistema_origem(c, det)
    if link:   # ausente não apaga um link já gravado
        linha["link_sistema_origem"] = link
    lic_id = sb.upsert("licitacoes_externas", linha, "fonte,codigo_externo")[0]["id"]
    _inc(resumo, "gravadas")

    # raw destas duas tabelas vai para o GCS (arquivo_raw). Omitir a coluna no upsert
    # merge-duplicates mantém o valor já gravado; linha nova fica com raw NULL até o DROP.
    # licitacoes_externas.raw e licitacao_documentos.raw continuam no banco.
    if itens:
        linhas_itens = []
        for it in itens:
            ln = {
                "licitacao_id": lic_id, "numero_item": it["numeroItem"], "descricao": it.get("descricao"),
                "material_ou_servico": material_ou_servico(it), "quantidade": _num(it.get("quantidade")),
                "unidade_medida": it.get("unidadeMedida"), "valor_unitario_estimado": _num(it.get("valorUnitarioEstimado")),
                "valor_total_estimado": _num(it.get("valorTotal")),
                "catalogo_codigo_item": str(it["catalogoCodigoItem"]) if it.get("catalogoCodigoItem") else None,
                # catalogo.id do PNCP (1 = Compras.gov.br; 2 = Outros, código do órgão): só o 1 casa com CATMAT
                "catalogo_id": catalogo_id(it),
                "situacao": it.get("situacaoCompraItemNome"), "tem_resultado": it.get("temResultado"),
                "categoria_escopo": por_item[it["numeroItem"]][0], "interesse_borracha": por_item[it["numeroItem"]][1],
            }
            _enviar_raw(arquivos_raw, "licitacao_itens",
                        {"licitacao_id": lic_id, "numero_item": ln["numero_item"]}, it)
            linhas_itens.append(ln)
        sb.upsert("licitacao_itens", linhas_itens, "licitacao_id,numero_item")

    linhas = []
    for it, r in pares:
        ln = {
            "licitacao_id": lic_id, "numero_item": it["numeroItem"],
            "sequencial_resultado": r.get("sequencialResultado") or 1,
            "fornecedor_nome": r.get("nomeRazaoSocialFornecedor") if r.get("tipoPessoa") != "PF" else None,
            "fornecedor_cnpj": cnpj_ou_none(r.get("niFornecedor")),
            "porte_fornecedor": r.get("porteFornecedorNome"),
            "quantidade_homologada": _num(r.get("quantidadeHomologada")),
            "valor_unitario_homologado": _num(r.get("valorUnitarioHomologado")),
            "valor_total_homologado": _num(r.get("valorTotalHomologado")),
            "situacao": r.get("situacaoCompraItemResultadoNome"), "data_resultado": _data(r.get("dataResultado")),
        }
        _enviar_raw(arquivos_raw, "licitacao_resultados", {
            "licitacao_id": lic_id, "numero_item": ln["numero_item"],
            "sequencial_resultado": ln["sequencial_resultado"],
        }, _raw_resultado(r))
        linhas.append(ln)
    if linhas:
        sb.upsert("licitacao_resultados", linhas, "licitacao_id,numero_item,sequencial_resultado")

    if erro_arquivos is not None:   # só chega aqui com 410: compra excluída não tem documentos para gravar
        log.info("            documentos indisponíveis na compra excluída do PNCP: %s", str(erro_arquivos)[:120])
        return
    visto_em = datetime.now(timezone.utc).isoformat()
    docs = [{
        "licitacao_id": lic_id, "secao": "processo",
        "nome_original": a.get("titulo"), "arquivo_origem": f"pncp-{a.get('sequencialDocumento')}",
        "data_documento": _data(a.get("dataPublicacaoPncp")),
        "raw": {"tipo_documento": a.get("tipoDocumentoNome"), "url": a.get("url") or a.get("uri")},
        "last_seen_at": visto_em, "removido_do_portal_em": None,
    } for a in arquivos if a.get("statusAtivo", True)]
    # Documento que o PNCP inativou ou tirou da lista: marca removido_do_portal_em (coluna que o
    # documentos_paradigma já usa; nada é apagado). O reclassificador ignora documento removido ao decidir a fase
    # (Copilot/Codex, PR #134: termo de homologação retirado pelo órgão não força mais historico).
    _marcar_documentos_removidos(sb, lic_id, {d["arquivo_origem"] for d in docs}, visto_em, resumo)
    salvos = sb.upsert("licitacao_documentos", docs, "licitacao_id,secao,arquivo_origem") if docs else []
    # Coleta completa: versão só depois da marcação/upsert. 410 não chega aqui (return acima) e, se
    # excluida com arquivos ok, também não grava versão.
    if not excluida:
        versao = datas_atualizacao(det)
        if versao:
            sb.atualizar("licitacoes_externas", lic_id, versao)
    if not docs:
        return
    if not baixar_arquivos:
        return
    for d in salvos:
        if d.get("status_processamento") not in ("pendente", "erro"):
            continue
        url = (d.get("raw") or {}).get("url")
        try:
            conteudo, ctype = pncp.baixar(url, max_bytes)
            if parece_html(conteudo, ctype):
                raise RuntimeError("PNCP devolveu HTML em vez do arquivo")
            ext, mime = tipo_arquivo(conteudo, d.get("nome_original"), ctype)
            caminho = arm.caminho("pncp", 0, c["orgao_cnpj"] + "-" + str(c["ano"]) + "-" + str(c["numero_sequencial"]),
                                  "processo", f"{d['arquivo_origem']}.{ext}")
            uri = arm.salvar(caminho, conteudo, mime)
            sb.atualizar("licitacao_documentos", d["id"], {
                "storage_uri": uri, "mime_type": mime, "tamanho_bytes": len(conteudo),
                "sha256": sha256(conteudo), "baixado_em": datetime.now(timezone.utc).isoformat(),
                "status_processamento": "baixado", "erro": None})
            log.info("    arquivo: %s (%.1f MB)", (d.get("nome_original") or "")[:70], len(conteudo) / 1048576)
        except Exception as e:
            sb.atualizar("licitacao_documentos", d["id"], {"status_processamento": "erro", "erro": str(e)[:300]})


def raw_com_prazo_do_detalhe(c: dict, det: dict | None) -> dict:
    """raw gravado = item da busca, com o prazo de proposta e a data de atualização do DETALHE quando existem e
    diferem (Copilot, PR #134, 3ª e 4ª rodadas). Sem migration, e o item da busca não é alterado.
    - Prazo: a fase e a prioridade são decididas com o prazo do detalhe (compra_com_detalhe), e a view
      licitacoes_externas_prioridade_efetiva lê raw.data_fim_vigencia (senão data_fim); gravar o prazo da busca
      defasada fazia a view rebaixar a "Recebendo propostas"/leads reaberta pelo detalhe. O prazo do detalhe vai em
      raw.data_fim_vigencia (e data_fim), o da busca fica em raw.data_fim_vigencia_busca, com
      raw.data_fim_vigencia_fonte = "detalhe".
    - Atualização: a suspensão por documento só vale sem retificação posterior (atualizacao_da_compra), e o coletor
      decide com o dataAtualizacao do detalhe. Ele vai em raw.data_atualizacao_detalhe (raw.data_atualizacao_pncp
      continua sendo o da busca), para o reclassificador sem detalhe decidir com a mesma data.
    Sem detalhe (ou sem esses campos nele), o raw é a busca, como antes."""
    extra = {}
    prazo = (det or {}).get("dataEncerramentoProposta")
    if prazo and prazo != c.get("data_fim_vigencia"):
        extra.update(data_fim_vigencia=prazo, data_fim_vigencia_busca=c.get("data_fim_vigencia"),
                     data_fim_vigencia_fonte="detalhe")
    atualizacao = (det or {}).get("dataAtualizacao")
    if atualizacao and atualizacao != c.get("data_atualizacao_pncp"):
        extra["data_atualizacao_detalhe"] = atualizacao
    return {**c, **extra} if extra else c


def atualizacao_da_compra(det: dict | None, raw: dict | None) -> str | None:
    """Última atualização (retificação) da compra para sinal_documental: dataAtualizacao do detalhe consultado
    agora; senão a do detalhe gravada pelo coletor (raw.data_atualizacao_detalhe); senão a da busca
    (raw.data_atualizacao_pncp). Coletor e reclassificador usam a mesma ordem (Copilot, PR #134, 4ª rodada)."""
    raw = raw if isinstance(raw, dict) else {}
    return ((det or {}).get("dataAtualizacao") or raw.get("data_atualizacao_detalhe")
            or raw.get("data_atualizacao_pncp"))


def _excluida_sem_hidratacao(pncp, sb, c: dict, erro: Exception, dry_run: bool, resumo: dict) -> bool:
    """itens()/resultados falharam: o detalhe é consultado mesmo assim (Copilot, PR #134, 2ª rodada), porque uma
    compra excluída do PNCP costuma falhar justamente nesses endpoints e, sem isso, a linha já gravada como
    leads/monitorar ficaria em Oportunidades. Com 410 confirmado, a linha JÁ GRAVADA (fonte pncp, mesmo código)
    recebe só prioridade=historico e fase="Excluída do PNCP"; categoria, interesse, itens e resultados ficam como
    estão e nada é inserido (sem itens não dá para saber se a compra é do escopo). True = resolvida (não vai para
    a segunda passada). Sem 410 (detalhe ok ou falhou): False, e quem chama relança o erro original: sem itens ou
    resultados nada é decidido nem gravado (regra do achado 1 da 1ª rodada)."""
    try:
        consultar_detalhe(pncp, c)
    except CompraExcluida:
        pass
    except ConsultaFalhou:
        return False
    else:
        return False
    codigo = c.get("numero_controle_pncp")
    _inc(resumo, "excluidas_do_pncp")
    _inc(resumo, "excluidas_sem_itens")
    log.info("  excluída  | %s | itens/resultados indisponíveis (%s); detalhe HTTP 410", codigo, str(erro)[:80])
    if dry_run or not codigo:
        return True
    linhas = sb.selecionar("licitacoes_externas", select="id", fonte="eq.pncp", codigo_externo=f"eq.{codigo}")
    for ln in linhas or []:
        sb.atualizar("licitacoes_externas", ln["id"], {"prioridade": "historico", "fase": FASE_EXCLUIDA})
        _inc(resumo, "excluidas_marcadas")
    return True


def _marcar_documentos_removidos(sb, lic_id, ativos: set[str], agora: str, resumo: dict) -> None:
    """Marca removido_do_portal_em nos documentos PNCP da compra (secao processo, arquivo_origem pncp-*) que não
    estão mais ativos em /arquivos. Documento que voltou a ficar ativo é desmarcado pelo upsert (None)."""
    existentes = sb.selecionar("licitacao_documentos", select="id,arquivo_origem,removido_do_portal_em",
                               licitacao_id=f"eq.{lic_id}", secao="eq.processo", arquivo_origem="like.pncp-*")
    for r in existentes or []:
        if r.get("arquivo_origem") not in ativos and not r.get("removido_do_portal_em"):
            sb.atualizar("licitacao_documentos", r["id"], {"removido_do_portal_em": agora})
            _inc(resumo, "documentos_removidos_do_portal")


def compra_de_codigo(codigo: str | None, **extra) -> dict | None:
    """'44892693000140-1-000157/2026' (numero_controle_pncp) -> chaves do detalhe da compra."""
    m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", codigo or "")
    if not m:
        return None
    return {"orgao_cnpj": m.group(1), "numero_sequencial": int(m.group(2)), "ano": int(m.group(3)),
            "numero_controle_pncp": codigo, **extra}


def corrigir_processos(pncp: PNCP, sb: Supabase) -> dict:
    """Versões até a v12 gravaram o código PNCP em numero_processo. Busca o processo administrativo real.

    Três desfechos por linha: processo encontrado (corrigidas), detalhe válido sem processo
    (sem_processo, grava NULL: o valor antigo era o código PNCP) e falha da consulta
    (falha_consulta, não grava nada). Se o detalhe trouxer valorTotalEstimado, valor_total vai junto
    (nunca NULL: identificacao omite a chave sem valor)."""
    r = {"lidas": 0, "corrigidas": 0, "sem_processo": 0, "falha_consulta": 0}
    linhas = sb.selecionar("licitacoes_externas", fonte="eq.pncp", select="id,codigo_externo,orgao_cnpj,numero_edital")
    for ln in linhas:
        r["lidas"] += 1
        c = compra_de_codigo(ln.get("codigo_externo"), title=ln.get("numero_edital"))
        if not c:
            continue
        try:
            ident = identificacao(pncp, c)
        except ConsultaFalhou as e:
            r["falha_consulta"] += 1
            log.warning("  %s: consulta falhou, nada gravado: %s", ln["codigo_externo"], str(e)[:120])
            continue
        sb.atualizar("licitacoes_externas", ln["id"], ident)
        if ident["numero_processo"]:
            r["corrigidas"] += 1
        else:
            r["sem_processo"] += 1
        log.info("  %s -> processo %s | %s", ln["codigo_externo"], ident["numero_processo"], ident["numero_edital"])
    return r


PRIORIDADES_RECOLETA_PADRAO = "leads,monitorar"


def compra_para_recoleta(raw: dict, codigo: str, det: dict) -> dict | None:
    """Item da busca guardado em `raw` atualizado com o que o detalhe traz de autoritativo (a busca atrasa e a
    compra pode ter sido retificada): objeto, situação, prazo de proposta e versão. None se o código não é PNCP."""
    chaves = compra_de_codigo(codigo)
    if not chaves:
        return None
    c = {**(raw if isinstance(raw, dict) else {}), **chaves}
    for chave_busca, chave_detalhe in (("description", "objetoCompra"), ("situacao_nome", "situacaoCompraNome"),
                                       ("data_fim_vigencia", "dataEncerramentoProposta"),
                                       ("data_atualizacao_pncp", "dataAtualizacao"),
                                       ("link_sistema_origem", "linkSistemaOrigem")):
        if det.get(chave_detalhe) not in (None, ""):
            c[chave_busca] = det[chave_detalhe]
    return c


def recoletar_atualizadas(pncp: PNCP, sb: Supabase, arm: Armazenamento | None = None,
                          prioridades: list[str] | set[str] | str | None = PRIORIDADES_RECOLETA_PADRAO,
                          com_resultados: bool = True, max_bytes: int = 80 * 1048576, dry_run: bool = False,
                          limite: int | None = None, agora: datetime | None = None,
                          mapa_catmat: MapaCatmat | None = None) -> dict:
    """Recoleta (metadados + itens + resultados + lista de arquivos) as compras PNCP já gravadas cujo
    dataAtualizacao/dataAtualizacaoGlobal no detalhe do PNCP difere do guardado em
    licitacoes_externas.pncp_data_atualizacao[_global] (ou que ainda não têm valor guardado).

    Lê as compras no escopo (categoria_escopo não nula) com prioridade efetiva em `prioridades`
    (view licitacoes_externas_prioridade_efetiva; padrão leads,monitorar) e faz UMA consulta de detalhe
    por compra; só as que mudaram passam por _processar (com o detalhe já consultado). Nunca baixa
    arquivo: o download é sob demanda (--baixar-pendentes, só para as compras do pipeline).
    Compra que a recoleta classifica como fora do escopo não é regravada (como na coleta normal) e
    continua sem a versão guardada. `limite` = máximo de compras recoletadas. --dry-run só conta."""
    prio_set = validar_prioridades(prioridades)
    agora = agora or datetime.now(timezone.utc)
    resumo = {"lidas": 0, "consultadas": 0, "sem_mudanca": 0, "mudaram": 0, "recoletadas": 0,
              "falha_detalhe": 0, "sem_data_pncp": 0, "erros": 0, "motivos": {}}
    prio_map = {pl["id"]: pl.get("prioridade") for pl in
                sb.selecionar("licitacoes_externas_prioridade_efetiva", fonte="eq.pncp", order="id.asc",
                              select="id,prioridade")}
    linhas = sb.selecionar("licitacoes_externas", fonte="eq.pncp", categoria_escopo="not.is.null", order="id.asc",
                           select="id,codigo_externo,pncp_data_atualizacao,pncp_data_atualizacao_global,raw")
    arquivos_raw = None if dry_run else _abrir_arquivos_pncp(str(uuid.uuid4()))
    try:
        for ln in linhas:
            if (prio_map.get(ln["id"]) or "").lower() not in prio_set:
                continue
            resumo["lidas"] += 1
            if limite and resumo["recoletadas"] >= limite:
                break
            chaves = compra_de_codigo(ln.get("codigo_externo"))
            if not chaves:
                continue
            resumo["consultadas"] += 1
            try:
                det = consultar_detalhe(pncp, chaves)
            except CompraExcluida:
                # 410: o detalhe não traz versão. _processar marca historico/"Excluída do PNCP" e não grava
                # pncp_data_atualizacao*. det=None para ele consultar de novo e cair no bloco da main.
                log.info("  %s: excluída do PNCP (410); versão não gravada", ln["codigo_externo"])
                if dry_run:
                    _inc(resumo, "excluidas_do_pncp")
                    continue
                try:
                    c = compra_para_recoleta(ln.get("raw") or {}, ln["codigo_externo"], {})
                    if c is not None:
                        _processar(pncp, sb, arm, c, None, com_resultados, False, max_bytes, False, resumo,
                                   agora=agora, det=None, mapa_catmat=mapa_catmat, arquivos_raw=arquivos_raw)
                        resumo["recoletadas"] += 1
                except ArquivoRawErro:
                    raise
                except Exception as e:
                    resumo["erros"] += 1
                    log.warning("  %s: marcação de excluída falhou (tenta de novo na próxima): %s",
                                ln["codigo_externo"], str(e)[:160])
                continue
            except ConsultaFalhou as e:
                resumo["falha_detalhe"] += 1
                log.warning("  %s: detalhe falhou, fica para a próxima: %s", ln["codigo_externo"], str(e)[:120])
                continue
            motivo = mudou_no_pncp(ln, det)
            if motivo is None:
                resumo["sem_data_pncp" if not datas_atualizacao(det) else "sem_mudanca"] += 1
                continue
            resumo["mudaram"] += 1
            resumo["motivos"][motivo] = resumo["motivos"].get(motivo, 0) + 1
            log.info("  %s: %s (guardado %s / %s; PNCP %s / %s)", ln["codigo_externo"], motivo,
                     ln.get("pncp_data_atualizacao"), ln.get("pncp_data_atualizacao_global"),
                     det.get("dataAtualizacao"), det.get("dataAtualizacaoGlobal"))
            if dry_run:
                continue
            try:
                _processar(pncp, sb, arm, compra_para_recoleta(ln.get("raw"), ln["codigo_externo"], det), None,
                           com_resultados, False, max_bytes, False, resumo, agora=agora, det=det,
                           mapa_catmat=mapa_catmat, arquivos_raw=arquivos_raw)
                resumo["recoletadas"] += 1
            except ArquivoRawErro:
                raise
            except Exception as e:
                resumo["erros"] += 1
                log.warning("  %s: recoleta falhou (versão não gravada, tenta de novo na próxima): %s",
                            ln["codigo_externo"], str(e)[:160])
        return resumo
    finally:
        if arquivos_raw is not None:
            resumo["arquivo_raw"] = fechar_todos(list(arquivos_raw.values()))


def _compra_slug(lic: dict) -> str:
    c = lic.get("raw") or {}
    cnpj = c.get("orgao_cnpj") or lic.get("orgao_cnpj")
    ano = c.get("ano")
    seq = c.get("numero_sequencial")
    if not (cnpj and ano and seq):
        m = re.match(r"(\d{14})-\d-(\d+)/(\d{4})$", lic.get("codigo_externo") or "")
        if m:
            cnpj = cnpj or m.group(1)
            seq = seq or int(m.group(2))
            ano = ano or int(m.group(3))
    if cnpj and ano and seq:
        return f"{cnpj}-{ano}-{seq}"
    if lic.get("codigo_externo"):
        return re.sub(r"[^A-Za-z0-9._-]", "_", str(lic["codigo_externo"]))
    return str(lic.get("id") or "0")


_MIME_POR_EXTENSAO = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "zip": "application/zip",
    "rar": "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    "doc": "application/msword",
}
_EXTENSAO_POR_MIME = {mime: ext for ext, mime in _MIME_POR_EXTENSAO.items()}
_EXTENSAO_POR_MIME.update({
    "application/x-zip-compressed": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-rar": "rar",
})
_OCTET_STREAM = "application/octet-stream"


def _content_type_limpo(content_type: str | None) -> str | None:
    ctype = (content_type or "").split(";")[0].strip().lower()
    if not ctype or ctype == _OCTET_STREAM:
        return None
    return ctype


def _extensao_do_nome(nome: str | None) -> str | None:
    nome = (nome or "").strip()
    if "." not in nome:
        return None
    ext = nome.rsplit(".", 1)[-1].lower()
    if re.fullmatch(r"[a-z0-9]{1,5}", ext):
        return ext
    return None


def _mime_da_extensao(ext: str) -> str:
    return _MIME_POR_EXTENSAO.get(ext) or mimetypes.guess_type(f"arquivo.{ext}")[0] or _OCTET_STREAM


def _extensao_do_mime(ctype: str) -> str | None:
    ext = _EXTENSAO_POR_MIME.get(ctype)
    if ext:
        return ext
    adivinhada = mimetypes.guess_extension(ctype, strict=False)
    if not adivinhada:
        return None
    ext = adivinhada.removeprefix(".").lower()
    if ext == "jpe":
        ext = "jpg"
    if re.fullmatch(r"[a-z0-9]{1,5}", ext):
        return ext
    return None


def _tipo_zip(conteudo: bytes) -> tuple[str, str]:
    """PK\\x03\\x04 é ZIP. DOCX/XLSX são o mesmo contêiner com um membro interno conhecido."""
    try:
        with zipfile.ZipFile(io.BytesIO(conteudo)) as zf:
            nomes = [n.replace("\\", "/") for n in zf.namelist()]
    except Exception:
        # Assinatura PK sem diretório central legível continua ZIP. A detecção não falha o download.
        return "zip", _MIME_POR_EXTENSAO["zip"]
    if any(n == "word/document.xml" or n.endswith("/word/document.xml") for n in nomes):
        return "docx", _MIME_POR_EXTENSAO["docx"]
    if any(n == "xl" or n.startswith("xl/") for n in nomes):
        return "xlsx", _MIME_POR_EXTENSAO["xlsx"]
    return "zip", _MIME_POR_EXTENSAO["zip"]


def tipo_arquivo(conteudo: bytes, nome_original: str | None = None,
                 content_type: str | None = None) -> tuple[str, str]:
    """Extensão (sem ponto) e mime reais do anexo.

    Magic numbers vencem a extensão de nome_original e o Content-Type. No piloto de
    02/10/2026 o PNCP devolveu todo arquivo como application/octet-stream, e vários
    títulos não têm extensão ('21 - Edital', 'ETP_E_TR'). Sem assinatura: extensão do
    nome, senão Content-Type que não seja octet-stream, senão bin.
    """
    if conteudo.startswith(b"%PDF-"):
        return "pdf", _MIME_POR_EXTENSAO["pdf"]
    if conteudo.startswith(b"PK\x03\x04"):
        return _tipo_zip(conteudo)
    if conteudo.startswith(b"Rar!"):
        return "rar", _MIME_POR_EXTENSAO["rar"]
    if conteudo.startswith(b"7z\xbc\xaf"):
        return "7z", _MIME_POR_EXTENSAO["7z"]
    if conteudo.startswith(b"\xd0\xcf\x11\xe0"):
        return "doc", _MIME_POR_EXTENSAO["doc"]
    ext = _extensao_do_nome(nome_original)
    if ext:
        return ext, _mime_da_extensao(ext)
    ctype = _content_type_limpo(content_type)
    if ctype:
        ext = _extensao_do_mime(ctype)
        if ext:
            return ext, ctype
    return "bin", _OCTET_STREAM


def baixar_pendentes(pncp: PNCP, sb: Supabase, arm: Armazenamento | None,
                     categorias: list[str] | set[str] | str | None = None,
                     max_bytes: int = 80 * 1048576,
                     dry_run: bool = False,
                     limite: int | None = None,
                     prioridades: list[str] | set[str] | str | None = None) -> dict:
    """Lê de licitacao_documentos os registros da fonte pncp com status 'pendente',
    filtra por licitacoes_externas.categoria_escopo (por padrão exclui 'fraco')
    e opcionalmente por prioridade efetiva (view licitacoes_externas_prioridade_efetiva),
    baixa cada arquivo pela URL guardada, grava no storage (Armazenamento.do_ambiente: Supabase Storage, GCS ou local)
    e atualiza status_processamento, sha256, mime_type (assinatura do arquivo, não o
    Content-Type octet-stream do PNCP), tamanho_bytes, baixado_em e erro,
    respeitando MAX_MB, o delay e o Retry-After.
    Documento com removido_do_portal_em preenchido (anexo que o PNCP inativou depois de gravado) não entra
    na seleção (removido_do_portal_em=is.null): senão --baixar-pendentes baixaria um inativo ainda pendente.
    Idempotente: não baixa de novo o que já tem sha256; o caminho no storage é determinístico (sobrescreve).
    Só baixa URL https de PNCP_HOSTS_PERMITIDOS (cada redirecionamento também é validado).
    Falha transitória (429/5xx esgotados, timeout, conexão, storage) mantém 'pendente' com o erro anotado,
    para a próxima execução tentar de novo; falha definitiva (acima de MAX_MB, HTML, host fora da allowlist,
    4xx) vai para 'erro'.
    --dry-run: lista os documentos elegíveis sem baixar nem gravar."""
    if isinstance(categorias, str):
        cat_set = {c.strip().lower() for c in categorias.split(",") if c.strip()}
    elif categorias is not None:
        cat_set = {c.strip().lower() for c in categorias if c.strip()}
    else:
        cat_set = {c.strip().lower() for c in CATEGORIAS_PADRAO_DOWNLOAD.split(",") if c.strip()}

    prio_set = validar_prioridades(prioridades)

    log.info("baixar_pendentes: buscando licitações externas fonte=pncp e categorias=%s prioridades=%s",
             sorted(cat_set), sorted(prio_set) if prio_set is not None else "todas")
    lics = sb.selecionar("licitacoes_externas", fonte="eq.pncp", order="id.asc",
                         select="id,codigo_externo,orgao_cnpj,categoria_escopo,raw")

    # Mapeamento de prioridade efetiva a partir da view licitacoes_externas_prioridade_efetiva
    prio_map: dict[int, str | None] = {}
    if prio_set is not None or dry_run:
        prio_lics = sb.selecionar("licitacoes_externas_prioridade_efetiva", fonte="eq.pncp", order="id.asc",
                                  select="id,prioridade")
        for pl in prio_lics:
            prio_map[pl["id"]] = pl.get("prioridade")

    def _lic_elegivel(l: dict) -> bool:
        if (l.get("categoria_escopo") or "").lower() not in cat_set:
            return False
        if prio_set is not None:
            prio = prio_map.get(l["id"])
            if prio is None or prio.lower() not in prio_set:
                return False
        return True

    lic_map = {l["id"]: l for l in lics if _lic_elegivel(l)}
    lic_todas_pncp = {l["id"] for l in lics}
    log.info("licitacoes_externas pncp: %d total, %d nas categorias/prioridades selecionadas",
             len(lic_todas_pncp), len(lic_map))

    docs = sb.selecionar("licitacao_documentos", status_processamento="eq.pendente",
                         removido_do_portal_em="is.null", order="id.asc",
                         select="id,licitacao_id,secao,nome_original,arquivo_origem,storage_uri,mime_type,tamanho_bytes,sha256,status_processamento,erro,raw")
    log.info("licitacao_documentos com status pendente: %d encontrados", len(docs))

    resumo = {
        "lidos": len(docs),
        "elegiveis": 0,
        "baixados": 0,
        "ja_baixados": 0,
        "ignorados_categoria": 0,
        "ignorados_prioridade": 0,
        "ignorados_sem_url": 0,
        "bloqueados_host": 0,
        "erros": 0,
        "erros_transitorios": 0,
        "por_prioridade": {},
        "detalhes": [],
    }

    lics_orig_map = {l["id"]: l for l in lics}

    for d in docs:
        lic_id = d.get("licitacao_id")
        if lic_id not in lic_todas_pncp:
            # Não é documento de licitação do PNCP
            continue

        lic_orig = lics_orig_map.get(lic_id)
        if lic_orig and (lic_orig.get("categoria_escopo") or "").lower() not in cat_set:
            # Excluído pelo filtro de categoria (ex.: fraco)
            resumo["ignorados_categoria"] += 1
            continue

        if prio_set is not None:
            prio_efetiva = prio_map.get(lic_id)
            if prio_efetiva is None or prio_efetiva.lower() not in prio_set:
                resumo["ignorados_prioridade"] += 1
                continue

        if lic_id not in lic_map:
            continue

        lic = lic_map[lic_id]
        cat = lic.get("categoria_escopo")
        prio = prio_map.get(lic_id)

        # Idempotência: não baixar de novo se já tem sha256
        if d.get("sha256"):
            resumo["ja_baixados"] += 1
            log.info("  doc #%s já possui sha256; pulando", d["id"])
            continue

        url = (d.get("raw") or {}).get("url") or (d.get("raw") or {}).get("uri")
        if not url:
            resumo["ignorados_sem_url"] += 1
            log.warning("  doc #%s sem URL em raw; pulando", d["id"])
            continue

        if not url_permitida(url):
            resumo["bloqueados_host"] += 1
            log.warning("  doc #%s: URL fora dos hosts permitidos (%s); não baixa: %s",
                        d["id"], ",".join(PNCP_HOSTS_PERMITIDOS), str(url)[:120])
            if not dry_run:
                sb.atualizar("licitacao_documentos", d["id"], {
                    "status_processamento": "erro",
                    "erro": f"URL fora dos hosts permitidos: {str(url)[:200]}",
                })
            continue

        if limite and resumo["elegiveis"] >= limite:
            log.info("Limite de %d downloads atingido", limite)
            break

        resumo["elegiveis"] += 1
        if prio_set is not None or dry_run:
            prio_chave = prio or "sem_prioridade"
            resumo["por_prioridade"][prio_chave] = resumo["por_prioridade"].get(prio_chave, 0) + 1
        compra_slug = _compra_slug(lic)
        nome_orig = d.get("nome_original") or d.get("arquivo_origem") or "arquivo"

        if dry_run:
            log.info("  [dry-run] doc #%s | %s | lic #%s (cat: %s, prio: %s) -> %s",
                     d["id"], nome_orig[:60], lic_id, cat, prio, url)
            resumo["detalhes"].append({
                "doc_id": d["id"],
                "licitacao_id": lic_id,
                "categoria": cat,
                "prioridade": prio,
                "nome_original": nome_orig,
                "url": url,
            })
            continue

        try:
            conteudo, ctype = pncp.baixar(url, max_bytes)
            if parece_html(conteudo, ctype):
                raise ArquivoRecusado("PNCP devolveu HTML em vez do arquivo")
            ext, mime = tipo_arquivo(conteudo, d.get("nome_original"), ctype)
            caminho = arm.caminho("pncp", 0, compra_slug, d.get("secao") or "processo",
                                  f"{d['arquivo_origem']}.{ext}")
            uri = arm.salvar(caminho, conteudo, mime)
            h = sha256(conteudo)
            sb.atualizar("licitacao_documentos", d["id"], {
                "storage_uri": uri,
                "mime_type": mime,
                "tamanho_bytes": len(conteudo),
                "sha256": h,
                "baixado_em": datetime.now(timezone.utc).isoformat(),
                "status_processamento": "baixado",
                "erro": None,
            })
            resumo["baixados"] += 1
            log.info("  doc #%s baixado: %s (%.1f MB) -> %s",
                     d["id"], nome_orig[:60], len(conteudo) / 1048576, uri)
        except Exception as e:
            definitivo = _falha_definitiva(e)
            resumo["erros" if definitivo else "erros_transitorios"] += 1
            log.warning("  doc #%s falha %s ao baixar: %s", d["id"],
                        "definitiva" if definitivo else "transitória (fica pendente)", str(e)[:120])
            sb.atualizar("licitacao_documentos", d["id"], {
                "status_processamento": "erro" if definitivo else "pendente",
                "erro": str(e)[:300],
            })

    return resumo


def _falha_definitiva(e: Exception) -> bool:
    """Acima de MAX_MB, HTML, host fora da allowlist, resposta inválida e 4xx (exceto 429) não melhoram
    com nova tentativa. O resto (429/5xx esgotados, timeout, conexão, storage) é transitório."""
    if isinstance(e, (ValueError, RespostaInvalida)):
        return True
    if isinstance(e, requests.HTTPError) and e.response is not None:
        return 400 <= e.response.status_code < 500 and e.response.status_code != 429
    return False


def fatiar_lote(termos: list[str], lote: str) -> list[str]:
    """'K/N' -> K-ésima de N fatias contíguas da lista (1-based). Determinístico: rodar 1/N..N/N cobre a
    lista inteira sem repetir, e repetir um lote que falhou retoma exatamente os mesmos termos."""
    m = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", lote or "")
    if not m:
        raise ValueError(f"--lote deve ser K/N (ex.: 1/4), veio {lote!r}")
    k, n = int(m.group(1)), int(m.group(2))
    if n < 1 or not 1 <= k <= n:
        raise ValueError(f"--lote {lote}: precisa de 1 <= K <= N")
    tam = -(-len(termos) // n)
    return termos[(k - 1) * tam:k * tam]


def _cli_prioridades(valor: str) -> str:
    """Validador do tipo de --prioridades no argparse. Valida contra PRIORIDADES_VALIDAS
    e levanta ArgumentTypeError se houver valor inválido ou vazio."""
    try:
        validar_prioridades(valor)
    except ValueError as e:
        raise argparse.ArgumentTypeError(str(e)) from e
    return valor


def criar_parser() -> argparse.ArgumentParser:
    """Parser da linha de comando (também usado por coletor.pncp_cloud_run para ler as opções já canônicas,
    com as abreviações do argparse resolvidas)."""
    ap = argparse.ArgumentParser(description="Coletor PNCP (escopo LicitaGym)")
    ap.add_argument("--modo", choices=list(MODOS), default="leads",
                    help="leads (padrão): recebendo proposta; monitorar: em julgamento; historico: encerradas. "
                         "Só escolhe o status da busca: a prioridade gravada vem do estado de cada compra")
    # Obsoletos (janela de homologação do antigo modo leads): aceitos para não quebrar agendamentos, sem efeito.
    ap.add_argument("--dias", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--margem-publicacao", type=int, help=argparse.SUPPRESS)
    selecao = ap.add_mutually_exclusive_group()
    selecao.add_argument("--termos", help="lista separada por vírgula (padrão: os ~160 de TERMOS_ESCOPO_COMPLETO)")
    selecao.add_argument("--escopo-completo", action="store_true",
                         help="usa os ~160 termos de TERMOS_ESCOPO_COMPLETO (58 PDMs; já é o padrão, mantido por compatibilidade)")
    selecao.add_argument("--termos-padrao", action="store_true",
                         help="usa só os 12 termos resumidos de TERMOS_PADRAO (execução rápida)")
    ap.add_argument("--todos-termos", action="store_true",
                    help="TERMOS_PADRAO (ou --termos) + escopo completo (compatibilidade)")
    ap.add_argument("--lote", help="K/N: roda só a fatia K de N da lista de termos (ex.: --lote 1/4)")
    ap.add_argument("--status", choices=["todos", "recebendo_proposta", "em_julgamento", "encerradas"],
                    help="sobrescreve o status do modo")
    ap.add_argument("--paginas", type=int, help="páginas por termo (padrão: leads 20, outros 3)")
    ap.add_argument("--tam", type=int, default=50,
                    help="resultados por página (máximo 100; pedido maior é cortado)")
    ap.add_argument("--sem-resultados", action="store_true", help="não consulta vencedores")
    ap.add_argument("--baixar-arquivos", action="store_true", help="baixa edital/anexos (para o RAG)")
    ap.add_argument("--baixar-pendentes", action="store_true",
                    help="baixa arquivos pendentes do PNCP gravados em licitacao_documentos")
    ap.add_argument("--categorias",
                    help="categorias de escopo permitidas no download de pendentes (padrão: catmat,forte,borracha,piso,obra_piso)")
    ap.add_argument("--prioridades", type=_cli_prioridades,
                    help="prioridades efetivas permitidas no download de pendentes (valores: leads, monitorar, historico)")
    ap.add_argument("--limite-download", type=int, default=None,
                    help="limite máximo de documentos para baixar no modo --baixar-pendentes")
    ap.add_argument("--recoletar-atualizadas", action="store_true",
                    help="recoleta compras PNCP já gravadas cujo dataAtualizacao/dataAtualizacaoGlobal mudou no PNCP "
                         "(usa --prioridades, padrão leads,monitorar; nunca baixa arquivos)")
    ap.add_argument("--limite-recoleta", type=int, default=None,
                    help="máximo de compras recoletadas por --recoletar-atualizadas")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--corrigir-processos", action="store_true",
                    help="só corrige numero_processo das compras PNCP já gravadas (processo administrativo real)")
    return ap


def _leitor_mapa_catmat_dry_run() -> LeituraMapaCatmat | None:
    """Dry-run: lê o mapa CATMAT por um cliente só leitura, para classificar como a coleta real. None só quando não
    há banco nenhum (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY ausentes); só uma das duas é erro de configuração."""
    url, chave = env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY")
    if not url and not chave:
        return None
    if not (url and chave):
        raise MapaCatmatIndisponivel("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY: só uma das duas está definida")
    return LeituraMapaCatmat(Supabase(url, chave))


def _mapa_catmat_ou_abortar(obter_leitor) -> tuple[bool, MapaCatmat | None]:
    """(ok, mapa). ok=False: banco configurado e mapa indisponível; quem chama aborta antes de gravar."""
    try:
        return True, carregar_mapa_catmat_se_houver_banco(obter_leitor())
    except MapaCatmatIndisponivel as e:
        log.error("Mapa CATMAT indisponível com o banco configurado; abortando antes de gravar "
                  "(sem o código a classificação mudaria em silêncio): %s", str(e)[:300])
        return False, None


def main(argv: list[str] | None = None) -> int:
    ap = criar_parser()
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.corrigir_processos:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        log.info("RESUMO: %s", corrigir_processos(PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5"))), sb))
        return 0

    if args.recoletar_atualizadas:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        ok, mapa = _mapa_catmat_ou_abortar(lambda: sb)
        if not ok:
            return 1
        r = recoletar_atualizadas(PNCP(delay=float(env("DELAY_SEGUNDOS", "1.0"))), sb, None,
                                  prioridades=args.prioridades or PRIORIDADES_RECOLETA_PADRAO,
                                  com_resultados=not args.sem_resultados,
                                  max_bytes=int(float(env("MAX_MB", "80")) * 1048576),
                                  dry_run=args.dry_run, limite=args.limite_recoleta, mapa_catmat=mapa)
        if not args.dry_run:
            drenar_licitacao_match(sb)
        log.info("RESUMO RECOLETA: %s", r)
        return 0

    if args.baixar_pendentes:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        arm = Armazenamento.do_ambiente() if not args.dry_run else None
        pncp = PNCP(delay=float(env("DELAY_SEGUNDOS", "0.5")))
        r = baixar_pendentes(
            pncp, sb, arm,
            categorias=args.categorias,
            prioridades=args.prioridades,
            max_bytes=int(float(env("MAX_MB", "80")) * 1048576),
            dry_run=args.dry_run,
            limite=args.limite_download,
        )
        log.info("RESUMO BAIXAR PENDENTES: %s", r)
        return 0

    # Padrão = escopo completo (~160 termos, 58 PDMs; decisão do owner, 30/09/2026). --termos-padrao volta aos 12
    # termos resumidos. Com a lista ampla o ritmo cai para ~1 req/s (abaixo) e --lote K/N divide a execução.
    if args.termos:
        termos = [t.strip() for t in args.termos.split(",") if t.strip()]
    elif args.termos_padrao:
        termos = list(TERMOS_PADRAO)
    else:
        termos = list(TERMOS_ESCOPO_COMPLETO)
    if args.todos_termos:
        termos = list(dict.fromkeys(termos + list(TERMOS_ESCOPO_COMPLETO)))
    if args.lote:
        try:
            termos = fatiar_lote(termos, args.lote)
        except ValueError as e:
            ap.error(str(e))
    # Lista maior que a padrão: 1 worker e 1 s entre chamadas (~1 req/s, o mesmo ritmo que as Edge Functions
    # usam para pncp.gov.br em private.http_host_lease), salvo PNCP_WORKERS/DELAY_SEGUNDOS explícitos.
    amplo = len(termos) > len(TERMOS_PADRAO)
    delay = float(env("DELAY_SEGUNDOS", "1.0" if amplo else "0.5"))
    workers = int(env("PNCP_WORKERS", "1" if amplo else "3"))

    sb = arm = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
        arm = Armazenamento.do_ambiente()
    # mapa CATMAT antes de qualquer gravação: na coleta real pelo próprio cliente; no dry-run por um só leitura
    ok, mapa = _mapa_catmat_ou_abortar(lambda: sb if sb is not None else _leitor_mapa_catmat_dry_run())
    if not ok:
        return 1
    if args.dias is not None or args.margem_publicacao is not None:
        log.warning("--dias/--margem-publicacao não têm mais efeito: leads = recebendo proposta "
                    "(compra homologada não é lead; decisão de 29/09/2026)")
    status = args.status or MODOS[args.modo]["status"]
    paginas = args.paginas or (20 if args.modo == "leads" else 3)
    log.info("modo=%s status=%s termos=%s lote=%s workers=%s delay=%ss", args.modo, status, len(termos),
             args.lote or "-", workers, delay)
    tam = clamp_tamanho(args.tam, padrao=50, minimo=1, maximo=TAMANHO_PAGINA_MAX)
    if tam != args.tam:
        log.info("--tam %s limitado a %s", args.tam, tam)
    r = coletar(PNCP(delay=delay), sb, arm, termos, status, paginas,
                tam, not args.sem_resultados, args.baixar_arquivos,
                int(float(env("MAX_MB", "80")) * 1048576), args.dry_run,
                modo=args.modo, workers=workers, mapa_catmat=mapa)
    drenar_licitacao_match(sb)  # recorte CATMAT por texto: zera a pendência de licitacao_match (sem efeito no dry-run)
    log.info("RESUMO: %s", r)
    if r.get("falha_busca"):
        log.error("%s busca(s) falharam: %s. Rode de novo o mesmo comando (os upserts são idempotentes).",
                  r["falha_busca"], "; ".join(r.get("termos_com_falha", [])[:10]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

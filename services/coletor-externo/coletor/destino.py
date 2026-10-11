"""Gravação no Supabase (PostgREST) e no armazenamento de arquivos (GCS ou disco local)."""
from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from pathlib import Path

import logging

import requests

from .paginacao import avaliar_pagina, contagem_exata

# PostgREST do projeto aceita até 1000, mas a leitura paginada pede no máximo 100
# (regra de 03/10/2026). SUPABASE_PAGE_SIZE acima de 100 é cortado aqui.
POSTGREST_MAX_ROWS = max(1, min(100, int(os.environ.get("SUPABASE_PAGE_SIZE", "100"))))

# Tabelas lidas pelo coletor cuja PK não é `id`. O resto (e as views com `id`) pagina em keyset por id.
# RPC (`rpc/...`) não tem `id`: fica no `order` que o chamador passou, com offset.
_PK_SEM_ID = {
    "fornecedores": "cnpj",
    "portal_visitante": "fonte",
    # PK composta (id_compra, id_item_compra): quem lê passa o order completo; aqui só evita o `,id.asc` e o keyset.
    "precos_praticados_itens": "id_compra",
}


def _pk_tabela(tabela: str) -> str | None:
    if tabela.startswith("rpc/"):
        return None
    return _PK_SEM_ID.get(tabela, "id")


def _partes_order(order: str) -> list[tuple[str, str]]:
    partes: list[tuple[str, str]] = []
    for bruto in order.split(","):
        pedaco = bruto.strip()
        if not pedaco:
            continue
        if "." in pedaco:
            coluna, direcao = pedaco.rsplit(".", 1)
            if direcao not in ("asc", "desc"):
                coluna, direcao = pedaco, "asc"
        else:
            coluna, direcao = pedaco, "asc"
        partes.append((coluna.strip(), direcao))
    return partes


def _order_efetivo(order: str | None, pk: str | None) -> str | None:
    """Sem order: PK asc. Order sem a PK `id` ganha `,id.asc` para o desempate ser estável."""
    if order is None:
        return f"{pk}.asc" if pk else None
    if pk != "id":
        return order
    partes = _partes_order(order)
    if partes == [("id", "asc")]:
        return "id.asc"
    if partes == [("id", "desc")]:
        return "id.desc"
    if any(coluna == "id" for coluna, _ in partes):
        return order
    return order.rstrip().rstrip(",") + ",id.asc"


def _select_inclui(select: str | None, coluna: str) -> bool:
    if not select or select.strip() in ("", "*"):
        return True
    for pedaco in select.split(","):
        nome = pedaco.strip().split("(")[0].strip()
        if nome == coluna or nome.endswith(f".{coluna}") or nome == "*":
            return True
    return False


def _classificar_filtro_id(filtro: str | None) -> str:
    if filtro is None:
        return "livre"
    if filtro.startswith("gt.") or filtro.startswith("gte."):
        return "faixa"
    return "outro"


def _usar_keyset(tabela: str, order: str | None, passou_offset: bool, filtro_id: str | None,
                 select: str | None) -> tuple[bool, str]:
    """Keyset só em `id` asc/desc, sem offset explícito e com `id` no select."""
    if passou_offset or _pk_tabela(tabela) != "id" or not order or not _select_inclui(select, "id"):
        return False, "asc"
    if _classificar_filtro_id(filtro_id) == "outro":
        return False, "asc"
    partes = _partes_order(order)
    if partes == [("id", "asc")]:
        return True, "asc"
    if partes == [("id", "desc")]:
        return True, "desc"
    return False, "asc"

log = logging.getLogger(__name__)

# public.licitacao_match (migration 20261002170000): texto gravado em licitacao_itens.descricao ou
# licitacoes_externas.objeto vira pendência (trigger) e é recalculado por licitacao_match_atualizar.
# O coletor drena a cada LICITACAO_MATCH_LOTE linhas de texto gravadas e no fim da execução, para a
# pendência ficar pequena (a RPC do recorte CATMAT casa o texto pendente ao vivo, o que custa CPU).
TABELAS_TEXTO_CATMAT = {"licitacao_itens": {"descricao", "licitacao_id"}, "licitacoes_externas": {"objeto"}}
LICITACAO_MATCH_LOTE = int(os.environ.get("LICITACAO_MATCH_LOTE", "300"))
LICITACAO_MATCH_MAX_LOTES = 200


class Supabase:
    """Cliente mínimo do PostgREST usando a service_role key (ignora RLS; só no backend!)."""

    def __init__(self, url: str, service_key: str):
        self.base = url.rstrip("/") + "/rest/v1"
        # Schema explícito: sem estes cabeçalhos o PostgREST usa o primeiro schema exposto no painel. Em 09/10/2026 esse
        # schema era `api` (vazio) e toda leitura/gravação dos coletores dava 404 PGRST205 ("api.<tabela>").
        self.h = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Accept-Profile": "public",
            "Content-Profile": "public",
        }
        self._textos_sem_drenar = 0

    def _contar_textos(self, tabela: str, n: int) -> None:
        """Conta linhas de texto CATMAT gravadas e drena licitacao_match ao passar de LICITACAO_MATCH_LOTE."""
        self._textos_sem_drenar += n
        if self._textos_sem_drenar >= LICITACAO_MATCH_LOTE:
            self.drenar_licitacao_match()

    def drenar_licitacao_match(self, limite: int | None = None, max_lotes: int = LICITACAO_MATCH_MAX_LOTES) -> int | None:
        """Chama public.licitacao_match_atualizar em lotes até não sobrar pendência (ou max_lotes).

        Devolve quantas pendências restam, ou None se a drenagem falhou. Falha não interrompe a coleta: a RPC do
        recorte CATMAT continua correta com pendência (casa o texto pendente ao vivo), só fica mais lenta."""
        lote = limite or LICITACAO_MATCH_LOTE
        restantes = None
        try:
            for _ in range(max_lotes):
                restantes = int(self.rpc("licitacao_match_atualizar", {"p_limite": lote}))
                if restantes <= 0:
                    break
        except (requests.RequestException, RuntimeError, TypeError, ValueError) as e:
            # Zera o contador: a próxima tentativa só depois de outras LICITACAO_MATCH_LOTE linhas (ou no fim da
            # execução), sem repetir a RPC a cada upsert. A pendência continua em licitacao_match_pendente.
            self._textos_sem_drenar = 0
            log.warning("licitacao_match: drenagem falhou (%s); a pendência fica em licitacao_match_pendente", e)
            return None
        self._textos_sem_drenar = 0
        if restantes:
            log.warning("licitacao_match: %s pendência(s) após %s lotes", restantes, max_lotes)
        return restantes

    def upsert(self, tabela: str, linhas: list[dict] | dict, conflito: str) -> list[dict]:
        r = requests.post(
            f"{self.base}/{tabela}",
            params={"on_conflict": conflito},
            json=linhas,
            headers={**self.h, "Prefer": "resolution=merge-duplicates,return=representation"},
            timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela}: {r.status_code} {r.text[:500]}")
        if tabela in TABELAS_TEXTO_CATMAT:
            self._contar_textos(tabela, len(linhas) if isinstance(linhas, list) else 1)
        return r.json()

    def atualizar(self, tabela: str, id_: int, campos: dict) -> None:
        r = requests.patch(
            f"{self.base}/{tabela}", params={"id": f"eq.{id_}"}, json=campos,
            headers={**self.h, "Prefer": "return=minimal"}, timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela}#{id_}: {r.status_code} {r.text[:500]}")
        if TABELAS_TEXTO_CATMAT.get(tabela, set()) & set(campos):
            self._contar_textos(tabela, 1)

    def atualizar_onde(self, tabela: str, filtros: dict[str, str], campos: dict) -> int:
        """PATCH pelas colunas do filtro (PostgREST, ex.: {"id_compra": "eq.X"}). Devolve quantas linhas mudaram.

        Filtro vazio é recusado (atualizaria a tabela inteira)."""
        if not filtros:
            raise ValueError(f"Supabase {tabela}: atualizar_onde sem filtro")
        r = requests.patch(
            f"{self.base}/{tabela}", params={**filtros, "select": ",".join(filtros)}, json=campos,
            headers={**self.h, "Prefer": "return=representation"}, timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {tabela} {filtros}: {r.status_code} {r.text[:500]}")
        linhas = r.json()
        if not isinstance(linhas, list):
            raise RuntimeError(f"Supabase {tabela} {filtros}: resposta inesperada ao atualizar")
        return len(linhas)

    def remover_pendentes_exceto(self, licitacao_id: int, manter_ids: list[int]) -> None:
        """Apaga linhas desta licitação que não correspondem mais a nenhum documento do
        portal (ex.: cópias por lote registradas por versões antigas do coletor).
        Não mexe em linhas já extraídas/indexadas pelo RAG."""
        params = {"licitacao_id": f"eq.{licitacao_id}",
                  "status_processamento": "in.(pendente,baixado,erro,ignorado)"}
        if manter_ids:
            params["id"] = f"not.in.({','.join(str(i) for i in manter_ids)})"
        r = requests.delete(f"{self.base}/licitacao_documentos", params=params,
                            headers={**self.h, "Prefer": "return=minimal"}, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase limpeza: {r.status_code} {r.text[:300]}")

    def remover_chunks(self, documento_id: int) -> None:
        r = requests.delete(f"{self.base}/licitacao_chunks", params={"documento_id": f"eq.{documento_id}"},
                            headers={**self.h, "Prefer": "return=minimal"}, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase chunks: {r.status_code} {r.text[:300]}")

    def rpc(self, funcao: str, params: dict) -> list[dict]:
        r = requests.post(f"{self.base}/rpc/{funcao}", json=params, headers=self.h, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase rpc {funcao}: {r.status_code} {r.text[:300]}")
        return r.json()

    @staticmethod
    def _int_param(valor) -> int | None:
        if valor in (None, ""):
            return None
        return int(valor)

    def selecionar(self, tabela: str, **filtros: str) -> list[dict]:
        """Lê a tabela em páginas de no máximo 100.

        `Prefer: count=exact` só na primeira página. O total guardado (ou uma página
        vazia) encerra. `count=planned` e `count=estimated` não param a leitura.

        Sem `order`, a paginação é keyset: `order=id.asc` e `id=gt.<último>`, sem
        offset. `order` que não inclui `id` ganha `,id.asc`. Tabela sem coluna `id`
        usa offset ordenado pela PK. `offset` explícito mantém a paginação por offset.
        """
        params_fixos = dict(filtros)
        limite_total = self._int_param(params_fixos.pop("limit", None))
        passou_offset = "offset" in params_fixos
        offset_inicial = self._int_param(params_fixos.pop("offset", None)) or 0
        order = _order_efetivo(params_fixos.pop("order", None), _pk_tabela(tabela))
        usar_keyset, direcao = _usar_keyset(
            tabela, order, passou_offset, params_fixos.get("id"), params_fixos.get("select"),
        )
        filtro_id = params_fixos.pop("id", None) if usar_keyset else None
        linhas: list[dict] = []
        anterior: list | None = None
        total: int | None = None
        avisou_sem_total = False
        cursor = None
        primeira = True
        while True:
            restante = None if limite_total is None else limite_total - len(linhas)
            if restante is not None and restante <= 0:
                return linhas
            limite_pagina = POSTGREST_MAX_ROWS if restante is None else min(POSTGREST_MAX_ROWS, restante)
            params = dict(params_fixos)
            params["limit"] = str(limite_pagina)
            if order:
                params["order"] = order
            if usar_keyset:
                if cursor is not None:
                    params["id"] = f"{'gt' if direcao == 'asc' else 'lt'}.{cursor}"
                elif filtro_id is not None:
                    params["id"] = filtro_id
            else:
                params["offset"] = str(offset_inicial + len(linhas))
            headers = dict(self.h)
            if primeira:
                headers["Prefer"] = "count=exact"
            r = requests.get(f"{self.base}/{tabela}", params=params, headers=headers, timeout=60)
            if getattr(r, "status_code", None) == 404:
                log.warning("Supabase %s: HTTP 404 ao selecionar; não é fim de coleta", tabela)
            r.raise_for_status()
            lote = r.json()
            if not isinstance(lote, list):
                raise RuntimeError(f"Supabase {tabela}: resposta inesperada ao selecionar")
            if lote and anterior is not None and lote == anterior:
                log.warning("Supabase %s: página repetida; não é fim de coleta", tabela)
                raise RuntimeError(f"Supabase {tabela}: página repetida; não é fim de coleta")
            anterior = lote
            if primeira:
                total, aviso_contagem = contagem_exata(getattr(r, "headers", None))
                if aviso_contagem:
                    log.warning("Supabase %s: %s", tabela, aviso_contagem)
                primeira = False
            linhas.extend(lote)
            if usar_keyset and lote:
                if "id" not in lote[-1]:
                    raise RuntimeError(f"Supabase {tabela}: keyset sem coluna id na linha")
                cursor = lote[-1]["id"]
            corpo = {"totalRegistros": total} if total is not None else {}
            decisao = avaliar_pagina(
                lote, tamanho=limite_pagina, pagina=1, corpo=corpo, acumulado=len(linhas),
            )
            if decisao.aviso:
                log.warning("Supabase %s: %s", tabela, decisao.aviso)
            elif total is None and lote and len(lote) < limite_pagina and not avisou_sem_total:
                log.warning(
                    "Supabase %s: página com %s itens (pedido %s) sem total exato; seguindo até página vazia",
                    tabela, len(lote), limite_pagina,
                )
                avisou_sem_total = True
            if decisao.encerrar:
                return linhas


def drenar_licitacao_match(sb) -> int | None:
    """Fim de execução de coletor: drena licitacao_match se houver cliente Supabase (nada no --dry-run)."""
    if isinstance(sb, Supabase):
        return sb.drenar_licitacao_match()
    return None


class SupabaseStorage:
    """Bucket privado do Supabase Storage (padrão do LicitaGym: os arquivos ficam dentro do SaaS).
    URI gravada no banco: supabase://<bucket>/<caminho>. O Dashboard abre por link assinado (usuário logado)."""

    def __init__(self, url: str, service_key: str, bucket: str, sessao: requests.Session | None = None):
        self.base = url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self.s = sessao or requests.Session()
        self.h = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}

    def salvar(self, caminho: str, conteudo: bytes, ctype: str) -> str:
        r = self.s.post(f"{self.base}/object/{self.bucket}/{caminho}", data=conteudo,
                        headers={**self.h, "Content-Type": ctype, "x-upsert": "true"}, timeout=(30, 300))
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase Storage {caminho}: {r.status_code} {r.text[:300]}")
        return f"supabase://{self.bucket}/{caminho}"

    def ler(self, uri: str) -> bytes:
        bucket, caminho = uri.removeprefix("supabase://").split("/", 1)
        r = self.s.get(f"{self.base}/object/{bucket}/{caminho}", headers=self.h, timeout=(30, 300))
        r.raise_for_status()
        return r.content


class Armazenamento:
    """Destino dos arquivos, nesta ordem:
    1. Supabase Storage, se SUPABASE_STORAGE_BUCKET estiver definido (padrão do LicitaGym);
    2. Google Cloud Storage, se GCS_BUCKET estiver definido;
    3. disco local ./dados (só para teste: fica fora do SaaS)."""

    def __init__(self, bucket: str | None = None, pasta_local: str = "dados", supabase: SupabaseStorage | None = None):
        self.bucket_nome = bucket
        self.pasta_local = Path(pasta_local)
        self._bucket = None
        self.supabase = supabase
        if bucket and supabase is None:
            from google.cloud import storage  # import tardio: só precisa no Cloud Run
            self._bucket = storage.Client().bucket(bucket)

    @classmethod
    def do_ambiente(cls) -> "Armazenamento":
        sb_bucket = env("SUPABASE_STORAGE_BUCKET")
        if sb_bucket:
            return cls(supabase=SupabaseStorage(env("SUPABASE_URL", obrigatorio=True),
                                                env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True), sb_bucket))
        return cls(env("GCS_BUCKET"))

    @property
    def dentro_do_saas(self) -> bool:
        return self.supabase is not None or self._bucket is not None

    @staticmethod
    def caminho(fonte: str, modulo: int, id_externo: int, secao: str, arquivo: str) -> str:
        seguro = re.sub(r"[^A-Za-z0-9._-]", "_", arquivo)
        return f"{fonte}/{modulo}/{id_externo}/{secao}/{seguro}"

    def salvar(self, caminho: str, conteudo: bytes, content_type: str | None) -> str:
        ctype = content_type or mimetypes.guess_type(caminho)[0] or "application/octet-stream"
        if self.supabase is not None:
            return self.supabase.salvar(caminho, conteudo, ctype)
        if self._bucket is not None:
            blob = self._bucket.blob(caminho)
            blob.upload_from_string(conteudo, content_type=ctype)
            return f"gs://{self.bucket_nome}/{caminho}"
        destino = self.pasta_local / caminho
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(conteudo)
        return str(destino.resolve())


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parece_html(conteudo: bytes, ctype: str | None) -> bool:
    """O portal devolve uma página HTML quando o download falha."""
    if ctype and "html" in ctype and not conteudo[:5] == b"%PDF-":
        head = conteudo[:512].lower()
        return b"<html" in head or b"<!doctype" in head
    return False


def env(nome: str, padrao: str | None = None, obrigatorio: bool = False) -> str | None:
    v = os.environ.get(nome, padrao)
    if obrigatorio and not v:
        raise SystemExit(f"Variável de ambiente obrigatória ausente: {nome}")
    return v

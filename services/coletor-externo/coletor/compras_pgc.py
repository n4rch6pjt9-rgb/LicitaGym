"""Coletor Compras.gov PGC (Plano de Contratações Anual).

Consulta:
  GET https://dadosabertos.compras.gov.br/modulo-pgc/2_consultarPgcDetalheCatalogo
    ?anoPcaProjetoCompra={ano}&tipo=Material&codigo={codigo_classe}&pagina={pagina}&tamanhoPagina={tamanhoPagina}

Filtra por classes do escopo (7830 núcleo fitness, 7220 pisos).
Grava em public.pca_pgc_itens via PostgREST (upsert idempotente).

Spec 0057: o manual v2.0 diz tipo=M/S, mas a API só aceita Material/Servico (testado em 11/11/2026). A API repete a
mesma chave do upsert em várias linhas (DFDs/artefatos), inclusive na mesma página: o lote é deduplicado antes de
gravar, ficando com a linha de dataHoraAtualizacaoItem mais recente (empate: dataHoraAtualizacaoArtefato; depois a
última lida). statusContratacaoExecucao é código opaco (sem dicionário oficial): vai como texto, nunca como booleano.
Roda no Job pelo coletor.main (--coleta pgc) ou direto (python -m coletor.compras_pgc).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
from datetime import date, datetime, timezone
from typing import Any

import requests

from .compras_api import corpo_json, erro_http
from .destino import Supabase, env
from .paginacao import TAMANHO_PAGINA_MAX, avaliar_pagina, clamp_tamanho, pagina_repetida
from .retry import espera_retry

log = logging.getLogger("coletor.compras_pgc")

BASE_URL = "https://dadosabertos.compras.gov.br"
ENDPOINT = "/modulo-pgc/2_consultarPgcDetalheCatalogo"
UA = "LicitaGym-Coletor/1.1 (pesquisa de licitacoes publicas)"

CLASSES_PADRAO = [7830, 7220]


def normalizar_registro_pgc(item: dict[str, Any], ano_contexto: int | None = None) -> dict[str, Any] | None:
    """Mapeia item retornado pela API para o schema da tabela public.pca_pgc_itens.
    Se o ano do PCA não estiver presente no item nem for fornecido no contexto,
    retorna None para não fabricar ano fictício e evitar contaminação do radar."""
    def _int(val: Any) -> int | None:
        if val in (None, ""):
            return None
        try:
            return int(val)
        except (ValueError, TypeError):
            return None

    def _num(val: Any) -> float | None:
        if val in (None, ""):
            return None
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    def _txt(val: Any) -> str | None:
        if val is None or isinstance(val, bool):
            return None
        v = str(val).strip()
        return v or None

    def _date(val: Any) -> str | None:
        if not val or not isinstance(val, str):
            return None
        v = val.strip()
        if len(v) >= 10 and v[4] == "-" and v[7] == "-":
            return v[:10]
        return None

    raw_str = json.dumps(item, sort_keys=True, ensure_ascii=False)
    p_hash = hashlib.sha256(raw_str.encode("utf-8")).hexdigest()

    orgao_cnpj = str(item.get("orgao") or "").strip()
    codigo_uasg = str(item.get("codigoUasg") or "").strip()
    ano_pca = _int(item.get("anoPcaProjetoCompra")) or ano_contexto
    if not ano_pca:
        log.warning("Item PGC ignorado: anoPcaProjetoCompra ausente e sem ano_contexto")
        return None

    num_item_pncp = _int(item.get("numeroItemPncp"))
    cod_item_cat = _int(item.get("codigoItemCatalogo"))

    return {
        "codigo_uasg": codigo_uasg,
        "nome_uasg": item.get("nomeUasg"),
        "orgao_cnpj": orgao_cnpj,
        "numero_artefato": _int(item.get("numeroArtefato")),
        "ano_artefato": _int(item.get("anoArtefato")),
        "codigo_estado_artefato": _int(item.get("codigoEstadoArtefato")),
        "codigo_categoria_artefato": _int(item.get("codigoCategoriaArtefato")),
        "descricao_artefato": item.get("descricaoArtefato"),
        "codigo_tipo_artefato": _int(item.get("codigoTipoArtefato")),
        "ordem_dfd": _int(item.get("ordemDfd")),
        "descricao_objeto_dfd": item.get("descricaoObjetoDfd"),
        "nivel_prioridade_dfd": item.get("nivelPrioridadeDfd"),
        "data_prevista_formalizacao_demanda": _date(item.get("dataPrevistaFormalizacaoDemanda")),
        "codigo_area_dfd": _int(item.get("codigoAreaDfd")),
        "tipo_item": item.get("tipoItem"),
        "item_sustentavel": item.get("itemSustentavel"),
        "codigo_grupo_material": _int(item.get("codigoGrupoMaterial")),
        "nome_grupo_material": item.get("nomeGrupoMaterial"),
        "codigo_classe_material": _int(item.get("codigoClasseMaterial")),
        "nome_classe_material": item.get("nomeClasseMaterial"),
        "codigo_pdm_material": str(item.get("codigoPdmMaterial") or "") or None,
        "nome_pdm_material": item.get("nomePdmMaterial"),
        "codigo_item_catalogo": cod_item_cat,
        "descricao_item_catalogo": item.get("descricaoItemCatalogo"),
        "sigla_unidade_fornecimento": item.get("siglaUnidadeFornecimento"),
        "nome_unidade_fornecimento": item.get("nomeUnidadeFornecimento"),
        "quantidade_item": _num(item.get("quantidadeItem")),
        "valor_unitario_item": _num(item.get("valorUnitarioItem")),
        "valor_total_item": _num(item.get("valorTotalItem")),
        "titulo_projeto_compra": item.get("tituloProjetoCompra"),
        "descricao_projeto_compra": item.get("descricaoProjetoCompra"),
        "ano_pca_projeto_compra": ano_pca,
        "data_inicio_processo_compra": _date(item.get("dataInicioProcessoCompra")),
        "data_fim_processo_compra": _date(item.get("dataFimProcessoCompra")),
        "duracao_processo_compra": _int(item.get("duracaoProcessoCompra")),
        "numero_item_pncp": num_item_pncp,
        "status_contratacao_execucao": _txt(item.get("statusContratacaoExecucao")),
        "data_hora_publicacao_pncp": item.get("dataHoraPublicacaoPncp"),
        "data_hora_atualizacao_item": item.get("dataHoraAtualizacaoItem"),
        "raw": item,
        "payload_hash": p_hash,
        "last_synced_at": datetime.now(timezone.utc).isoformat(),
    }


class ClienteComprasPGC:
    def __init__(self, delay: float = 1.0, timeout: int = 60, sessao: requests.Session | None = None):
        self.delay = max(1.0, delay)
        self.timeout = timeout
        self.s = sessao or requests.Session()
        self.s.headers.update({"User-Agent": UA, "Accept": "application/json"})

    def consultar_classe(self, classe: int, ano: int, pagina: int = 1, tamanho_pagina: int = TAMANHO_PAGINA_MAX) -> dict[str, Any]:
        url = f"{BASE_URL}{ENDPOINT}"
        params = {
            "anoPcaProjetoCompra": ano,
            "tipo": "Material",
            "codigo": classe,
            "pagina": pagina,
            "tamanhoPagina": clamp_tamanho(tamanho_pagina, padrao=TAMANHO_PAGINA_MAX, minimo=10,
                                           maximo=TAMANHO_PAGINA_MAX),
        }
        contexto = f"PGC classe {classe} ano {ano} pagina {pagina}"
        for tentativa in range(1, 4):
            try:
                time.sleep(self.delay)
                r = self.s.get(url, params=params, timeout=self.timeout)
                if r.status_code == 200:
                    return corpo_json(r, contexto)
                if r.status_code == 404:
                    log.warning("HTTP 404 em %s; não é fim de coleta", contexto)
                    raise erro_http(r, contexto)
                if 400 <= r.status_code < 500 and r.status_code != 429:
                    # erro do pedido (ex.: 400 "Parâmetro inválido"): repetir não muda a resposta
                    raise erro_http(r, contexto)
                if r.status_code in (429, 502, 503, 504):
                    if tentativa == 3:
                        raise RuntimeError(f"HTTP {r.status_code} esgotado em PGC classe {classe}")
                    espera = espera_retry(r, tentativa, base=3.0)
                    log.warning("HTTP %d em PGC classe %d (tentativa %d), esperando %.1fs...", r.status_code, classe, tentativa, espera)
                    time.sleep(espera)
                    continue
                r.raise_for_status()
            except requests.RequestException as e:
                log.warning("Falha de rede em PGC classe %d tentativa %d: %s", classe, tentativa, e)
                if tentativa == 3:
                    raise
                time.sleep(espera_retry(None, tentativa, base=2.0))
        raise RuntimeError(f"Falha ao consultar PGC classe {classe} após retries")


CONFLITO = "orgao_cnpj,codigo_uasg,ano_pca_projeto_compra,numero_item_pncp,codigo_item_catalogo"


def _chave(linha: dict[str, Any]) -> tuple | None:
    """Chave do upsert (uq_pca_pgc_item). Linha sem algum campo da chave não tem identidade: não entra."""
    k = tuple(linha.get(c) for c in CONFLITO.split(","))
    return None if any(v in (None, "") for v in k) else k


def _recencia(linha: dict[str, Any]) -> tuple[str, str]:
    raw = linha.get("raw") or {}
    return (str(raw.get("dataHoraAtualizacaoItem") or ""), str(raw.get("dataHoraAtualizacaoArtefato") or ""))


def deduplicar(linhas: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int, int]:
    """Uma linha por chave do upsert: a mais recente (item, depois artefato; empate: a última lida).

    Devolve (linhas, repetidas descartadas, sem chave descartadas)."""
    escolhidas: dict[tuple, dict[str, Any]] = {}
    sem_chave = 0
    for ln in linhas:
        k = _chave(ln)
        if k is None:
            sem_chave += 1
            continue
        atual = escolhidas.get(k)
        if atual is None or _recencia(ln) >= _recencia(atual):
            escolhidas[k] = ln
    unicas = list(escolhidas.values())
    return unicas, len(linhas) - sem_chave - len(unicas), sem_chave


LOTE_UPSERT = 500


def coletar(
    cliente: ClienteComprasPGC,
    sb: Supabase | None,
    classes: list[int],
    anos: list[int],
    limite: int | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Lê todas as páginas de cada (ano, classe), deduplica pela chave do upsert e só então grava.

    A deduplicação é por (ano, classe) inteiro, não por página: a mesma chave aparece em páginas diferentes. Classe
    com erro de leitura não grava nada (leitura parcial nunca vira gravação)."""
    total_coletados = 0
    total_gravados = 0
    repetidos = 0
    sem_chave = 0
    erros = 0
    amostras: list[dict[str, Any]] = []

    def resumo() -> dict[str, Any]:
        return {
            "sucesso": erros == 0,
            "total_coletados": total_coletados,
            "total_gravados": total_gravados,
            "repetidos_descartados": repetidos,
            "sem_chave": sem_chave,
            "erros": erros,
            "amostras": amostras,
        }

    for ano in anos:
        for classe in classes:
            pagina = 1
            paginas_vistas: set[str] = set()
            lidos = 0
            linhas_classe: list[dict[str, Any]] = []
            falhou = False
            atingiu_limite = False
            while True:
                log.info("Consultando PGC classe %d ano %d pagina %d...", classe, ano, pagina)
                try:
                    resp = cliente.consultar_classe(classe, ano, pagina=pagina, tamanho_pagina=TAMANHO_PAGINA_MAX)
                except Exception as e:
                    log.error("Erro ao buscar classe %d ano %d pagina %d: %s", classe, ano, pagina, e)
                    falhou = True
                    break

                if not isinstance(resp, dict) or not isinstance(resp.get("resultado"), list):
                    log.warning("PGC classe %d ano %d página %d: resposta inesperada; não é fim de coleta",
                                classe, ano, pagina)
                    falhou = True
                    break
                itens = resp["resultado"]
                if pagina_repetida(itens, paginas_vistas) and itens:
                    log.warning("PGC classe %d ano %d página %d: conteúdo repetido; não é fim de coleta",
                                classe, ano, pagina)
                    falhou = True
                    break

                for it in itens:
                    norm = normalizar_registro_pgc(it, ano_contexto=ano)
                    if norm and norm.get("orgao_cnpj") and norm.get("codigo_uasg"):
                        linhas_classe.append(norm)
                        total_coletados += 1
                        if len(amostras) < 5:
                            amostras.append({
                                "orgao": norm["orgao_cnpj"],
                                "uasg": norm["codigo_uasg"],
                                "item": norm["codigo_item_catalogo"],
                                "desc": (norm["descricao_item_catalogo"] or "")[:40],
                                "valor_total": norm["valor_total_item"],
                            })

                if limite and total_coletados >= limite:
                    log.info("Limite de %d itens atingido", limite)
                    atingiu_limite = True
                    break

                lidos += len(itens)
                decisao = avaliar_pagina(
                    itens, tamanho=TAMANHO_PAGINA_MAX, pagina=pagina, corpo=resp, acumulado=lidos,
                )
                if decisao.aviso:
                    log.warning("PGC classe %d ano %d página %d: %s", classe, ano, pagina, decisao.aviso)
                if decisao.encerrar:
                    break
                pagina += 1

            if falhou:
                erros += 1
                log.error("PGC classe %d ano %d: leitura incompleta; nada gravado desta classe", classe, ano)
                continue

            unicas, rep, sc = deduplicar(linhas_classe)
            repetidos += rep
            sem_chave += sc
            if sc:
                log.warning("PGC classe %d ano %d: %d linha(s) sem chave completa (não gravadas)", classe, ano, sc)
            if not dry_run and sb is not None:
                for k in range(0, len(unicas), LOTE_UPSERT):
                    lote = unicas[k:k + LOTE_UPSERT]
                    try:
                        sb.upsert("pca_pgc_itens", lote, conflito=CONFLITO)
                        total_gravados += len(lote)
                    except Exception as e:
                        log.error("Erro no upsert de %d linhas PGC: %s", len(lote), e)
                        erros += 1
            log.info("PGC classe %d ano %d: %d lidas, %d únicas, %d repetidas, %d sem chave",
                     classe, ano, len(linhas_classe), len(unicas), rep, sc)
            if atingiu_limite:
                return resumo()

    return resumo()


def anos_padrao(hoje: date) -> list[int]:
    """Ano corrente e o seguinte: o PCA do ano seguinte é montado no PGC antes de ir ao PNCP."""
    return [hoje.year, hoje.year + 1]


def executar(argv: list[str] | None = None, hoje: date | None = None,
             sessao: requests.Session | None = None) -> int:
    """Entrada do Job (coletor.main --coleta pgc) e do módulo. Código 1 se qualquer classe falhar."""
    ap = argparse.ArgumentParser(description="Coletor Compras.gov PGC (PCA por classe)")
    ap.add_argument("--classes", help="Classes separadas por vírgula (padrão: 7830,7220)", default="7830,7220")
    ap.add_argument("--anos", help="Anos do PCA separados por vírgula (padrão: ano atual e seguinte)", default=None)
    ap.add_argument("--limite", type=int, help="Teto de itens a processar")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay mínimo em segundos entre requisições (mínimo 1.0)")
    ap.add_argument("--dry-run", action="store_true", help="Não grava no banco; mostra resumo e amostras")
    args = ap.parse_args(argv)

    classes = [int(c.strip()) for c in args.classes.split(",") if c.strip()]
    if args.anos:
        anos = [int(a.strip()) for a in args.anos.split(",") if a.strip()]
    else:
        anos = anos_padrao(hoje or datetime.now(timezone.utc).date())

    cliente = ClienteComprasPGC(delay=args.delay, sessao=sessao)
    sb = None
    if not args.dry_run:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))

    res = coletar(cliente, sb, classes, anos, limite=args.limite, dry_run=args.dry_run)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res["sucesso"] else 1


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    return executar(argv)


if __name__ == "__main__":
    sys.exit(main())

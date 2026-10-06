"""Reclassifica o escopo (categoria_escopo, interesse_borracha) e a prioridade das compras PNCP já gravadas em
licitacoes_externas com o classificador atual (coletor.escopo / coletor.pncp.avaliar).

Motivo (30/09/2026): na rodada de produção da noite, "puxador" contava como aparelho de academia ("forte") e
284 dos 507 leads gravados eram puxador de porta/gaveta/armário. Na mesma correção o escopo passou a deixar fora
serviço de pessoas sem material (credenciamento de oficineiros/instrutores, aulas, vagas em academia; ex.: id 229)
e academia ao ar livre/ATI (só entra pelo piso). O coletor só regrava compras que reencontra e classifica no
escopo; compra que passou a ficar FORA nunca é tocada pela recoleta. Este script corrige o retrato.

Fonte dos itens: licitacao_itens gravados; sem itens gravados (na rodada de 30/09 nenhum item foi gravado por
causa do CHECK licitem_ms_chk), só com --consultar-pncp (GET público em /itens, só leitura). Sem itens, a linha
só é reavaliada se o objeto sozinho confirmar a categoria gravada; senão conta como sem_itens e não mexe
(a categoria gravada pode ter vindo de um item que o objeto não cita).

Prioridade: recalculada pelo estado gravado + itens (coletor.pncp.motivo_prioridade), com as travas do
backfill_prioridade_pncp: sem o detalhe do PNCP não sai de historico e nunca promove a leads (fail-closed).
Compra que sai do escopo: categoria_escopo=NULL, interesse_borracha=false e prioridade=NULL (sai de
Oportunidades/leads sem apagar a linha nem os itens/documentos; nada é deletado).

Fase (02/10/2026): licitacoes_externas.fase recebe a fase real (coletor.pncp.fase_da_compra): homologação,
revogação/anulação e suspensão publicadas só como documento da compra (licitacao_documentos gravados; documento
de contrato/ata não conta), prazo implausível (2604, 9999 -> monitorar, nunca leads) e, com --consultar-detalhe,
compra excluída do PNCP (detalhe HTTP 410 -> historico). `situacao` continua a oficial do PNCP. A fase só é
gravada quando a prioridade nova passa pelas travas (senão ficaria rótulo de uma prioridade que não foi gravada).
Com --consultar-detalhe (GET público no detalhe e em /arquivos, só das linhas leads/monitorar no escopo) o estado do
detalhe entra na conta e as travas "sem detalhe" deixam de valer, como no coletor; a fase usa a lista ATUAL de
documentos (só ativos) e, se /arquivos falhar, o detalhe da linha é descartado. Sem o detalhe valem os documentos
gravados que não estão marcados como removidos (removido_do_portal_em; o coletor marca a cada recoleta). 410
confirmado vai para historico mesmo sem itens reavaliáveis. Lead só é gravado se o prazo que a view lê
(raw.data_fim_vigencia, senão data_fim) estiver aberto: o reclassificador não regrava o prazo (PR #134, review).

Padrão: DRY-RUN (só SELECT; o cliente do Supabase fica embrulhado em modo somente leitura). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp                       # dry-run, todas as PNCP
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp --id-min 50 --id-max 556 --termo puxador
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp --apply               # grava
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp --consultar-detalhe   # + 410/estado do detalhe

Forte ancorado (03/10/2026, modo núcleo; pncp.forte_ancorado): o mapa CATMAT traz as âncoras do catálogo
(itens de catmat_itens_mapa(), 100 por página). Dry-run OFFLINE, sem tocar no banco: o bot LicitaGym Supabase roda o SQL de
export (RECLASSIFICAR-FORTE-EXPORT.sql) e devolve os CSVs (coletor/entrada_arquivos.py); daí
  python -m coletor.reclassificar_escopo_pncp --entrada-dir DIR --sql-backup backup.sql --mudancas-csv mud.csv \\
         --json linhas.json
--entrada-dir implica --so-escopo (prioridade e fase não são recalculadas) e não aceita --apply.
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone

from .catmat_codigo import MapaCatmat, MapaCatmatIndisponivel, carregar_mapa_catmat_se_houver_banco
from .destino import Supabase, env
from .entrada_arquivos import ClienteArquivos
from .escopo import classificar, excluir_compra, objeto_passagem, servico_sem_material
from .pncp import (FASE_EXCLUIDA, PNCP, CompraExcluida, _instante, atualizacao_da_compra, avaliar, compra_com_detalhe,
                   compra_de_codigo, consultar_detalhe, fase_da_compra)

log = logging.getLogger("coletor.reclassificar_escopo_pncp")

# Os itens NÃO vêm embutidos no SELECT das compras: o PostgREST corta o recurso embutido em max-rows (1000) e as
# compras com mais itens (#794: 2668, #799: 5357 em 01/10/2026) eram reavaliadas só pelos 1000 primeiros.
# Os itens são lidos à parte, paginados (Supabase.selecionar pagina por offset), em lotes de compras.
SELECT = ("id,codigo_externo,objeto,categoria_escopo,interesse_borracha,prioridade,situacao,fase,data_homologacao,"
          "data_fim,termos_busca,created_at,raw")
# material_ou_servico entra para a regra de item de serviço ('S') de pncp.avaliar valer na reclassificação também.
# catalogo_codigo_item/catalogo_id: código CATMAT antes do texto (pncp.avaliar com mapa_catmat; 03/10/2026).
SELECT_ITENS = ("id,licitacao_id,numero_item,descricao,material_ou_servico,situacao,tem_resultado,categoria_escopo,"
                "interesse_borracha,catalogo_codigo_item,catalogo_id")
LOTE_COMPRAS_ITENS = 50
# removido_do_portal_em: documento que o PNCP inativou ou tirou de /arquivos (marcado pelo coletor a cada recoleta;
# antes do PR #134 nenhuma linha PNCP era marcada). Removido não decide a fase (statusAtivo=False no detector).
SELECT_DOCUMENTOS = "licitacao_id,nome_original,data_documento,raw,removido_do_portal_em"


class SomenteLeitura:
    """Embrulha o cliente do Supabase no dry-run: só selecionar passa; qualquer escrita levanta."""

    def __init__(self, sb):
        self._sb = sb

    def selecionar(self, tabela: str, **filtros):
        return self._sb.selecionar(tabela, **filtros)

    def __getattr__(self, nome):
        raise PermissionError(f"dry-run: {nome} bloqueado (cliente somente leitura)")


def _compra(ln: dict) -> dict:
    raw = ln.get("raw") if isinstance(ln.get("raw"), dict) else {}
    return {"description": ln.get("objeto") or raw.get("description") or "", "title": raw.get("title")}


def carregar_itens(sb, linhas: list[dict], lote: int = LOTE_COMPRAS_ITENS) -> int:
    """Preenche ln["licitacao_itens"] com TODOS os itens gravados de cada compra (sem o corte de 1000 do embutido).
    Retorna o total de itens lidos."""
    por_compra: dict[int, list[dict]] = {ln["id"]: [] for ln in linhas}
    ids = list(por_compra)
    total = 0
    for i in range(0, len(ids), lote):
        bloco = ids[i:i + lote]
        itens = sb.selecionar("licitacao_itens", select=SELECT_ITENS,
                              licitacao_id="in.(" + ",".join(str(x) for x in bloco) + ")",
                              order="licitacao_id,numero_item,id")
        for it in itens:
            if it.get("licitacao_id") in por_compra:
                por_compra[it["licitacao_id"]].append(it)
                total += 1
    for ln in linhas:
        ln["licitacao_itens"] = por_compra[ln["id"]]
    return total


def carregar_documentos(sb, linhas: list[dict], lote: int = LOTE_COMPRAS_ITENS) -> int:
    """Preenche ln["_documentos"] com os documentos gravados da compra (só título, tipo, data e se ainda está
    ativo: o sinal de fase vem do nome). data_documento foi gravado com o horário de Brasília rotulado como UTC
    (pncp._data), então o fuso é descartado e a data volta a ser lida como Brasília, igual a data_atualizacao_pncp.
    Limitação: removido_do_portal_em só é marcado quando o coletor recoleta a compra; documento inativado depois da
    última recoleta ainda conta aqui. Com --consultar-detalhe vale a lista ao vivo de /arquivos (só ativos)."""
    por_compra: dict[int, list[dict]] = {ln["id"]: [] for ln in linhas}
    ids = list(por_compra)
    total = 0
    for i in range(0, len(ids), lote):
        bloco = ids[i:i + lote]
        docs = sb.selecionar("licitacao_documentos", select=SELECT_DOCUMENTOS,
                             licitacao_id="in.(" + ",".join(str(x) for x in bloco) + ")", order="licitacao_id,id")
        for d in docs:
            if d.get("licitacao_id") in por_compra:
                raw = d.get("raw") if isinstance(d.get("raw"), dict) else {}
                por_compra[d["licitacao_id"]].append({
                    "nome_original": d.get("nome_original"), "tipo_documento": raw.get("tipo_documento"),
                    "data_documento": str(d["data_documento"])[:19] if d.get("data_documento") else None,
                    "statusAtivo": not d.get("removido_do_portal_em")})
                total += 1
    for ln in linhas:
        ln["_documentos"] = por_compra[ln["id"]]
    return total


def _itens_gravados(ln: dict) -> list[dict]:
    return [{"numeroItem": it["numero_item"], "descricao": it.get("descricao"), "situacao": it.get("situacao"),
             "materialOuServico": it.get("material_ou_servico"),
             "catalogoCodigoItem": it.get("catalogo_codigo_item"), "catalogoId": it.get("catalogo_id"),
             "tem_resultado": it.get("tem_resultado"), "_id": it.get("id"),
             "_categoria": it.get("categoria_escopo"), "_interesse": it.get("interesse_borracha")}
            for it in (ln.get("licitacao_itens") or [])]


def _nova_prioridade(ln: dict, itens: list[dict] | None, agora: datetime, det: dict | None = None,
                     excluida: bool = False) -> tuple[str | None, str, str | None, str | None]:
    """(prioridade a gravar ou None = não mexe, motivo, trava aplicada, fase a gravar ou None = não mexe).
    Sem o detalhe: nunca sai de historico nem promove a leads (fail-closed). Com o detalhe (--consultar-detalhe),
    como no coletor, o estado do detalhe vence e as travas não se aplicam."""
    atual = ln.get("prioridade")
    base = {k: v for k, v in ln.items() if k not in ("prioridade", "fase", "licitacao_itens", "_documentos")}
    raw = ln.get("raw") if isinstance(ln.get("raw"), dict) else {}
    fase, nova, motivo = fase_da_compra(
        compra_com_detalhe(base, det), agora=agora, itens=itens or None, documentos=ln.get("_documentos"),
        retificada_em=atualizacao_da_compra(det, raw), excluida=excluida)
    if nova is None:
        return None, motivo, "indeterminada", None
    if det is None and not excluida:
        if atual == "historico" and nova != "historico":
            return None, motivo, "historico_mantido_sem_detalhe", None
        if nova == "leads" and atual != "leads":
            return None, motivo, "leads_sem_detalhe", None
    # leads só com o prazo que a view lê (raw.data_fim_vigencia em BRT, senão data_fim) ainda aberto: a view
    # licitacoes_externas_prioridade_efetiva rebaixa leads de prazo vencido para monitorar, então o prazo futuro do
    # detalhe sozinho gravaria um lead que o dashboard nunca mostra (e a fase "Recebendo propostas" num monitorar).
    # O reclassificador não regrava o prazo; a recoleta do coletor atualiza raw/data_fim e promove (Copilot, PR #134).
    if nova == "leads":
        prazo_view = _instante(raw.get("data_fim_vigencia")) or _instante(ln.get("data_fim"))
        if prazo_view is not None and prazo_view <= agora:
            return None, motivo, "leads_prazo_gravado_vencido", None
    fase_nova = fase if fase is not None and fase != ln.get("fase") else None
    return (nova if nova != atual else None), motivo, None, fase_nova


def reavaliar(ln: dict, itens_pncp: list[dict] | None, agora: datetime, det: dict | None = None,
              excluida: bool = False, mapa_catmat: MapaCatmat | None = None, so_escopo: bool = False,
              so_regra_nova: bool = False) -> dict:
    """Resultado para UMA linha: {status, categoria, interesse, prioridade, campos, itens_campos, ...}.
    status: sem_itens | sem_mudanca | sai_do_escopo | muda | divergencia_previa.
    Com as âncoras ligadas, `categoria_regra_antiga` é o mesmo cálculo sem elas e `causa` diz por que a categoria
    gravada mudaria: "regra_nova" (sem as âncoras ficaria a gravada) ou "divergencia_previa" (sem as âncoras já
    mudaria: gravado velho, de uma versão anterior do classificador). `so_regra_nova`: linha com divergência prévia
    não é tocada (status divergencia_previa, nada a gravar, nem nos itens), para esta reclassificação só aplicar o
    efeito da regra nova.
    `so_escopo`: só categoria_escopo/interesse_borracha (compra e itens); prioridade e fase não são recalculadas
    (compra que sai do escopo continua indo para prioridade NULL, como sempre). `ancoras`/`vetos` na saída: âncora
    do catálogo que deu "forte" a cada item e lista fixa que vetou (regra do forte ancorado, pncp.forte_ancorado)."""
    atual_cat, atual_ib, atual_prio = ln.get("categoria_escopo"), bool(ln.get("interesse_borracha")), ln.get("prioridade")
    gravados = _itens_gravados(ln)
    itens = gravados or itens_pncp
    compra = _compra(ln)
    out = {"id": ln["id"], "codigo_externo": ln.get("codigo_externo"), "objeto": (compra["description"] or "")[:160],
           "termos_busca": ln.get("termos_busca") or [], "created_at": ln.get("created_at"),
           "categoria_antes": atual_cat, "interesse_antes": atual_ib, "prioridade_antes": atual_prio,
           "fonte_itens": "gravados" if gravados else ("pncp" if itens_pncp is not None else None),
           "n_itens": len(itens or []), "campos": {}, "itens_campos": []}
    if itens is None:
        if not objeto_decide(ln):
            if excluida:   # 410 confirmado não depende dos itens (Copilot/Codex, PR #134)
                return _so_exclusao(ln, out)
            out.update(status="sem_itens", categoria_depois=atual_cat, motivo="sem itens gravados nem consulta ao PNCP")
            return out
        out["fonte_itens"] = "objeto"
        cat, ib, _ = avaliar(compra, [], mapa_catmat)
        if cat is not None:
            # objeto confirma a categoria gravada; interesse fica o gravado. Forte ancorado: sem item não há âncora,
            # e o "forte" que só o objeto dava cai para "fraco" (pncp.avaliar)
            rebaixa = cat == "fraco" and atual_cat == "forte" and getattr(mapa_catmat, "ancoras", None) is not None
            cat, ib = ("fraco" if rebaixa else atual_cat), atual_ib
        por_item = {}
    else:
        motivos: dict = {}
        cat, ib, por_item = avaliar(compra, itens, mapa_catmat, motivos=motivos)
        out["motivos_itens"] = motivos
        out["ancoras"] = sorted({f"{m['pdm']}:{m['ancora']}" for n, m in motivos.items()
                                 if m["ancora"] and not m["veto"] and por_item.get(n, (None,))[0] == "forte"})
        out["vetos"] = sorted({f"{m['veto']}:{m['ancora']}" for m in motivos.values() if m["veto"]})
    if getattr(mapa_catmat, "ancoras", None) is not None:
        sem_ancoras = replace(mapa_catmat, ancoras=None)
        if itens is None:
            antiga = avaliar(compra, [], sem_ancoras)[0]
            antiga = atual_cat if antiga is not None else None
        else:
            antiga = avaliar(compra, itens, sem_ancoras)[0]
        out["categoria_regra_antiga"] = antiga
        out["causa"] = None if cat == atual_cat else ("regra_nova" if antiga == atual_cat else "divergencia_previa")
        if so_regra_nova and out["causa"] == "divergencia_previa":
            out.update(status="divergencia_previa", categoria_depois=atual_cat, categoria_calculada=cat,
                       interesse_depois=atual_ib, prioridade_depois=atual_prio,
                       motivo=f"sem a regra nova o classificador já dá {antiga or 'NULL'} (gravado {atual_cat or 'NULL'}):"
                              " gravado velho, fora desta reclassificação (--so-regra-nova)")
            return out
    out["categoria_depois"], out["interesse_depois"] = cat, ib
    # itens gravados cuja categoria/interesse mudaria
    for it in gravados:
        c_it, b_it = por_item.get(it["numeroItem"], (None, False))
        mud = {}
        if c_it != it["_categoria"]:
            mud["categoria_escopo"] = c_it
        if bool(b_it) != bool(it["_interesse"]):
            mud["interesse_borracha"] = bool(b_it)
        if mud and it["_id"] is not None:
            out["itens_campos"].append((it["_id"], mud))
            out.setdefault("itens_detalhe", []).append({
                "id": it["_id"], "numero_item": it["numeroItem"], "descricao": (it.get("descricao") or "")[:160],
                "antes": {"categoria_escopo": it["_categoria"], "interesse_borracha": it["_interesse"]},
                "depois": mud})
    if cat is None:
        alvo = {"categoria_escopo": None, "interesse_borracha": False, "prioridade": None}
        atual = {"categoria_escopo": atual_cat, "interesse_borracha": atual_ib, "prioridade": atual_prio}
        out["campos"] = {k: v for k, v in alvo.items() if atual[k] != v}
        out["status"] = "sai_do_escopo" if atual_cat is not None else (
            "muda" if out["campos"] or out["itens_campos"] else "sem_mudanca")
        out["prioridade_depois"] = None
        out["motivo"] = "fora do escopo com o classificador atual"
        return out
    campos = {}
    if cat != atual_cat:
        campos["categoria_escopo"] = cat
    if bool(ib) != atual_ib:
        campos["interesse_borracha"] = bool(ib)
    if so_escopo:
        prio, motivo, trava, fase = None, "só escopo (prioridade e fase não recalculadas)", None, None
    else:
        prio, motivo, trava, fase = _nova_prioridade(ln, itens, agora, det, excluida)
    if prio is not None:
        campos["prioridade"] = prio
    if fase is not None:
        campos["fase"] = fase
    out.update(prioridade_depois=prio or atual_prio, motivo=motivo, trava_prioridade=trava, campos=campos,
               fase_antes=ln.get("fase"), fase_depois=fase or ln.get("fase"),
               status="muda" if campos or out["itens_campos"] else "sem_mudanca")
    return out


def _so_exclusao(ln: dict, out: dict) -> dict:
    """Compra excluída do PNCP (detalhe HTTP 410 confirmado) cujos itens não dá para reavaliar (sem itens gravados
    e objeto que não decide, ou consulta de itens que falhou): grava historico/"Excluída do PNCP" e mantém a
    classificação de escopo gravada (categoria/interesse não são reavaliados)."""
    campos = {}
    if ln.get("prioridade") != "historico":
        campos["prioridade"] = "historico"
    if ln.get("fase") != FASE_EXCLUIDA:
        campos["fase"] = FASE_EXCLUIDA
    out.update(status="muda" if campos else "sem_mudanca", campos=campos,
               categoria_depois=ln.get("categoria_escopo"), interesse_depois=bool(ln.get("interesse_borracha")),
               prioridade_depois="historico", motivo="compra excluída do PNCP (HTTP 410); itens não reavaliados",
               trava_prioridade=None, fase_antes=ln.get("fase"), fase_depois=FASE_EXCLUIDA)
    return out


def objeto_decide(ln: dict) -> bool:
    """True quando o objeto sozinho já decide a categoria nova sem consultar os itens:
    - a compra inteira fica fora (exclusão ou serviço de pessoas sem material), ou
    - o objeto, com o classificador atual, dá a mesma categoria gravada. As regras novas só restringem
      (puxador, cross over, SBR/EPDM, serviço, academia ao ar livre): a categoria nova fica entre a do objeto e a
      gravada (que já era o máximo de objeto + itens), então as duas iguais fecham a conta.
    Sem consultar os itens a linha também não muda interesse_borracha (fica o gravado).
    Exceção (02/10/2026): forte em compra de passagem (móveis, brinquedos, expediente, hospitalar) depende de haver
    item core, então o objeto sozinho não decide; o puxador como acessório (regra que amplia) também só vem dos itens."""
    objeto = _compra(ln)["description"]
    if excluir_compra(objeto) or servico_sem_material(objeto):
        return True
    if ln.get("categoria_escopo") == "forte" and objeto_passagem(objeto):
        return False
    if ln.get("categoria_escopo") == "fraco":
        return False
    return ln.get("categoria_escopo") is not None and classificar(objeto) == ln.get("categoria_escopo")


def _buscar_itens(pncp, ln: dict) -> tuple[list[dict] | None, str | None]:
    c = compra_de_codigo(ln.get("codigo_externo"))
    if not c:
        return None, f"codigo_externo inválido: {ln.get('codigo_externo')!r}"
    try:
        return pncp.itens(c), None
    except Exception as e:  # falha de consulta: não mexe na linha
        return None, str(e)[:160]


def _buscar_detalhe(pncp, ln: dict) -> tuple[dict | None, bool, str | None]:
    """(detalhe, excluída do PNCP, erro). Falha comum: (None, False, erro) e a linha segue sem o detalhe."""
    c = compra_de_codigo(ln.get("codigo_externo"))
    if not c:
        return None, False, f"codigo_externo inválido: {ln.get('codigo_externo')!r}"
    try:
        return consultar_detalhe(pncp, c), False, None
    except CompraExcluida as e:
        return None, True, None
    except Exception as e:  # ConsultaFalhou: segue com as travas de "sem detalhe"
        return None, False, str(e)[:160]


def _buscar_arquivos(pncp, ln: dict) -> tuple[list[dict] | None, str | None]:
    """Lista ATUAL de documentos da compra em /arquivos (GET público). Só os ativos decidem a fase."""
    c = compra_de_codigo(ln.get("codigo_externo"))
    if not c:
        return None, f"codigo_externo inválido: {ln.get('codigo_externo')!r}"
    try:
        arquivos = pncp.arquivos(c)
    except Exception as e:
        return None, str(e)[:160]
    if not isinstance(arquivos, list):
        return None, "resposta inesperada de /arquivos"
    return [{"titulo": a.get("titulo"), "tipoDocumentoNome": a.get("tipoDocumentoNome"),
             "dataPublicacaoPncp": a.get("dataPublicacaoPncp"), "statusAtivo": a.get("statusAtivo", True)}
            for a in arquivos], None


def _filtros(id_min, id_max, desde, termo, limite) -> dict:
    f = {"select": SELECT, "fonte": "eq.pncp", "order": "id"}
    ids = [f"gte.{id_min}"] if id_min is not None else []
    if id_max is not None:
        ids.append(f"lte.{id_max}")
    if len(ids) == 2:
        f["and"] = f"(id.{ids[0]},id.{ids[1]})"
    elif ids:
        f["id"] = ids[0]
    if desde:
        f["created_at"] = f"gte.{desde}"
    if termo:
        f["termos_busca"] = "cs.{" + json.dumps(termo, ensure_ascii=False) + "}"
    if limite:
        f["limit"] = str(limite)
    return f


def reclassificar(sb, pncp=None, *, aplicar: bool = False, consultar_pncp: bool = False,
                  consultar_detalhe_pncp: bool = False, id_min: int | None = None,
                  id_max: int | None = None, desde: str | None = None, termo: str | None = None,
                  limite: int | None = None, amostra: int = 5, agora: datetime | None = None,
                  workers: int = 1, cache_itens: dict | None = None, salvar_cache=None,
                  mapa_catmat: MapaCatmat | None = None, so_escopo: bool = False,
                  so_regra_nova: bool = False) -> dict:
    """Resumo da reclassificação; em dry-run (aplicar=False) nunca grava (sb deve ser SomenteLeitura).
    `cache_itens`: codigo_externo -> itens do PNCP já consultados (lido antes e completado com as consultas novas).
    `mapa_catmat`: código CATMAT antes do texto, como no coletor (None = só texto)."""
    agora = agora or datetime.now(timezone.utc)
    linhas = sb.selecionar("licitacoes_externas", **_filtros(id_min, id_max, desde, termo, limite))
    n_itens = carregar_itens(sb, linhas)
    if so_escopo:   # prioridade/fase não são recalculadas: os documentos não entram
        for ln in linhas:
            ln["_documentos"] = []
        n_docs = 0
    else:
        n_docs = carregar_documentos(sb, linhas)
    log.info("%d compra(s), %d item(ns) e %d documento(s) gravado(s) lidos", len(linhas), n_itens, n_docs)
    r = {"lidas": len(linhas), "itens_lidos": n_itens, "itens_gravados": 0, "itens_pncp": 0, "decididas_pelo_objeto": 0, "falha_consulta": 0, "sem_itens": 0,
         "sem_mudanca": 0, "divergencia_previa": 0, "sai_do_escopo": 0, "sai_dos_leads": 0, "muda": 0, "muda_categoria": 0,
         "muda_interesse": 0, "muda_prioridade": 0, "itens_mudariam": 0, "gravadas": 0,
         "muda_fase": 0, "transicoes_fase": {}, "excluidas_do_pncp": 0, "falha_detalhe": 0, "detalhes_consultados": 0,
         "arquivos_consultados": 0, "falha_arquivos": 0, "documentos_ao_vivo": 0,
         "trava_prioridade": {}, "transicoes_categoria": {}, "transicoes_prioridade": {},
         "sai_do_escopo_por_categoria": {}, "amostra": {}, "linhas": []}

    precisa = [ln for ln in linhas if consultar_pncp and pncp is not None and not ln.get("licitacao_itens")
               and not objeto_decide(ln)]
    itens_pncp: dict[int, tuple[list[dict] | None, str | None]] = {}
    if cache_itens is not None:
        for ln in list(precisa):
            if ln.get("codigo_externo") in cache_itens:
                itens_pncp[ln["id"]] = (cache_itens[ln["codigo_externo"]], None)
                precisa.remove(ln)
    if precisa:
        log.info("consultando itens no PNCP de %d compra(s) sem itens gravados", len(precisa))
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            for n, (ln, res) in enumerate(zip(precisa, ex.map(lambda ln: _buscar_itens(pncp, ln), precisa)), 1):
                itens_pncp[ln["id"]] = res
                if n % 25 == 0 or n == len(precisa):
                    log.info("  itens do PNCP: %d/%d compras", n, len(precisa))
                if cache_itens is not None and res[1] is None:
                    cache_itens[ln["codigo_externo"]] = res[0]
                if salvar_cache and n % 10 == 0:
                    salvar_cache(cache_itens)

    # Detalhe só das linhas que hoje aparecem em Oportunidades (leads/monitorar) e seguem no escopo: é onde
    # um 410 ou o estado do detalhe muda o que o Marcelo vê. ~1 req/s; o PNCP devolve 429 em rajada.
    detalhes: dict[int, tuple[dict | None, bool, str | None]] = {}
    if consultar_detalhe_pncp and pncp is not None:
        alvo = [ln for ln in linhas if ln.get("prioridade") in ("leads", "monitorar") and ln.get("categoria_escopo")]
        log.info("consultando o detalhe no PNCP de %d compra(s) leads/monitorar", len(alvo))
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            for ln, res in zip(alvo, ex.map(lambda ln: _buscar_detalhe(pncp, ln), alvo)):
                detalhes[ln["id"]] = res
                r["detalhes_consultados"] += 1
                if res[1]:
                    r["excluidas_do_pncp"] += 1
                elif res[2] is not None:
                    r["falha_detalhe"] += 1
        # Documentos ao vivo (Copilot/Codex, PR #134): os gravados não dizem se o órgão retirou o termo depois da
        # última recoleta. Com o detalhe, a fase só usa a lista atual de /arquivos (só ativos). Se /arquivos falhar,
        # o detalhe dessa linha é descartado (valem os documentos gravados e as travas de "sem detalhe"). 410 já
        # decide sem documento.
        alvo_arq = [ln for ln in alvo if not detalhes[ln["id"]][1]]
        with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
            for ln, (arqs, erro_arq) in zip(alvo_arq, ex.map(lambda ln: _buscar_arquivos(pncp, ln), alvo_arq)):
                r["arquivos_consultados"] += 1
                if erro_arq is not None:
                    r["falha_arquivos"] += 1
                    log.warning("  #%s %s: /arquivos indisponível, segue sem o detalhe: %s", ln["id"],
                                ln.get("codigo_externo"), erro_arq)
                    detalhes[ln["id"]] = (None, False, erro_arq)
                    continue
                ln["_documentos"] = arqs
                r["documentos_ao_vivo"] += 1

    for ln in linhas:
        ip = None
        if ln["id"] in itens_pncp:
            ip, erro = itens_pncp[ln["id"]]
            if erro is not None:
                r["falha_consulta"] += 1
                if not detalhes.get(ln["id"], (None, False, None))[1]:
                    log.warning("  #%s %s: itens do PNCP indisponíveis, não mexe: %s", ln["id"],
                                ln.get("codigo_externo"), erro)
                    r["linhas"].append({"id": ln["id"], "codigo_externo": ln.get("codigo_externo"),
                                        "status": "falha_consulta", "erro": erro,
                                        "categoria_antes": ln.get("categoria_escopo"),
                                        "termos_busca": ln.get("termos_busca") or []})
                    continue
                # 410 confirmado: a exclusão vale mesmo sem os itens (reavaliar -> _so_exclusao)
                ip = None
            else:
                r["itens_pncp"] += 1
        elif ln.get("licitacao_itens"):
            r["itens_gravados"] += 1
        det, excluida, _ = detalhes.get(ln["id"], (None, False, None))
        res = reavaliar(ln, ip, agora, det, excluida, mapa_catmat, so_escopo, so_regra_nova)
        if res.get("fonte_itens") == "objeto":
            r["decididas_pelo_objeto"] += 1
        r["linhas"].append(res)
        st = res["status"]
        r[st] += 1
        if res.get("trava_prioridade"):
            r["trava_prioridade"][res["trava_prioridade"]] = r["trava_prioridade"].get(res["trava_prioridade"], 0) + 1
        if st in ("sem_itens", "sem_mudanca", "divergencia_previa"):
            continue
        campos = res["campos"]
        if st == "sai_do_escopo":
            k = res["categoria_antes"] or "NULL"
            r["sai_do_escopo_por_categoria"][k] = r["sai_do_escopo_por_categoria"].get(k, 0) + 1
            if res["prioridade_antes"] == "leads":
                r["sai_dos_leads"] += 1
        if "categoria_escopo" in campos:
            r["muda_categoria"] += 1
            k = f"{res['categoria_antes'] or 'NULL'}->{campos['categoria_escopo'] or 'NULL'}"
            r["transicoes_categoria"][k] = r["transicoes_categoria"].get(k, 0) + 1
            ex_ = r["amostra"].setdefault(k, [])
            if len(ex_) < amostra:
                ex_.append((res["id"], res["codigo_externo"], res["objeto"][:90]))
        if "interesse_borracha" in campos:
            r["muda_interesse"] += 1
        if "fase" in campos:
            r["muda_fase"] += 1
            k = f"{res.get('fase_antes') or 'NULL'}->{campos['fase']}"
            r["transicoes_fase"][k] = r["transicoes_fase"].get(k, 0) + 1
        if "prioridade" in campos:
            r["muda_prioridade"] += 1
            k = f"{res['prioridade_antes'] or 'NULL'}->{campos['prioridade'] or 'NULL'}"
            r["transicoes_prioridade"][k] = r["transicoes_prioridade"].get(k, 0) + 1
        r["itens_mudariam"] += len(res["itens_campos"])
        if aplicar:
            try:
                if campos:
                    sb.atualizar("licitacoes_externas", res["id"], campos)
                for item_id, mud in res["itens_campos"]:
                    sb.atualizar("licitacao_itens", item_id, mud)
            except RuntimeError as e:
                if " 401 " in str(e) or " 403 " in str(e):
                    raise SystemExit("Supabase recusou a chave (401/403). Confira SUPABASE_SERVICE_ROLE_KEY.")
                raise
            r["gravadas"] += 1
    return r


_CAMPOS_COMPRA = ("categoria_escopo", "interesse_borracha", "prioridade", "fase")
_CAMPOS_ITEM = ("categoria_escopo", "interesse_borracha")


def _sql_literal(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def _ids_sql(ids: list[int], por_linha: int = 20) -> str:
    return ",\n    ".join(", ".join(str(x) for x in ids[i:i + por_linha]) for i in range(0, len(ids), por_linha))


def sql_backup(linhas: list[dict], gerado_em: str) -> str:
    """SQL de backup das linhas que MUDARIAM (dry-run). Parte 1: SELECT só leitura dos valores atuais, para o bot
    rodar e guardar ANTES do --apply. Parte 2 (comentada): restauração com os valores lidos neste dry-run, só para
    reverter um --apply com o ok do Marcelo. Este arquivo não grava nada."""
    compras = [ln for ln in linhas if ln.get("status") in ("muda", "sai_do_escopo") and ln.get("campos")]
    itens = [d for ln in linhas if ln.get("status") in ("muda", "sai_do_escopo") for d in ln.get("itens_detalhe", [])]
    ids_c = sorted(ln["id"] for ln in compras)
    ids_i = sorted(d["id"] for d in itens)
    out = [f"-- Backup do reclassificador (forte ancorado) gerado em {gerado_em} pelo DRY-RUN; nada foi gravado.",
           f"-- {len(ids_c)} compra(s) e {len(ids_i)} item(ns) mudariam.",
           "-- PARTE 1: rodar ANTES do --apply (só leitura) e guardar a saída como backup.",
           "begin read only;", "set local statement_timeout = '20s';"]
    if ids_c:
        out += ["select id, codigo_externo, categoria_escopo, interesse_borracha, prioridade, fase",
                "  from public.licitacoes_externas", " where id in (", "    " + _ids_sql(ids_c), " )", " order by id;"]
    for i in range(0, len(ids_i), 1000):   # blocos de 1000 ids (consulta leve, pela PK)
        out += ["select id, licitacao_id, numero_item, categoria_escopo, interesse_borracha",
                "  from public.licitacao_itens", " where id in (", "    " + _ids_sql(ids_i[i:i + 1000]), " )",
                " order by id;"]
    out += ["rollback;", "",
            "-- PARTE 2: restauração (NÃO RODAR sem o ok do Marcelo). Valores lidos no dry-run; confira com a",
            "-- parte 1.",
            "-- begin;"]
    for ln in sorted(compras, key=lambda x: x["id"]):
        antes = {"categoria_escopo": ln.get("categoria_antes"), "interesse_borracha": ln.get("interesse_antes"),
                 "prioridade": ln.get("prioridade_antes"), "fase": ln.get("fase_antes")}
        sets = ", ".join(f"{k} = {_sql_literal(antes[k])}" for k in _CAMPOS_COMPRA if k in ln["campos"])
        out.append(f"-- update public.licitacoes_externas set {sets} where id = {ln['id']};")
    for d in sorted(itens, key=lambda x: x["id"]):
        sets = ", ".join(f"{k} = {_sql_literal(d['antes'][k])}" for k in _CAMPOS_ITEM if k in d["depois"])
        out.append(f"-- update public.licitacao_itens set {sets} where id = {d['id']};")
    out += ["-- commit;", ""]
    return "\n".join(out)


def escrever_mudancas_csv(linhas: list[dict], caminho: str) -> int:
    """Uma linha por campo que mudaria (compra ou item), com a âncora/veto que decidiu. Retorna o nº de linhas."""
    n = 0
    with open(caminho, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["tipo", "licitacao_id", "item_id", "numero_item", "codigo_externo", "prioridade", "campo", "antes",
                    "depois", "causa", "categoria_regra_antiga", "ancoras", "vetos", "texto"])
        for ln in sorted(linhas, key=lambda x: x.get("id") or 0):
            causa, antiga = ln.get("causa") or "", ln.get("categoria_regra_antiga")
            if ln.get("status") == "divergencia_previa":   # não tocada: fica no CSV com o motivo
                w.writerow(["compra", ln["id"], "", "", ln.get("codigo_externo"), ln.get("prioridade_antes"),
                            "categoria_escopo (NÃO aplicada)", ln.get("categoria_antes"), ln.get("categoria_calculada"),
                            causa, antiga, "", "", ln.get("motivo")])
                n += 1
                continue
            if ln.get("status") not in ("muda", "sai_do_escopo"):
                continue
            antes = {"categoria_escopo": ln.get("categoria_antes"), "interesse_borracha": ln.get("interesse_antes"),
                     "prioridade": ln.get("prioridade_antes"), "fase": ln.get("fase_antes")}
            for k, v in (ln.get("campos") or {}).items():
                w.writerow(["compra", ln["id"], "", "", ln.get("codigo_externo"), ln.get("prioridade_antes"), k,
                            antes.get(k), v, causa, antiga, " | ".join(ln.get("ancoras") or []),
                            " | ".join(ln.get("vetos") or []), (ln.get("objeto") or "")[:160]])
                n += 1
            motivos = ln.get("motivos_itens") or {}
            for d in ln.get("itens_detalhe", []):
                m = motivos.get(d["numero_item"]) or {}
                anc = f"{m['pdm']}:{m['ancora']}" if m.get("ancora") else ""
                for k, v in d["depois"].items():
                    w.writerow(["item", ln["id"], d["id"], d["numero_item"], ln.get("codigo_externo"),
                                ln.get("prioridade_antes"), k, d["antes"].get(k), v, "", "", anc, m.get("veto") or "",
                                d["descricao"]])
                    n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Reclassifica escopo/categoria/prioridade das compras PNCP gravadas")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, só SELECT)")
    ap.add_argument("--consultar-pncp", action="store_true",
                    help="busca no PNCP (GET) os itens das compras sem itens gravados")
    ap.add_argument("--consultar-detalhe", action="store_true",
                    help="consulta (GET) o detalhe das compras leads/monitorar: 410 = excluída do PNCP (historico)")
    ap.add_argument("--id-min", type=int)
    ap.add_argument("--id-max", type=int)
    ap.add_argument("--desde", help="só linhas com created_at >= este instante ISO (ex.: 2026-09-30T23:08:00Z)")
    ap.add_argument("--termo", help="só linhas com este termo em termos_busca (ex.: puxador)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--amostra", type=int, default=5, help="exemplos por transição (padrão 5)")
    ap.add_argument("--json", help="grava o resultado por linha neste arquivo (fora do repositório)")
    ap.add_argument("--cache-itens", help="arquivo JSON (fora do repositório) com os itens já consultados no PNCP: "
                                          "lido se existir e regravado com as consultas novas")
    ap.add_argument("--so-escopo", action="store_true",
                    help="só categoria_escopo/interesse_borracha (compra e itens); prioridade e fase não são "
                         "recalculadas")
    ap.add_argument("--so-regra-nova", action="store_true",
                    help="com as âncoras: não toca compra cuja categoria já mudaria sem a regra nova (gravado velho); "
                         "ela sai no relatório como divergencia_previa")
    ap.add_argument("--entrada-dir", help="dry-run OFFLINE: lê os CSVs exportados pelo bot (RECLASSIFICAR-FORTE-"
                                          "EXPORT.sql) em vez do Supabase; implica --so-escopo; não aceita --apply")
    ap.add_argument("--sql-backup", help="grava aqui o SQL de backup (SELECT só leitura + restauração comentada) "
                                         "das linhas que mudariam")
    ap.add_argument("--mudancas-csv", help="grava aqui a lista de mudanças (uma linha por campo de compra/item)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.entrada_dir:
        if args.apply or args.consultar_pncp or args.consultar_detalhe:
            log.error("--entrada-dir é só dry-run offline: sem --apply, --consultar-pncp nem --consultar-detalhe")
            return 2
        args.so_escopo = True
        sb = ClienteArquivos(args.entrada_dir)
    else:
        sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    # mapa CATMAT pelo cliente original, ANTES de embrulhar em SomenteLeitura (que bloqueia rpc): o dry-run usa a
    # mesma regra de código que o --apply. Falha com o banco configurado aborta antes de qualquer gravação.
    try:
        mapa = carregar_mapa_catmat_se_houver_banco(sb)
    except MapaCatmatIndisponivel as e:
        log.error("Mapa CATMAT indisponível; abortando antes de reclassificar "
                  "(sem o código a classificação mudaria em silêncio): %s", str(e)[:300])
        return 1
    if not args.apply:
        sb = SomenteLeitura(sb)
    pncp = None
    if args.consultar_pncp or args.consultar_detalhe:
        # mesmo ritmo do coletor com lista ampla (~1 req/s; ver pncp.main)
        pncp = PNCP(delay=float(env("DELAY_SEGUNDOS", "1.0")), timeout=int(env("PNCP_TIMEOUT", "60")),
                    tentativas=int(env("PNCP_TENTATIVAS", "4")))
    cache = salvar = None
    if args.cache_itens:
        try:
            with open(args.cache_itens, encoding="utf-8") as fh:
                cache = json.load(fh)
        except FileNotFoundError:
            cache = {}

        def salvar(c):
            with open(args.cache_itens, "w", encoding="utf-8") as fh:
                json.dump(c, fh, ensure_ascii=False)
    r = reclassificar(sb, pncp, aplicar=args.apply, consultar_pncp=args.consultar_pncp,
                      consultar_detalhe_pncp=args.consultar_detalhe, id_min=args.id_min,
                      id_max=args.id_max, desde=args.desde, termo=args.termo, limite=args.limit,
                      amostra=args.amostra, workers=int(env("PNCP_WORKERS", "1")), cache_itens=cache,
                      salvar_cache=salvar, mapa_catmat=mapa, so_escopo=args.so_escopo,
                      so_regra_nova=args.so_regra_nova)
    if salvar is not None:
        salvar(cache)
    linhas = r.pop("linhas")
    if args.sql_backup:
        with open(args.sql_backup, "w", encoding="utf-8") as fh:
            fh.write(sql_backup(linhas, datetime.now(timezone.utc).isoformat(timespec="seconds")))
        log.info("SQL de backup em %s", args.sql_backup)
    if args.mudancas_csv:
        log.info("%d mudança(s) em %s", escrever_mudancas_csv(linhas, args.mudancas_csv), args.mudancas_csv)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(linhas, fh, ensure_ascii=False, indent=1, default=str)
    amostra = r.pop("amostra")
    for chave, n in sorted(r["transicoes_categoria"].items(), key=lambda kv: -kv[1]):
        print(f"categoria {chave}: {n}")
        for id_, codigo, obj in amostra.get(chave, []):
            print(f"  #{id_} {codigo}: {obj}")
    log.info("RESUMO%s: %s", "" if args.apply else " (DRY-RUN, nada gravado; use --apply)", r)
    return 0


if __name__ == "__main__":
    sys.exit(main())

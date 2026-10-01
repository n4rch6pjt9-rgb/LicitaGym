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

Padrão: DRY-RUN (só SELECT; o cliente do Supabase fica embrulhado em modo somente leitura). Para gravar: --apply.
  export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...     # nunca no código
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp                       # dry-run, todas as PNCP
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp --id-min 50 --id-max 556 --termo puxador
  python -m coletor.reclassificar_escopo_pncp --consultar-pncp --apply               # grava
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from .destino import Supabase, env
from .escopo import classificar, excluir_compra, servico_sem_material
from .pncp import PNCP, avaliar, compra_de_codigo, motivo_prioridade

log = logging.getLogger("coletor.reclassificar_escopo_pncp")

SELECT = ("id,codigo_externo,objeto,categoria_escopo,interesse_borracha,prioridade,situacao,data_homologacao,"
          "data_fim,termos_busca,created_at,raw,"
          "licitacao_itens(id,numero_item,descricao,situacao,tem_resultado,categoria_escopo,interesse_borracha)")


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


def _itens_gravados(ln: dict) -> list[dict]:
    return [{"numeroItem": it["numero_item"], "descricao": it.get("descricao"), "situacao": it.get("situacao"),
             "tem_resultado": it.get("tem_resultado"), "_id": it.get("id"),
             "_categoria": it.get("categoria_escopo"), "_interesse": it.get("interesse_borracha")}
            for it in (ln.get("licitacao_itens") or [])]


def _nova_prioridade(ln: dict, itens: list[dict] | None, agora: datetime) -> tuple[str | None, str, str | None]:
    """(prioridade a gravar ou None = não mexe, motivo, trava aplicada)."""
    atual = ln.get("prioridade")
    base = {k: v for k, v in ln.items() if k not in ("prioridade", "licitacao_itens")}
    nova, motivo = motivo_prioridade(base, agora=agora, itens=itens or None)
    if nova is None:
        return None, motivo, "indeterminada"
    if atual == "historico" and nova != "historico":
        return None, motivo, "historico_mantido_sem_detalhe"
    if nova == "leads" and atual != "leads":
        return None, motivo, "leads_sem_detalhe"
    return (nova if nova != atual else None), motivo, None


def reavaliar(ln: dict, itens_pncp: list[dict] | None, agora: datetime) -> dict:
    """Resultado para UMA linha: {status, categoria, interesse, prioridade, campos, itens_campos, ...}.
    status: sem_itens | sem_mudanca | sai_do_escopo | muda."""
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
            out.update(status="sem_itens", categoria_depois=atual_cat, motivo="sem itens gravados nem consulta ao PNCP")
            return out
        out["fonte_itens"] = "objeto"
        cat, ib, _ = avaliar(compra, [])
        if cat is not None:
            cat, ib = atual_cat, atual_ib   # objeto confirma a categoria gravada; interesse fica o gravado
        por_item = {}
    else:
        cat, ib, por_item = avaliar(compra, itens)
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
    prio, motivo, trava = _nova_prioridade(ln, itens, agora)
    if prio is not None:
        campos["prioridade"] = prio
    out.update(prioridade_depois=prio or atual_prio, motivo=motivo, trava_prioridade=trava, campos=campos,
               status="muda" if campos or out["itens_campos"] else "sem_mudanca")
    return out


def objeto_decide(ln: dict) -> bool:
    """True quando o objeto sozinho já decide a categoria nova sem consultar os itens:
    - a compra inteira fica fora (exclusão ou serviço de pessoas sem material), ou
    - o objeto, com o classificador atual, dá a mesma categoria gravada. As regras novas só restringem
      (puxador, cross over, SBR/EPDM, serviço, academia ao ar livre): a categoria nova fica entre a do objeto e a
      gravada (que já era o máximo de objeto + itens), então as duas iguais fecham a conta.
    Sem consultar os itens a linha também não muda interesse_borracha (fica o gravado)."""
    objeto = _compra(ln)["description"]
    if excluir_compra(objeto) or servico_sem_material(objeto):
        return True
    return ln.get("categoria_escopo") is not None and classificar(objeto) == ln.get("categoria_escopo")


def _buscar_itens(pncp, ln: dict) -> tuple[list[dict] | None, str | None]:
    c = compra_de_codigo(ln.get("codigo_externo"))
    if not c:
        return None, f"codigo_externo inválido: {ln.get('codigo_externo')!r}"
    try:
        return pncp.itens(c), None
    except Exception as e:  # falha de consulta: não mexe na linha
        return None, str(e)[:160]


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


def reclassificar(sb, pncp=None, *, aplicar: bool = False, consultar_pncp: bool = False, id_min: int | None = None,
                  id_max: int | None = None, desde: str | None = None, termo: str | None = None,
                  limite: int | None = None, amostra: int = 5, agora: datetime | None = None,
                  workers: int = 1, cache_itens: dict | None = None, salvar_cache=None) -> dict:
    """Resumo da reclassificação; em dry-run (aplicar=False) nunca grava (sb deve ser SomenteLeitura).
    `cache_itens`: codigo_externo -> itens do PNCP já consultados (lido antes e completado com as consultas novas)."""
    agora = agora or datetime.now(timezone.utc)
    linhas = sb.selecionar("licitacoes_externas", **_filtros(id_min, id_max, desde, termo, limite))
    r = {"lidas": len(linhas), "itens_gravados": 0, "itens_pncp": 0, "decididas_pelo_objeto": 0, "falha_consulta": 0, "sem_itens": 0,
         "sem_mudanca": 0, "sai_do_escopo": 0, "sai_dos_leads": 0, "muda": 0, "muda_categoria": 0,
         "muda_interesse": 0, "muda_prioridade": 0, "itens_mudariam": 0, "gravadas": 0,
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

    for ln in linhas:
        ip = None
        if ln["id"] in itens_pncp:
            ip, erro = itens_pncp[ln["id"]]
            if erro is not None:
                r["falha_consulta"] += 1
                log.warning("  #%s %s: itens do PNCP indisponíveis, não mexe: %s", ln["id"], ln.get("codigo_externo"), erro)
                r["linhas"].append({"id": ln["id"], "codigo_externo": ln.get("codigo_externo"), "status": "falha_consulta",
                                    "erro": erro, "categoria_antes": ln.get("categoria_escopo"),
                                    "termos_busca": ln.get("termos_busca") or []})
                continue
            r["itens_pncp"] += 1
        elif ln.get("licitacao_itens"):
            r["itens_gravados"] += 1
        res = reavaliar(ln, ip, agora)
        if res.get("fonte_itens") == "objeto":
            r["decididas_pelo_objeto"] += 1
        r["linhas"].append(res)
        st = res["status"]
        r[st] += 1
        if res.get("trava_prioridade"):
            r["trava_prioridade"][res["trava_prioridade"]] = r["trava_prioridade"].get(res["trava_prioridade"], 0) + 1
        if st in ("sem_itens", "sem_mudanca"):
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


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Reclassifica escopo/categoria/prioridade das compras PNCP gravadas")
    ap.add_argument("--apply", action="store_true", help="grava no Supabase (sem isto: dry-run, só SELECT)")
    ap.add_argument("--consultar-pncp", action="store_true",
                    help="busca no PNCP (GET) os itens das compras sem itens gravados")
    ap.add_argument("--id-min", type=int)
    ap.add_argument("--id-max", type=int)
    ap.add_argument("--desde", help="só linhas com created_at >= este instante ISO (ex.: 2026-09-30T23:08:00Z)")
    ap.add_argument("--termo", help="só linhas com este termo em termos_busca (ex.: puxador)")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--amostra", type=int, default=5, help="exemplos por transição (padrão 5)")
    ap.add_argument("--json", help="grava o resultado por linha neste arquivo (fora do repositório)")
    ap.add_argument("--cache-itens", help="arquivo JSON (fora do repositório) com os itens já consultados no PNCP: "
                                          "lido se existir e regravado com as consultas novas")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
    if not args.apply:
        sb = SomenteLeitura(sb)
    pncp = None
    if args.consultar_pncp:
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
    r = reclassificar(sb, pncp, aplicar=args.apply, consultar_pncp=args.consultar_pncp, id_min=args.id_min,
                      id_max=args.id_max, desde=args.desde, termo=args.termo, limite=args.limit,
                      amostra=args.amostra, workers=int(env("PNCP_WORKERS", "1")), cache_itens=cache,
                      salvar_cache=salvar)
    if salvar is not None:
        salvar(cache)
    linhas = r.pop("linhas")
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

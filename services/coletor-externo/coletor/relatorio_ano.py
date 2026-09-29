"""Relatório anual de certames encerrados de um portal Paradigma (Mural estatístico) para o BI.

Mesmo processo aplicado ao PE000652022 (2022), agora para qualquer ano:
  1. Mural estatístico do ano (PesquisarProcessosMuralEstatistico) para cada termo; une os processos.
  2. Detalhe + itens; escopo por item (catálogo Tipo=Produto + categorias mapeadas, regras, manutenção).
  3. Itens no escopo: grade de lances -> ranking, vencedor (troféu), marca/modelo, valor unitário e total.
  4. Participantes de todos os itens -> CNPJ na BrasilAPI/Minha Receita (fabricante × revenda pelo CNAE).
  5. CSV em padrão brasileiro (vírgula decimal, sem ponto de milhar) + resumo JSON.

Não grava no banco (use o coletor para isso). Guarda o bruto de cada processo em --cache para retomar.

  python -m coletor.relatorio_ano --fonte sfiec --ano 2023 --saida bi-sfiec-2023.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from collections import Counter, defaultdict
from pathlib import Path

from .fornecedores import CadastroFornecedores
from .marcas import enriquecer
from .paradigma import (FONTES, PortalParadigma, ResultadoInvalido, avaliar_processo, empresa_cnpj, limpar,
                        linhas_itens, linhas_resultados, modulo_de, parse_data, valor)
from .perfil_item import texto_do_item

log = logging.getLogger("coletor.relatorio_ano")

TERMOS_PADRAO = ["EQUIPAMENTOS ESPORTIVOS", "academia", "musculação", "ginástica", "esteira", "esportivo",
                 "esportivos", "crossfit", "pilates", "fitness"]
CAMPOS = ["ano", "processo", "origem_lista", "modulo", "modalidade", "objeto", "situacao_processo", "data_encerramento",
          "valor_estimado_processo_brl", "valor_negociado_processo_brl", "item", "codigo", "produto_padronizado", "descricao",
          "familia_equipamento", "no_taxonomia", "cinematica", "categoria_escopo", "escopo_metodo", "qtd", "unidade",
          "valor_ref_unit_brl", "situacao_item", "ranking", "vencedor",
          # fornecedor -> marca -> modelo (o que foi ofertado) e o gate fabricante × revenda
          "empresa", "cnpj", "marca", "marca_normalizada", "modelo", "modelo_linha", "modelo_codigo",
          "relacao_marca",
          "tipo_empresa", "perfil_comercial", "marca_propria", "marca_propria_metodo", "qtd_marcas_fornecedor",
          *[f"marca_fornecedor_{i}" for i in range(1, 11)], "cnae", "cnae_desc", "uf", "municipio", "porte",
          "valor_unit_brl", "valor_total_brl", "desconto_vs_ref_pct", "acrescimo_vs_ref_pct",
          # referências do edital (Anexo II), quando transcritas
          "perfil_edital", "fonte_carga_edital", "carga_placas_kg_edital", "qtd_marcas_referencia",
          "ref_marca_1", "ref_modelo_1", "ref_linha_1", "ref_codigo_1",
          "ref_marca_2", "ref_modelo_2", "ref_linha_2", "ref_codigo_2",
          "ref_marca_3", "ref_modelo_3", "ref_linha_3", "ref_codigo_3",
          "marca_ofertada_na_referencia", "posicao_na_referencia"]


def br(v, casas: int = 2) -> str:
    """Número no padrão brasileiro para planilha: 4674.5 -> '4674,50' (sem ponto de milhar)."""
    if v is None or v == "":
        return ""
    return f"{float(v):.{casas}f}".replace(".", ",")


def br_qtd(v) -> str:
    if v is None:
        return ""
    f = float(v)
    return str(int(f)) if f.is_integer() else br(f, 3)


_NUM = ("valor_unit_brl", "valor_total_brl")


def _num_br(v) -> float | None:
    """'1234,50' / '55,00%' / 12.3 -> float."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    return float(str(v).replace("%", "").replace(".", "").replace(",", ".").strip())


def variacao_vs_ref(l: dict) -> float | None:
    """Variação do preço sobre a referência em % (negativo = abaixo). Aceita o formato novo (2 colunas) ou o antigo."""
    if "_var" in l:
        return l["_var"]
    d, a = _num_br(l.get("desconto_vs_ref_pct")), _num_br(l.get("acrescimo_vs_ref_pct"))
    if a:
        return a
    if d is None:
        return None
    # CSV antigo (sem '%'): a coluna já era a variação com sinal (-55 = 55% abaixo). Novo ('55,00%'): desconto positivo.
    bruto = l.get("desconto_vs_ref_pct")
    return d if isinstance(bruto, str) and "%" not in bruto else -d


def pct(v: float | None) -> str:
    """0 a 100 sem sinal, com símbolo: 54.93 -> '54,93%' (o Google Planilhas/Excel pt-BR lê como porcentagem)."""
    return "" if v is None else f"{abs(v):.2f}".replace(".", ",") + "%"


def escrever_csv(linhas: list[dict], saida: str) -> None:
    """CSV ';' em padrão brasileiro: vírgula decimal, sem ponto de milhar, VERDADEIRO/FALSO."""
    with open(saida, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(CAMPOS)
        for l in linhas:
            var = variacao_vs_ref(l)
            l = {**l, "desconto_vs_ref_pct": pct(var) if var is not None and var <= 0 else "",
                 "acrescimo_vs_ref_pct": pct(var) if var is not None and var > 0 else ""}
            row = []
            for c in CAMPOS:
                v = l.get(c)
                if c in _NUM and isinstance(v, (int, float)) and not isinstance(v, bool):
                    v = br(v)
                elif c == "carga_placas_kg_edital" and isinstance(v, float):
                    v = br_qtd(v).rstrip("0").rstrip(",") if "," in br_qtd(v) else br_qtd(v)
                elif isinstance(v, bool):
                    v = "VERDADEIRO" if v else "FALSO"
                row.append("" if v is None else v)
            w.writerow(row)


def ler_csv(caminho: str) -> list[dict]:
    with open(caminho, encoding="utf-8-sig") as fh:
        linhas = list(csv.DictReader(fh, delimiter=";"))
    for l in linhas:
        l["vencedor"] = {"VERDADEIRO": True, "FALSO": False}.get(l.get("vencedor"), l.get("vencedor"))
    return linhas


def consolidar(entradas: list[str], saida: str) -> list[dict]:
    """Junta CSVs anuais e recalcula o gate de marca sobre o conjunto inteiro (portfólio do fornecedor em todos os anos)."""
    linhas = [l for e in entradas for l in ler_csv(e)]
    enriquecer(linhas)
    escrever_csv(linhas, saida)
    return linhas


def coletar_ano(portal: PortalParadigma, ano: int, termos: list[str], produtos: dict | None, cache: Path,
                max_por_termo: int = 500) -> list[dict]:
    """Bruto de cada processo encerrado no ano: listagem, detalhe, itens e lances dos itens no escopo."""
    cache.mkdir(parents=True, exist_ok=True)
    vistos: dict[tuple[int, int], dict] = {}
    for t in termos:
        de = 1
        while de <= max_por_termo:
            lote = portal.listar_encerrados(t, ano, de, de + 49)
            for x in lote:
                if isinstance(x.get("nCdOrigem"), int) and x.get("nAnoFinalizacao") == ano:
                    vistos.setdefault((x["nCdOrigem"], modulo_de(x)), x)
            if len(lote) < 50:
                break
            de += 50
    for x in list(vistos.values()):
        x.setdefault("_origem", "mural_estatistico")
    n_estatistico = len(vistos)
    # O Mural estatístico não traz tudo (ex.: SFIEC PD000802025, homologado em 09/2025, e os cancelados).
    # Complementa com o mural comum: entra se foi homologado/finalizado no ano, ou cancelado com início no ano.
    for t in termos:
        for x in portal.listar(t, 1, max_por_termo):
            chave = (x.get("nCdOrigem"), modulo_de(x))
            if not isinstance(chave[0], int) or chave[0] <= 0 or chave in vistos:
                continue
            d = portal.detalhes(*chave) or {}
            fim = parse_data(d.get("tDtHomologacao")) or parse_data(d.get("tDtFinalizacao")) or ""
            ini = parse_data(d.get("tDtInicial")) or ""
            cancelado = "cancel" in (d.get("sDsSituacao") or "").lower() or "revog" in (d.get("sDsSituacao") or "").lower()
            if fim[:4] == str(ano) or (cancelado and ini[:4] == str(ano)):
                vistos[chave] = {**x, "_origem": "mural_comum"}
    log.info("%s %s: %d processos (%d do Mural estatístico, %d do mural comum) nos termos %s", portal.fonte.slug, ano,
             len(vistos), n_estatistico, len(vistos) - n_estatistico, termos)
    brutos = []
    for (pid, mod), lst in sorted(vistos.items()):
        arq = cache / f"{portal.fonte.slug}_{pid}_m{mod}.json"
        if arq.exists():
            b = json.loads(arq.read_text(encoding="utf-8"))
            b["listagem"] = lst  # listagem atual (origem e totais do mural) vale sobre a do cache
            brutos.append(b)
            continue
        try:
            d = portal.detalhes(pid, mod)
            its = portal.itens(d) if d else []
            cat, _ = avaliar_processo(d, its, produtos) if d else (None, False)
            li = linhas_itens(None, its, produtos) if cat else []
            lances = {}
            for it, linha in zip(its, li):
                if it.get("nCdItem"):
                    # todos os itens (inclusive fora do escopo) para o cadastro de participantes
                    lances[str(it["nCdItem"])] = portal.resultado_item(d, it)
            b = {"listagem": lst, "detalhe": d, "itens": its, "categoria": cat, "lances": lances}
            arq.write_text(json.dumps(b, ensure_ascii=False, default=str), encoding="utf-8")
            brutos.append(b)
            log.info("  %s %s | %s | %d itens | %s", pid, (d or {}).get("sNrProcesso"), cat, len(its),
                     ((d or {}).get("sDsObjeto") or "")[:60])
        except Exception as e:
            log.warning("  %s/m%s: %s", pid, mod, e)
    return brutos


def linhas_bi(brutos: list[dict], produtos: dict | None, ano: int) -> tuple[list[dict], list[str], dict]:
    linhas, cnpjs, alertas = [], [], []
    for b in brutos:
        d, lst = b.get("detalhe") or {}, limpar(b.get("listagem") or {})
        if not b.get("categoria"):
            continue
        its = b["itens"]
        li = linhas_itens(None, its, produtos)
        homolog = parse_data(d.get("tDtHomologacao"))
        base = {"ano": ano, "processo": d.get("sNrProcesso"), "origem_lista": (b.get("listagem") or {}).get("_origem"),
                "modulo": modulo_de(d),
                "modalidade": d.get("sNmModalidade"), "objeto": (d.get("sDsObjeto") or "").strip(),
                "situacao_processo": d.get("sDsSituacao"), "data_encerramento": parse_data(lst.get("tDtEncerrado")) or homolog,
                "valor_estimado_processo_brl": br(valor(lst.get("dVlEstimado"))),
                "valor_negociado_processo_brl": br(valor(lst.get("dVlNegociado")))}
        for it, linha in zip(its, li):
            brutos_item = limpar(b["lances"].get(str(it.get("nCdItem"))) or [])
            cnpjs += [c for c in (empresa_cnpj(r.get("sNmEmpresa"))[1] for r in brutos_item) if c]
            if not linha["categoria_escopo"]:
                continue
            item = {**base, "item": linha["numero_item"], "codigo": linha.get("catalogo_codigo_item"),
                    "descricao": texto_do_item(linha["descricao"]), "familia_equipamento": linha.get("familia_equipamento"),
                    "no_taxonomia": linha.get("no_taxonomia"), "categoria_escopo": linha["categoria_escopo"],
                    "escopo_metodo": linha["escopo_metodo"], "qtd": br_qtd(linha["quantidade"]),
                    "unidade": linha.get("unidade_medida"), "valor_ref_unit_brl": br(linha["valor_unitario_estimado"]),
                    "situacao_item": linha.get("situacao")}
            try:
                res = linhas_resultados(None, linha["numero_item"], brutos_item, homolog, it.get("sStItem"),
                                        linha["quantidade"])
            except ResultadoInvalido as e:
                alertas.append(f"{d.get('sNrProcesso')} {e}")
                res = []
            if not res:
                linhas.append(item)
            ref = linha["valor_unitario_estimado"]
            for r in res:
                linhas.append({**item, "ranking": r["ranking"], "vencedor": r["vencedor"], "empresa": r["fornecedor_nome"],
                               "cnpj": r["fornecedor_cnpj"], "marca": r["marca"], "marca_normalizada": r["marca_normalizada"],
                               "modelo": r["modelo"], "valor_unit_brl": r["valor_proposta"],
                               "valor_total_brl": r["valor_total_homologado"],
                               "_var": (r["valor_proposta"] / ref - 1) * 100 if ref and r["valor_proposta"] else None})
    return linhas, cnpjs, {"alertas": alertas}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Relatório anual (BI) de certames encerrados Paradigma")
    ap.add_argument("--fonte", choices=sorted(FONTES))
    ap.add_argument("--ano", type=int)
    ap.add_argument("--consolidar", nargs="+", metavar="CSV", help="junta CSVs anuais e recalcula o gate de marca")
    ap.add_argument("--termos", help="separados por ';' (padrão: " + "; ".join(TERMOS_PADRAO) + ")")
    ap.add_argument("--saida", required=True)
    ap.add_argument("--cache", default="cache_relatorio")
    ap.add_argument("--delay", type=float, default=0.6)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.consolidar:
        linhas = consolidar(args.consolidar, args.saida)
        print(json.dumps({"linhas": len(linhas), "perfis": Counter(l.get("perfil_comercial") for l in linhas
                                                                    if l.get("vencedor") is True)}, ensure_ascii=False))
        return 0
    if not (args.fonte and args.ano):
        ap.error("--fonte e --ano são obrigatórios (ou use --consolidar)")

    portal = PortalParadigma(FONTES[args.fonte], delay=args.delay)
    produtos = portal.produtos_escopo()
    termos = [t.strip() for t in args.termos.split(";")] if args.termos else TERMOS_PADRAO
    brutos = coletar_ano(portal, args.ano, termos, produtos, Path(args.cache) / args.fonte / str(args.ano))
    linhas, cnpjs, extra = linhas_bi(brutos, produtos, args.ano)

    # Fornecedores (cache em arquivo entre anos)
    cache_forn = Path(args.cache) / "fornecedores.json"
    cad_cache = json.loads(cache_forn.read_text(encoding="utf-8")) if cache_forn.exists() else {}
    faltam = sorted({c for c in cnpjs if c not in cad_cache})
    if faltam:
        r = CadastroFornecedores(None, dry_run=True).cadastrar(faltam)
        for l in r["linhas"]:
            cad_cache[l["cnpj"]] = {k: l.get(k) for k in ("razao_social", "cnae_principal", "cnae_principal_descricao",
                                                           "uf", "municipio", "porte", "fabricante")}
        cache_forn.write_text(json.dumps(cad_cache, ensure_ascii=False), encoding="utf-8")
    for l in linhas:
        f = cad_cache.get(l.get("cnpj") or "", {})
        if f:
            l.update({"tipo_empresa": "fabricante" if f.get("fabricante") else "comércio/revenda",
                      "razao_social_receita": f.get("razao_social"),
                      "cnae": f.get("cnae_principal"), "cnae_desc": f.get("cnae_principal_descricao"),
                      "uf": f.get("uf"), "municipio": f.get("municipio"), "porte": f.get("porte")})

    enriquecer(linhas)
    escrever_csv(linhas, args.saida)

    v = [l for l in linhas if l.get("vencedor")]
    resumo = {
        "fonte": args.fonte, "ano": args.ano, "termos": termos,
        "processos_encerrados": len(brutos), "processos_no_escopo": sum(1 for b in brutos if b.get("categoria")),
        "linhas": len(linhas), "itens_com_vencedor": len(v), "participantes": len(set(cnpjs)),
        "alertas": extra["alertas"],
        "valor_vencedores_brl": round(sum(l.get("valor_total_brl") or 0 for l in v), 2),
        "por_familia": Counter((l.get("familia_equipamento") or "sem_familia") for l in v),
        "vencedores": Counter(l.get("empresa") for l in v).most_common(15),
        "marcas_vencedoras": Counter(l.get("marca_normalizada") for l in v).most_common(15),
        "por_modalidade": Counter(b["detalhe"].get("sNmModalidade") for b in brutos if b.get("categoria") and b.get("detalhe")),
        "processos_cancelados": [b["detalhe"].get("sNrProcesso") for b in brutos if b.get("detalhe")
                                 and "cancel" in (b["detalhe"].get("sDsSituacao") or "").lower()],
        "fora_do_mural_estatistico": [b["detalhe"].get("sNrProcesso") for b in brutos if b.get("detalhe")
                                      and (b.get("listagem") or {}).get("_origem") == "mural_comum"],
    }
    print(json.dumps(resumo, ensure_ascii=False, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Gera o seed SQL do catálogo de tarefas (Lei 14.133) a partir do YAML e dos textos legais.

Uso:
    python scripts/gerar_seed_catalogo_tarefas.py \
        --catalogo data/catalogo_tarefas_14133.yaml \
        --textos data/lei14133_textos \
        --saida supabase/migrations/20260927100100_seed_catalogo_tarefas_14133.sql

Regras (golden rules do projeto):
  - Falha alto: artigo citado sem texto, evento/fase inexistente ou prazo incoerente abortam a geração.
  - Nada vira vazio: campo ausente no YAML fica NULL explícito, nunca string vazia.
  - Idempotente: upsert por chave natural; tarefas fora do YAML são desativadas (ativo=false), não apagadas.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

UNIDADES_COM_QTD = {"dias_uteis", "dias_corridos", "meses", "anos"}
UNIDADES_SEM_QTD = {"imediato", "definido_no_edital", "sem_prazo_legal"}
CODIGO_RE = re.compile(r"^14133-F\d{2}-T\d{2}$")


class CatalogoInvalido(Exception):
    pass


def lit(valor) -> str:
    """Literal SQL com dollar-quoting; None vira NULL."""
    if valor is None:
        return "null"
    if isinstance(valor, bool):
        return "true" if valor else "false"
    if isinstance(valor, int):
        return str(valor)
    texto = str(valor)
    tag = "$t$"
    while tag in texto:
        tag = tag[:-1] + "x$"
    return f"{tag}{texto}{tag}"


def ler_textos(pasta: Path) -> dict[int, dict]:
    """Lê os .md com blocos '## Art. N ...' e retorna {artigo: {texto, recorte, fonte, obs}}."""
    artigos: dict[int, dict] = {}
    for arq in sorted(pasta.glob("*.md")):
        blocos = re.split(r"^## Art\. ", arq.read_text(encoding="utf-8"), flags=re.M)[1:]
        for bloco in blocos:
            cabecalho, _, corpo = bloco.partition("\n")
            m = re.match(r"(\d+)\s*(?:\((.*)\))?", cabecalho.strip())
            if not m:
                raise CatalogoInvalido(f"{arq.name}: cabeçalho inválido: {cabecalho!r}")
            num = int(m.group(1))
            recorte = m.group(2)
            linhas, fontes, obs = [], [], []
            for linha in corpo.splitlines():
                if linha.startswith("Fonte:"):
                    fontes.append(linha.removeprefix("Fonte:").strip())
                elif linha.startswith("(") and linha.endswith(")") and ("conferir" in linha.lower() or "atenção" in linha.lower()):
                    obs.append(linha.strip("()"))
                elif linha.startswith("#") or linha.startswith(">"):
                    continue
                else:
                    linhas.append(linha)
            texto = "\n".join(linhas).strip()
            if "[NÃO OBTIDO]" in texto or not texto:
                raise CatalogoInvalido(f"Art. {num}: texto não obtido em {arq.name}")
            if not fontes:
                raise CatalogoInvalido(f"Art. {num}: sem linha 'Fonte:' em {arq.name}")
            if num in artigos:
                raise CatalogoInvalido(f"Art. {num} duplicado ({arq.name})")
            url = fontes[0].split(" ")[0]
            nota = " ".join(fontes[0].split(" ")[1:]).strip()
            artigos[num] = {
                "texto": texto,
                "recorte": recorte,
                "fonte": url,
                "obs": "; ".join(x for x in [nota, *obs] if x) or None,
            }
    return artigos


def validar(cat: dict, textos: dict[int, dict]) -> None:
    fases = {f["codigo"] for f in cat["fases"]}
    eventos = {e["codigo"] for e in cat["eventos"]}
    codigos = [t["codigo"] for t in cat["tarefas"]]
    erros: list[str] = []

    if len(codigos) != len(set(codigos)):
        erros.append("código de tarefa duplicado")
    for e in cat["eventos"]:
        if e.get("fase") and e["fase"] not in fases:
            erros.append(f"evento {e['codigo']}: fase {e['fase']} inexistente")
    for tr in cat["transicoes"]:
        for campo in ("de", "para"):
            if tr[campo] not in fases:
                erros.append(f"transição {tr}: fase inexistente")
        if tr["evento"] not in eventos:
            erros.append(f"transição {tr}: evento {tr['evento']} inexistente")

    for t in cat["tarefas"]:
        c = t["codigo"]
        if not CODIGO_RE.match(c):
            erros.append(f"{c}: código fora do padrão 14133-Fxx-Tyy")
        if t["fase"] not in fases:
            erros.append(f"{c}: fase {t['fase']} inexistente")
        if c.split("-")[1] != t["fase"]:
            erros.append(f"{c}: prefixo do código não bate com a fase {t['fase']}")
        if t.get("parent") and t["parent"] not in codigos:
            erros.append(f"{c}: parent {t['parent']} inexistente")
        if t.get("evento_abertura") and t["evento_abertura"] not in eventos:
            erros.append(f"{c}: evento_abertura {t['evento_abertura']} inexistente")
        p = t["prazo"]
        u = p.get("unidade")
        if u in UNIDADES_COM_QTD:
            if not (p.get("qtd") and p.get("sentido") and p.get("evento")):
                erros.append(f"{c}: prazo em {u} exige qtd, sentido e evento")
            elif p["evento"] not in eventos:
                erros.append(f"{c}: evento do prazo {p['evento']} inexistente")
        elif u in UNIDADES_SEM_QTD:
            if p.get("qtd"):
                erros.append(f"{c}: prazo {u} não aceita qtd")
        else:
            erros.append(f"{c}: unidade de prazo inválida {u!r}")
        if not t.get("base_legal"):
            erros.append(f"{c}: sem base legal")
        for art, _disp, papel in t.get("base_legal", []):
            if art not in textos:
                erros.append(f"{c}: art. {art} citado sem texto legal")
            if papel not in {"fundamento", "prazo", "consequencia", "referencia"}:
                erros.append(f"{c}: papel inválido {papel}")
        for dep, tipo in t.get("depende_de", []):
            if dep not in codigos:
                erros.append(f"{c}: depende de {dep} inexistente")
            if tipo not in {"requer", "alternativa_a"}:
                erros.append(f"{c}: tipo de dependência inválido {tipo}")
    if erros:
        raise CatalogoInvalido("\n".join(erros))


def gerar(cat: dict, textos: dict[int, dict]) -> str:
    norma = cat["norma"]
    out: list[str] = [
        "-- GERADO por scripts/gerar_seed_catalogo_tarefas.py. Não editar à mão.",
        "-- Fonte: data/catalogo_tarefas_14133.yaml + data/lei14133_textos/*.md",
        f"-- {len(cat['tarefas'])} tarefas, {len(cat['fases'])} fases, {len(cat['eventos'])} eventos, "
        f"{len(textos)} artigos.",
        "-- Textos legais obtidos de fontes secundárias: conferido_oficial=false até conferência com o Planalto.",
        "",
        "begin;",
        "",
    ]

    out.append("-- dispositivos legais")
    for num in sorted(textos):
        a = textos[num]
        out.append(
            "insert into public.norma_dispositivos (norma, artigo, texto, recorte, fonte_url, observacao) values "
            f"({lit(norma)}, {num}, {lit(a['texto'])}, {lit(a['recorte'])}, {lit(a['fonte'])}, {lit(a['obs'])})\n"
            "on conflict (norma, artigo) do update set texto = excluded.texto, recorte = excluded.recorte, "
            "fonte_url = excluded.fonte_url, observacao = excluded.observacao, atualizado_em = now(), "
            "conferido_oficial = case when public.norma_dispositivos.texto = excluded.texto "
            "then public.norma_dispositivos.conferido_oficial else false end;"
        )

    out.append("\n-- fases")
    for f in cat["fases"]:
        arts = "array[" + ",".join(str(x) for x in f["artigos"]) + "]::integer[]"
        out.append(
            "insert into public.processo_fases (codigo, norma, ordem, nome, macro, descricao, artigos) values "
            f"({lit(f['codigo'])}, {lit(norma)}, {lit(f['ordem'])}, {lit(f['nome'])}, {lit(f['macro'])}, "
            f"{lit(f['descricao'])}, {arts})\n"
            "on conflict (codigo) do update set ordem = excluded.ordem, nome = excluded.nome, macro = excluded.macro, "
            "descricao = excluded.descricao, artigos = excluded.artigos;"
        )

    out.append("\n-- eventos")
    for e in cat["eventos"]:
        out.append(
            "insert into public.processo_eventos (codigo, fase_codigo, nome, descricao, origem, fonte_dado) values "
            f"({lit(e['codigo'])}, {lit(e.get('fase'))}, {lit(e['nome'])}, {lit(e['descricao'])}, "
            f"{lit(e['origem'])}, {lit(e.get('fonte_dado'))})\n"
            "on conflict (codigo) do update set fase_codigo = excluded.fase_codigo, nome = excluded.nome, "
            "descricao = excluded.descricao, origem = excluded.origem, fonte_dado = excluded.fonte_dado;"
        )

    out.append("\n-- transições")
    for tr in cat["transicoes"]:
        out.append(
            "insert into public.processo_fase_transicoes (norma, fase_origem, fase_destino, evento_codigo, condicao, artigo_base) values "
            f"({lit(norma)}, {lit(tr['de'])}, {lit(tr['para'])}, {lit(tr['evento'])}, "
            f"{lit(json.dumps(tr.get('condicao') or {}, ensure_ascii=False))}::jsonb, {lit(tr['artigo'])})\n"
            "on conflict (norma, fase_origem, fase_destino, evento_codigo) do update set "
            "condicao = excluded.condicao, artigo_base = excluded.artigo_base;"
        )

    out.append("\n-- tarefas (duas passadas: parent depois, para respeitar a FK)")
    ordem_por_fase: dict[str, int] = {}
    for t in cat["tarefas"]:
        ordem_por_fase[t["fase"]] = ordem_por_fase.get(t["fase"], 0) + 10
        p = t["prazo"]
        out.append(
            "insert into public.tarefas_catalogo (codigo, norma, fase_codigo, ordem, titulo, descricao, natureza, ator, "
            "evento_abertura, prazo_quantidade, prazo_unidade, prazo_sentido, prazo_evento, prazo_observacao, condicao, "
            "consequencia_omissao, efeito_suspensivo, saida_esperada, ativo) values ("
            f"{lit(t['codigo'])}, {lit(norma)}, {lit(t['fase'])}, {ordem_por_fase[t['fase']]}, {lit(t['titulo'])}, "
            f"{lit(t['descricao'])}, {lit(t['natureza'])}::public.tarefa_natureza, {lit(t['ator'])}, "
            f"{lit(t.get('evento_abertura'))}, {lit(p.get('qtd'))}, {lit(p['unidade'])}::public.prazo_unidade, "
            f"{lit(p.get('sentido'))}::public.prazo_sentido, {lit(p.get('evento'))}, {lit(p.get('obs'))}, "
            f"{lit(json.dumps(t.get('condicao') or {}, ensure_ascii=False))}::jsonb, {lit(t.get('consequencia'))}, "
            f"{lit(bool(t.get('efeito_suspensivo', False)))}, {lit(t.get('saida'))}, true)\n"
            "on conflict (codigo) do update set fase_codigo = excluded.fase_codigo, ordem = excluded.ordem, "
            "titulo = excluded.titulo, descricao = excluded.descricao, natureza = excluded.natureza, ator = excluded.ator, "
            "evento_abertura = excluded.evento_abertura, prazo_quantidade = excluded.prazo_quantidade, "
            "prazo_unidade = excluded.prazo_unidade, prazo_sentido = excluded.prazo_sentido, prazo_evento = excluded.prazo_evento, "
            "prazo_observacao = excluded.prazo_observacao, condicao = excluded.condicao, "
            "consequencia_omissao = excluded.consequencia_omissao, efeito_suspensivo = excluded.efeito_suspensivo, "
            "saida_esperada = excluded.saida_esperada, ativo = true, atualizado_em = now(), "
            "versao = public.tarefas_catalogo.versao + case when public.tarefas_catalogo.descricao is distinct from excluded.descricao "
            "or public.tarefas_catalogo.prazo_quantidade is distinct from excluded.prazo_quantidade "
            "or public.tarefas_catalogo.prazo_unidade is distinct from excluded.prazo_unidade "
            "or public.tarefas_catalogo.condicao is distinct from excluded.condicao then 1 else 0 end;"
        )
    for t in cat["tarefas"]:
        out.append(
            f"update public.tarefas_catalogo set parent_codigo = {lit(t.get('parent'))} where codigo = {lit(t['codigo'])};"
        )

    codigos = ", ".join(lit(t["codigo"]) for t in cat["tarefas"])
    out.append(f"\n-- tarefas removidas do YAML ficam inativas (histórico preservado)")
    out.append(f"update public.tarefas_catalogo set ativo = false, atualizado_em = now() "
               f"where norma = {lit(norma)} and codigo not in ({codigos});")

    out.append("\n-- base legal (recria por tarefa)")
    out.append(f"delete from public.tarefas_catalogo_base_legal where tarefa_codigo in ({codigos});")
    for t in cat["tarefas"]:
        vistos = set()
        for art, disp, papel in t["base_legal"]:
            chave = (art, disp)
            if chave in vistos:  # mesmo dispositivo com dois papéis: fica o primeiro
                continue
            vistos.add(chave)
            out.append(
                "insert into public.tarefas_catalogo_base_legal (tarefa_codigo, norma, artigo, dispositivo, papel) values "
                f"({lit(t['codigo'])}, {lit(norma)}, {art}, {lit(disp)}, {lit(papel)});"
            )

    out.append("\n-- dependências (recria por tarefa)")
    out.append(f"delete from public.tarefas_catalogo_dependencias where tarefa_codigo in ({codigos});")
    for t in cat["tarefas"]:
        for dep, tipo in t.get("depende_de", []):
            out.append(
                "insert into public.tarefas_catalogo_dependencias (tarefa_codigo, depende_de_codigo, tipo) values "
                f"({lit(t['codigo'])}, {lit(dep)}, {lit(tipo)});"
            )

    out += ["", "commit;", ""]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalogo", default="data/catalogo_tarefas_14133.yaml")
    ap.add_argument("--textos", default="data/lei14133_textos")
    ap.add_argument("--saida", default="supabase/migrations/20260927100100_seed_catalogo_tarefas_14133.sql")
    ap.add_argument("--check", action="store_true", help="só valida, não escreve")
    args = ap.parse_args()

    cat = yaml.safe_load(Path(args.catalogo).read_text(encoding="utf-8"))
    textos = ler_textos(Path(args.textos))
    try:
        validar(cat, textos)
    except CatalogoInvalido as exc:
        print(f"CATÁLOGO INVÁLIDO:\n{exc}", file=sys.stderr)
        return 1
    if args.check:
        print(f"OK: {len(cat['tarefas'])} tarefas, {len(textos)} artigos.")
        return 0
    Path(args.saida).write_text(gerar(cat, textos), encoding="utf-8", newline="\n")
    print(f"Gerado {args.saida}: {len(cat['tarefas'])} tarefas, {len(textos)} artigos.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

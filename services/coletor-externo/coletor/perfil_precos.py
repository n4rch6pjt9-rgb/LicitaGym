"""Rotulador de "fora do perfil" nos preços homologados (spec 0037).

"Fora do perfil" = o produto comprado não é o produto do PDM/item CATMAT (ex.: esteira transportadora de resíduos
cadastrada como esteira ergométrica, compra 93099205000052026). Comprador de outro ramo (hospital, fisioterapia,
quartel) comprando o mesmo produto é "no perfil"; preço alto ou baixo sozinho também não decide.

Uma chamada ao modelo por compra (o objeto e o comprador são da compra), com os itens dela. Entram objeto, UASG/órgão,
PDM, item CATMAT, descrição detalhada, marca/fabricante/modelo, unidade, preço e a mediana do mesmo PDM + unidade em
12 meses (só como sinal), e o veredito das regras de `escopo.py` sobre o objeto e sobre o item (só como sinal).
Nunca entram fornecedor, CNPJ ou CPF.

Fase 0 (esta versão): só `--dry-run`. Lê a base, rotula uma amostra estratificada e loga o rótulo de cada item, os
tokens e a projeção para a base inteira. A gravação (tabela `precos_rotulo_perfil`) é da fase 1.

Uso (Cloud Run Job, como a coleta de preços):
    --args="--coleta,perfil-precos,--dry-run,--limite,50"
    --args="--coleta,perfil-precos,--dry-run,--compras,93099205000052026"
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable

from coletor import escopo
from coletor.ia import tipo_falha

log = logging.getLogger("coletor.perfil_precos")

VERSAO_PROMPT = "0037.1"
# Compras que entram sempre na amostra da fase 0 (gabarito da spec 0037): esteira transportadora no PDM 7115.
ANCORAS = ("93099205000052026",)
ROTULOS = ("no_perfil", "fora_do_perfil", "incerto")
SINAIS = ("objeto", "descricao", "marca", "comprador", "preco")
MOTIVO_MAX = 240
TABELA = "precos_praticados_itens"
# Só o que o prompt usa. Fornecedor (nome, CNPJ/CPF) fica de fora de propósito (LGPD; e não decide o perfil).
COLUNAS = ("id_compra,id_item_compra,numero_item_compra,codigo_pdm,nome_pdm,codigo_item_catalogo,descricao_item,"
           "descricao_detalhada_item,marca,fabricante,modelo,sigla_unidade_fornecimento,preco_unitario,"
           "data_resultado,objeto_compra,nome_uasg,nome_orgao")
TENTATIVAS_JSON = int(os.environ.get("PERFIL_TENTATIVAS_JSON", "3"))
# Teto de saída por chamada (inclui o pensamento no Gemini 3) e itens por chamada: compra grande vai em lotes, cada
# lote com o objeto e o comprador, para o JSON nunca ser cortado no meio.
MAX_SAIDA = int(os.environ.get("PERFIL_MAX_TOKENS", "8192"))
# 6 itens desde 23/10/2026: lotes de 15 levavam mais de 37 s no 3.8 Flash global e estouravam o prazo (execução f4fx6);
# com 6, as chamadas voltaram em 6 a 9 s (execução pqfms).
ITENS_POR_CHAMADA = int(os.environ.get("PERFIL_ITENS_POR_CHAMADA", "6"))
# Falha do Vertex (500, prazo) numa compra conta como erro dela e a rodada segue; muitas seguidas param a rodada.
TENTATIVAS_VERTEX = int(os.environ.get("PERFIL_TENTATIVAS_VERTEX", "3"))
MAX_FALHAS_SEGUIDAS = int(os.environ.get("PERFIL_MAX_FALHAS_SEGUIDAS", "8"))
# Ritmo do Vertex (23/10, execução qdh48: o endpoint global do 3.8 Flash devolveu 429 e 504 em rajada e cada 504
# levava ~90s). Pausa mínima entre chamadas, espera longa entre tentativas e prazo próprio por chamada.
PAUSA_S = float(os.environ.get("PERFIL_PAUSA_S", "4"))
ESPERAS_VERTEX = tuple(float(x) for x in os.environ.get("PERFIL_ESPERAS_S", "30,60").split(",") if x.strip())
# 90 s: com 40 s o Vertex desistia em ~37 s e cortava chamadas que terminariam (o prazo vai ao servidor).
TIMEOUT_MS = int(os.environ.get("PERFIL_TIMEOUT_MS", "90000"))
TEXTO_MAX = 600   # por campo de texto no prompt (descrição detalhada pode ser longa)

# (texto da resposta, uso de tokens) — o modelo real é Gemini (ia.py); nos testes, uma função falsa.
Modelo = Callable[[str], tuple[str, dict]]


class RespostaInvalida(ValueError):
    """Resposta do modelo fora do JSON combinado (K-3)."""


class RespostaCortada(RespostaInvalida):
    """O modelo parou no teto de tokens: repetir a mesma chamada dá o mesmo corte, então não se tenta de novo."""


@dataclass
class Resumo:
    compras: int = 0
    itens: int = 0
    rotulos: dict = field(default_factory=lambda: {r: 0 for r in ROTULOS})
    erros: int = 0
    descartados: int = 0
    tokens_entrada: int = 0
    tokens_saida: int = 0
    tokens_pensamento: int = 0
    chamadas: int = 0
    chamadas_perdidas: int = 0      # respostas inválidas ou cortadas (os tokens delas ficam à parte na projeção)
    tokens_perdidos: int = 0
    erros_por_tipo: dict = field(default_factory=dict)   # compras sem rótulo, pelo tipo da última falha

    def somar_uso(self, uso: dict) -> None:
        self.chamadas += 1
        self.tokens_entrada += int(uso.get("entrada") or 0)
        self.tokens_saida += int(uso.get("saida") or 0)
        self.tokens_pensamento += int(uso.get("pensamento") or 0)


# ---------------------------------------------------------------------------------------------------- dados

def _num(v) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n == n else None


# CPF/CNPJ que apareçam no texto livre (marca de MEI, descrição) não vão ao modelo nem ao log.
_DOC = re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")


def sem_documento(s: str) -> str:
    return _DOC.sub("[doc]", s)


def _txt(v, limite: int = TEXTO_MAX) -> str | None:
    if v is None:
        return None
    s = sem_documento(" ".join(str(v).split()))
    if not s:
        return None
    return s if len(s) <= limite else s[: limite - 1] + "…"


def carregar_linhas(sb, pdms: list[int] | None = None, compras: list[str] | None = None) -> list[dict]:
    """Linhas de preço com o que o prompt precisa. Sem filtro: a base toda (a mediana precisa do PDM inteiro)."""
    # order pela PK inteira: a leitura é por offset (a tabela não tem `id`) e `id_compra` sozinho empata entre os itens
    # da mesma compra, o que faria a página seguinte repetir ou pular linhas.
    filtros: dict[str, str] = {"select": COLUNAS, "preco_unitario": "gt.0", "order": "id_compra.asc,id_item_compra.asc"}
    if pdms:
        filtros["codigo_pdm"] = "in.(" + ",".join(str(p) for p in pdms) + ")"
    if compras:
        filtros["id_compra"] = "in.(" + ",".join(compras) + ")"
    linhas = sb.selecionar(TABELA, **filtros)
    if not isinstance(linhas, list):
        raise RuntimeError(f"leitura de {TABELA} respondeu {type(linhas).__name__}, esperado lista")
    return linhas


def medianas(linhas: list[dict], hoje: date, meses: int = 12) -> dict[tuple[str, str], tuple[float, int]]:
    """Mediana do preço por (PDM, unidade de fornecimento) nos últimos `meses`, pela data do resultado."""
    corte = (hoje - timedelta(days=round(meses * 365.25 / 12))).isoformat()
    grupos: dict[tuple[str, str], list[float]] = defaultdict(list)
    for l in linhas:
        p = _num(l.get("preco_unitario"))
        d = str(l.get("data_resultado") or "")[:10]
        if p and p > 0 and d >= corte:
            grupos[(str(l.get("codigo_pdm")), str(l.get("sigla_unidade_fornecimento") or ""))].append(p)
    return {k: (round(statistics.median(v), 2), len(v)) for k, v in grupos.items()}


def agrupar_por_compra(linhas: list[dict]) -> dict[str, list[dict]]:
    por: dict[str, list[dict]] = defaultdict(list)
    for l in linhas:
        if l.get("id_compra") and l.get("id_item_compra") is not None:
            por[str(l["id_compra"])].append(l)
    for itens in por.values():
        itens.sort(key=lambda l: (l.get("numero_item_compra") or 0, l.get("id_item_compra") or 0))
    return dict(por)


def _ordem_estavel(chave: str) -> str:
    return hashlib.md5(chave.encode()).hexdigest()


def amostra_estratificada(por_compra: dict[str, list[dict]], limite: int, fixas: list[str] | None = None) -> list[str]:
    """Compras para a fase 0: as `fixas` (âncoras) primeiro e depois uma por PDM em rodízio, em ordem estável (md5 do
    id), para cobrir os PDMs em vez de concentrar nos que têm mais compras. A compra entra na fila de TODOS os PDMs dos
    seus itens (um PDM que só aparece no 2º item de alguma compra também é coberto); compra já escolhida não se repete
    e o PDM que ela já cobre perde a vez. Mesma entrada, mesma amostra."""
    escolhidas = [c for c in (fixas or []) if c in por_compra]
    usadas = set(escolhidas)
    pdms_de = {c: {str(l.get("codigo_pdm")) for l in itens} for c, itens in por_compra.items()}
    cobertos = set().union(*(pdms_de[c] for c in escolhidas)) if escolhidas else set()
    por_pdm: dict[str, list[str]] = defaultdict(list)
    for c, pdms in pdms_de.items():
        for pdm in pdms:
            por_pdm[pdm].append(c)
    filas = {pdm: sorted(v, key=_ordem_estavel) for pdm, v in sorted(por_pdm.items())}
    while len(escolhidas) < limite:
        # primeiro os PDMs ainda sem nenhuma compra na amostra; depois rodízio entre todos
        pendentes = [p for p in filas if p not in cobertos and filas[p]] or [p for p in filas if filas[p]]
        if not pendentes:
            break
        avancou = False
        for pdm in pendentes:
            fila = filas[pdm]
            while fila and fila[0] in usadas:
                fila.pop(0)
            if not fila or len(escolhidas) >= limite:
                continue
            c = fila.pop(0)
            escolhidas.append(c)
            usadas.add(c)
            cobertos |= pdms_de[c]
            avancou = True
        if not avancou:
            break
    return escolhidas[:limite] if limite else escolhidas


def montar_entrada(itens: list[dict], meds: dict[tuple[str, str], tuple[float, int]]) -> dict:
    """Entrada normalizada de uma compra. É ela que vai no prompt e no hash (K-2: refazer só o que mudou)."""
    base = itens[0]
    objeto = _txt(base.get("objeto_compra"), 1500)
    saida_itens = []
    for l in itens:
        pdm = str(l.get("codigo_pdm"))
        un = str(l.get("sigla_unidade_fornecimento") or "")
        med = meds.get((pdm, un))
        desc = _txt(l.get("descricao_item"))
        saida_itens.append({
            "id": int(l["id_item_compra"]),
            "numero_item": l.get("numero_item_compra"),
            "pdm": {"codigo": pdm, "nome": _txt(l.get("nome_pdm"), 120)},
            "item_catmat": {"codigo": l.get("codigo_item_catalogo"), "descricao": desc},
            "descricao_detalhada": _txt(l.get("descricao_detalhada_item")),
            "marca": _txt(l.get("marca"), 120),
            "fabricante": _txt(l.get("fabricante"), 120),
            "modelo": _txt(l.get("modelo"), 160),
            "unidade": un or None,
            "preco_unitario": _num(l.get("preco_unitario")),
            "mediana_pdm_unidade_12m": {"valor": med[0], "n": med[1]} if med else None,
            "regra_escopo_item": escopo.classificar_texto_item(desc or "")[0],
        })
    return {
        "id_compra": str(base["id_compra"]),
        "objeto": objeto,
        "comprador": _txt(" / ".join(x for x in (base.get("nome_orgao"), base.get("nome_uasg")) if x), 300),
        # classificar() SEM classes_catmat: com o código CATMAT do item ele diria "catmat" sempre. O que importa aqui é
        # se o OBJETO fala de academia/esporte; None não decide nada (muito objeto é genérico).
        "regra_escopo_objeto": escopo.classificar(objeto or ""),
        "itens": saida_itens,
    }


def hash_entrada(entrada: dict) -> str:
    bruto = json.dumps(entrada, ensure_ascii=False, sort_keys=True) + "|" + VERSAO_PROMPT
    return hashlib.sha256(bruto.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------------------------------- prompt

PROMPT = """Você revisa preços homologados de compras públicas brasileiras usados como referência de preço de
equipamentos de academia, ginástica, esporte e recreação. Para cada item da compra abaixo, decida se o PRODUTO
comprado é de fato o produto do PDM/item CATMAT informado.

Rótulos:
- "no_perfil": o produto comprado é o do PDM/item CATMAT. Comprador de qualquer ramo (hospital, fisioterapia,
  quartel, escola, presídio, prefeitura) comprando o mesmo produto é "no_perfil".
- "fora_do_perfil": o produto comprado é outro, apesar do código CATMAT. Exemplo: "esteira elétrica" num consórcio de
  resíduos sólidos, com marca/modelo de esteira transportadora industrial, cadastrada no PDM de esteira ergométrica.
- "incerto": os dados não bastam para decidir.

Regras:
- Decida pelo conjunto: objeto da compra, comprador, descrição do item, marca/fabricante/modelo. Preço muito diferente
  da mediana é só um sinal; sozinho nunca decide "fora_do_perfil".
- "regra_escopo_objeto" e "regra_escopo_item" são saídas de regras automáticas de palavras-chave (null = a regra não
  reconheceu). São sinais fracos: objeto genérico ("aquisição de material permanente") é comum e não indica nada.
- Não invente fatos. O motivo cita o trecho que decidiu (até {motivo_max} caracteres, em português).
- "sinais": quais campos pesaram, dentre {sinais}.

Responda SOMENTE com JSON neste formato, um elemento por item recebido (use o "id" do item):
{{"itens": [{{"id": <id>, "rotulo": "no_perfil" | "fora_do_perfil" | "incerto", "motivo": "<texto>",
"sinais": ["objeto", ...]}}]}}

Compra:
{entrada}
"""


def montar_prompt(entrada: dict) -> str:
    return PROMPT.format(motivo_max=MOTIVO_MAX, sinais=", ".join(SINAIS),
                         entrada=json.dumps(entrada, ensure_ascii=False, indent=1))


def validar_resposta(texto: str, ids: set[int]) -> tuple[dict[int, dict], list]:
    """Rótulos por id_item_compra e a lista do que foi descartado (id que não estava na entrada). Resposta que não é o
    JSON combinado levanta RespostaInvalida; item recebido sem resposta também (não se inventa rótulo)."""
    try:
        dados = json.loads(texto)
    except (json.JSONDecodeError, TypeError) as e:
        raise RespostaInvalida(f"JSON inválido: {e}") from e
    if not isinstance(dados, dict) or not isinstance(dados.get("itens"), list):
        raise RespostaInvalida("esperado objeto com a lista 'itens'")
    rotulos: dict[int, dict] = {}
    descartados = []
    vistos: set[int] = set()
    for it in dados["itens"]:
        if not isinstance(it, dict):
            raise RespostaInvalida(f"item fora do formato: {it!r}")
        ident = it.get("id")
        if isinstance(ident, bool) or not isinstance(ident, int):
            raise RespostaInvalida(f"id inválido: {ident!r}")
        if ident in vistos:
            raise RespostaInvalida(f"id repetido na resposta: {ident}")
        vistos.add(ident)
        if ident not in ids:
            descartados.append(ident)
            continue
        rot = it.get("rotulo")
        motivo = it.get("motivo")
        sinais = it.get("sinais", [])
        if rot not in ROTULOS:
            raise RespostaInvalida(f"rótulo inválido: {rot!r}")
        if not isinstance(motivo, str) or not motivo.strip():
            raise RespostaInvalida(f"motivo vazio no item {ident}")
        if not isinstance(sinais, list) or any(s not in SINAIS for s in sinais):
            raise RespostaInvalida(f"sinais inválidos no item {ident}: {sinais!r}")
        rotulos[ident] = {"rotulo": rot, "motivo": sem_documento(" ".join(motivo.split()))[:MOTIVO_MAX],
                          "sinais": list(dict.fromkeys(sinais))}
    faltando = ids - set(rotulos)
    if faltando:
        raise RespostaInvalida(f"itens sem resposta: {sorted(faltando)}")
    return rotulos, descartados


def lotes(entrada: dict) -> list[dict]:
    """A compra em lotes de até ITENS_POR_CHAMADA itens, cada um com o objeto e o comprador (o contexto que decide)."""
    itens = entrada["itens"]
    tam = max(1, ITENS_POR_CHAMADA)
    return [{**entrada, "itens": itens[k:k + tam]} for k in range(0, len(itens), tam)] or [entrada]


def _rotular_lote(modelo: Modelo, entrada: dict, resumo: Resumo) -> dict[int, dict]:
    prompt = montar_prompt(entrada)
    ids = {i["id"] for i in entrada["itens"]}
    ultimo: Exception | None = None
    for _ in range(max(1, TENTATIVAS_JSON)):
        texto, uso = modelo(prompt)
        resumo.somar_uso(uso)
        try:
            if uso.get("cortada"):
                raise RespostaCortada("resposta cortada no teto de tokens (PERFIL_MAX_TOKENS)")
            rotulos, descartados = validar_resposta(texto, ids)
        except RespostaInvalida as e:
            resumo.chamadas_perdidas += 1
            resumo.tokens_perdidos += sum(int(uso.get(k) or 0) for k in ("entrada", "saida", "pensamento"))
            ultimo = e
            if isinstance(e, RespostaCortada):
                break
            log.warning("perfil: compra %s resposta inválida (%s); tentando de novo", entrada["id_compra"], e)
            continue
        if descartados:
            resumo.descartados += len(descartados)
            log.warning("perfil: compra %s: ids fora da entrada descartados: %s", entrada["id_compra"], descartados)
        return rotulos
    raise ultimo if isinstance(ultimo, RespostaInvalida) else RespostaInvalida(str(ultimo))


def rotular_compra(modelo: Modelo, entrada: dict, resumo: Resumo) -> dict[int, dict]:
    """Uma chamada por lote de itens (mais novas tentativas se o JSON vier errado; resposta cortada não se repete).
    Lote que esgota as tentativas levanta RespostaInvalida: quem chama conta o erro da compra inteira e segue, sem
    gravar nada para ela."""
    rotulos: dict[int, dict] = {}
    for lote in lotes(entrada):
        rotulos.update(_rotular_lote(modelo, lote, resumo))
    return rotulos


# ---------------------------------------------------------------------------------------------------- execução

def _reais(v: float | None) -> str:
    return "—" if v is None else f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def executar(sb, modelo: Modelo, *, dry_run: bool = True, limite: int = 50, pdms: list[int] | None = None,
             compras: list[str] | None = None, hoje: date | None = None) -> dict:
    """Fase 0: rotula a amostra e devolve o resumo com a projeção para a base. Sem `dry_run` levanta: a gravação é da
    fase 1 (a tabela `precos_rotulo_perfil` ainda não existe)."""
    if not dry_run:
        raise NotImplementedError("perfil-precos: gravação é da fase 1 da spec 0037 (tabela precos_rotulo_perfil "
                                  "ainda não criada); use --dry-run")
    hoje = hoje or date.today()
    linhas = carregar_linhas(sb, pdms=pdms)
    meds = medianas(linhas, hoje)
    por_compra = agrupar_por_compra(linhas)
    faltam: list[str] = []
    if compras:
        faltam = [c for c in compras if c not in por_compra]
        if faltam:
            log.error("perfil: compras sem preço na base (ou fora dos PDMs pedidos): %s", faltam)
        alvo = [c for c in compras if c in por_compra]
        recorte = "compras"
    else:
        alvo = amostra_estratificada(por_compra, limite, fixas=list(ANCORAS))
        recorte = "pdms" if pdms else "base"
    log.info("perfil: base com %s linhas em %s compras; rotulando %s compras (dry-run, prompt %s)",
             len(linhas), len(por_compra), len(alvo), VERSAO_PROMPT)

    resumo = Resumo()
    falhas_seguidas = 0
    for c in alvo:
        entrada = montar_entrada(por_compra[c], meds)
        gasto_antes = resumo.tokens_entrada + resumo.tokens_saida + resumo.tokens_pensamento
        perdido_antes = resumo.tokens_perdidos
        try:
            rotulos = rotular_compra(modelo, entrada, resumo)
        except Exception as e:  # noqa: BLE001 - resposta inválida OU falha do Vertex numa compra não derruba as outras
            # Compra descartada inteira: TODOS os tokens dela (inclusive dos lotes que deram certo) ficam fora da
            # projeção, para tokens e itens da projeção serem do mesmo conjunto.
            resumo.tokens_perdidos = perdido_antes + (
                resumo.tokens_entrada + resumo.tokens_saida + resumo.tokens_pensamento - gasto_antes)
            resumo.erros += 1
            falhas_seguidas += 1
            tipo = "resposta inválida" if isinstance(e, RespostaInvalida) else tipo_falha(e)
            resumo.erros_por_tipo[tipo] = resumo.erros_por_tipo.get(tipo, 0) + 1
            log.error("perfil: compra %s sem rótulo (%s): %s", c, tipo, str(e)[:300])
            if falhas_seguidas >= MAX_FALHAS_SEGUIDAS:
                log.error("perfil: %s compras seguidas sem rótulo; parando a rodada", falhas_seguidas)
                break
            continue
        falhas_seguidas = 0
        resumo.compras += 1
        for item in entrada["itens"]:
            r = rotulos[item["id"]]
            resumo.itens += 1
            resumo.rotulos[r["rotulo"]] += 1
            med = item["mediana_pdm_unidade_12m"]
            log.info("perfil: [%s] compra %s item %s PDM %s %s | preço %s (mediana %s) | %s",
                     r["rotulo"], c, item["numero_item"], item["pdm"]["codigo"], item["pdm"]["nome"] or "",
                     _reais(item["preco_unitario"]), _reais(med["valor"]) if med else "—", r["motivo"])
    res = _fechar(resumo, recorte=recorte, total_itens=len(linhas), total_compras=len(por_compra))
    if faltam:
        res["sucesso"] = False
        res["compras_nao_encontradas"] = faltam
    return res


def _fechar(resumo: Resumo, *, recorte: str, total_itens: int, total_compras: int) -> dict:
    validas = resumo.chamadas - resumo.chamadas_perdidas
    tokens_validos = resumo.tokens_entrada + resumo.tokens_saida + resumo.tokens_pensamento - resumo.tokens_perdidos
    por_chamada = None
    if resumo.chamadas:
        por_chamada = {k: round(v / resumo.chamadas) for k, v in (
            ("entrada", resumo.tokens_entrada), ("saida", resumo.tokens_saida), ("pensamento", resumo.tokens_pensamento))}
    projecao = None
    # Projeção por ITEM (o custo cresce com os itens da compra; a amostra em rodízio por PDM não representa o tamanho
    # das compras) e só quando o recorte é a base: com --pdms ou --compras o número não diz nada sobre a base.
    if recorte == "base" and resumo.itens:
        fracao_entrada = resumo.tokens_entrada / max(1, resumo.tokens_entrada + resumo.tokens_saida + resumo.tokens_pensamento)
        por_item = tokens_validos / resumo.itens
        total = round(por_item * total_itens)
        projecao = {
            "itens_na_base": total_itens,
            "compras_na_base": total_compras,
            "tokens_por_item": round(por_item),
            "tokens_entrada": round(total * fracao_entrada),
            "tokens_saida_mais_pensamento": round(total * (1 - fracao_entrada)),
        }
        # Preço por milhão de tokens (USD) do GEN_MODEL vigente, informado no Job: o código não inventa tabela de preço.
        pe, ps = _num(os.environ.get("PRECO_ENTRADA_USD_MTOK")), _num(os.environ.get("PRECO_SAIDA_USD_MTOK"))
        if pe is not None and ps is not None:
            projecao["custo_usd"] = round(projecao["tokens_entrada"] / 1e6 * pe
                                          + projecao["tokens_saida_mais_pensamento"] / 1e6 * ps, 2)
    return {
        "sucesso": resumo.erros == 0,
        "recorte": recorte,
        "versao_prompt": VERSAO_PROMPT,
        "compras_rotuladas": resumo.compras,
        "itens": resumo.itens,
        "rotulos": resumo.rotulos,
        "erros": resumo.erros,
        "erros_por_tipo": resumo.erros_por_tipo,
        "ids_descartados": resumo.descartados,
        "chamadas": resumo.chamadas,
        "chamadas_validas": validas,
        "chamadas_perdidas": resumo.chamadas_perdidas,
        "tokens": {"entrada": resumo.tokens_entrada, "saida": resumo.tokens_saida,
                   "pensamento": resumo.tokens_pensamento, "perdidos": resumo.tokens_perdidos,
                   "por_chamada": por_chamada},
        "projecao_base": projecao,
    }


def _respeitar_pausa(ultima: list[float], pausa: float | None = None, *, relogio=time.monotonic,
                     dormir=time.sleep) -> None:
    """Garante PAUSA_S entre o início de duas chamadas ao Vertex (inclusive as novas tentativas). `ultima` guarda o
    instante da chamada anterior."""
    pausa = PAUSA_S if pausa is None else pausa
    falta = ultima[0] + pausa - relogio() if ultima[0] else 0.0
    if falta > 0:
        dormir(falta)
    ultima[0] = relogio()


def modelo_gemini() -> Modelo:
    """Gemini do Vertex (ia.py: GEN_MODEL, projeto GOOGLE_CLOUD_PROJECT, créditos do projeto GCP), JSON na saída."""
    from coletor.ia import GEN_MODEL, Gemini, motivo_fim

    g = Gemini(timeout_ms=TIMEOUT_MS)
    cfg = g._config(temperatura=0, response_mime_type="application/json", max_output_tokens=MAX_SAIDA)
    ultima = [0.0]

    def gerar(prompt: str):
        _respeitar_pausa(ultima)
        return g.client.models.generate_content(model=GEN_MODEL, contents=prompt, config=cfg)

    def chamar(prompt: str) -> tuple[str, dict]:
        # Poucas tentativas: com o padrão (8) um 500 do Vertex prendia a rodada por ~17 min (22/10, execução lx294).
        r = g._retry(lambda: gerar(prompt), tentativas=TENTATIVAS_VERTEX, esperas=ESPERAS_VERTEX)
        u = getattr(r, "usage_metadata", None)
        uso = {"entrada": getattr(u, "prompt_token_count", 0) or 0,
               "saida": getattr(u, "candidates_token_count", 0) or 0,
               "pensamento": getattr(u, "thoughts_token_count", 0) or 0,
               "cortada": motivo_fim(r) == "MAX_TOKENS"}
        return r.text or "", uso

    return chamar


class SoLeitura:
    """No dry-run o rotulador só lê: qualquer outra operação no Supabase é bloqueada."""

    def __init__(self, sb):
        self._sb = sb

    def selecionar(self, tabela: str, **filtros):
        return self._sb.selecionar(tabela, **filtros)

    def __getattr__(self, nome):
        raise PermissionError(f"perfil-precos dry-run: {nome} bloqueado (cliente somente leitura)")

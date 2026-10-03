"""Âncoras do catálogo CATMAT da empresa e casamento ancorado no começo da descrição do item (regra do "forte").

Decisão do Marcelo (03/10/2026, 19:00 BRT): uma compra só é "forte" quando algum item de material casa, no MODO
NÚCLEO, uma âncora de PDM ou de item incluído no catálogo da empresa. As listas fixas de escopo.py deixam de
promover a "forte" (no máximo "fraco"); piso, borracha e obra_piso seguem como estão. Dry-run em produção
(TAXONOMIA-DRYRUN-RESULTADOS.md, 18:44-18:51 BRT): 529 das 632 compras leads/monitorar casam no modo núcleo.

De onde vêm as âncoras: dos itens CATMAT do catálogo efetivo gravados em catmat_item_pdm (tabela que a api-catmat
já hidrata; nenhuma tabela nova), mais os itens incluídos avulsos. A descrição do item é quebrada em nome (cabeça)
e atributos ("ANILHA, MATERIAL: FERRO, COR: PRETA" -> ANILHA + MATERIAL=FERRO, COR=PRETA), e cada item gera:
  - cabeca: o nome do item (e as partes de "A / B" e "A - B"), ex.: "corda de pular", "caneleira";
  - atributo_tipo: o TIPO, quando a cabeça é genérica ("APARELHO / EQUIPAMENTO ..."), ex.: "cadeira extensora";
  - atributo_nome: o atributo NOME;
  - item_avulso: item incluído de PDM fora do catálogo: cabeça + MATERIAL (ex.: "piso sintetico borracha").
Mesma regra de catmat_ancoras_geradas() da migration 20261003200000 (não aplicada) e do TAXONOMIA-DRYRUN.sql.

Casamento (casar): tokens da descrição do item sem o enchimento inicial ("ITEM 1 -", "LOTE", "KIT", "CATMAT 123");
o 1º token tem de ser o núcleo da âncora (com plural); as demais palavras da âncora entre os 11 tokens seguintes
(estrito). Modo núcleo: âncora de cabeça cujo núcleo não é genérico (bola, mesa, corda, banco...) casa só pelo
núcleo ("CANELEIRAS 2 KG" casa "caneleira"; "CORDA NAVAL" não casa "corda de pular").
"""
from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

log = logging.getLogger("coletor.catmat_ancoras")

TABELA_ITENS = "catmat_item_pdm"
PAGINA = 100   # regra dos coletores Python: no máximo 100 linhas por página
MAX_PAGINAS = 200   # 20 mil itens por bloco de PDMs: muito acima dos ~660 do catálogo de hoje
MODOS = ("nucleo", "estrito")

_MAI = "A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9"
# vírgula seguida de CHAVE EM MAIÚSCULAS e dois-pontos (= catmat_atributos_da_descricao / quebrarDescricaoItem)
_SEPARADOR = re.compile(r",\s*(?=[" + _MAI + r"][" + _MAI + r" /().ºª-]{0,80}:)")
_GENERICO = re.compile(r"^(aparelho|equipamento)\b")
# cabeça de uma palavra só que não identifica produto
_CABECA_FRACA = frozenset({"bola", "mesa", "estante", "suporte", "corda", "cinto"})
# valores de TIPO que não identificam nada sozinhos
_TIPO_FRACO = frozenset({
    "eletrica", "eletrico", "mecanica", "mecanico", "articulado", "barra", "escada", "manual", "simples", "duplo",
    "dupla", "nao aplicavel", "outros", "outro", "roda", "caixa", "transport", "puxador", "biceps", "conjugado",
    "extensor", "argola", "pedestal", "abdominal", "pelota", "universal", "profissional", "infantil", "adulto"})
# núcleos genéricos: no modo núcleo a âncora com esse núcleo precisa casar inteira
GENERICOS = frozenset({
    "bola", "mesa", "corda", "cinto", "estante", "suporte", "esteira", "banco", "escada", "aparelho", "equipamento",
    "piso", "grama", "borracha", "cama", "bicicleta", "cadeira", "extensor", "material"})
_CONECTIVOS = frozenset({"a", "com", "da", "das", "de", "do", "dos", "e", "em", "o", "p", "para", "uso"})
_ENCHIMENTO = ("item|itens|lote|lotes|cota|catmat|kit|kits|par|pares|jogo|jogos|conjunto|conjuntos|unico|principal|"
               "reservada|ampla|material|materiais|esportivo|esportivos|contendo|unidades|unidade|pecas|no|n|com|de|"
               "[ivxl]+|[0-9]+[a-z]{0,2}|[a-z]{2}[0-9]{7}")
_PREFIXO = re.compile(r"^[^a-z0-9]*(?:(?:" + _ENCHIMENTO + r")[^a-z0-9]+)*")
JANELA = 11
_TR = str.maketrans("áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ",
                    "aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc")


class AncorasIndisponiveis(RuntimeError):
    """Itens do catálogo ilegíveis ou PDM efetivo sem itens em catmat_item_pdm (as âncoras ficariam incompletas)."""


def _norm(s: str | None) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


def _lg_normalizar(s: str | None) -> str:
    """= public.lg_normalizar: minúsculas, sem acento, pontuação mantida."""
    return (s or "").translate(_TR).lower()


def quebrar_descricao(descricao: str | None) -> tuple[str, list[tuple[str, str]]]:
    """("ANILHA, MATERIAL: FERRO , COR: PRETA") -> ("ANILHA", [("MATERIAL", "FERRO"), ("COR", "PRETA")])."""
    partes = _SEPARADOR.split((descricao or "").strip())
    nome = partes[0].strip().rstrip(",").strip()
    atributos = []
    for p in partes[1:]:
        k, _, v = p.partition(":")
        atributos.append((re.sub(r"\s+", " ", k).strip(), re.sub(r"\s+", " ", v).strip().rstrip(",").strip()))
    return nome, atributos


def variantes(w: str) -> frozenset[str]:
    """Plural/singular simples (haltere ~ halter/halteres; colchonete ~ colchonetes; bambolê ~ bamboles)."""
    v = {w}
    if w[-1] in "aeiou":
        v.add(w + "s")
    elif w[-1] == "l":
        v.add(w[:-1] + "is")
    elif w[-1] == "m":
        v.add(w[:-1] + "ns")
    elif w[-1] in "rz":
        v.add(w + "es")
    if w.endswith("ao"):
        v |= {w[:-2] + "oes", w[:-2] + "aes"}
    if w.endswith("s") and len(w) > 3:
        v.add(w[:-1])
    if w.endswith("e") and len(w) > 4 and w[-2] in "rtl":
        v |= {w[:-1], w[:-1] + "es"}
    return frozenset(x for x in v if x)


def palavras(ancora: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", _lg_normalizar(ancora)) if w not in _CONECTIVOS]


def tokens(descricao: str | None) -> list[str]:
    return re.findall(r"[a-z0-9]+", _PREFIXO.sub("", _lg_normalizar(descricao), count=1))


def _variantes_cabeca(nome: str) -> set[str]:
    out = set()
    n = _norm(nome)
    if len(n) >= 4:
        out.add(n)
    if _GENERICO.match(n):
        return out   # cabeça genérica: só ela inteira (quem identifica é o TIPO)
    for parte in re.split(r"\s/\s|/", nome):
        b = _norm(re.split(r"\s-\s", parte)[0])
        if len(b) >= 4:
            out.add(b)
        p = _norm(parte)
        if len(p) >= 4 and not _GENERICO.match(p):
            out.add(p)
    return {a for a in out if a not in _CABECA_FRACA}


@dataclass(frozen=True)
class Ancora:
    codigo_pdm: int
    ancora: str
    origem: str                 # cabeca | atributo_tipo | atributo_nome | item_avulso
    codigo_item_origem: int
    nucleo: str
    resto: tuple[frozenset[str], ...]
    nucleo_basta: bool          # modo núcleo: casa só pelo núcleo


def gerar_ancoras(itens: Iterable[Mapping], pdms_catalogo: Iterable[int], itens_avulsos: Iterable[int] = (),
                  itens_excluidos: Iterable[int] = ()) -> list[Ancora]:
    """itens: {codigo_item, codigo_pdm, descricao} de catmat_item_pdm. Só PDMs do catálogo efetivo (fora os itens
    excluídos) e itens avulsos. Inativos entram (a licitação descreve o produto, não o status no Compras.gov)."""
    efetivos, avulsos, excluidos = set(pdms_catalogo), set(itens_avulsos), set(itens_excluidos)
    sel = sorted((it for it in itens if it["codigo_item"] not in excluidos
                  and (it["codigo_pdm"] in efetivos or it["codigo_item"] in avulsos)), key=lambda it: it["codigo_item"])
    res: dict[tuple[int, str], tuple[str, int]] = {}

    def add(pdm, a, origem, item):
        a = a.strip()
        if len(a) >= 4 and not a.isdigit():
            res.setdefault((pdm, a), (origem, item))

    cabecas: dict[str, set[int]] = {}
    for it in sel:
        nome, atributos = quebrar_descricao(it.get("descricao"))
        pdm, cab = it["codigo_pdm"], _norm(nome)
        cabecas.setdefault(cab, set()).add(pdm)
        if pdm not in efetivos:   # avulso de PDM fora do catálogo: cabeça + MATERIAL do item, ou NOME
            for k, v in atributos:
                k, v = _norm(k), _norm(v)
                if k == "material" and v:
                    add(pdm, cab + " " + " ".join(v.split()[:2]), "item_avulso", it["codigo_item"])
                if k == "nome" and v:
                    add(pdm, v, "item_avulso", it["codigo_item"])
            continue
        for a in _variantes_cabeca(nome):
            add(pdm, a, "cabeca", it["codigo_item"])
        for k, v in atributos:
            k, v = _norm(k), _norm(v)
            if k == "nome" and v and not _GENERICO.match(v) and len(v.split()) <= 5:
                add(pdm, v, "atributo_nome", it["codigo_item"])
            if k == "tipo" and _GENERICO.match(cab) and v and v not in _TIPO_FRACO and len(v) >= 4:
                add(pdm, v, "atributo_tipo", it["codigo_item"])
    # variante de cabeça que é a cabeça inteira de OUTRO PDM fica com o outro ('haltere' de 'HALTERE - USO PISCINA')
    out = []
    for (pdm, a), (origem, item) in sorted(res.items()):
        if a in cabecas and pdm not in cabecas[a]:
            continue
        ws = palavras(a)
        if not ws:
            continue
        out.append(Ancora(pdm, a, origem, item, ws[0], tuple(variantes(w) for w in ws[1:]),
                          origem == "cabeca" and ws[0] not in GENERICOS))
    return out


@dataclass(frozen=True)
class AncorasCatalogo:
    """Índice núcleo (com variantes) -> âncoras, e o modo do casamento."""
    ancoras: tuple[Ancora, ...] = ()
    modo: str = "nucleo"
    _indice: Mapping[str, tuple[Ancora, ...]] = field(default_factory=dict, compare=False, repr=False)

    @classmethod
    def de(cls, ancoras: Iterable[Ancora], modo: str = "nucleo") -> "AncorasCatalogo":
        if modo not in MODOS:
            raise ValueError(f"modo de casamento inválido: {modo!r}")
        idx: dict[str, list[Ancora]] = {}
        lista = tuple(ancoras)
        for a in lista:
            for v in variantes(a.nucleo):
                idx.setdefault(v, []).append(a)
        return cls(lista, modo, {k: tuple(v) for k, v in idx.items()})

    def casar(self, descricao: str | None) -> list[Ancora]:
        """Âncoras que a descrição do item casa (vazio = nenhuma)."""
        tk = tokens(descricao)
        if not tk:
            return []
        janela = set(tk[1:1 + JANELA])
        out = []
        for a in self._indice.get(tk[0], ()):
            if all(janela & rv for rv in a.resto) or (self.modo == "nucleo" and a.nucleo_basta):
                out.append(a)
        return out


def _inteiro(v) -> int | None:
    """Código CATMAT inteiro positivo (int ou texto só de dígitos, como em catmat_codigo._inteiro)."""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v > 0 else None
    s = str(v).strip() if v is not None else ""
    return int(s) if s.isdigit() and int(s) > 0 else None


def ler_itens_catalogo(sb, pdms: Iterable[int], itens_avulsos: Iterable[int] = ()) -> list[dict]:
    """codigo_item, codigo_pdm, descricao de catmat_item_pdm dos PDMs do catálogo e dos itens avulsos (GET, 100 por
    página). Falha de leitura ou linha fora do contrato -> AncorasIndisponiveis.
    Só a página vazia encerra (página curta não, como em coletor/paginacao.py, PR #211); teto de páginas contra laço."""
    def paginar(**filtro) -> list[dict]:
        linhas: list[dict] = []
        for _ in range(MAX_PAGINAS):
            try:
                lote = sb.selecionar(TABELA_ITENS, select="codigo_item,codigo_pdm,descricao", order="codigo_item.asc",
                                     limit=str(PAGINA), offset=str(len(linhas)), **filtro)
            except Exception as e:
                raise AncorasIndisponiveis(f"{TABELA_ITENS} falhou: {e}") from e
            if not isinstance(lote, list):
                raise AncorasIndisponiveis(f"{TABELA_ITENS} respondeu {type(lote).__name__}, esperado lista")
            if not lote:
                return linhas
            if len(lote) > PAGINA:
                raise AncorasIndisponiveis(f"{TABELA_ITENS}: página com {len(lote)} linhas (máximo {PAGINA})")
            linhas.extend(lote)
        raise AncorasIndisponiveis(f"{TABELA_ITENS}: passou de {MAX_PAGINAS} páginas sem página vazia")

    pdms, avulsos = sorted(set(pdms)), sorted(set(itens_avulsos))
    brutos = []
    for i in range(0, len(pdms), 50):
        brutos += paginar(codigo_pdm="in.(" + ",".join(map(str, pdms[i:i + 50])) + ")")
    for i in range(0, len(avulsos), 50):
        brutos += paginar(codigo_item="in.(" + ",".join(map(str, avulsos[i:i + 50])) + ")")
    vistos: dict[int, dict] = {}
    for ln in brutos:
        item, pdm = (_inteiro(ln.get(k)) if isinstance(ln, dict) else None for k in ("codigo_item", "codigo_pdm"))
        if item is None or pdm is None:
            raise AncorasIndisponiveis(f"{TABELA_ITENS}: linha inválida: {ln!r}")
        vistos[item] = {"codigo_item": item, "codigo_pdm": pdm, "descricao": ln.get("descricao")}
    return [vistos[k] for k in sorted(vistos)]


def carregar_ancoras(sb, pdms_catalogo: Iterable[int], itens_avulsos: Iterable[int] = (),
                     itens_excluidos: Iterable[int] = (), modo: str = "nucleo") -> AncorasCatalogo:
    """Lê os itens e gera as âncoras. PDM efetivo sem nenhum item em catmat_item_pdm -> AncorasIndisponiveis
    (fail-closed: sem os itens o PDM inteiro deixaria de ser forte em silêncio; rode a carga dos itens antes)."""
    pdms = set(pdms_catalogo)
    itens = ler_itens_catalogo(sb, pdms, itens_avulsos)
    com_itens = {it["codigo_pdm"] for it in itens}
    sem = sorted(pdms - com_itens)
    if sem:
        raise AncorasIndisponiveis(f"{len(sem)} PDM(s) do catálogo efetivo sem itens em {TABELA_ITENS}: "
                                   f"{', '.join(map(str, sem[:20]))}{'...' if len(sem) > 20 else ''}")
    anc = gerar_ancoras(itens, pdms, itens_avulsos, itens_excluidos)
    log.info("Âncoras do catálogo: %d itens, %d âncoras em %d PDMs (modo %s)", len(itens), len(anc),
             len({a.codigo_pdm for a in anc}), modo)
    return AncorasCatalogo.de(anc, modo)

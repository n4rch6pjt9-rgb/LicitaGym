// Spec 0039: detecção de divergências numéricas dentro do mesmo atributo e mesmo item.
// Ex.: "Item 1 - Esteira: Peso máximo do usuário: 188,44Kg" vs "Suporta usuário de até 180 kg".
// Regra: emite achado quando há >=2 valores para o mesmo atributo, mesma unidade,
// pertencentes ao mesmo item/equipamento da licitação, com diferença acima do limiar
// (5% Categoria 1 / 10% Categoria 2). Faixas são ignoradas.
// Não afirma contradição entre equipamentos distintos (ex.: esteira vs bicicleta)
// nem quando a identidade do item não puder ser estabelecida.
import { normalizarComMapa } from "./achados.ts";
import { itemNaPosicao, trechoLimpo } from "./citacao.ts";
import { REGRA_VERSAO, type Achado, type Fonte } from "./tipos.ts";
import type { ChunkEdital } from "./edital.ts";

export interface AtributoDivergencia {
  codigo: string;
  rotulos: RegExp;
  unidade_padrao: string;
  limiar: number;
  categoria: 1 | 2;
}

// Categoria 1 (críticos, 5%): capacidade do usuário — divergência pode ser eliminatória.
// Categoria 2 (importantes, 10%): peso do equipamento e pilha de peso.
export const ATRIBUTOS_DIVERGENCIA: AtributoDivergencia[] = [
  {
    codigo: "peso_maximo_usuario",
    rotulos: /peso maximo do usuario|suporta usuario (de )?ate|capacidade (maxima )?(de )?usuario|classificacao de peso do usuario/,
    unidade_padrao: "kg",
    limiar: 0.04,
    categoria: 1,
  },
  {
    codigo: "peso_maximo_treino",
    rotulos: /peso maximo de trein(amento|o)/,
    unidade_padrao: "kg",
    limiar: 0.04,
    categoria: 1,
  },
  {
    codigo: "peso_equipamento",
    rotulos: /peso (do equipamento|da maquina|do produto|da unidade|equipamento)/,
    unidade_padrao: "kg",
    limiar: 0.10,
    categoria: 2,
  },
  {
    codigo: "pilha_peso",
    rotulos: /(pilha|torre|coluna) de peso/,
    unidade_padrao: "kg",
    limiar: 0.10,
    categoria: 2,
  },
];

export interface EscopoItem {
  equipamento: string | null;
  itemNumero: string | null;
}

interface MencaoAtributo {
  atributo: AtributoDivergencia;
  valor: number;
  unidade: string;
  inicio: number;
  fim: number;
  chunk: ChunkEdital;
  origem: number[];
  escopo: EscopoItem;
}

const RE_EQUIPAMENTO =
  /\b(esteira|bicicleta|bike|eliptico|transport|simulador|remo|esqui|escada|air\s*bike|spinning|supino|leg\s*press|puxador|remada|cross(?:over)?|hack|cadeira\s*extensora|mesa\s*flexora|extensora|flexora|adutor|abdutor|panturrilha|peck\s*deck|peitoral|desenvolvimento|gluteo|abdominal|smith|haltere?|anilhas?|dumbbel?l?)(?:es|s)?\b/gi;

const RE_EQUIPAMENTO_UNICO = new RegExp(RE_EQUIPAMENTO.source, "i");

const RE_ITEM_EXPLICITO =
  /(?<!\b(?:conforme|vide|ver|subitem|acordo com)(?:\s+(?:o|a|ao|no|do|os|as))?\s+)\b(?:item|lote)\s*(\d{1,3})\b(?!\s*[.,]\s*\d)/gi;

function normalizarEquipamento(eq: string): string {
  const s = eq.toLowerCase().trim().replace(/\s+/g, "_");
  if (s.startsWith("esteira")) return "esteira";
  if (s.startsWith("bicicleta") || s.startsWith("bike") || s.startsWith("spinning") || s.startsWith("air_bike")) return "bicicleta";
  if (s.startsWith("eliptico") || s.startsWith("transport")) return "eliptico";
  if (s.startsWith("simulador")) return "simulador";
  if (s.startsWith("remo")) return "remo";
  if (s.startsWith("escada")) return "escada";
  if (s.startsWith("leg_press")) return "leg_press";
  if (s.startsWith("supino")) return "supino";
  if (s.startsWith("puxador")) return "puxador";
  if (s.startsWith("remada")) return "remada";
  if (s.startsWith("cross")) return "crossover";
  if (s.startsWith("extensora") || s.includes("extensora")) return "extensora";
  if (s.startsWith("flexora") || s.includes("flexora")) return "flexora";
  if (s.startsWith("adutor")) return "adutor";
  if (s.startsWith("abdutor")) return "abdutor";
  if (s.startsWith("panturrilha")) return "panturrilha";
  if (s.startsWith("peck") || s.startsWith("peitoral")) return "peitoral";
  if (s.startsWith("desenvolvimento")) return "desenvolvimento";
  if (s.startsWith("smith")) return "smith";
  if (s.startsWith("hack")) return "hack";
  return s;
}

function extrairEquipamento(norm: string, inicio: number, fim: number): string | null {
  const trechoAntes = norm.slice(Math.max(0, inicio - 350), inicio);
  const matchesAntes = [...trechoAntes.matchAll(new RegExp(RE_EQUIPAMENTO.source, "gi"))];
  if (matchesAntes.length > 0) {
    const ultimo = matchesAntes[matchesAntes.length - 1][0];
    return normalizarEquipamento(ultimo);
  }
  const trechoDepois = norm.slice(fim, Math.min(norm.length, fim + 120));
  const matchDepois = RE_EQUIPAMENTO_UNICO.exec(trechoDepois);
  if (matchDepois) {
    return normalizarEquipamento(matchDepois[0]);
  }
  return null;
}

function extrairNumeroItem(norm: string, inicio: number): string | null {
  const trechoAntes = norm.slice(Math.max(0, inicio - 350), inicio);
  const matchesAntes = [...trechoAntes.matchAll(new RegExp(RE_ITEM_EXPLICITO.source, "gi"))];
  if (matchesAntes.length > 0) {
    return matchesAntes[matchesAntes.length - 1][1];
  }
  return null;
}

/**
 * Avalia se duas menções pertencem comprovadamente ao mesmo item/equipamento da compra.
 * Evita afirmar contradição quando a identidade do item não puder ser estabelecida.
 */
export function saoDoMesmoItem(a: EscopoItem, b: EscopoItem): boolean {
  // Se nenhuma identidade foi estabelecida para um dos dois, evita afirmar contradição
  if ((!a.equipamento && !a.itemNumero) || (!b.equipamento && !b.itemNumero)) {
    return false;
  }
  // Se ambos têm equipamento e são diferentes, não são o mesmo item (ex.: esteira vs bicicleta)
  if (a.equipamento && b.equipamento && a.equipamento !== b.equipamento) {
    return false;
  }
  // Se ambos têm número de item e são diferentes, não são o mesmo item (ex.: item 1 vs item 2)
  if (a.itemNumero && b.itemNumero && a.itemNumero !== b.itemNumero) {
    return false;
  }
  // Se ambos têm o mesmo equipamento, e nenhum conflito de número de item
  if (a.equipamento && b.equipamento && a.equipamento === b.equipamento) {
    return true;
  }
  // Se ambos têm o mesmo número de item, e nenhum conflito de equipamento
  if (a.itemNumero && b.itemNumero && a.itemNumero === b.itemNumero) {
    return true;
  }
  return false;
}

function normalizarUnidade(u: string): string {
  const t = u.toLowerCase().trim();
  if (/^kg$|^quilograma/.test(t)) return "kg";
  if (/^lb$|^libra/.test(t)) return "lb";
  return t;
}

/** Extrai menções de um atributo no texto normalizado. Ignora faixas ("entre X e Y"). */
function mencoesAtributo(
  norm: string,
  atributo: AtributoDivergencia,
  chunk: ChunkEdital,
  origem: number[],
): MencaoAtributo[] {
  const saida: MencaoAtributo[] = [];
  // Converte grupos capturantes em non-capturing para preservar índices m[1]=número, m[2]=unidade
  const rotulosEscapados = atributo.rotulos.source.replace(/(?<!\\)\((?!\?)/g, "(?:");
  const re = new RegExp(
    `(?:${rotulosEscapados})[^\\d]{0,40}(\\d+(?:[.,]\\d+)?)\\s*(kg|quilogramas?|libras?|lb)\\b`,
    "g",
  );
  for (const m of norm.matchAll(re)) {
    const valor = Number(m[1].replace(",", "."));
    if (!Number.isFinite(valor) || valor <= 0) continue;
    // Ignora faixas: "entre 40 e 180 kg", "de 6 a 25 kg"
    const antes = norm.slice(Math.max(0, (m.index ?? 0) - 25), m.index ?? 0);
    if (/\b(entre|de)\s*$/.test(antes)) continue;

    const inicio = m.index ?? 0;
    const fim = inicio + m[0].length;
    const equipamento = extrairEquipamento(norm, inicio, fim);
    const itemNumero = extrairNumeroItem(norm, inicio);

    saida.push({
      atributo,
      valor,
      unidade: normalizarUnidade(m[2]),
      inicio,
      fim,
      chunk,
      origem,
      escopo: { equipamento, itemNumero },
    });
  }
  return saida;
}

function fonteDaMencion(m: MencaoAtributo): Fonte {
  const i0 = m.origem[m.inicio];
  const i1 = m.origem[m.fim - 1];
  const trecho = m.chunk.texto.slice(
    Math.max(0, i0 ?? 0),
    Math.min(m.chunk.texto.length, (i1 ?? m.chunk.texto.length - 1) + 1),
  );
  const casou = i0 === undefined || i1 === undefined ? null : m.chunk.texto.slice(i0, i1 + 1);
  return {
    tipo: "chunk",
    chunk_id: m.chunk.id,
    documento_id: m.chunk.documento_id,
    pagina: m.chunk.pagina,
    trecho: trecho.slice(0, 240),
    item: i0 === undefined ? null : itemNaPosicao(m.chunk.texto, i0),
    trecho_limpo: trechoLimpo(trecho, 300, casou),
  };
}

export function detectarDivergencias(chunks: ChunkEdital[]): Achado[] {
  const grupos = new Map<string, Achado>();
  const juntar = (chave: string, a: Achado) => {
    const g = grupos.get(chave);
    if (!g) grupos.set(chave, a);
    else if (g.fontes.filter((f) => f.tipo === "chunk").length < 4) {
      g.fontes = [...g.fontes.filter((f) => f.tipo === "chunk"), ...a.fontes.filter((f) => f.tipo === "chunk")];
    }
  };

  // Coleta todas as menções de cada atributo em todos os chunks.
  const mencoesPorAtributo = new Map<string, MencaoAtributo[]>();
  for (const chunk of chunks) {
    const { norm, origem } = normalizarComMapa(chunk.texto);
    for (const atributo of ATRIBUTOS_DIVERGENCIA) {
      const mencoes = mencoesAtributo(norm, atributo, chunk, origem);
      if (!mencoes.length) continue;
      const lista = mencoesPorAtributo.get(atributo.codigo) ?? [];
      lista.push(...mencoes);
      mencoesPorAtributo.set(atributo.codigo, lista);
    }
  }

  // Compara valores dentro do mesmo atributo, mesma unidade e comprovadamente mesmo item/equipamento.
  for (const [codigo, mencoes] of mencoesPorAtributo) {
    if (mencoes.length < 2) continue;

    const porUnidade = new Map<string, MencaoAtributo[]>();
    for (const m of mencoes) {
      const lista = porUnidade.get(m.unidade) ?? [];
      lista.push(m);
      porUnidade.set(m.unidade, lista);
    }

    for (const [_unidade, grupo] of porUnidade) {
      if (grupo.length < 2) continue;

      // Agrupa menções pela identidade comprovada do item/equipamento
      const clusters: MencaoAtributo[][] = [];
      for (const m of grupo) {
        if (!m.escopo.equipamento && !m.escopo.itemNumero) {
          // Identidade não estabelecida: evita afirmar contradição
          continue;
        }
        const clusterEncontrado = clusters.find((c) =>
          c.every((existente) => saoDoMesmoItem(m.escopo, existente.escopo))
        );
        if (clusterEncontrado) {
          clusterEncontrado.push(m);
        } else {
          clusters.push([m]);
        }
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        const atributo = cluster[0].atributo;
        const unidade = cluster[0].unidade;
        const valores = cluster.map((m) => m.valor);
        const menor = Math.min(...valores);
        const maior = Math.max(...valores);
        if (menor === maior) continue;

        const divergenciaPct = (maior - menor) / menor;
        if (divergenciaPct < atributo.limiar) continue;

        const eqInfo = cluster[0].escopo.equipamento ? ` (${cluster[0].escopo.equipamento})` : "";
        const itemInfo = cluster[0].escopo.itemNumero ? ` do item ${cluster[0].escopo.itemNumero}` : "";
        const contexto = `${eqInfo}${itemInfo}`.trim();

        const fontes: Fonte[] = cluster.map(fonteDaMencion);
        fontes.push({ tipo: "calculo", regra: "divergencia_numerica_v1", versao: REGRA_VERSAO });
        const chaveCluster = `${codigo}:${cluster[0].escopo.equipamento ?? ""}:${cluster[0].escopo.itemNumero ?? ""}`;
        juntar(chaveCluster, {
          codigo: `especificacao.divergencia_${codigo}`,
          natureza: "fato",
          metodo: "regra",
          severidade: atributo.categoria === 1 ? "atencao" : "info",
          titulo: `especificacao.divergencia_${codigo}`,
          detalhe: `Valores divergentes para "${codigo}"${contexto ? ` em ${contexto}` : ""}: ${menor} ${unidade} vs ${maior} ${unidade} (${(divergenciaPct * 100).toFixed(1)}% de diferença). Requer esclarecimento antes de cotar.`,
          dados: {
            atributo: codigo,
            categoria: atributo.categoria,
            equipamento: cluster[0].escopo.equipamento,
            item_numero: cluster[0].escopo.itemNumero,
            unidade,
            valor_menor: menor,
            valor_maior: maior,
            divergencia_pct: Math.round(divergenciaPct * 1000) / 10,
            quantidade_mencoes: cluster.length,
          },
          fontes,
        });
      }
    }
  }
  return [...grupos.values()];
}

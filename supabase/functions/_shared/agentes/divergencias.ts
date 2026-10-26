// Spec 0039: detecção de divergências numéricas dentro do mesmo atributo.
// Ex.: "Peso máximo do usuário: 188,44Kg" (tabela) vs "Suporta usuário de até 180 kg" (texto).
// Regra: emite achado quando há >=2 valores para o mesmo atributo, mesma unidade,
// com diferença acima do limiar (5% Categoria 1 / 10% Categoria 2). Faixas são ignoradas.
import { normalizarComMapa } from "./achados.ts";
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

interface MencaoAtributo {
  atributo: AtributoDivergencia;
  valor: number;
  unidade: string;
  inicio: number;
  fim: number;
  chunk: ChunkEdital;
  origem: number[];
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
    saida.push({
      atributo,
      valor,
      unidade: normalizarUnidade(m[2]),
      inicio: m.index ?? 0,
      fim: (m.index ?? 0) + m[0].length,
      chunk,
      origem,
    });
  }
  return saida;
}

// Fonte de chunk: importada indiretamente via edital.ts para manter consistência.
// Aqui reutilizamos o trecho normalizado como fonte de registro simples.
function fonteDaMencion(m: MencaoAtributo): Fonte {
  const trecho = m.chunk.texto.slice(
    Math.max(0, m.origem[m.inicio] ?? 0),
    Math.min(m.chunk.texto.length, (m.origem[m.fim - 1] ?? 0) + 1),
  );
  return {
    tipo: "chunk",
    chunk_id: m.chunk.id,
    documento_id: m.chunk.documento_id,
    pagina: m.chunk.pagina,
    trecho: trecho.slice(0, 240),
  };
}

export function detectarDivergencias(chunks: ChunkEdital[]): Achado[] {
  const grupos = new Map<string, Achado>();
  const juntar = (a: Achado) => {
    const g = grupos.get(a.codigo);
    if (!g) grupos.set(a.codigo, a);
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

  // Compara valores dentro do mesmo atributo e mesma unidade.
  for (const [codigo, mencoes] of mencoesPorAtributo) {
    if (mencoes.length < 2) continue;

    const porUnidade = new Map<string, MencaoAtributo[]>();
    for (const m of mencoes) {
      const lista = porUnidade.get(m.unidade) ?? [];
      lista.push(m);
      porUnidade.set(m.unidade, lista);
    }

    for (const [unidade, grupo] of porUnidade) {
      if (grupo.length < 2) continue;
      const atributo = grupo[0].atributo;
      const valores = grupo.map((m) => m.valor);
      const menor = Math.min(...valores);
      const maior = Math.max(...valores);
      if (menor === maior) continue;

      const divergenciaPct = (maior - menor) / menor;
      if (divergenciaPct < atributo.limiar) continue;

      const fontes: Fonte[] = grupo.map(fonteDaMencion);
      fontes.push({ tipo: "calculo", regra: "divergencia_numerica_v1", versao: REGRA_VERSAO });
      juntar({
        codigo: `especificacao.divergencia_${codigo}`,
        natureza: "fato",
        metodo: "regra",
        severidade: atributo.categoria === 1 ? "atencao" : "info",
        titulo: `especificacao.divergencia_${codigo}`,
        detalhe: `Valores divergentes para "${codigo}": ${menor} ${unidade} vs ${maior} ${unidade} (${(divergenciaPct * 100).toFixed(1)}% de diferença). Requer esclarecimento antes de cotar.`,
        dados: {
          atributo: codigo,
          categoria: atributo.categoria,
          unidade,
          valor_menor: menor,
          valor_maior: maior,
          divergencia_pct: Math.round(divergenciaPct * 1000) / 10,
          quantidade_mencoes: grupo.length,
        },
        fontes,
      });
    }
  }
  return [...grupos.values()];
}

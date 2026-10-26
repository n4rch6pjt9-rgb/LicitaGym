// Contrato de Recomendação de Lance (v1)
// Lê precos_praticados_itens (janela de JANELA_MESES, filtrado por unidade normalizada)
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { JANELA_MESES, LIMITE_AMOSTRAS, unidadeNorm } from "./agentes/preco.ts";

export type StatusRec = "SUCCESS_WITH_DATA" | "EMPTY_VALID" | "FAILED";
export type Decisao = "disputar" | "nao_disputar" | "aguardar_aprovacao";

export interface RecomendacaoLance {
  recomendacao_id: string;
  status: StatusRec;
  decisao: Decisao;
  motivos: string[];
  alertas: string[];
  parametros: { teto_absoluto: number; alvo: number; piso_inexequibilidade: number } | null;
  referencia: {
    codigo_item: number;
    unidade: string;
    mediana: number;
    p25: number;
    p75: number;
    n: number;
    fonte: string;
  } | null;
  regra_version: string;
  gerado_em: string;
}

export interface InputRec {
  codigo_item: number;
  unidade: string | null;
  custo_proprio: number;
  margem_min: number;
  estimado_edital: number;
}

const REGRA_VERSION = "bot-guards.v1";
const ALERTA_SOBREPRECO = 3.0; // estimado > 3× mediana → requer aprovação

function percentilLinear(ordenados: number[], p: number): number {
  const n = ordenados.length;
  if (n === 1) return ordenados[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return ordenados[lo] + frac * (ordenados[hi] - ordenados[lo]);
}

export async function recomendar(
  input: InputRec,
  client?: SupabaseClient,
): Promise<RecomendacaoLance> {
  const base: RecomendacaoLance = {
    recomendacao_id: "",
    status: "EMPTY_VALID",
    decisao: "nao_disputar",
    motivos: [],
    alertas: [],
    parametros: null,
    referencia: null,
    regra_version: REGRA_VERSION,
    gerado_em: new Date().toISOString(),
  };

  const unidadeAlvo = unidadeNorm(input.unidade);
  if (!input.codigo_item || !unidadeAlvo || unidadeAlvo === "ND") {
    base.motivos.push("input_invalido");
    return base;
  }

  const supabase = client ?? createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const desde = new Date();
  desde.setUTCMonth(desde.getUTCMonth() - JANELA_MESES);
  const desdeIso = desde.toISOString().slice(0, 10);

  // Referência: precos_praticados_itens com filtro explícito de unidade normalizada (UNIDADE ↔ UN)
  const { data: rows, error } = await supabase
    .from("precos_praticados_itens")
    .select("preco_unitario, sigla_unidade_fornecimento")
    .eq("codigo_item_catalogo", input.codigo_item)
    .gte("data_resultado", desdeIso)
    .gt("preco_unitario", 0)
    .order("data_resultado", { ascending: false })
    .order("id_compra_item", { ascending: true })
    .limit(LIMITE_AMOSTRAS);

  if (error || !rows || rows.length === 0) {
    base.motivos.push("sem_referencia");
    return base;
  }

  const precos = (rows as Array<Record<string, unknown>>)
    .filter((r) => unidadeNorm(r.sigla_unidade_fornecimento as string | null) === unidadeAlvo)
    .map((r) => Number(r.preco_unitario))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (precos.length === 0) {
    base.motivos.push("sem_referencia");
    return base;
  }

  if (precos.length < 3) {
    base.motivos.push("amostra_insuficiente");
    return base;
  }

  const med = Number(percentilLinear(precos, 0.50).toFixed(2));
  const p25 = Number(percentilLinear(precos, 0.25).toFixed(2));
  const p75 = Number(percentilLinear(precos, 0.75).toFixed(2));

  base.referencia = {
    codigo_item: input.codigo_item,
    unidade: unidadeAlvo,
    mediana: med,
    p25,
    p75,
    n: precos.length,
    fonte: "precos_praticados_itens",
  };

  // Alerta de sobrepreço (estimado > 3× mediana) — edital inflado como o item 17 da lic 18667
  const razao = med > 0 ? input.estimado_edital / med : 0;
  if (razao >= ALERTA_SOBREPRECO) {
    base.alertas.push(`edital_${razao.toFixed(1)}x_mediana: possível sobrepreço`);
  }

  // Faixa parametrizada
  const teto = Number(Math.min(input.estimado_edital, p75).toFixed(2));
  const piso = Number(
    Math.max(
      0.5 * input.estimado_edital, // inexequibilidade (50% do edital)
      input.custo_proprio * (1 + input.margem_min),
    ).toFixed(2),
  );

  if (piso > teto) {
    base.motivos.push("faixa_inviavel");
    return base;
  }

  const alvo = Math.min(teto, Math.max(piso, med));

  base.status = "SUCCESS_WITH_DATA";
  base.decisao = razao >= ALERTA_SOBREPRECO ? "aguardar_aprovacao" : "disputar";
  base.parametros = {
    teto_absoluto: teto,
    alvo,
    piso_inexequibilidade: piso,
  };
  base.recomendacao_id = `sha256:${input.codigo_item}:${unidadeAlvo}:${med}`;
  return base;
}

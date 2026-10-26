// Contrato de Recomendação de Lance (v1)
// Lê v_bi_precos_praticados (12m, filtros de sentinela/bot aplicados na view)
// Quando precos_rotulo_perfil existir, a migração é trocar a fonte.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

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
  unidade: string;
  custo_proprio: number;
  margem_min: number;
  estimado_edital: number;
}

const REGRA_VERSION = "bot-guards.v1";
const ALERTA_SOBREPRECO = 3.0; // estimado > 3× mediana → requer aprovação

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

  if (!input.codigo_item || !input.unidade || input.unidade === "ND") {
    base.motivos.push("input_invalido");
    return base;
  }

  const supabase = client ?? createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Referência: view 12m (filtros de sentinela/bot/outlier já aplicados)
  const { data, error } = await supabase
    .from("v_bi_precos_praticados")
    .select("codigo_item, unidade, preco_mediana, preco_p25, preco_p75, n_cotacoes, outlier_tipo")
    .eq("codigo_item", input.codigo_item)
    .eq("unidade", input.unidade)
    .maybeSingle();

  if (error || !data || data.n_cotacoes < 3) {
    base.motivos.push(data ? "amostra_insuficiente" : "sem_referencia");
    return base;
  }

  const med = Number(data.preco_mediana);
  const p25 = Number(data.preco_p25);
  const p75 = Number(data.preco_p75);

  base.referencia = {
    codigo_item: data.codigo_item,
    unidade: data.unidade,
    mediana: med,
    p25,
    p75,
    n: data.n_cotacoes,
    fonte: "v_bi_precos_praticados_12m",
  };

  // Alerta de sobrepreço (estimado > 3× mediana) — edital inflado como o item 17 da lic 18667
  const razao = med > 0 ? input.estimado_edital / med : 0;
  if (razao >= ALERTA_SOBREPRECO) {
    base.alertas.push(`edital_${razao.toFixed(1)}x_mediana: possível sobrepreço`);
  }

  // Faixa parametrizada
  const teto = Math.min(input.estimado_edital, p75);
  const piso = Math.max(
    0.5 * input.estimado_edital, // inexequibilidade (50% do edital)
    input.custo_proprio * (1 + input.margem_min),
  );

  if (piso > teto) {
    base.motivos.push("faixa_inviavel");
    return base;
  }

  base.status = "SUCCESS_WITH_DATA";
  base.decisao = razao >= ALERTA_SOBREPRECO ? "aguardar_aprovacao" : "disputar";
  base.parametros = {
    teto_absoluto: Number(teto.toFixed(2)),
    alvo: Number(med.toFixed(2)),
    piso_inexequibilidade: Number(piso.toFixed(2)),
  };
  base.recomendacao_id = `sha256:${input.codigo_item}:${input.unidade}:${med}`;
  return base;
}

// GET api-precos (spec specs/0009-precos-historicos-pesquisa-preco.md).
// Preços homologados da Pesquisa de Preço do Compras.gov (public.precos_praticados_itens), por PDM do catálogo da
// empresa, para a tela /precos e a aba "Inteligência de Preços" da oportunidade.
//
//   ?action=resumo&pdm=<int>[&item=<int>][&meses=12|24][&uf=XX][&unidade=SIGLA]
//       estatísticas do recorte calculadas no banco (public.precos_praticados_resumo): n, média, mín, p25, mediana,
//       p75, máx, unidade de fornecimento predominante e todas as unidades do recorte (`unidades`). n < 3: média e
//       quartis null, com motivo.
//   ?action=amostras&pdm=<int>[&item][&meses][&uf][&unidade][&page=1][&limit=20, até 100]
//       as linhas do mesmo recorte, por data_resultado desc (desempate pela chave id_compra, id_item_compra).
//       Página além do total: 400 com codigo "page_alem_do_total" (o PostgREST responde 416/PGRST103).
//
// Unidade (decisão 4 da spec): sem `unidade` o recorte pode misturar unidades de fornecimento (UN, PAR, M2...). Para
// comparar com o valor estimado de um item da oportunidade, o front passa `unidade` = sigla de fornecimento do item;
// sem isso não compara.
//
// Período: os últimos `meses` (padrão 12) até hoje no horário de Brasília, por data_resultado: de (hoje − N meses
// + 1 dia) até hoje, inclusive. Só entra preço > 0 (nulo ou zero não é preço), nas duas actions.
// Catálogo: PDM fora de catalogo_catmat_pdms_efetivos() é 400 com codigo "pdm_fora_do_catalogo" (decisão: o front
// só oferece PDMs do catálogo, então um PDM de fora é erro de chamada, não "sem preço").
// Arredondamento: média e percentis com 2 casas, meio para longe do zero (round(numeric, 2) no banco, a mesma regra
// de centavos() em api-pncp-pca/radar.ts); mín, máx e preço unitário como vieram da fonte.
// Segurança: o cliente service_role só é criado DEPOIS de requireUserAuth. Parâmetro inválido é 400; erro de banco
// é 500 com mensagem genérica (detalhe só no log); nunca lista vazia no lugar de erro. Ausente chega como null.
import { createClient } from "npm:@supabase/supabase-js@2";
import { errorDetail, jsonResponse, requireUserAuth } from "../_shared/http.ts";
import { numeroOuAusente } from "../_shared/pcaLeading.ts";

export const FONTE = "compras.gov/pesquisa-preco";
export const TABELA = "precos_praticados_itens";
export const RPC_RESUMO = "precos_praticados_resumo";
export const RPC_CATALOGO = "catalogo_catmat_pdms_efetivos";
export const ARREDONDAMENTO =
  "Média e percentis (p25, mediana, p75) com 2 casas, meio para longe do zero; percentil por interpolação linear " +
  "(definição do percentile_cont). Mínimo, máximo e preço unitário como vieram da fonte.";

const MESES_VALIDOS = [12, 24];
const MESES_PADRAO = 12;
const LIMIT_PADRAO = 20;
const LIMIT_MAX = 100;
const N_MINIMO = 3;

const COLUNAS_AMOSTRA = [
  "id_compra",
  "id_item_compra",
  "numero_item_compra",
  "codigo_item_catalogo",
  "codigo_pdm",
  "data_resultado",
  "data_compra",
  "codigo_uasg",
  "nome_uasg",
  "codigo_orgao",
  "nome_orgao",
  "estado",
  "municipio",
  "quantidade",
  "preco_unitario",
  "sigla_unidade_fornecimento",
  "nome_unidade_fornecimento",
  "sigla_unidade_medida",
  "nome_unidade_medida",
  "marca",
  "nome_fornecedor",
  "ni_fornecedor",
  "objeto_compra",
  "descricao_item",
  "descricao_detalhada_item",
].join(", ");

type Resultado = { data: Record<string, unknown>[] | null; error: unknown; count?: number | null };

/** Subconjunto do query builder do PostgREST usado aqui (tipo estrutural: evita o TS2589 do supabase-js). */
export interface PrecosQuery extends PromiseLike<Resultado> {
  select(cols: string, opts?: { count?: "exact" }): PrecosQuery;
  eq(col: string, v: unknown): PrecosQuery;
  gt(col: string, v: number): PrecosQuery;
  gte(col: string, v: string): PrecosQuery;
  lte(col: string, v: string): PrecosQuery;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): PrecosQuery;
  range(from: number, to: number): PrecosQuery;
}

export interface PrecosClient {
  from(tabela: string): PrecosQuery;
  rpc(funcao: string, args?: Record<string, unknown>): PrecosQuery;
}

export interface PrecosDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente?: () => PrecosClient;
  /** Data de hoje (AAAA-MM-DD) no horário de Brasília. Injetável para teste. */
  hoje?: () => string;
}

/** Erro de domínio que pode ir ao cliente (resultado não verificado). Qualquer outro erro vira mensagem genérica. */
export class PrecosNaoVerificado extends Error {}

/** Página pedida além do total de amostras: erro de chamada (400), não falha de banco. */
class PaginaAlemDoTotal extends Error {}

type Action = "resumo" | "amostras";

interface PrecosParams {
  action: Action;
  pdm: number;
  item: number | null;
  meses: number;
  uf: string | null;
  unidade: string | null;
  page: number;
  limit: number;
}

function criarClienteServico(): PrecosClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Service role não configurado");
  return createClient(url, key, { auth: { persistSession: false } }) as unknown as PrecosClient;
}

/** Hoje no horário de Brasília (UTC−3, sem horário de verão desde 2019). */
function hojeBrasilia(): string {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Período de `meses` meses que termina em `fim` (inclusive): começa no dia seguinte a (fim − N meses). A subtração de
 * meses segue o Postgres (31/03 − 1 mês = 28 ou 29/02).
 */
export function periodoDe(fim: string, meses: number): { inicio: string; fim: string } {
  const [y, m, d] = fim.split("-").map(Number);
  const total = y * 12 + (m - 1) - meses;
  const ty = Math.floor(total / 12);
  const tm = total % 12 + 1;
  const ultimoDia = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const base = new Date(Date.UTC(ty, tm - 1, Math.min(d, ultimoDia)));
  base.setUTCDate(base.getUTCDate() + 1);
  return { inicio: iso(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()), fim };
}

function vazio(v: string | null): boolean {
  return v === null || v.trim() === "";
}

export function parsePrecosParams(url: URL): PrecosParams | { error: string } {
  const q = (k: string) => url.searchParams.get(k);

  const actionRaw = q("action");
  if (vazio(actionRaw) || !["resumo", "amostras"].includes(actionRaw!.trim())) {
    return { error: "action inválida: use resumo ou amostras" };
  }
  const action = actionRaw!.trim() as Action;

  const pdmRaw = q("pdm");
  if (vazio(pdmRaw)) return { error: "pdm obrigatório: informe o código PDM" };
  if (!/^\d{1,9}$/.test(pdmRaw!.trim()) || Number(pdmRaw!.trim()) < 1) {
    return { error: "pdm inválido: use o código numérico" };
  }

  const itemRaw = q("item");
  if (!vazio(itemRaw) && (!/^\d{1,9}$/.test(itemRaw!.trim()) || Number(itemRaw!.trim()) < 1)) {
    return { error: "item inválido: use o código CATMAT numérico" };
  }

  const mesesRaw = q("meses");
  if (!vazio(mesesRaw) && !MESES_VALIDOS.map(String).includes(mesesRaw!.trim())) {
    return { error: "meses inválido: use 12 ou 24" };
  }

  const ufRaw = q("uf");
  if (!vazio(ufRaw) && !/^[A-Za-z]{2}$/.test(ufRaw!.trim())) return { error: "uf inválida: use a sigla (ex.: PR)" };

  const unidadeRaw = q("unidade");
  if (!vazio(unidadeRaw) && !/^[A-Za-z0-9]{1,10}$/.test(unidadeRaw!.trim())) {
    return { error: "unidade inválida: use a sigla da unidade de fornecimento (ex.: UN, PAR)" };
  }

  const pageRaw = q("page");
  if (!vazio(pageRaw) && !/^[1-9]\d{0,5}$/.test(pageRaw!.trim())) return { error: "page inválida: use 1 ou mais" };
  const limitRaw = q("limit");
  if (!vazio(limitRaw)) {
    const l = limitRaw!.trim();
    if (!/^\d{1,3}$/.test(l) || Number(l) < 1 || Number(l) > LIMIT_MAX) {
      return { error: `limit inválido: use de 1 a ${LIMIT_MAX}` };
    }
  }

  return {
    action,
    pdm: Number(pdmRaw!.trim()),
    item: vazio(itemRaw) ? null : Number(itemRaw!.trim()),
    meses: vazio(mesesRaw) ? MESES_PADRAO : Number(mesesRaw!.trim()),
    uf: vazio(ufRaw) ? null : ufRaw!.trim().toUpperCase(),
    unidade: vazio(unidadeRaw) ? null : unidadeRaw!.trim().toUpperCase(),
    page: vazio(pageRaw) ? 1 : Number(pageRaw!.trim()),
    limit: vazio(limitRaw) ? LIMIT_PADRAO : Number(limitRaw!.trim()),
  };
}

/** Texto como veio da fonte; vazio ou só espaço é ausente (null). */
function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function dataIso(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function inteiro(v: unknown): number | null {
  const n = numeroOuAusente(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

function amostraDe(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    data_resultado: dataIso(raw.data_resultado),
    data_compra: dataIso(raw.data_compra),
    codigo_uasg: texto(raw.codigo_uasg),
    nome_uasg: texto(raw.nome_uasg),
    codigo_orgao: inteiro(raw.codigo_orgao),
    nome_orgao: texto(raw.nome_orgao),
    uf: texto(raw.estado),
    municipio: texto(raw.municipio),
    quantidade: numeroOuAusente(raw.quantidade),
    preco_unitario: numeroOuAusente(raw.preco_unitario),
    sigla_unidade_fornecimento: texto(raw.sigla_unidade_fornecimento),
    nome_unidade_fornecimento: texto(raw.nome_unidade_fornecimento),
    sigla_unidade_medida: texto(raw.sigla_unidade_medida),
    nome_unidade_medida: texto(raw.nome_unidade_medida),
    marca: texto(raw.marca),
    nome_fornecedor: texto(raw.nome_fornecedor),
    ni_fornecedor: texto(raw.ni_fornecedor),
    objeto_compra: texto(raw.objeto_compra),
    descricao_item: texto(raw.descricao_item),
    descricao_detalhada_item: texto(raw.descricao_detalhada_item),
    id_compra: texto(raw.id_compra),
    id_item_compra: inteiro(raw.id_item_compra),
    numero_item_compra: inteiro(raw.numero_item_compra),
    codigo_item_catalogo: inteiro(raw.codigo_item_catalogo),
    codigo_pdm: inteiro(raw.codigo_pdm),
    fonte: FONTE,
  };
}

/** Lista {sigla, nome, n} das unidades do recorte; sigla/nome ausentes ficam null (não inventa unidade). */
function unidadesDe(raw: unknown): Array<{ sigla: string | null; nome: string | null; n: number }> {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new PrecosNaoVerificado("Não verificado: lista de unidades fora do contrato.");
  return raw.map((u) => {
    const o = (u ?? {}) as Record<string, unknown>;
    const n = inteiro(o.n);
    if (n === null) throw new PrecosNaoVerificado("Não verificado: unidade sem contagem.");
    return { sigla: texto(o.sigla), nome: texto(o.nome), n };
  });
}

/** Erro de "faixa fora do total" do PostgREST (offset além das linhas). */
function foraDoTotal(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "PGRST103";
}

async function pdmNoCatalogo(client: PrecosClient, pdm: number): Promise<boolean> {
  const { data, error } = await client.rpc(RPC_CATALOGO).select("codigo_pdm").eq("codigo_pdm", pdm);
  if (error) throw error;
  if (!Array.isArray(data)) throw new PrecosNaoVerificado("Não verificado: leitura do catálogo sem resposta.");
  return data.length > 0;
}

async function resumo(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string }) {
  const { data, error } = await client.rpc(RPC_RESUMO, {
    p_pdm: p.pdm,
    p_inicio: periodo.inicio,
    p_fim: periodo.fim,
    p_item: p.item,
    p_uf: p.uf,
    p_unidade: p.unidade,
  });
  if (error) throw error;
  if (!Array.isArray(data) || data.length !== 1) {
    throw new PrecosNaoVerificado("Não verificado: o resumo de preços não devolveu exatamente uma linha.");
  }
  const r = data[0];
  const n = inteiro(r.n);
  if (n === null || n < 0) throw new PrecosNaoVerificado("Não verificado: resumo de preços sem contagem.");
  // Defesa em profundidade: a função do banco já anula média e quartis com n < 3.
  const suficiente = n >= N_MINIMO;
  const quartil = (v: unknown) => (suficiente ? numeroOuAusente(v) : null);
  const motivo = texto(r.motivo) ??
    (n === 0
      ? "Sem preços homologados no recorte."
      : !suficiente
      ? "Menos de 3 preços no recorte: média e quartis não são calculados."
      : null);
  const unidadeN = inteiro(r.unidade_n);
  return {
    n,
    media: quartil(r.media),
    min: n > 0 ? numeroOuAusente(r.preco_min) : null,
    p25: quartil(r.p25),
    mediana: quartil(r.mediana),
    p75: quartil(r.p75),
    max: n > 0 ? numeroOuAusente(r.preco_max) : null,
    motivo,
    unidade_fornecimento_predominante: n > 0 && unidadeN !== null && unidadeN > 0
      ? { sigla: texto(r.unidade_sigla), nome: texto(r.unidade_nome), n: unidadeN }
      : null,
    unidades: unidadesDe(r.unidades),
    ultima_data_resultado: dataIso(r.ultima_data_resultado),
    atualizado_em: typeof r.atualizado_em === "string" && r.atualizado_em !== "" ? r.atualizado_em : null,
    arredondamento: ARREDONDAMENTO,
  };
}

async function amostras(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string }) {
  let q = client.from(TABELA).select(COLUNAS_AMOSTRA, { count: "exact" })
    .eq("codigo_pdm", String(p.pdm))
    .gte("data_resultado", periodo.inicio)
    .lte("data_resultado", periodo.fim)
    .gt("preco_unitario", 0);
  if (p.item !== null) q = q.eq("codigo_item_catalogo", p.item);
  if (p.uf !== null) q = q.eq("estado", p.uf);
  if (p.unidade !== null) q = q.eq("sigla_unidade_fornecimento", p.unidade);
  const offset = (p.page - 1) * p.limit;
  const { data, error, count } = await q
    .order("data_resultado", { ascending: false, nullsFirst: false })
    .order("id_compra", { ascending: true })
    .order("id_item_compra", { ascending: true })
    .range(offset, offset + p.limit - 1);
  if (foraDoTotal(error)) throw new PaginaAlemDoTotal();
  if (error) throw error;
  if (typeof count !== "number") throw new PrecosNaoVerificado("Não verificado: contagem ausente na leitura dos preços.");
  if (!Array.isArray(data)) throw new PrecosNaoVerificado("Não verificado: leitura dos preços sem linhas.");
  return { itens: data.map(amostraDe), total: count, page: p.page, limit: p.limit };
}

export async function responderPrecos(req: Request, url: URL, deps: PrecosDeps = {}): Promise<Response> {
  const denied = await (deps.requireAuth ?? requireUserAuth)(req);
  if (denied) return denied;

  const p = parsePrecosParams(url);
  if ("error" in p) return jsonResponse({ error: p.error }, 400);

  const periodo = periodoDe((deps.hoje ?? hojeBrasilia)(), p.meses);
  try {
    const client = (deps.criarCliente ?? criarClienteServico)();
    if (!(await pdmNoCatalogo(client, p.pdm))) {
      return jsonResponse({
        error: `pdm ${p.pdm} fora do catálogo da empresa`,
        codigo: "pdm_fora_do_catalogo",
      }, 400);
    }
    const base = {
      fonte: FONTE,
      filtro: { pdm: p.pdm, item: p.item, meses: p.meses, uf: p.uf, unidade: p.unidade },
      periodo_inicio: periodo.inicio,
      periodo_fim: periodo.fim,
    };
    const corpo = p.action === "resumo" ? await resumo(client, p, periodo) : await amostras(client, p, periodo);
    return jsonResponse({ ...base, ...corpo });
  } catch (error) {
    if (error instanceof PaginaAlemDoTotal) {
      return jsonResponse({
        error: `page ${p.page} além do total de amostras do recorte`,
        codigo: "page_alem_do_total",
      }, 400);
    }
    console.error(`[api-precos] ${p.action}`, errorDetail(error));
    // Detalhe do banco (função, coluna, hint) fica só no log.
    const msg = error instanceof PrecosNaoVerificado ? error.message : "Falha ao ler os preços.";
    return jsonResponse({ error: msg }, 500);
  }
}

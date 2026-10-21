// GET api-precos (specs 0009-precos-historicos-pesquisa-preco.md e 0031-precos-estimado-homologado-auditoria.md).
// Preços homologados da Pesquisa de Preço do Compras.gov (public.precos_praticados_itens), por PDM do catálogo da
// empresa, para a tela /precos, o BI e a aba "Inteligência de Preços" da oportunidade.
//
// Recorte (o mesmo nas três actions, calculado no banco por public.precos_praticados_recorte):
//   pdm=<int> obrigatório; item=<int>; meses=12|24; uf=XX; unidade=SIGLA; municipio=<nome> (exige uf);
//   uasg=<código só de dígitos ou texto do nome da UASG/órgão>; objeto=<texto>; q=<busca livre>.
//   Texto sem acento e sem diferenciar maiúsculas; várias palavras = todas presentes (decisão de 21/10, spec 0031).
//
//   ?action=resumo
//       estatísticas do recorte calculadas no banco (public.precos_praticados_resumo): n, média, mín, p25, mediana,
//       p75, máx, unidade de fornecimento predominante, todas as unidades do recorte (`unidades`), item com mais
//       amostras (sem o filtro de item) e a mediana da diferença estimado → homologado (%), com n_com_estimado.
//       n < 3: média e quartis null, com motivo. Nada é excluído do cálculo sozinho (spec 0031: o operador limpa o
//       recorte pelos filtros).
//   ?action=amostras[&page=1][&limit=20, até 100]
//       as linhas do recorte (public.precos_praticados_amostras), por data_resultado desc (desempate pela chave
//       id_compra, id_item_compra), com estimado, homologado, diferença, links do PNCP e do portal oficial, esfera e
//       poder. Página além do total: 400 com codigo "page_alem_do_total".
//   ?action=itens
//       itens do PDM com N > 0 no recorte (sem o filtro de item), por n desc (dropdown da /precos).
//
// Links (spec 0031, decisão de 21/10): link_pncp = https://pncp.gov.br/app/editais/<cnpj>/<ano>/<sequencial>, do nº
// de controle oficial; link_portal_oficial = o linkSistemaOrigem que o PNCP mostra ("pncp") ou, sem ele (dispensas),
// o acompanhamento da compra no Compras.gov montado a partir do id_compra ("montado"). Sem a compra consultada no
// PNCP, os dois são null e `motivo_sem_estimado` diz por quê.
// Diferença: diferenca_valor = homologado − estimado; diferenca_percentual = (homologado − estimado) / estimado × 100;
// 2 casas, meio para longe do zero; só com estimado oficial > 0.
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
export const RPC_AMOSTRAS = "precos_praticados_amostras";
export const RPC_ITENS = "precos_praticados_itens_pdm";
export const LINK_PNCP_BASE = "https://pncp.gov.br/app/editais";
export const LINK_COMPRAS_GOV_BASE =
  "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=";
export const RPC_CATALOGO = "catalogo_catmat_pdms_efetivos";
export const ARREDONDAMENTO =
  "Média e percentis (p25, mediana, p75) com 2 casas, meio para longe do zero; percentil por interpolação linear " +
  "(definição do percentile_cont). Mínimo, máximo e preço unitário como vieram da fonte.";

const MESES_VALIDOS = [12, 24];
const MESES_PADRAO = 12;
const LIMIT_PADRAO = 20;
const LIMIT_MAX = 100;
const N_MINIMO = 3;
const TEXTO_MAX = 120;

const ESFERAS: Record<string, string> = { F: "Federal", E: "Estadual", M: "Municipal", D: "Distrital" };
const PODERES: Record<string, string> = { E: "Executivo", L: "Legislativo", J: "Judiciário" };

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

type Action = "resumo" | "amostras" | "itens";

interface PrecosParams {
  action: Action;
  pdm: number;
  item: number | null;
  meses: number;
  uf: string | null;
  unidade: string | null;
  municipio: string | null;
  uasg: string | null;
  objeto: string | null;
  q: string | null;
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
  if (vazio(actionRaw) || !["resumo", "amostras", "itens"].includes(actionRaw!.trim())) {
    return { error: "action inválida: use resumo, amostras ou itens" };
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

  const textos: Record<string, string | null> = {};
  for (const k of ["municipio", "uasg", "objeto", "q"]) {
    const v = q(k);
    if (vazio(v)) {
      textos[k] = null;
      continue;
    }
    const t = v!.trim().replace(/\s+/g, " ");
    if (t.length > TEXTO_MAX) return { error: `${k} inválido: use até ${TEXTO_MAX} caracteres` };
    if ([...t].some((c) => c.charCodeAt(0) < 32)) return { error: `${k} inválido: caractere de controle` };
    textos[k] = t;
  }
  if (textos.municipio !== null && vazio(ufRaw)) return { error: "municipio exige uf (a cidade depende da UF)" };

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
    municipio: textos.municipio,
    uasg: textos.uasg,
    objeto: textos.objeto,
    q: textos.q,
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

/**
 * Fornecedor exibível (decisão do Marcelo, 09/10, LGPD):
 *   14 dígitos (CNPJ)  -> ni_fornecedor como veio, ni_tipo "cnpj", nome como veio;
 *   11 dígitos (CPF)   -> ni_fornecedor null, ni_tipo "cpf", nome "Pessoa física" (o nome civil também é dado pessoal);
 *   qualquer outro valor (vazio, "0", 2, 7, 9 dígitos, com pontuação) -> ni_fornecedor e ni_tipo null (ausente).
 * Em 09/10: 1 linha com 11 dígitos e 5 malformadas, de 25.465.
 */
export function fornecedorDe(ni: unknown, nome: unknown): {
  ni_fornecedor: string | null;
  ni_tipo: "cnpj" | "cpf" | null;
  nome_fornecedor: string | null;
} {
  const s = typeof ni === "string" ? ni.trim() : "";
  if (/^\d{14}$/.test(s)) return { ni_fornecedor: s, ni_tipo: "cnpj", nome_fornecedor: texto(nome) };
  if (/^\d{11}$/.test(s)) return { ni_fornecedor: null, ni_tipo: "cpf", nome_fornecedor: "Pessoa física" };
  return { ni_fornecedor: null, ni_tipo: null, nome_fornecedor: texto(nome) };
}

/** Arredonda a 2 casas, meio para longe do zero (a mesma regra do banco), sem o erro de float de Math.round. */
export function arred2(n: number): number {
  const s = Math.sign(n);
  const a = Math.abs(n);
  return s * Math.round(Number((a * 100).toPrecision(15))) / 100 + 0;
}

/** Link do PNCP a partir do nº de controle oficial da compra (<CNPJ>-<d>-<sequencial>/<ano>); fora do formato: null. */
export function linkPncp(numero: unknown): string | null {
  const s = texto(numero);
  const m = s ? /^(\d{14})-\d-(\d{1,6})\/(\d{4})$/.exec(s.trim()) : null;
  return m ? `${LINK_PNCP_BASE}/${m[1]}/${m[3]}/${Number(m[2])}` : null;
}

/**
 * Link do portal oficial (decisão de 21/10): o linkSistemaOrigem do PNCP; sem ele, o acompanhamento da compra no
 * Compras.gov montado a partir do id_compra (17 dígitos), no formato que o PNCP usa nas dispensas com link.
 */
export function linkPortalOficial(linkPncpOrigem: unknown, idCompra: unknown):
  { link: string | null; origem: "pncp" | "montado" | null } {
  const l = texto(linkPncpOrigem);
  if (l && /^https:\/\//i.test(l)) return { link: l, origem: "pncp" };
  const id = texto(idCompra);
  if (id && /^\d{17}$/.test(id)) return { link: `${LINK_COMPRAS_GOV_BASE}${id}`, origem: "montado" };
  return { link: null, origem: null };
}

function rotulo(mapa: Record<string, string>, v: unknown): { codigo: string | null; nome: string | null } {
  const c = texto(v);
  return { codigo: c, nome: c ? mapa[c.toUpperCase()] ?? null : null };
}

function enriquecimentoDe(raw: Record<string, unknown>, homologado: number | null) {
  const consultada = raw.compra_consultada === true;
  const encontrada = raw.compra_encontrada === true;
  const estimado = numeroOuAusente(raw.valor_unitario_estimado);
  const est = estimado !== null && estimado > 0 ? estimado : null;
  const portal = consultada && encontrada
    ? linkPortalOficial(raw.link_sistema_origem, raw.id_compra)
    : { link: null, origem: null };
  const motivo = !consultada
    ? "Compra ainda não consultada no PNCP (fora do recorte de enriquecimento ou pendente)."
    : !encontrada
    ? "Compra não encontrada no PNCP."
    : est === null
    ? "O PNCP não informa o valor estimado deste item."
    : null;
  return {
    valor_estimado: est,
    valor_homologado: homologado,
    diferenca_valor: est !== null && homologado !== null ? arred2(homologado - est) : null,
    diferenca_percentual: est !== null && homologado !== null ? arred2((homologado - est) / est * 100) : null,
    motivo_sem_estimado: motivo,
    numero_controle_pncp: consultada && encontrada ? texto(raw.numero_controle_pncp) : null,
    link_pncp: consultada && encontrada ? linkPncp(raw.numero_controle_pncp) : null,
    link_portal_oficial: portal.link,
    link_portal_oficial_origem: portal.origem,
  };
}

function amostraDe(raw: Record<string, unknown>): Record<string, unknown> {
  const homologado = numeroOuAusente(raw.preco_unitario);
  const esfera = rotulo(ESFERAS, raw.esfera);
  const poder = rotulo(PODERES, raw.poder);
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
    ...fornecedorDe(raw.ni_fornecedor, raw.nome_fornecedor),
    objeto_compra: texto(raw.objeto_compra),
    descricao_item: texto(raw.descricao_item),
    descricao_detalhada_item: texto(raw.descricao_detalhada_item),
    id_compra: texto(raw.id_compra),
    id_item_compra: inteiro(raw.id_item_compra),
    numero_item_compra: inteiro(raw.numero_item_compra),
    codigo_item_catalogo: inteiro(raw.codigo_item_catalogo),
    codigo_pdm: inteiro(raw.codigo_pdm),
    esfera: esfera.nome,
    esfera_codigo: esfera.codigo,
    poder: poder.nome,
    poder_codigo: poder.codigo,
    modalidade: inteiro(raw.modalidade),
    forma: texto(raw.forma),
    criterio_julgamento: texto(raw.criterio_julgamento),
    percentual_maior_desconto: numeroOuAusente(raw.percentual_maior_desconto),
    ...enriquecimentoDe(raw, homologado),
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

async function pdmNoCatalogo(client: PrecosClient, pdm: number): Promise<boolean> {
  const { data, error } = await client.rpc(RPC_CATALOGO).select("codigo_pdm").eq("codigo_pdm", pdm);
  if (error) throw error;
  if (!Array.isArray(data)) throw new PrecosNaoVerificado("Não verificado: leitura do catálogo sem resposta.");
  return data.length > 0;
}

/** Filtros do recorte comum (sem item, que cada action trata) no formato dos parâmetros das funções do banco. */
function argsRecorte(p: PrecosParams, periodo: { inicio: string; fim: string }): Record<string, unknown> {
  return {
    p_pdm: p.pdm,
    p_inicio: periodo.inicio,
    p_fim: periodo.fim,
    p_uf: p.uf,
    p_unidade: p.unidade,
    p_municipio: p.municipio,
    p_uasg: p.uasg,
    p_objeto: p.objeto,
    p_q: p.q,
  };
}

async function resumo(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string }) {
  const { data, error } = await client.rpc(RPC_RESUMO, { ...argsRecorte(p, periodo), p_item: p.item });
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
  const itemMaisN = inteiro(r.item_mais_n);
  const nComEstimado = inteiro(r.n_com_estimado) ?? 0;
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
    item_mais_amostras: itemMaisN !== null && itemMaisN > 0 && inteiro(r.item_mais_codigo) !== null
      ? { codigo_item_catalogo: inteiro(r.item_mais_codigo), descricao: texto(r.item_mais_descricao), n: itemMaisN }
      : null,
    n_com_estimado: nComEstimado,
    diferenca_mediana_percentual: nComEstimado >= N_MINIMO ? numeroOuAusente(r.diferenca_mediana_percentual) : null,
    ultima_data_resultado: dataIso(r.ultima_data_resultado),
    atualizado_em: typeof r.atualizado_em === "string" && r.atualizado_em !== "" ? r.atualizado_em : null,
    arredondamento: ARREDONDAMENTO,
  };
}

async function lerAmostras(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string },
  offset: number, limit: number) {
  const { data, error } = await client.rpc(RPC_AMOSTRAS, {
    ...argsRecorte(p, periodo),
    p_item: p.item,
    p_offset: offset,
    p_limit: limit,
  });
  if (error) throw error;
  if (!Array.isArray(data)) throw new PrecosNaoVerificado("Não verificado: leitura dos preços sem linhas.");
  return data;
}

function totalDe(linhas: Record<string, unknown>[]): number {
  const t = inteiro(linhas[0]?.total);
  if (t === null || t < linhas.length) {
    throw new PrecosNaoVerificado("Não verificado: contagem ausente na leitura dos preços.");
  }
  return t;
}

async function amostras(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string }) {
  const offset = (p.page - 1) * p.limit;
  const data = await lerAmostras(client, p, periodo, offset, p.limit);
  if (data.length === 0) {
    if (p.page === 1) return { itens: [], total: 0, page: p.page, limit: p.limit };
    // Página vazia além da primeira: conta o recorte para distinguir "página além do total" de recorte vazio.
    const primeira = await lerAmostras(client, p, periodo, 0, 1);
    if (primeira.length > 0) throw new PaginaAlemDoTotal();
    return { itens: [], total: 0, page: p.page, limit: p.limit };
  }
  return { itens: data.map(amostraDe), total: totalDe(data), page: p.page, limit: p.limit };
}

async function itens(client: PrecosClient, p: PrecosParams, periodo: { inicio: string; fim: string }) {
  const { data, error } = await client.rpc(RPC_ITENS, argsRecorte(p, periodo));
  if (error) throw error;
  if (!Array.isArray(data)) throw new PrecosNaoVerificado("Não verificado: lista de itens sem resposta.");
  const lista = data.map((raw) => {
    const codigo = inteiro(raw.codigo_item_catalogo);
    const n = inteiro(raw.n);
    if (codigo === null || n === null) throw new PrecosNaoVerificado("Não verificado: item sem código ou contagem.");
    return { codigo_item_catalogo: codigo, descricao: texto(raw.descricao), n };
  }).filter((i) => i.n > 0);
  lista.sort((a, b) => b.n - a.n || a.codigo_item_catalogo - b.codigo_item_catalogo);
  return { itens: lista, total: lista.length };
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
      filtro: {
        pdm: p.pdm,
        item: p.item,
        meses: p.meses,
        uf: p.uf,
        unidade: p.unidade,
        municipio: p.municipio,
        uasg: p.uasg,
        objeto: p.objeto,
        q: p.q,
      },
      periodo_inicio: periodo.inicio,
      periodo_fim: periodo.fim,
    };
    const corpo = p.action === "resumo"
      ? await resumo(client, p, periodo)
      : p.action === "itens"
      ? await itens(client, p, periodo)
      : await amostras(client, p, periodo);
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

// GET api-pncp-pca?visao=radar (spec specs/0006-pca-radar-itens-escopo.md).
// Itens planejados no PCA (PNCP + PGC, sem duplicar) que estão no escopo do catálogo da empresa, lidos de
// public.v_bi_pca_radar. A view só tem grant para service_role: o cliente service_role só é criado DEPOIS de
// requireUserAuth. Filtros, ordenação e paginação vão para o banco; parâmetro inválido é 400, erro de banco é 500
// (nunca lista vazia). Valor, data ou órgão ausentes chegam como null.
import { createClient } from "npm:@supabase/supabase-js@2";
import { errorDetail, jsonResponse, requireUserAuth } from "../_shared/http.ts";
import { numeroOuAusente } from "../_shared/pcaLeading.ts";

export const RADAR_VIEW = "v_bi_pca_radar";

const COLUNAS = [
  "fonte",
  "orgao_cnpj",
  "codigo_uasg",
  "orgao_nome",
  "ano_pca",
  "codigo_pdm",
  "codigo_item",
  "descricao_item",
  "quantidade",
  "valor_unitario",
  "valor_total",
  "data_prevista",
  "mes_previsto",
  "prioridade",
  "status",
  "numero_item_pncp",
  "casamento_confirmado",
  "metodo_identificacao",
].join(", ");

/**
 * Desempate por TODAS as colunas da resposta (a view não tem id). Duas linhas que empatam em tudo são idênticas, então
 * trocar uma pela outra entre execuções não muda nem a página nem a soma.
 */
export const DESEMPATE = COLUNAS.split(", ").filter((c) => c !== "data_prevista" && c !== "valor_total");

const LIMIT_PADRAO = 20;
const LIMIT_MAX = 100;
/** Leitura da soma em páginas de 1.000 (max_rows da Data API). Acima do teto, erro em vez de soma parcial. */
const PAGINA_SOMA = 1000;
const MAX_PAGINAS_SOMA = 50;

type Resultado = { data: Record<string, unknown>[] | null; error: unknown; count?: number | null };

/** Subconjunto do query builder do PostgREST usado aqui (tipo estrutural: evita o TS2589 do supabase-js). */
export interface RadarQuery extends PromiseLike<Resultado> {
  select(cols: string, opts?: { count?: "exact" }): RadarQuery;
  eq(col: string, v: unknown): RadarQuery;
  gte(col: string, v: number | string): RadarQuery;
  ilike(col: string, padrao: string): RadarQuery;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): RadarQuery;
  range(from: number, to: number): RadarQuery;
}

export interface RadarClient {
  from(tabela: string): RadarQuery;
}

export interface RadarDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente?: () => RadarClient;
}

type Ordem = "data" | "valor";

/** Erro de domínio que pode ir ao cliente (resultado não verificado). Qualquer outro erro vira mensagem genérica. */
export class RadarNaoVerificado extends Error {}

interface RadarParams {
  ano: number;
  mes: string | null;
  mesDe: string | null;
  pdm: number | null;
  orgaoCnpj: string | null;
  orgaoNome: string | null;
  fonte: "pncp" | "pgc" | null;
  valorMin: number | null;
  soConfirmados: boolean;
  ordem: Ordem;
  page: number;
  limit: number;
}

function criarClienteServico(): RadarClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Service role não configurado");
  return createClient(url, key, { auth: { persistSession: false } }) as unknown as RadarClient;
}

function vazio(v: string | null): boolean {
  return v === null || v.trim() === "";
}

export function parseRadarParams(url: URL): RadarParams | { error: string } {
  const q = (k: string) => url.searchParams.get(k);

  const anoRaw = q("ano");
  if (!vazio(anoRaw) && !/^\d{4}$/.test(anoRaw!.trim())) return { error: "ano inválido: use AAAA" };
  const ano = vazio(anoRaw) ? new Date().getUTCFullYear() : Number(anoRaw!.trim());

  const mesRaw = q("mes");
  if (!vazio(mesRaw) && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mesRaw!.trim())) {
    return { error: "mes inválido: use AAAA-MM" };
  }

  const mesDeRaw = q("mes_de");
  if (!vazio(mesDeRaw) && !/^\d{4}-(0[1-9]|1[0-2])$/.test(mesDeRaw!.trim())) {
    return { error: "mes_de inválido: use AAAA-MM" };
  }
  if (!vazio(mesRaw) && !vazio(mesDeRaw)) return { error: "use mes ou mes_de, não os dois" };

  const pdmRaw = q("pdm");
  if (!vazio(pdmRaw) && !/^\d{1,9}$/.test(pdmRaw!.trim())) return { error: "pdm inválido: use o código numérico" };

  let orgaoCnpj: string | null = null;
  let orgaoNome: string | null = null;
  const orgaoRaw = q("orgao");
  if (!vazio(orgaoRaw)) {
    const o = orgaoRaw!.trim();
    if (o.length > 200) return { error: "orgao inválido: termo longo demais" };
    const digitos = o.replace(/\D/g, "");
    if (/^[\d.\/\-\s]+$/.test(o)) {
      // Só número: tem que ser o CNPJ completo (raiz ou pedaço de CNPJ não vira busca por nome).
      if (digitos.length !== 14) return { error: "orgao inválido: use o CNPJ completo (14 dígitos) ou parte do nome" };
      orgaoCnpj = digitos;
    } else {
      // Curingas e separadores do PostgREST não viram padrão: o termo é literal.
      const termo = o.replace(/[%_*\\(),]/g, "").trim();
      if (termo.length === 0) return { error: "orgao inválido: informe o CNPJ ou parte do nome" };
      if (termo.length > 120) return { error: "orgao inválido: termo longo demais" };
      orgaoNome = termo;
    }
  }

  const fonteRaw = q("fonte");
  if (!vazio(fonteRaw) && !["pncp", "pgc"].includes(fonteRaw!.trim())) {
    return { error: "fonte inválida: use pncp ou pgc" };
  }

  const valorRaw = q("valor_min");
  if (!vazio(valorRaw) && !/^\d+(\.\d+)?$/.test(valorRaw!.trim())) {
    return { error: "valor_min inválido: use um número maior ou igual a zero" };
  }

  const confRaw = q("so_confirmados");
  if (!vazio(confRaw) && !["true", "false"].includes(confRaw!.trim())) {
    return { error: "so_confirmados inválido: use true ou false" };
  }

  const ordemRaw = q("ordem");
  if (!vazio(ordemRaw) && !["data", "valor"].includes(ordemRaw!.trim())) {
    return { error: "ordem inválida: use data ou valor" };
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
    ano,
    mes: vazio(mesRaw) ? null : mesRaw!.trim(),
    mesDe: vazio(mesDeRaw) ? null : mesDeRaw!.trim(),
    pdm: vazio(pdmRaw) ? null : Number(pdmRaw!.trim()),
    orgaoCnpj,
    orgaoNome,
    fonte: vazio(fonteRaw) ? null : fonteRaw!.trim() as "pncp" | "pgc",
    valorMin: vazio(valorRaw) ? null : Number(valorRaw!.trim()),
    soConfirmados: !vazio(confRaw) && confRaw!.trim() === "true",
    ordem: vazio(ordemRaw) ? "data" : ordemRaw!.trim() as Ordem,
    page: vazio(pageRaw) ? 1 : Number(pageRaw!.trim()),
    limit: vazio(limitRaw) ? LIMIT_PADRAO : Number(limitRaw!.trim()),
  };
}

function aplicarFiltros(q: RadarQuery, p: RadarParams): RadarQuery {
  q = q.eq("ano_pca", p.ano);
  if (p.mes) q = q.eq("mes_previsto", p.mes);
  // a partir do mês (inclusive); item sem mês previsto fica de fora quando o filtro está ativo
  if (p.mesDe) q = q.gte("mes_previsto", p.mesDe);
  if (p.pdm !== null) q = q.eq("codigo_pdm", p.pdm);
  if (p.orgaoCnpj) q = q.eq("orgao_cnpj", p.orgaoCnpj);
  if (p.orgaoNome) q = q.ilike("orgao_nome", `%${p.orgaoNome}%`);
  if (p.fonte) q = q.eq("fonte", p.fonte);
  if (p.valorMin !== null) q = q.gte("valor_total", p.valorMin);
  if (p.soConfirmados) q = q.eq("casamento_confirmado", true);
  return q;
}

function aplicarOrdem(q: RadarQuery, ordem: Ordem): RadarQuery {
  q = ordem === "valor"
    ? q.order("valor_total", { ascending: false, nullsFirst: false })
        .order("data_prevista", { ascending: true, nullsFirst: false })
    : q.order("data_prevista", { ascending: true, nullsFirst: false })
        .order("valor_total", { ascending: false, nullsFirst: false });
  for (const col of DESEMPATE) q = q.order(col, { ascending: true, nullsFirst: false });
  return q;
}

/**
 * Converte um valor monetário em centavos inteiros, arredondando meio para longe do zero na 3ª casa.
 * Usa a representação decimal (texto do numeric ou o menor texto do número), não float: 100.005 → 10001.
 */
export function centavos(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    const n = numeroOuAusente(raw);
    return n === null ? null : Math.round(n * 100);
  }
  const frac = (m[3] ?? "").padEnd(3, "0");
  let c = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1;
  return m[1] === "-" ? -c : c;
}

function itemDe(raw: Record<string, unknown>): Record<string, unknown> {
  const cnpj = typeof raw.orgao_cnpj === "string" && raw.orgao_cnpj !== "" ? raw.orgao_cnpj : null;
  const nome = typeof raw.orgao_nome === "string" && raw.orgao_nome.trim() !== "" ? raw.orgao_nome : null;
  return {
    ...raw,
    orgao_cnpj: cnpj,
    // A view cai no CNPJ quando não tem nome: isso não é nome, então chega como ausente.
    orgao_nome: nome !== null && nome !== cnpj ? nome : null,
    quantidade: numeroOuAusente(raw.quantidade),
    valor_unitario: numeroOuAusente(raw.valor_unitario),
    valor_total: numeroOuAusente(raw.valor_total),
    data_prevista: typeof raw.data_prevista === "string" && raw.data_prevista !== "" ? raw.data_prevista : null,
    mes_previsto: typeof raw.mes_previsto === "string" && raw.mes_previsto !== "" ? raw.mes_previsto : null,
    casamento_confirmado: raw.casamento_confirmado === true,
  };
}

/**
 * Soma de todo o recorte filtrado (não só da página). O teto é checado pelo count ANTES de ler; o número de páginas
 * sai do count. Erro, recorte acima do teto ou linhas lidas ≠ count: exceção, nunca soma parcial.
 */
async function somarEscopo(client: RadarClient, p: RadarParams, total: number) {
  if (total > PAGINA_SOMA * MAX_PAGINAS_SOMA) {
    throw new RadarNaoVerificado(
      `Não verificado: recorte com ${total} itens, acima de ${PAGINA_SOMA * MAX_PAGINAS_SOMA}; refine o filtro.`,
    );
  }
  let somaCentavos = 0;
  let conhecidos = 0;
  let lidos = 0;
  const paginas = Math.ceil(total / PAGINA_SOMA);
  for (let pagina = 0; pagina < paginas; pagina++) {
    const from = pagina * PAGINA_SOMA;
    const q = aplicarOrdem(aplicarFiltros(client.from(RADAR_VIEW).select("valor_total"), p), p.ordem)
      .range(from, from + PAGINA_SOMA - 1);
    const { data, error } = await q;
    if (error) throw error;
    const linhas = data ?? [];
    for (const l of linhas) {
      const c = centavos(l.valor_total);
      if (c !== null) {
        somaCentavos += c;
        conhecidos++;
      }
    }
    lidos += linhas.length;
  }
  if (lidos !== total) {
    throw new RadarNaoVerificado(
      `Não verificado: a soma leu ${lidos} itens e a contagem deu ${total} (base mudou durante a leitura).`,
    );
  }
  return { valor: conhecidos > 0 ? somaCentavos / 100 : null, semValor: lidos - conhecidos };
}

export async function responderRadar(req: Request, url: URL, deps: RadarDeps = {}): Promise<Response> {
  const denied = await (deps.requireAuth ?? requireUserAuth)(req);
  if (denied) return denied;

  const p = parseRadarParams(url);
  if ("error" in p) return jsonResponse({ error: p.error }, 400);

  try {
    const client = (deps.criarCliente ?? criarClienteServico)();
    const offset = (p.page - 1) * p.limit;
    const pagina = aplicarOrdem(
      aplicarFiltros(client.from(RADAR_VIEW).select(COLUNAS, { count: "exact" }), p),
      p.ordem,
    ).range(offset, offset + p.limit - 1);
    const { data, error, count } = await pagina;
    if (error) throw error;
    if (typeof count !== "number") throw new RadarNaoVerificado("Não verificado: contagem ausente na leitura do radar.");

    const soma = await somarEscopo(client, p, count);
    return jsonResponse({
      itens: (data ?? []).map(itemDe),
      total: count,
      valor_total_escopo: soma.valor,
      itens_sem_valor: soma.semValor,
      page: p.page,
      limit: p.limit,
      ordem: p.ordem,
    });
  } catch (error) {
    console.error("[api-pncp-pca] radar", errorDetail(error));
    // Detalhe do banco (view, coluna, hint) fica só no log.
    const msg = error instanceof RadarNaoVerificado ? error.message : "Falha ao ler o radar do PCA.";
    return jsonResponse({ error: msg }, 500);
  }
}

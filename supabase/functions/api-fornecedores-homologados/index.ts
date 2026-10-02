// Edge Function: api-fornecedores-homologados
// Base de fornecedores homologados/vencedores (licitacao_resultados × licitacoes_externas)
// + enriquecimento cadastral via Econodata API v4.
//
// Ações (POST JSON { action, ... }):
//   list     → lista segmentada (filtros: q, modalidade, uf, porte, enriquecido, min_editais; ordenação; paginação)
//   get      → detalhe de um CNPJ: agregados, editais homologados e dados Econodata
//   stats    → totais para os cards/filtros da página
//   enrich   → consulta a Econodata para 1..20 CNPJs (estimar=true faz dry-run sem custo)
//   balance  → saldo de tokens Econodata
//   orgaos_list / orgao_get → órgãos compradores (licitações, homologações, fornecedores vencedores)
//
// Segredos: ECONODATA_API_KEY (Supabase → Edge Functions → Secrets). Nunca exposto ao navegador.
// Leitura exige sessão de usuário (JWT Supabase, validado no código; verify_jwt=false como as demais api-*).
// Banco acessado com service_role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { requireUserAuth } from "../_shared/http.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ECONODATA_BASE = "https://api.econodata.com.br";
const ECONODATA_INCLUIR = ["cadastro", "perfilNegocio", "contatosBasicos"] as const;
const ENRICH_MAX = 20;
const REENRICH_DAYS = 30;

const LIST_COLUMNS = [
  "cnpj", "nome_pncp", "razao_social", "nome_fantasia", "porte_pncp", "porte_econodata",
  "qtd_editais", "qtd_itens", "qtd_orgaos", "valor_total_homologado", "ticket_medio_edital",
  "modalidades", "tipos_licitacao", "ufs_vitoria", "categorias", "marcas", "objetos",
  "primeira_homologacao", "ultima_homologacao", "uf_sede", "municipio_sede",
  "cnae_principal", "cnae_principal_descricao", "recebimentos_governo", "situacao_cadastral",
  "enriquecido", "econodata_consultado_em",
].join(",");

const ORDER: Record<string, { col: string; asc: boolean }> = {
  valor: { col: "valor_total_homologado", asc: false },
  editais: { col: "qtd_editais", asc: false },
  recente: { col: "ultima_homologacao", asc: false },
  nome: { col: "nome_pncp", asc: true },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const onlyDigits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const isCnpj = (v: string) => /^\d{14}$/.test(v);
const str = (v: unknown, max = 120) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ---------------------------------------------------------------- filtro CATMAT (PDM / item / UF)

/**
 * Resolve os filtros por PDM CATMAT e por item (texto da descrição ou código CATMAT) sobre os itens
 * homologados. Retorna null quando nenhum desses filtros foi pedido, ou a lista de CNPJs
 * (de fornecedor ou de órgão) que atendem.
 */
async function cnpjsPorItem(
  db: SupabaseClient,
  p: Record<string, unknown>,
  coluna: "fornecedor_cnpj" | "orgao_cnpj",
): Promise<string[] | null> {
  const pdm = int(p.pdm, 0, 0, 99_999_999);
  const item = str(p.item, 80).replace(/[%,()]/g, " ").trim();
  if (!pdm && !item) return null;
  let q = db.from("homologacoes_itens").select(coluna).not(coluna, "is", null).limit(5000);
  if (pdm) q = q.eq("codigo_pdm", pdm);
  if (item) {
    const dig = onlyDigits(item);
    q = dig.length >= 4 && dig === item ? q.eq("catalogo_codigo_item", dig) : q.ilike("item_descricao", `%${item}%`);
  }
  const uf = str(p.uf, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(uf)) q = q.eq("uf", uf);
  const { data, error } = await q;
  if (error) throw error;
  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []) as any[];
  const out: string[] = rows.map((r) => onlyDigits(r[coluna])).filter((c) => c.length > 0);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- list / stats / get

async function handleList(db: SupabaseClient, p: Record<string, unknown>): Promise<Response> {
  const page = int(p.page, 1, 1, 10_000);
  const pageSize = int(p.pageSize, 25, 1, 100);
  const order = ORDER[str(p.ordenar, 20)] ?? ORDER.valor;

  let q = db.from("fornecedores_homologados").select(LIST_COLUMNS, { count: "exact" });

  const busca = str(p.q, 80).replace(/[%,()]/g, " ").trim();
  if (busca) {
    const dig = onlyDigits(busca);
    q = dig.length >= 8
      ? q.like("cnpj", `${dig}%`)
      : q.or(`nome_pncp.ilike.%${busca}%,razao_social.ilike.%${busca}%,nome_fantasia.ilike.%${busca}%`);
  }
  const modalidade = str(p.modalidade);
  if (modalidade) q = q.contains("tipos_licitacao", [modalidade]);
  const uf = str(p.uf, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(uf)) q = q.contains("ufs_vitoria", [uf]);
  const porte = str(p.porte, 40);
  if (porte) q = q.eq("porte_pncp", porte);
  if (p.enriquecido === true || p.enriquecido === false) q = q.eq("enriquecido", p.enriquecido);
  const minEditais = int(p.min_editais, 0, 0, 1000);
  if (minEditais > 0) q = q.gte("qtd_editais", minEditais);
  const porItem = await cnpjsPorItem(db, p, "fornecedor_cnpj");
  if (porItem) {
    if (porItem.length === 0) return json({ data: [], page, pageSize, total: 0 });
    q = q.in("cnpj", porItem);
  }

  const from = (page - 1) * pageSize;
  const { data, count, error } = await q
    .order(order.col, { ascending: order.asc, nullsFirst: false })
    .order("cnpj", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) {
    console.error("[api-fornecedores-homologados] list:", error);
    return json({ error: "Falha ao consultar fornecedores" }, 500);
  }
  return json({ data, page, pageSize, total: count ?? 0 });
}

async function handleStats(db: SupabaseClient): Promise<Response> {
  const { data, error } = await db
    .from("fornecedores_homologados")
    .select("qtd_editais,valor_total_homologado,modalidades,ufs_vitoria,porte_pncp,enriquecido");
  if (error) return json({ error: "Falha ao calcular estatísticas" }, 500);
  const [{ data: itens }, { count: orgaos }] = await Promise.all([
    db.from("homologacoes_itens").select("codigo_pdm,nome_pdm,fornecedor_cnpj").not("codigo_pdm", "is", null).limit(20000),
    db.from("orgaos_compradores").select("id", { count: "exact", head: true }),
  ]);
  const pdmMap = new Map<number, { codigo_pdm: number; nome_pdm: string; itens: number; forn: Set<string> }>();
  for (const it of itens ?? []) {
    const e = pdmMap.get(it.codigo_pdm) ?? { codigo_pdm: it.codigo_pdm, nome_pdm: it.nome_pdm, itens: 0, forn: new Set<string>() };
    e.itens++;
    e.forn.add(it.fornecedor_cnpj);
    pdmMap.set(it.codigo_pdm, e);
  }
  const pdms = [...pdmMap.values()]
    .map((e) => ({ codigo_pdm: e.codigo_pdm, nome_pdm: e.nome_pdm, itens: e.itens, fornecedores: e.forn.size }))
    .sort((a, b) => a.nome_pdm.localeCompare(b.nome_pdm, "pt-BR"));
  const modalidades: Record<string, number> = {};
  const ufs: Record<string, number> = {};
  const portes: Record<string, number> = {};
  let valor = 0, editais = 0, enriquecidos = 0;
  for (const r of data ?? []) {
    valor += Number(r.valor_total_homologado ?? 0);
    editais += Number(r.qtd_editais ?? 0);
    if (r.enriquecido) enriquecidos++;
    for (const [m, n] of Object.entries((r.modalidades ?? {}) as Record<string, number>)) {
      modalidades[m] = (modalidades[m] ?? 0) + Number(n);
    }
    for (const u of (r.ufs_vitoria ?? []) as string[]) ufs[u] = (ufs[u] ?? 0) + 1;
    const pt = r.porte_pncp ?? "Não informado";
    portes[pt] = (portes[pt] ?? 0) + 1;
  }
  return json({
    fornecedores: data?.length ?? 0,
    vitorias_edital: editais,
    valor_total_homologado: Math.round(valor * 100) / 100,
    enriquecidos,
    modalidades, ufs, portes, pdms,
    orgaos: orgaos ?? 0,
    econodata_configurada: Boolean(Deno.env.get("ECONODATA_API_KEY")),
  });
}

async function handleGet(db: SupabaseClient, p: Record<string, unknown>): Promise<Response> {
  const cnpj = onlyDigits(p.cnpj);
  if (!isCnpj(cnpj)) return json({ error: "CNPJ inválido" }, 400);

  const [agg, forn, res, hi] = await Promise.all([
    db.from("fornecedores_homologados").select("*").eq("cnpj", cnpj).maybeSingle(),
    db.from("fornecedores")
      .select("cnpj,razao_social,nome_fantasia,matriz_filial,situacao_cadastral,data_inicio_atividade,natureza_juridica,porte,porte_econodata,capital_social,cnae_principal,cnae_principal_descricao,cnaes_secundarios,uf,municipio,cep,logradouro,numero,bairro,email,telefones,emails_publicos,socios,recebimentos_governo,ufs_atuacao,filiais_qtd,consulta_fonte,econodata_consultado_em")
      .eq("cnpj", cnpj).maybeSingle(),
    db.from("licitacao_resultados")
      .select("licitacao_id,numero_item,valor_total_homologado,valor_unitario_homologado,quantidade_homologada,marca,modelo,data_resultado,licitacoes_externas(id,fonte,codigo_externo,numero_edital,numero_processo,objeto,modalidade,orgao_nome,uf,municipio,data_homologacao,valor_total)")
      .eq("fornecedor_cnpj", cnpj)
      .order("data_resultado", { ascending: false })
      .limit(500),
    db.from("homologacoes_itens")
      .select("licitacao_id,numero_item,item_descricao,catalogo_codigo_item,codigo_pdm,nome_pdm,pdm_metodo")
      .eq("fornecedor_cnpj", cnpj)
      .limit(1000),
  ]);
  const itemInfo = new Map<string, Record<string, unknown>>();
  for (const x of hi.data ?? []) itemInfo.set(`${x.licitacao_id}:${x.numero_item}`, x);
  const pdmsFornecedor = new Map<number, { codigo_pdm: number; nome_pdm: string; itens: number }>();
  for (const x of hi.data ?? []) {
    if (!x.codigo_pdm) continue;
    const e = pdmsFornecedor.get(x.codigo_pdm) ?? { codigo_pdm: x.codigo_pdm, nome_pdm: x.nome_pdm, itens: 0 };
    e.itens++;
    pdmsFornecedor.set(x.codigo_pdm, e);
  }
  if (agg.error || res.error || forn.error) {
    console.error("[api-fornecedores-homologados] get:", agg.error ?? res.error ?? forn.error);
    return json({ error: "Falha ao consultar fornecedor" }, 500);
  }
  if (!agg.data) return json({ error: "Fornecedor não encontrado na base de homologados" }, 404);

  // Agrupa itens por edital
  const editais = new Map<number, Record<string, unknown>>();
  for (const r of res.data ?? []) {
    // deno-lint-ignore no-explicit-any
    const row = r as any;
    const lic = row.licitacoes_externas ?? {};
    const e = editais.get(row.licitacao_id) ?? {
      licitacao_id: row.licitacao_id,
      fonte: lic.fonte, codigo_externo: lic.codigo_externo, numero_edital: lic.numero_edital,
      numero_processo: lic.numero_processo, objeto: lic.objeto, modalidade: lic.modalidade,
      orgao_nome: lic.orgao_nome, uf: lic.uf, municipio: lic.municipio,
      data_homologacao: lic.data_homologacao ?? row.data_resultado,
      valor_edital: lic.valor_total, valor_homologado: 0, itens: [] as unknown[],
    };
    e.valor_homologado = Number(e.valor_homologado) + Number(row.valor_total_homologado ?? 0);
    const info = itemInfo.get(`${row.licitacao_id}:${row.numero_item}`) ?? {};
    (e.itens as unknown[]).push({
      numero_item: row.numero_item, quantidade: row.quantidade_homologada,
      descricao: info.item_descricao ?? null, catalogo_codigo_item: info.catalogo_codigo_item ?? null,
      codigo_pdm: info.codigo_pdm ?? null, nome_pdm: info.nome_pdm ?? null, pdm_metodo: info.pdm_metodo ?? null,
      valor_unitario: row.valor_unitario_homologado, valor_total: row.valor_total_homologado,
      marca: row.marca, modelo: row.modelo,
    });
    editais.set(row.licitacao_id, e);
  }
  return json({
    fornecedor: agg.data,
    cadastro: forn.data,
    pdms: [...pdmsFornecedor.values()].sort((a, b) => b.itens - a.itens),
    editais: [...editais.values()],
  });
}

async function handleHistorico(db: SupabaseClient, p: Record<string, unknown>): Promise<Response> {
  const cnpj = onlyDigits(p.cnpj);
  if (!cnpj || cnpj.length !== 14) {
    return json({ error: "CNPJ inválido (deve conter 14 dígitos)" }, 400);
  }
  const { data, error } = await db
    .from("v_bi_fornecedor_historico")
    .select("*")
    .eq("cnpj", cnpj)
    .maybeSingle();

  if (error) {
    console.error("[api-fornecedores-homologados] historico:", error);
    return json({ error: "Falha ao consultar histórico de fornecedor no BI" }, 500);
  }
  if (!data) {
    return json({ error: "Fornecedor não encontrado no histórico de compras homologadas" }, 404);
  }
  return json({ data });
}

// ---------------------------------------------------------------- órgãos compradores

const ORGAO_ORDER: Record<string, { col: string; asc: boolean }> = {
  valor: { col: "valor_homologado", asc: false },
  editais: { col: "qtd_licitacoes", asc: false },
  recente: { col: "ultima_publicacao", asc: false },
  nome: { col: "nome", asc: true },
};

async function handleOrgaosList(db: SupabaseClient, p: Record<string, unknown>): Promise<Response> {
  const page = int(p.page, 1, 1, 10_000);
  const pageSize = int(p.pageSize, 25, 1, 100);
  const order = ORGAO_ORDER[str(p.ordenar, 20)] ?? ORGAO_ORDER.editais;
  let q = db.from("orgaos_compradores").select("*", { count: "exact" });
  const busca = str(p.q, 80).replace(/[%,()]/g, " ").trim();
  if (busca) {
    const dig = onlyDigits(busca);
    q = dig.length >= 8 ? q.like("cnpj", `${dig}%`) : q.or(`nome.ilike.%${busca}%,municipio.ilike.%${busca}%`);
  }
  const modalidade = str(p.modalidade);
  if (modalidade) q = q.contains("tipos_licitacao", [modalidade]);
  const uf = str(p.uf, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(uf)) q = q.eq("uf", uf);
  const porItem = await cnpjsPorItem(db, p, "orgao_cnpj");
  if (porItem) {
    if (porItem.length === 0) return json({ data: [], page, pageSize, total: 0 });
    q = q.in("cnpj", porItem);
  }
  const from = (page - 1) * pageSize;
  const { data, count, error } = await q
    .order(order.col, { ascending: order.asc, nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) {
    console.error("[api-fornecedores-homologados] orgaos_list:", error);
    return json({ error: "Falha ao consultar órgãos" }, 500);
  }
  return json({ data, page, pageSize, total: count ?? 0 });
}

async function handleOrgaoGet(db: SupabaseClient, p: Record<string, unknown>): Promise<Response> {
  const id = str(p.id, 60);
  if (!id) return json({ error: "Informe o id do órgão" }, 400);
  const { data: orgao, error } = await db.from("orgaos_compradores").select("*").eq("id", id).maybeSingle();
  if (error) return json({ error: "Falha ao consultar órgão" }, 500);
  if (!orgao) return json({ error: "Órgão não encontrado" }, 404);

  let lq = db.from("licitacoes_externas")
    .select("id,fonte,codigo_externo,numero_edital,numero_processo,objeto,modalidade,situacao,status_normalizado,unidade_compradora,valor_total,data_publicacao,data_homologacao,licitacao_resultados(fornecedor_cnpj,fornecedor_nome,valor_total_homologado)")
    .order("data_publicacao", { ascending: false, nullsFirst: false })
    .limit(200);
  lq = orgao.cnpj ? lq.eq("orgao_cnpj", orgao.cnpj) : lq.is("orgao_cnpj", null);
  const { data: lics, error: e2 } = await lq;
  if (e2) {
    console.error("[api-fornecedores-homologados] orgao_get:", e2);
    return json({ error: "Falha ao consultar licitações do órgão" }, 500);
  }
  const fornecedores = new Map<string, { cnpj: string; nome: string; valor: number; editais: Set<number> }>();
  // deno-lint-ignore no-explicit-any
  const licitacoes = (lics ?? []).map((l: any) => {
    const res = (l.licitacao_resultados ?? []) as Array<{ fornecedor_cnpj: string; fornecedor_nome: string; valor_total_homologado: number }>;
    for (const r of res) {
      if (!r.fornecedor_cnpj) continue;
      const f = fornecedores.get(r.fornecedor_cnpj) ?? { cnpj: r.fornecedor_cnpj, nome: r.fornecedor_nome, valor: 0, editais: new Set<number>() };
      f.valor += Number(r.valor_total_homologado ?? 0);
      f.editais.add(l.id);
      fornecedores.set(r.fornecedor_cnpj, f);
    }
    const { licitacao_resultados: _r, ...rest } = l;
    return {
      ...rest,
      valor_homologado: res.reduce((s, r) => s + Number(r.valor_total_homologado ?? 0), 0),
      vencedores: [...new Set(res.map((r) => r.fornecedor_nome).filter(Boolean))],
    };
  });
  return json({
    orgao,
    licitacoes,
    fornecedores: [...fornecedores.values()]
      .map((f) => ({ cnpj: f.cnpj, nome: f.nome, valor_homologado: f.valor, qtd_editais: f.editais.size }))
      .sort((a, b) => b.valor_homologado - a.valor_homologado),
  });
}

// ---------------------------------------------------------------- Econodata

type EconoResult = { status: number; body: unknown; tokens: number | null };

async function econodata(path: string, init: RequestInit & { estimate?: boolean } = {}): Promise<EconoResult> {
  const key = Deno.env.get("ECONODATA_API_KEY");
  if (!key) return { status: 503, body: { error: "ECONODATA_API_KEY não configurada" }, tokens: null };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (init.estimate) headers["X-Estimate-Only"] = "true";
  const resp = await fetch(`${ECONODATA_BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(25_000) });
  const text = await resp.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* texto */ }
  const charged = resp.headers.get("X-Tokens-Charged");
  return { status: resp.status, body, tokens: charged == null ? null : Number(charged) };
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));

// deno-lint-ignore no-explicit-any
function mapEmpresa(e: any): Record<string, unknown> {
  const cnpj = onlyDigits(e.cnpj);
  const c = e.cadastro ?? {};
  const p = e.perfilNegocio ?? {};
  const k = e.contatosBasicos ?? {};
  const end = c.endereco ?? {};
  const cnae = onlyDigits(c.cnaePrimario?.codigo);
  // Sócios: guarda nome/qualificação/data; descarta CPF e e-mail pessoal (LGPD, minimização).
  // deno-lint-ignore no-explicit-any
  const socios = Array.isArray(c.socios) ? c.socios.map((s: any) => compact({
    nome: s.nome, qualificacao: s.qualificacao, cnpjSocio: s.cnpjSocio,
    dataEntrada: s.dataEntrada, representanteLegal: s.representanteLegal,
  })) : undefined;
  // deno-lint-ignore no-explicit-any
  const telefones = Array.isArray(k.telefones) ? k.telefones.map((t: any) => t?.numero).filter(Boolean) : undefined;
  return compact({
    cnpj,
    cnpj_raiz: cnpj.slice(0, 8),
    razao_social: c.razaoSocial,
    nome_fantasia: c.nomeFantasia,
    matriz_filial: c.tipoUnidade,
    situacao_cadastral: c.situacaoCadastral?.tipo ?? c.situacao,
    data_situacao_cadastral: isoDate(c.situacaoCadastral?.data),
    data_inicio_atividade: isoDate(c.dataAbertura),
    natureza_juridica: c.naturezaJuridica?.nome,
    porte: c.enquadramentoPorte,
    capital_social: typeof c.capitalSocial === "number" ? c.capitalSocial : undefined,
    cnae_principal: cnae ? Number.parseInt(cnae, 10) : undefined,
    cnae_principal_descricao: c.cnaePrimario?.descricao,
    cnaes_secundarios: Array.isArray(c.cnaesSecundarios) ? c.cnaesSecundarios : undefined,
    uf: end.uf ?? c.uf,
    municipio: end.cidade ?? c.cidade,
    cep: onlyDigits(end.cep) || undefined,
    logradouro: end.logradouro,
    bairro: end.bairro,
    email: k.emailReceita,
    telefones,
    emails_publicos: Array.isArray(k.emailsPublicos) ? k.emailsPublicos : undefined,
    socios,
    porte_econodata: p.porte,
    recebimentos_governo: typeof p.recebimentosGoverno === "number" ? p.recebimentosGoverno : undefined,
    ufs_atuacao: Array.isArray(p.ufs) ? p.ufs : undefined,
    filiais_qtd: Array.isArray(p.filiais) ? p.filiais.length : undefined,
    consulta_status: "ok",
    consulta_fonte: "econodata",
    consultado_em: new Date().toISOString(),
    econodata_consultado_em: new Date().toISOString(),
    econodata: e,
  });
}

async function handleEnrich(db: SupabaseClient, p: Record<string, unknown>, userId: string): Promise<Response> {
  const raw = Array.isArray(p.cnpjs) ? p.cnpjs : [p.cnpj];
  let cnpjs = [...new Set(raw.map(onlyDigits).filter(isCnpj))];
  if (cnpjs.length === 0) return json({ error: "Informe ao menos um CNPJ válido" }, 400);
  if (cnpjs.length > ENRICH_MAX) return json({ error: `Máximo de ${ENRICH_MAX} CNPJs por chamada` }, 400);
  const estimar = p.estimar === true;
  const forcar = p.forcar === true;

  // Só enriquece quem está na base de homologados (evita uso da chave como proxy genérico).
  const { data: base } = await db.from("fornecedores_homologados").select("cnpj,econodata_consultado_em").in("cnpj", cnpjs);
  const naBase = new Map((base ?? []).map((r) => [r.cnpj as string, r.econodata_consultado_em as string | null]));
  const foraDaBase = cnpjs.filter((c) => !naBase.has(c));
  cnpjs = cnpjs.filter((c) => naBase.has(c));
  const limite = Date.now() - REENRICH_DAYS * 86_400_000;
  const recentes = forcar ? [] : cnpjs.filter((c) => {
    const t = naBase.get(c);
    return t != null && new Date(t).getTime() > limite;
  });
  cnpjs = cnpjs.filter((c) => !recentes.includes(c));
  if (cnpjs.length === 0) {
    return json({ enriquecidos: [], pulados_recentes: recentes, fora_da_base: foraDaBase, tokens_cobrados: 0 });
  }

  const payload = {
    cnpjs,
    incluir: [...ECONODATA_INCLUIR],
    limitePorLista: { telefones: 3, emailsPublicos: 3, socios: 10, filiais: 50 },
  };
  const r = await econodata("/v4/companies", { method: "POST", body: JSON.stringify(payload), estimate: estimar });

  // deno-lint-ignore no-explicit-any
  const body = r.body as any;
  await db.from("econodata_consultas").insert({
    cnpjs, incluir: payload.incluir, estimativa: estimar, status_http: r.status,
    tokens_cobrados: r.tokens, tokens_estimados: body?.tokensEstimados ?? null,
    erro: r.status >= 400 ? JSON.stringify(body).slice(0, 1000) : null, usuario_id: userId,
  });

  if (r.status === 503 && body?.error?.includes?.("ECONODATA_API_KEY")) {
    return json({ error: "Integração Econodata não configurada (secret ECONODATA_API_KEY)." }, 503);
  }
  if (estimar) {
    if (r.status >= 400) return json({ error: "Econodata recusou a estimativa", status: r.status, detalhe: body }, 502);
    return json({ estimativa: true, cnpjs, tokens_estimados: body?.tokensEstimados ?? null, pulados_recentes: recentes, fora_da_base: foraDaBase });
  }
  if (r.status === 404) {
    await db.from("fornecedores").upsert(
      cnpjs.map((c) => ({ cnpj: c, cnpj_raiz: c.slice(0, 8), consulta_status: "nao_encontrado", consulta_fonte: "econodata", consultado_em: new Date().toISOString() })),
      { onConflict: "cnpj", ignoreDuplicates: true },
    );
    return json({ enriquecidos: [], nao_encontrados: cnpjs, tokens_cobrados: r.tokens ?? 0 });
  }
  if (r.status >= 400) {
    const msg = r.status === 401 ? "Chave Econodata inválida"
      : r.status === 402 ? "Saldo de tokens Econodata insuficiente"
      : r.status === 403 ? "Operação não permitida para a chave (trial é somente leitura)"
      : r.status === 429 ? "Limite de requisições Econodata atingido (60/min). Tente em instantes."
      : "Falha na Econodata";
    return json({ error: msg, status: r.status }, r.status === 429 ? 429 : 502);
  }

  const empresas = Array.isArray(body?.empresas) ? body.empresas : [];
  const rows = empresas.map(mapEmpresa).filter((row: Record<string, unknown>) => isCnpj(String(row.cnpj)));
  if (rows.length) {
    const { error } = await db.from("fornecedores").upsert(rows, { onConflict: "cnpj" });
    if (error) {
      console.error("[api-fornecedores-homologados] upsert:", error);
      return json({ error: "Dados recebidos, mas falhou ao gravar no banco" }, 500);
    }
  }
  return json({
    enriquecidos: rows.map((x: Record<string, unknown>) => x.cnpj),
    erros: body?.erros ?? [],
    pulados_recentes: recentes,
    fora_da_base: foraDaBase,
    tokens_cobrados: r.tokens ?? 0,
  });
}

async function handleBalance(): Promise<Response> {
  const r = await econodata("/v4/account/balance", { method: "GET" });
  if (r.status === 503) return json({ configurada: false, saldoTokens: null });
  if (r.status >= 400) return json({ configurada: true, error: "Falha ao consultar saldo", status: r.status }, 502);
  // deno-lint-ignore no-explicit-any
  return json({ configurada: true, saldoTokens: (r.body as any)?.saldoTokens ?? null });
}

// ---------------------------------------------------------------- servidor

export interface ApiFornecedoresContext {
  getDb?: () => SupabaseClient;
  requireAuth?: (req: Request) => Promise<Response | null>;
  getUserId?: (req: Request) => Promise<string | null>;
}

export async function handleRequest(req: Request, ctx: ApiFornecedoresContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST com corpo JSON { action }" }, 405);

  const authError = await (ctx.requireAuth ?? requireUserAuth)(req);
  if (authError) return authError;

  let p: Record<string, unknown>;
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
    p = b as Record<string, unknown>;
  } catch {
    return json({ error: "Corpo JSON inválido" }, 400);
  }

  const userId = (req as unknown as { user?: { id: string } }).user?.id
    ?? (await ctx.getUserId?.(req));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  try {
    const db = ctx.getDb ? ctx.getDb() : serviceClient();
    switch (p.action) {
      case "list": return await handleList(db, p);
      case "stats": return await handleStats(db);
      case "get": return await handleGet(db, p);
      case "enrich": return await handleEnrich(db, p, userId);
      case "balance": return await handleBalance();
      case "orgaos_list": return await handleOrgaosList(db, p);
      case "orgao_get": return await handleOrgaoGet(db, p);
      case "historico": return await handleHistorico(db, p);
      default: return json({ error: "Ação não suportada (list, stats, get, enrich, balance, orgaos_list, orgao_get, historico)" }, 400);
    }
  } catch (err) {
    console.error("[api-fornecedores-homologados] erro:", err);
    return json({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));

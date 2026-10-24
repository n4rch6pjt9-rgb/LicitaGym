// Spec 0031: cliente falso da api-precos para os testes desta pasta. Registra cada rpc com os argumentos e responde
// com as linhas dadas (o recorte em si é provado no banco por supabase/tests/precos_itens_contratacao_check.sql).
import { type PrecosClient, responderPrecos } from "../../../supabase/functions/api-precos/precos.ts";

export type Linha = Record<string, unknown>;
export const HOJE = "2026-10-21";

export function fake(
  resp: { amostras?: Linha[]; resumo?: Linha[]; itens?: Linha[]; municipios?: Linha[]; catalogo?: number[] },
) {
  const rpcs: Array<{ funcao: string; args: Record<string, unknown> }> = [];
  const catalogo = resp.catalogo ?? [9634];
  const pronto = (data: unknown) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (_c: string, v: unknown) => {
        (q as { _eq?: unknown })._eq = v;
        return q;
      },
      then: (ok: (r: unknown) => unknown, err?: (e: unknown) => unknown) => {
        const eq = (q as { _eq?: unknown })._eq;
        const d = Array.isArray(data) && eq !== undefined
          ? (data as Linha[]).filter((l) => l.codigo_pdm === eq)
          : data;
        return Promise.resolve({ data: d, error: null }).then(ok, err);
      },
    };
    return q;
  };
  const client = {
    from() {
      throw new Error("a api-precos não lê tabela direto (spec 0031)");
    },
    rpc(funcao: string, args?: Record<string, unknown>) {
      rpcs.push({ funcao, args: args ?? {} });
      if (funcao === "catalogo_catmat_pdms_efetivos") return pronto(catalogo.map((codigo_pdm) => ({ codigo_pdm })));
      if (funcao === "precos_praticados_amostras") {
        const off = Number(args?.p_offset ?? 0);
        const lim = Number(args?.p_limit ?? 20);
        const todas = resp.amostras ?? [];
        return pronto(todas.slice(off, off + lim).map((l) => ({ ...l, total: todas.length })));
      }
      if (funcao === "precos_praticados_itens_pdm") return pronto(resp.itens ?? []);
      if (funcao === "precos_praticados_municipios") return pronto(resp.municipios ?? []);
      return pronto(resp.resumo ?? []);
    },
  };
  return { client: client as unknown as PrecosClient, rpcs };
}

export async function chamar(qs: string, resp: Parameters<typeof fake>[0] = {}) {
  const f = fake(resp);
  let clientes = 0;
  const url = new URL(`https://x.supabase.co/functions/v1/api-precos?${qs}`);
  const res = await responderPrecos(new Request(url), url, {
    requireAuth: () => Promise.resolve(null),
    criarCliente: () => {
      clientes++;
      return f.client;
    },
    hoje: () => HOJE,
  });
  return { res, body: await res.json(), rpcs: f.rpcs, clientes };
}

/** Linha de public.precos_praticados_amostras do caso de referência 2 (Belém, item 66), já com a compra consultada. */
export function amostraBelem(p: Linha = {}): Linha {
  return {
    id_compra: "16021805900022026",
    id_item_compra: 12123540,
    numero_item_compra: 66,
    codigo_item_catalogo: 602701,
    codigo_pdm: "9634",
    data_resultado: "2026-08-05",
    data_compra: "2026-08-05",
    codigo_uasg: "160218",
    nome_uasg: "COLÉGIO MILITAR DE BELÉM",
    codigo_orgao: 52121,
    nome_orgao: "COMANDO DO EXERCITO",
    estado: "PA",
    municipio: "BELÉM",
    esfera: "F",
    poder: "E",
    modalidade: 5,
    forma: "SISRP",
    criterio_julgamento: "V",
    percentual_maior_desconto: 0,
    quantidade: 18,
    preco_unitario: 2229,
    sigla_unidade_fornecimento: "UN",
    nome_unidade_fornecimento: "UNIDADE",
    sigla_unidade_medida: null,
    nome_unidade_medida: null,
    marca: "PROCOPIO",
    nome_fornecedor: "SEBASTIAO Q. FERREIRA",
    ni_fornecedor: "07137759000160",
    objeto_compra: "Objeto: Pregão Eletrônico - Eventual aquisição de material esportivo",
    descricao_item: "MESA TÊNIS DE MESA / FUTMESA",
    descricao_detalhada_item: null,
    compra_consultada: true,
    compra_encontrada: true,
    numero_controle_pncp: "00394452000103-1-010524/2026",
    orgao_entidade_cnpj: "00394452000103",
    ano_compra_pncp: 2026,
    sequencial_compra_pncp: 10524,
    link_sistema_origem:
      "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=16021805900022026",
    valor_unitario_estimado: 3156.67,
    ...p,
  };
}

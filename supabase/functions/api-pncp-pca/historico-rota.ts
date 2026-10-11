/**
 * GET api-pncp-pca?visao=historico: autentica, resolve as classes no catálogo e lê public.pca_historico_orgao_ano
 * (só service_role). Erro de banco/RPC vai para o log; o chamador recebe mensagem genérica e 502.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { errorDetail, jsonResponse, parseQueryInt, requireUserAuth } from "../_shared/http.ts";
import { classesDaQuery, classesDoCatalogo, resolverClasses } from "../_shared/catalogo-classes.ts";
import { linhaHistorico, type LinhaHistorico, montarHistorico } from "./historico.ts";

const PAGE = 1000;
const MAX_PAGES = 20;
export const ERRO_HISTORICO = "Falha ao ler o histórico do PCA.";
const COLUNAS =
  "orgao_cnpj, orgao_nome, uf, ano_exercicio, classes_presentes, planos, itens, itens_sem_valor, valor_planejado, unidades, compras_escopo_observadas, valor_escopo_observado, execucoes_confirmadas, lag_medio_dias, lag_soma_dias, lag_n";

export interface HistoricoDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente?: () => SupabaseClient;
  anoAberto?: number;
}

function criarClienteServico(): SupabaseClient {
  const serviceUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceUrl || !serviceKey) throw new Error("Service role não configurado");
  return createClient(serviceUrl, serviceKey, { auth: { persistSession: false } });
}

/** Detalhe do banco (função, coluna, hint) fica só no log. */
function falhaBanco(contexto: string, error: unknown): Response {
  console.error(`[api-pncp-pca] historico ${contexto}`, errorDetail(error));
  return jsonResponse({ error: ERRO_HISTORICO }, 502);
}

export async function responderHistorico(req: Request, url: URL, deps: HistoricoDeps = {}): Promise<Response> {
  const denied = await (deps.requireAuth ?? requireUserAuth)(req);
  if (denied) return denied;
  const anoAberto = deps.anoAberto ?? new Date().getUTCFullYear();
  const anoFim = parseQueryInt(url, "ano_fim", anoAberto);
  const anoInicio = parseQueryInt(url, "ano_inicio", anoFim - 2);
  if (anoInicio > anoFim || anoFim - anoInicio > 5 || anoInicio < 2000 || anoFim > 2100) {
    return jsonResponse({ error: "janela de anos inválida" }, 400);
  }

  let admin: SupabaseClient;
  let catalogo: string[];
  try {
    admin = (deps.criarCliente ?? criarClienteServico)();
    catalogo = await classesDoCatalogo(admin);
  } catch (error) {
    return falhaBanco("catálogo", error);
  }
  // Padrão: as classes do catálogo CATMAT da empresa; ?classes=7830,7220 (ou ?classe=) só aceita classes dele.
  const pedidas = classesDaQuery(url);
  const resolvidas = resolverClasses(pedidas, catalogo);
  if (!resolvidas.ok) return jsonResponse({ error: resolvidas.erro }, resolvidas.status);
  const classes = resolvidas.classes;

  const linhas: LinhaHistorico[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    const to = from + PAGE - 1;
    const { data, error } = await admin
      .rpc("pca_historico_orgao_ano", { p_classes: classes, p_ano_inicio: anoInicio, p_ano_fim: anoFim })
      .select(COLUNAS)
      .order("orgao_cnpj", { ascending: true })
      .order("ano_exercicio", { ascending: true })
      .range(from, to);
    if (error) return falhaBanco("rpc", error);
    const batch = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    for (const raw of batch) {
      const linha = linhaHistorico(raw);
      if (linha) linhas.push(linha);
    }
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      return jsonResponse({ error: "Leitura interrompida: a janela não coube no limite de páginas." }, 500);
    }
  }

  const montado = montarHistorico(linhas, anoAberto);
  return jsonResponse({
    classes,
    origem_classes: pedidas ? "pedido" : "catalogo_catmat",
    ano_inicio: anoInicio,
    ano_fim: anoFim,
    ano_aberto: anoAberto,
    nota: "Contagem dos planos já sincronizados, nas classes pedidas. Compra observada é do escopo inteiro (categoria do objeto da licitação; os itens de licitação não trazem classe CATMAT), não da classe, e não é execução; republicação do PNCP conta uma vez. Execução confirmada exige evidência gravada. Prazo e execução usam só ano fechado; o prazo do órgão é a média por item. O ano em curso entra no planejado como exercício aberto.",
    ...montado,
  });
}

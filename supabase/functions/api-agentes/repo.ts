import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Achado, Agente, ResultadoAgente, Situacao } from "../_shared/agentes/tipos.ts";
import type { ChunkEdital } from "../_shared/agentes/edital.ts";
import { NORMA, type Dispositivo } from "../_shared/agentes/juridico.ts";
import { pisoTenantCentavos, type ItemPreco, type PropostaItem } from "../_shared/agentes/preco.ts";

export interface Dossie {
  licitacao: { id: number; payload_hash: string | null; data_abertura: string | null };
  documentos_sha256: string[];
  chunks: ChunkEdital[];
  itens: ItemPreco[];
  dispositivos: Dispositivo[];
}

export interface Execucao {
  id: number;
  licitacao_id: number;
  agente: Agente;
  situacao: Situacao;
  contexto_hash: string;
  regra_versao: string;
  entrada: { proposta: PropostaItem[] | null };
  achados: Achado[];
  revisao: "aguardando" | "aprovada" | "rejeitada";
  revisao_nota: string | null;
  revisado_por: string | null;
  revisado_em: string | null;
  solicitado_por: string;
  created_at: string;
}

export class ErroAgentes extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface AgentesRepo {
  tenantDoUsuario(userId: string): Promise<number>;
  carregarDossie(tenant: number, licitacaoId: number): Promise<Dossie | null>;
  buscarExecucao(tenant: number, licitacaoId: number, agente: Agente, contextoHash: string): Promise<Execucao | null>;
  gravarExecucao(
    tenant: number,
    userId: string,
    licitacaoId: number,
    contextoHash: string,
    proposta: PropostaItem[] | null,
    r: ResultadoAgente,
  ): Promise<Execucao>;
  ultimasExecucoes(tenant: number, licitacaoId: number): Promise<Execucao[]>;
  obterExecucao(tenant: number, id: number): Promise<Execucao | null>;
  ultimaAprovada(tenant: number, licitacaoId: number, agente: Agente): Promise<Execucao | null>;
  revisar(
    tenant: number,
    id: number,
    decisao: "aprovada" | "rejeitada",
    nota: string | null,
    userId: string,
  ): Promise<Execucao | null>;
}

const AGENTES: Agente[] = ["edital", "preco", "juridico"];

function comoExecucao(row: Record<string, unknown>): Execucao {
  const entrada = row.entrada as { proposta?: PropostaItem[] | null } | null;
  return {
    id: Number(row.id),
    licitacao_id: Number(row.licitacao_id),
    agente: row.agente as Agente,
    situacao: row.situacao as Situacao,
    contexto_hash: String(row.contexto_hash),
    regra_versao: String(row.regra_versao),
    entrada: { proposta: entrada?.proposta ?? null },
    achados: (row.achados as Achado[]) ?? [],
    revisao: row.revisao as Execucao["revisao"],
    revisao_nota: (row.revisao_nota as string | null) ?? null,
    revisado_por: (row.revisado_por as string | null) ?? null,
    revisado_em: (row.revisado_em as string | null) ?? null,
    solicitado_por: String(row.solicitado_por),
    created_at: String(row.created_at),
  };
}

function centavos(valor: unknown): number | null {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  const c = Math.round(valor * 100);
  return c > 0 ? c : null;
}

function codigoCatalogo(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isInteger(valor) && valor > 0) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor)) return Number(valor);
  return null;
}

export function createSupabaseRepo(client: SupabaseClient): AgentesRepo {
  return {
    async tenantDoUsuario(_userId) {
      const { data, error } = await client.from("tenants").select("id").eq("ativo", true).order("id").limit(2);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) throw new ErroAgentes("Nenhuma empresa ativa cadastrada.", 409);
      if (data.length > 1) {
        throw new ErroAgentes("Há mais de uma empresa cadastrada e o usuário ainda não está ligado a uma.", 409);
      }
      return data[0].id as number;
    },

    async carregarDossie(tenant, licitacaoId) {
      const { data: lic, error: eLic } = await client
        .from("licitacoes_externas")
        .select("id")
        .eq("id", licitacaoId)
        .maybeSingle();
      if (eLic) throw new Error(eLic.message);
      if (!lic) return null;

      const { data: docs, error: eDocs } = await client
        .from("licitacao_documentos")
        .select("sha256")
        .eq("licitacao_id", licitacaoId)
        .not("sha256", "is", null);
      if (eDocs) throw new Error(eDocs.message);
      const documentos_sha256 = ((docs ?? []) as { sha256: string }[])
        .map((d) => d.sha256)
        .filter((s) => typeof s === "string" && s.length > 0)
        .sort();

      const { data: chunks, error: eChunks } = await client
        .from("licitacao_chunks")
        .select("id,documento_id,pagina,texto")
        .eq("licitacao_id", licitacaoId)
        .eq("secao", "processo")
        .order("documento_id")
        .order("ordem")
        .limit(2000);
      if (eChunks) throw new Error(eChunks.message);

      const { data: itensRaw, error: eItens } = await client
        .from("licitacao_itens")
        .select("id,numero_item,unidade_medida,valor_unitario_estimado,catalogo_codigo_item")
        .eq("licitacao_id", licitacaoId)
        .order("numero_item");
      if (eItens) throw new Error(eItens.message);

      const desde = new Date();
      desde.setUTCMonth(desde.getUTCMonth() - 24);
      const desdeIso = desde.toISOString().slice(0, 10);
      const hoje = new Date().toISOString().slice(0, 10);

      const itens: ItemPreco[] = [];
      for (const bruto of (itensRaw ?? []) as Array<Record<string, unknown>>) {
        const codigo = codigoCatalogo(bruto.catalogo_codigo_item);
        let amostras: ItemPreco["amostras"] = [];
        if (codigo !== null) {
          const { data: amostrasRaw, error: eAm } = await client
            .from("precos_praticados_itens")
            .select("id_compra_item,preco_unitario,sigla_unidade_fornecimento")
            .eq("codigo_item_catalogo", codigo)
            .gte("data_resultado", desdeIso)
            .limit(200);
          if (eAm) throw new Error(eAm.message);
          amostras = ((amostrasRaw ?? []) as Array<Record<string, unknown>>)
            .filter((a) => typeof a.id_compra_item === "string")
            .map((a) => ({
              id_compra_item: a.id_compra_item as string,
              preco_centavos: Math.round(Number(a.preco_unitario) * 100),
              unidade: (a.sigla_unidade_fornecimento as string | null) ?? null,
            }));
        }

        let piso_centavos: number | null = null;
        const { data: dePara, error: eDe } = await client
          .from("catalogo_de_para")
          .select("produto_id")
          .eq("tenant_id", tenant)
          .eq("licitacao_item_id", bruto.id)
          .eq("status", "confirmado")
          .order("id")
          .limit(1);
        if (eDe) throw new Error(eDe.message);
        const produtoId = (dePara ?? [])[0]?.produto_id as number | undefined;
        if (produtoId !== undefined) {
          const { data: precos, error: ePr } = await client
            .from("catalogo_precos")
            .select("preco_tabela,desconto_max_pct,vigencia_inicio,vigencia_fim")
            .eq("tenant_id", tenant)
            .eq("produto_id", produtoId)
            .lte("vigencia_inicio", hoje)
            .order("vigencia_inicio", { ascending: false })
            .limit(5);
          if (ePr) throw new Error(ePr.message);
          const vigente = ((precos ?? []) as Array<Record<string, unknown>>).find((p) =>
            p.vigencia_fim === null || String(p.vigencia_fim) >= hoje
          );
          if (vigente && typeof vigente.preco_tabela === "number") {
            const tabela = Math.round(vigente.preco_tabela * 100);
            const desconto = typeof vigente.desconto_max_pct === "number" ? vigente.desconto_max_pct : 0;
            piso_centavos = pisoTenantCentavos(tabela, desconto);
          }
        }

        itens.push({
          numero_item: Number(bruto.numero_item),
          unidade: (bruto.unidade_medida as string | null) ?? null,
          estimado_centavos: centavos(bruto.valor_unitario_estimado),
          amostras,
          piso_centavos,
        });
      }

      const { data: dispositivos, error: eDisp } = await client
        .from("norma_dispositivos")
        .select("norma,artigo,texto,conferido_oficial")
        .eq("norma", NORMA);
      if (eDisp) throw new Error(eDisp.message);

      return {
        // licitacoes_externas ainda não registra uma data inequívoca de sessão pública.
        // Não usar início/fim de propostas para calcular prazo de impugnação.
        licitacao: { id: Number(lic.id), payload_hash: null, data_abertura: null },
        documentos_sha256,
        chunks: ((chunks ?? []) as ChunkEdital[]),
        itens,
        dispositivos: ((dispositivos ?? []) as Dispositivo[]),
      };
    },

    async buscarExecucao(tenant, licitacaoId, agente, contextoHash) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId)
        .eq("agente", agente)
        .eq("contexto_hash", contextoHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async gravarExecucao(tenant, userId, licitacaoId, contextoHash, proposta, r) {
      const { data, error } = await client
        .from("agente_execucoes")
        .insert({
          tenant_id: tenant,
          licitacao_id: licitacaoId,
          agente: r.agente,
          situacao: r.situacao,
          contexto_hash: contextoHash,
          regra_versao: r.regra_versao,
          entrada: { proposta },
          achados: r.achados,
          solicitado_por: userId,
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return comoExecucao(data as Record<string, unknown>);
    },

    async ultimasExecucoes(tenant, licitacaoId) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      const vistas = new Set<Agente>();
      const saida: Execucao[] = [];
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const exec = comoExecucao(row);
        if (vistas.has(exec.agente)) continue;
        vistas.add(exec.agente);
        saida.push(exec);
      }
      return AGENTES.flatMap((agente) => {
        const achou = saida.find((e) => e.agente === agente);
        return achou ? [achou] : [];
      });
    },

    async obterExecucao(tenant, id) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async ultimaAprovada(tenant, licitacaoId, agente) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId)
        .eq("agente", agente)
        .eq("revisao", "aprovada")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async revisar(tenant, id, decisao, nota, userId) {
      const { data, error } = await client
        .from("agente_execucoes")
        .update({
          revisao: decisao,
          revisao_nota: nota,
          revisado_por: userId,
          revisado_em: new Date().toISOString(),
        })
        .eq("tenant_id", tenant)
        .eq("id", id)
        .eq("revisao", "aguardando")
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },
  };
}

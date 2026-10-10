/**
 * Casamento edital/compra ↔ plano do PCA (link-pca-edital), sem o handler HTTP.
 * dry_run percorre o mesmo caminho do real, com as mesmas classes, e só pula as gravações.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  anosCompativeis,
  dentroJanelaDias,
  type LinkDecision,
  type LinkMatchRow,
  pickUniquePlanoLinks,
} from "./_shared_prod/pncp/link-pca-edital.ts";
import { jsonResponse } from "./_shared_prod/http.ts";

export type LinkOpcoes = {
  janelaDias: number;
  limite: number;
  dryRun: boolean;
  /** Classes PCA no fallback PDM (já resolvidas contra o catálogo). */
  classes: string[];
};

export type LinkStats = {
  editais_analisados: number;
  externas_analisadas: number;
  candidatos_codigo: number;
  candidatos_pdm_janela: number;
  ambiguos: number;
  /** Real: gravados. dry_run: decisões únicas que seriam gravadas. */
  vinculados: number;
  vinculados_externas: number;
  erros: number;
  dry_run: boolean;
  /** Probe: payload publicacao sem PCA → linker determinístico. */
  probe_payload_sem_id_pca: true;
};

/** Leitura de base que falhou: o handler loga o detalhe e responde mensagem genérica. */
export class FalhaLeituraLink extends Error {
  constructor(contexto: string, detalhe: unknown) {
    super(`${contexto}: ${detalhe instanceof Error ? detalhe.message : JSON.stringify(detalhe)}`);
  }
}

export const ERRO_LINK = "Falha ao ler os dados do vínculo PCA–edital.";

/** Erro de banco/RPC: detalhe só no log; o chamador recebe mensagem genérica e 502. */
export function falhaLink(contexto: string, error: unknown): Response {
  console.error(`[link-pca-edital] ${contexto}`, error instanceof Error ? error.message : error);
  return jsonResponse({ error: ERRO_LINK }, 502);
}

/** Planos ativos do ano com item ativo nas classes (escopo do casamento por PDM). */
export async function contarPlanosNasClasses(
  client: SupabaseClient,
  classes: string[],
  ano: number,
): Promise<number> {
  const { count, error } = await client
    .from("pca_planos")
    .select("id, pca_itens!inner(id)", { count: "exact", head: true })
    .eq("ativo", true)
    .eq("ano_exercicio", ano)
    .eq("pca_itens.ativo", true)
    .in("pca_itens.classe_material_servico", classes);
  if (error) throw new FalhaLeituraLink("planos nas classes", error);
  if (typeof count !== "number") throw new FalhaLeituraLink("planos nas classes", "contagem ausente");
  return count;
}

export async function executarLink(
  client: SupabaseClient,
  o: LinkOpcoes,
): Promise<{ stats: LinkStats; decisions: LinkDecision[] }> {
  const { janelaDias, limite, dryRun, classes } = o;

  const { data: editais, error: editaisError } = await client
    .from("contratacoes_editais")
    .select("id, orgao_cnpj, ano, data_publicacao, pca_plano_id, pca_link_evidencia")
    .eq("ativo", true)
    .is("pca_plano_id", null)
    .order("data_publicacao", { ascending: false })
    .limit(limite);
  if (editaisError) throw new FalhaLeituraLink("contratacoes_editais", editaisError);

  const stats: LinkStats = {
    editais_analisados: editais?.length ?? 0,
    externas_analisadas: 0,
    candidatos_codigo: 0,
    candidatos_pdm_janela: 0,
    ambiguos: 0,
    vinculados: 0,
    vinculados_externas: 0,
    erros: 0,
    dry_run: dryRun,
    probe_payload_sem_id_pca: true,
  };

  const matchRows: LinkMatchRow[] = [];

  for (const edital of editais ?? []) {
    const orgao = String(edital.orgao_cnpj ?? "").replace(/\D/g, "");
    const ano = Number(edital.ano);
    if (!orgao || !ano) continue;

    // --- Preferência: codigo_material_servico = codigo_item_origem ---
    const { data: itensEdital } = await client
      .from("contratacoes_itens")
      .select("codigo_material_servico")
      .eq("tipo_origem", "edital")
      .eq("origem_id", edital.id)
      .not("codigo_material_servico", "is", null);

    const codigos = [
      ...new Set(
        (itensEdital ?? [])
          .map((i) => String(i.codigo_material_servico ?? "").trim())
          .filter((c) => c.length > 0),
      ),
    ];

    if (codigos.length > 0) {
      const { data: pcaItens } = await client
        .from("pca_itens")
        .select("id, pca_plano_id, codigo_item_origem, pca_planos!inner(id, orgao_cnpj, ano_exercicio, ativo)")
        .in("codigo_item_origem", codigos)
        .eq("ativo", true);

      for (const item of pcaItens ?? []) {
        const plano = item.pca_planos as unknown as {
          id: string;
          orgao_cnpj: string;
          ano_exercicio: number;
          ativo: boolean;
        } | null;
        if (!plano?.ativo) continue;
        const planoCnpj = String(plano.orgao_cnpj ?? "").replace(/\D/g, "");
        if (planoCnpj !== orgao) continue;
        if (!anosCompativeis(ano, Number(plano.ano_exercicio))) continue;
        stats.candidatos_codigo++;
        matchRows.push({
          editalId: edital.id,
          planoId: plano.id,
          metodo: "codigo_item",
          origem: "contratacao_edital",
          detalhe:
            `codigo=${item.codigo_item_origem};orgao=${orgao};ano_edital=${ano};ano_plano=${plano.ano_exercicio}`,
        });
      }
    }

    // --- Fallback: órgão + PDM confirmado + janela prevista vs pub ---
    const { data: planosOrgao } = await client
      .from("pca_planos")
      .select("id, ano_exercicio")
      .eq("orgao_cnpj", orgao)
      .eq("ativo", true)
      .in("ano_exercicio", [ano, ano - 1]);

    for (const plano of planosOrgao ?? []) {
      const { data: itensPdm } = await client
        .from("pca_itens")
        .select(
          "id, data_prevista_contratacao, classe_material_servico, pca_item_pdm!inner(confirmado, codigo_pdm)",
        )
        .eq("pca_plano_id", plano.id)
        .eq("ativo", true)
        .in("classe_material_servico", classes)
        .eq("pca_item_pdm.confirmado", true)
        .not("data_prevista_contratacao", "is", null)
        .limit(50);

      for (const item of itensPdm ?? []) {
        const janela = dentroJanelaDias(
          item.data_prevista_contratacao,
          edital.data_publicacao,
          janelaDias,
        );
        if (!janela.ok) continue;
        const pdmRows = item.pca_item_pdm as unknown as Array<{
          confirmado: boolean;
          codigo_pdm: number;
        }>;
        const pdm = Array.isArray(pdmRows)
          ? pdmRows.find((p) => p.confirmado)
          : (pdmRows as unknown as { confirmado: boolean; codigo_pdm: number } | null);
        if (!pdm?.confirmado) continue;
        stats.candidatos_pdm_janela++;
        matchRows.push({
          editalId: edital.id,
          planoId: plano.id,
          metodo: "pdm_janela",
          origem: "contratacao_edital",
          detalhe:
            `pdm=${pdm.codigo_pdm};lag_dias=${janela.lagDias};classe=${item.classe_material_servico}`,
        });
      }
    }
  }

  const { data: externas, error: externasError } = await client
    .from("licitacoes_externas")
    .select("id, orgao_cnpj, data_publicacao")
    .is("pca_plano_id", null)
    .not("orgao_cnpj", "is", null)
    .not("data_publicacao", "is", null)
    .order("data_publicacao", { ascending: false })
    .limit(limite);
  if (externasError) throw new FalhaLeituraLink("licitacoes_externas", externasError);
  stats.externas_analisadas = externas?.length ?? 0;

  for (const compra of externas ?? []) {
    const orgao = String(compra.orgao_cnpj ?? "").replace(/\D/g, "");
    const pub = compra.data_publicacao as string;
    const ano = Number(String(pub).slice(0, 4));
    if (!orgao || !ano) continue;
    const compraId = String(compra.id);

    const { data: itensCompra } = await client
      .from("licitacao_itens")
      .select("catalogo_codigo_item")
      .eq("licitacao_id", compra.id)
      .not("catalogo_codigo_item", "is", null);
    const codigos = [
      ...new Set(
        (itensCompra ?? [])
          .map((i) => String(i.catalogo_codigo_item ?? "").trim())
          .filter((c) => c.length > 0),
      ),
    ];
    if (codigos.length > 0) {
      const { data: pcaItens } = await client
        .from("pca_itens")
        .select("id, pca_plano_id, codigo_item_origem, pca_planos!inner(id, orgao_cnpj, ano_exercicio, ativo)")
        .in("codigo_item_origem", codigos)
        .eq("ativo", true);
      for (const item of pcaItens ?? []) {
        const plano = item.pca_planos as unknown as {
          id: string;
          orgao_cnpj: string;
          ano_exercicio: number;
          ativo: boolean;
        } | null;
        if (!plano?.ativo) continue;
        const planoCnpj = String(plano.orgao_cnpj ?? "").replace(/\D/g, "");
        if (planoCnpj !== orgao) continue;
        if (!anosCompativeis(ano, Number(plano.ano_exercicio))) continue;
        stats.candidatos_codigo++;
        matchRows.push({
          editalId: compraId,
          planoId: plano.id,
          metodo: "codigo_item",
          origem: "licitacao_externa",
          detalhe:
            `codigo=${item.codigo_item_origem};orgao=${orgao};ano_compra=${ano};ano_plano=${plano.ano_exercicio}`,
        });
      }
    }

    const { data: matches } = await client
      .from("licitacao_match")
      .select("codigo_pdm")
      .eq("licitacao_id", compra.id)
      .limit(20);
    const pdms = [...new Set((matches ?? []).map((m) => Number(m.codigo_pdm)).filter((n) => n > 0))];
    if (pdms.length === 0) continue;

    const { data: planosOrgao } = await client
      .from("pca_planos")
      .select("id, ano_exercicio")
      .eq("orgao_cnpj", orgao)
      .eq("ativo", true)
      .in("ano_exercicio", [ano, ano - 1]);
    for (const plano of planosOrgao ?? []) {
      const { data: itensPdm } = await client
        .from("pca_itens")
        .select(
          "id, data_prevista_contratacao, classe_material_servico, pca_item_pdm!inner(confirmado, codigo_pdm)",
        )
        .eq("pca_plano_id", plano.id)
        .eq("ativo", true)
        .in("classe_material_servico", classes)
        .eq("pca_item_pdm.confirmado", true)
        .not("data_prevista_contratacao", "is", null)
        .limit(50);
      for (const item of itensPdm ?? []) {
        const janela = dentroJanelaDias(item.data_prevista_contratacao, pub, janelaDias);
        if (!janela.ok) continue;
        const pdmRows = item.pca_item_pdm as unknown as Array<{
          confirmado: boolean;
          codigo_pdm: number;
        }>;
        const pdm = Array.isArray(pdmRows)
          ? pdmRows.find((p) => p.confirmado && pdms.includes(Number(p.codigo_pdm)))
          : null;
        if (!pdm) continue;
        stats.candidatos_pdm_janela++;
        matchRows.push({
          editalId: compraId,
          planoId: plano.id,
          metodo: "pdm_janela",
          origem: "licitacao_externa",
          detalhe:
            `pdm=${pdm.codigo_pdm};lag_dias=${janela.lagDias};classe=${item.classe_material_servico}`,
        });
      }
    }
  }

  const decisions = pickUniquePlanoLinks(matchRows);
  const decidedEditais = new Set(decisions.map((d) => d.editalId));
  const editaisComCandidato = new Set(matchRows.map((r) => r.editalId));
  stats.ambiguos = [...editaisComCandidato].filter((id) => !decidedEditais.has(id)).length;

  const deEdital = decisions.filter((d) => d.origem === "contratacao_edital");
  const deExterna = decisions.filter((d) => d.origem === "licitacao_externa");
  if (!dryRun) {
    for (const d of deEdital) {
      const { error } = await client
        .from("contratacoes_editais")
        .update({
          pca_plano_id: d.planoId,
          pca_link_evidencia: d.evidencia,
          updated_at: new Date().toISOString(),
        })
        .eq("id", d.editalId)
        .is("pca_plano_id", null);
      if (error) stats.erros++;
      else stats.vinculados++;
    }
    for (const d of deExterna) {
      const { error } = await client
        .from("licitacoes_externas")
        .update({
          pca_plano_id: d.planoId,
          pca_link_evidencia: d.evidencia,
          updated_at: new Date().toISOString(),
        })
        .eq("id", Number(d.editalId))
        .is("pca_plano_id", null);
      if (error) stats.erros++;
      else stats.vinculados_externas++;
    }
  } else {
    stats.vinculados = deEdital.length;
    stats.vinculados_externas = deExterna.length;
  }

  return { stats, decisions };
}

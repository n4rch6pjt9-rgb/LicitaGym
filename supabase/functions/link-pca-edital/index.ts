import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "./_shared_prod/http.ts";
import { createServiceClient } from "./_shared_prod/pncp/supabase-admin.ts";
import {
  anosCompativeis,
  dentroJanelaDias,
  pickUniquePlanoLinks,
  type LinkMatchRow,
} from "./_shared_prod/pncp/link-pca-edital.ts";

type LinkBody = {
  /** Janela |prevista − pub| em dias (default 90). */
  janela_dias?: number;
  /** Limite de editais sem vínculo a analisar por chamada. */
  limite?: number;
  /** dry_run=true não grava — só reporta candidatos únicos. */
  dry_run?: boolean;
  /** Classes PCA no fallback PDM (default fitness + piso). */
  classes?: string[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as LinkBody;
  const janelaDias = Math.min(Math.max(body.janela_dias ?? 90, 1), 365);
  const limite = Math.min(Math.max(body.limite ?? 500, 1), 2000);
  const dryRun = body.dry_run === true;
  const classes = body.classes?.length ? body.classes : ["7830"];
  const ano = new Date().getUTCFullYear();

  const client = createServiceClient();

  if (dryRun) {
    const { count: planos, error: planosError } = await client
      .from("pca_planos")
      .select("id, pca_itens!inner(id)", { count: "exact", head: true })
      .eq("ativo", true)
      .eq("ano_exercicio", ano)
      .eq("pca_itens.ativo", true)
      .eq("pca_itens.classe_material_servico", "7830");
    if (planosError) return jsonResponse({ error: planosError.message }, 500);

    return jsonResponse({
      status: "ok",
      dry_run: true,
      escopo: {
        fonte: "pncp",
        grupo: "78",
        classe: "7830",
        ano,
        finalidade: "previsibilidade do segmento por órgão e UF",
      },
      planos_na_classe: planos ?? 0,
      candidatos_codigo: 0,
      candidatos_pdm_janela: 0,
      vinculados: 0,
      vinculados_externas: 0,
      nota: "Dry-run de classe e grupo. Não casa item, não usa janela de PDM e não grava pca_plano_id.",
    });
  }

  const { data: editais, error: editaisError } = await client
    .from("contratacoes_editais")
    .select("id, orgao_cnpj, ano, data_publicacao, pca_plano_id, pca_link_evidencia")
    .eq("ativo", true)
    .is("pca_plano_id", null)
    .order("data_publicacao", { ascending: false })
    .limit(limite);
  if (editaisError) return jsonResponse({ error: editaisError.message }, 500);

  const stats = {
    editais_analisados: editais?.length ?? 0,
    externas_analisadas: 0,
    candidatos_codigo: 0,
    candidatos_pdm_janela: 0,
    ambiguos: 0,
    vinculados: 0,
    vinculados_externas: 0,
    erros: 0,
    dry_run: dryRun,
    /** Probe: payload publicacao sem PCA → linker determinístico. */
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
  if (externasError) return jsonResponse({ error: externasError.message }, 500);
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

  return jsonResponse({
    status: "ok",
    ...stats,
    amostra_decisoes: decisions.slice(0, 20),
    nota: stats.vinculados + stats.vinculados_externas === 0
      ? "ainda 0 — sem match unívoco em contratacoes_editais nem em licitacoes_externas. dry_run não grava."
      : null,
  });
});

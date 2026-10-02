import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "./_shared_prod/http.ts";
import { PncpIntegracaoClient } from "./_shared_prod/pncp/integracao-client.ts";
import { normalizeContratacaoItem } from "./_shared_prod/pncp/normalize.ts";
import { createServiceClient } from "./_shared_prod/pncp/supabase-admin.ts";
import { upsertByHash } from "./_shared_prod/pncp/upsert.ts";

type SyncBody = {
  /** Máx. editais por chamada (default 50). */
  limite?: number;
  /** Só editais sem nenhum item ainda (default true). */
  so_sem_itens?: boolean;
  edital_id?: string;
};

function extractItemList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object"
    );
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ["data", "content", "itens", "resultado"]) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[]).filter((x): x is Record<string, unknown> =>
          !!x && typeof x === "object"
        );
      }
    }
  }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as SyncBody;
  const limite = Math.min(Math.max(body.limite ?? 50, 1), 200);
  const soSemItens = body.so_sem_itens !== false;

  const client = createServiceClient();
  const integracao = new PncpIntegracaoClient();

  let editaisQuery = client
    .from("contratacoes_editais")
    .select("id, orgao_cnpj, ano, sequencial")
    .eq("ativo", true)
    .order("data_publicacao", { ascending: false })
    .limit(limite);

  if (body.edital_id) {
    editaisQuery = client
      .from("contratacoes_editais")
      .select("id, orgao_cnpj, ano, sequencial")
      .eq("id", body.edital_id)
      .limit(1);
  }

  const { data: editais, error: editaisError } = await editaisQuery;
  if (editaisError) return jsonResponse({ error: editaisError.message }, 500);

  const stats = {
    editais_candidatos: editais?.length ?? 0,
    editais_processados: 0,
    editais_pulados_ja_tem_itens: 0,
    itens_novos: 0,
    itens_alterados: 0,
    itens_inalterados: 0,
    itens_sem_codigo: 0,
    erros: 0,
    /** Consulta /itens = 404; Integração /compras/.../itens = fonte. */
    fonte: "integracao:/orgaos/{cnpj}/compras/{ano}/{seq}/itens",
  };

  for (const edital of editais ?? []) {
    if (soSemItens && !body.edital_id) {
      const { count, error: countError } = await client
        .from("contratacoes_itens")
        .select("id", { count: "exact", head: true })
        .eq("tipo_origem", "edital")
        .eq("origem_id", edital.id);
      if (countError) {
        stats.erros++;
        continue;
      }
      if ((count ?? 0) > 0) {
        stats.editais_pulados_ja_tem_itens++;
        continue;
      }
    }

    const cnpj = String(edital.orgao_cnpj ?? "").replace(/\D/g, "");
    const ano = Number(edital.ano);
    const sequencial = Number(edital.sequencial);
    if (!cnpj || !ano || !sequencial) {
      stats.erros++;
      continue;
    }

    try {
      let pagina = 1;
      let recebeu = 0;
      const maxPaginas = 20;

      while (pagina <= maxPaginas) {
        const raw = await integracao.getCompraItens(cnpj, ano, sequencial, pagina, 50);
        const list = extractItemList(raw);
        if (list.length === 0) break;
        recebeu += list.length;

        for (const rawItem of list) {
          const itemRow = normalizeContratacaoItem(rawItem);
          if (!itemRow.numero_item) continue;
          if (!itemRow.codigo_material_servico) stats.itens_sem_codigo++;

          const result = await upsertByHash(
            client,
            "contratacoes_itens",
            {
              tipo_origem: "edital",
              origem_id: edital.id,
              numero_item: itemRow.numero_item,
            },
            {
              ...itemRow,
              tipo_origem: "edital",
              origem_id: edital.id,
            },
            { skipLastSynced: true },
          );
          if (result === "novo") stats.itens_novos++;
          else if (result === "alterado") stats.itens_alterados++;
          else if (result === "inalterado") stats.itens_inalterados++;
          else stats.erros++;
        }

        if (list.length < 50) break;
        pagina++;
      }

      if (recebeu > 0) stats.editais_processados++;
    } catch (error) {
      console.error("sync compra itens", edital.id, error);
      stats.erros++;
    }
  }

  return jsonResponse({ status: "ok", ...stats });
});

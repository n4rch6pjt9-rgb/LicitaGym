// Spec 0035: busca de oportunidade da rota do agente (K-0, R-2). O filtro por empresa, etapa e tarefa do agente está
// em agente_oportunidades_buscar (CA-0, CA-0b e CA-0c em supabase/tests/agente_consultas_check.sql).
import { assertEquals } from "jsr:@std/assert@1";
import { createSupabaseRepo } from "../../../supabase/functions/api-agentes/repo.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";
import { ambiente, chamar, ctx } from "./agentes_fake.ts";

Deno.test("K-0: busca saneada, página de 20 e máximo 50", async () => {
  const { repo, chamadasBusca } = ambiente();
  const r = await chamar(ctx(repo), { action: "oportunidades_buscar", agente: "edital", busca: "  Horizontina%_ ", pagina: 2 });
  assertEquals(r.status, 200);
  assertEquals(chamadasBusca, [{ agente: "edital", busca: "Horizontina", limite: 20, deslocamento: 20 }]);
  assertEquals([r.json.pagina, r.json.por_pagina, r.json.total], [2, 20, 0]);
  assertEquals((await chamar(ctx(repo), { action: "oportunidades_buscar", agente: "edital", por_pagina: 51 })).status, 400);
  assertEquals((await chamar(ctx(repo), { action: "oportunidades_buscar", agente: "edital", pagina: 0 })).status, 400);
});

Deno.test("K-0: só agentes com rota; preço e desconhecido dão 400", () => {
  for (const agente of ["preco", "xyz", undefined]) {
    assertEquals("error" in parseActionFromBody({ action: "oportunidades_buscar", agente }), true, String(agente));
  }
  assertEquals(parseActionFromBody({ action: "oportunidades_buscar", agente: "juridico", busca: "%%" }), {
    action: "oportunidades_buscar", agente: "juridico", busca: null, pagina: 1, por_pagina: 20,
  });
});

Deno.test("repo real: busca chama agente_oportunidades_buscar com a empresa e devolve etapa e total", async () => {
  const args: unknown[] = [];
  const cliente = {
    rpc: (nome: string, a: unknown) => {
      args.push(nome, a);
      return Promise.resolve({
        data: [{
          licitacao_id: 3558, numero_edital: "48/2026", numero_processo: null, orgao_nome: "Prefeitura de Horizontina", municipio: "Horizontina",
          uf: "RS", objeto: "Equipamentos de musculação", modalidade: "Pregão", data_fim: "2026-10-30T13:00:00Z", etapa_id: 5,
          etapa_nome: "Nova", total: 1,
        }],
        error: null,
      });
    },
  } as unknown as Parameters<typeof createSupabaseRepo>[0];
  const r = await createSupabaseRepo(cliente).buscarOportunidades(7, "edital", "horizontina", 20, 0);
  assertEquals(args, ["agente_oportunidades_buscar", { p_tenant: 7, p_agente: "edital", p_busca: "horizontina", p_limite: 20, p_deslocamento: 0 }]);
  assertEquals([r.total, r.itens[0].licitacao_id, r.itens[0].etapa], [1, 3558, { id: 5, nome: "Nova" }]);
});

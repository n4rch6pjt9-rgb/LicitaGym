import { assertEquals } from "jsr:@std/assert@1";
import { anexarAlertaPortal } from "../../../supabase/functions/api-dashboard-oportunidades/portal.ts";

// pipeline_oportunidades é por empresa e é lido com service_role: o alerta do Portal só olha o pipeline da empresa de
// quem chama (CLAUDE.md, "Tenants em construção"; issue #263). Obs.: no_pipeline = true significa FORA do pipeline.

const LINK = "https://www.portaldecompraspublicas.com.br/processos/MG/Prefeitura-Exemplo-1/PE-1-2026-1";

function clienteFalso(tabelas: Record<string, Array<Record<string, unknown>>>) {
  const consultas: Array<{ tabela: string; filtros: string[] }> = [];
  const client = {
    from(tabela: string) {
      let linhas = [...(tabelas[tabela] ?? [])];
      const registro = { tabela, filtros: [] as string[] };
      consultas.push(registro);
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (registro.filtros.push(`${c}=${v}`), (linhas = linhas.filter((l) => l[c] === v)), q),
        in: (c: string, vs: unknown[]) => ((linhas = linhas.filter((l) => vs.includes(l[c]))), q),
        then: (ok: (r: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: linhas, error: null }).then(ok),
      };
      return q;
    },
  };
  return { client, consultas };
}

const tabelas = () => ({
  licitacoes_externas: [{ id: 10, link_sistema_origem: LINK }],
  portal_consulta: [],
  pipeline_oportunidades: [{ tenant_id: 1, licitacao_id: 10 }],
});

Deno.test("alerta do Portal: licitação no pipeline da Konnen aparece no pipeline só para a Konnen", async () => {
  const konnen = clienteFalso(tabelas());
  // deno-lint-ignore no-explicit-any
  const [k] = await anexarAlertaPortal(konnen.client as any, [{ id: 10 }], () => Promise.resolve(1));
  assertEquals((k.portal as { no_pipeline: boolean }).no_pipeline, false);
  assertEquals(konnen.consultas.find((c) => c.tabela === "pipeline_oportunidades")?.filtros, ["tenant_id=1"]);

  const outra = clienteFalso(tabelas());
  // deno-lint-ignore no-explicit-any
  const [o] = await anexarAlertaPortal(outra.client as any, [{ id: 10 }], () => Promise.resolve(2));
  assertEquals((o.portal as { no_pipeline: boolean }).no_pipeline, true);
});

Deno.test("alerta do Portal: sem empresa resolvida, nada conta como no pipeline e o pipeline nem é lido", async () => {
  const sem = clienteFalso(tabelas());
  // deno-lint-ignore no-explicit-any
  const [s] = await anexarAlertaPortal(sem.client as any, [{ id: 10 }], () => Promise.resolve(null));
  assertEquals((s.portal as { no_pipeline: boolean }).no_pipeline, true);
  assertEquals(sem.consultas.some((c) => c.tabela === "pipeline_oportunidades"), false);
});

Deno.test("alerta do Portal: sem link do Portal, a empresa nem é resolvida", async () => {
  const c = clienteFalso({ licitacoes_externas: [{ id: 11, link_sistema_origem: "https://pncp.gov.br/x" }] });
  let chamadas = 0;
  // deno-lint-ignore no-explicit-any
  await anexarAlertaPortal(c.client as any, [{ id: 11 }], () => (chamadas++, Promise.resolve(1)));
  assertEquals(chamadas, 0);
});

// Spec 0035: documentos oficiais da licitação na rota do agente (K-1, R-1, R-3).
import { assertEquals } from "jsr:@std/assert@1";
import { categoriaErro, createSupabaseRepo } from "../../../supabase/functions/api-agentes/repo.ts";
import { ErroTenantAcesso } from "../../../supabase/functions/_shared/tenant.ts";
import { ambiente, chamar, ctx } from "./agentes_fake.ts";

Deno.test("CA-1: documentos_listar devolve os documentos com situação e páginas (null nos não indexados)", async () => {
  const { repo, documentosBrutos } = ambiente();
  documentosBrutos.push(
    { id: 1, secao: "processo", nome: "Edital.pdf", data_documento: null, status_processamento: "indexado", paginas: 12, erro: null },
    { id: 2, secao: "habilitacao", nome: "atestado.pdf", data_documento: null, status_processamento: "pendente", paginas: null, erro: null },
  );
  const r = await chamar(ctx(repo), { action: "documentos_listar", licitacao_id: 101 });
  assertEquals(r.status, 200);
  assertEquals(r.json.documentos.map((d: { paginas: number | null; entra_na_analise: boolean }) => [d.paginas, d.entra_na_analise]), [
    [12, true],
    [null, false],
  ]);
});

Deno.test("CA-2: sem vínculo com empresa, 403", async () => {
  const { repo } = ambiente();
  repo.tenantDoUsuario = () => Promise.reject(new ErroTenantAcesso("Sem vínculo com empresa.", 403));
  assertEquals((await chamar(ctx(repo), { action: "documentos_listar", licitacao_id: 101 })).status, 403);
});

Deno.test("CA-26: fora do pipeline da empresa, documentos, executar e obter dão 404", async () => {
  const { repo, execucoes } = ambiente();
  for (const action of ["documentos_listar", "analise_executar", "analise_obter"]) {
    const r = await chamar(ctx(repo), { action, licitacao_id: 202 });
    assertEquals(r.status, 404, action);
  }
  // 101 existe, mas sai do pipeline: nada roda
  const amb = ambiente();
  amb.pipeline.clear();
  assertEquals((await chamar(ctx(amb.repo), { action: "analise_executar", licitacao_id: 101 })).status, 404);
  assertEquals([execucoes.length, amb.execucoes.length], [0, 0]);
});

Deno.test("CA-27: a resposta tem só as chaves fixas e o erro em categoria, sem URI", async () => {
  const cliente = {
    rpc: (nome: string) => {
      assertEquals(nome, "agente_documentos_listar");
      return Promise.resolve({
        data: [{
          id: 5, secao: "processo", nome: "tr.pdf", data_documento: null, status_processamento: "erro", paginas: null,
          erro: "422 Client Error: for url: gs://segredo/tr.pdf", storage_uri: "gs://segredo/tr.pdf", raw: { x: 1 },
        }],
        error: null,
      });
    },
  } as unknown as Parameters<typeof createSupabaseRepo>[0];
  const [d] = await createSupabaseRepo(cliente).listarDocumentos(1, 101);
  assertEquals(Object.keys(d).sort(), ["data_documento", "entra_na_analise", "erro", "id", "nome", "paginas", "secao", "status_processamento"]);
  assertEquals(d.erro, "download");
  assertEquals(JSON.stringify(d).includes("gs://"), false);
});

Deno.test("R-3: categoria do erro gravado pelo coletor e pelo indexador", () => {
  assertEquals(categoriaErro("503 do PNCP"), "download");
  assertEquals(categoriaErro("sem texto aproveitável; ignorados: ['Edital.pdf']"), "extracao");
  assertEquals(categoriaErro("falha ao gravar chunks"), "indexacao");
  assertEquals(categoriaErro("algo estranho"), "outro");
  assertEquals(categoriaErro(null), null);
  assertEquals(categoriaErro("  "), null);
});

Deno.test("repo real: P0002 de agente_documentos_listar vira 404", async () => {
  const cliente = { rpc: () => Promise.resolve({ data: null, error: { code: "P0002", message: "fora" } }) } as unknown as Parameters<
    typeof createSupabaseRepo
  >[0];
  const e = await createSupabaseRepo(cliente).listarDocumentos(1, 101).then(() => null, (x) => x);
  assertEquals(e?.status, 404);
});

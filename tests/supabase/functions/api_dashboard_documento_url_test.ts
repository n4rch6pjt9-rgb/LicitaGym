// Spec 0061, K-2: action=documento_url da api-dashboard-oportunidades. URL assinada do Storage (10 minutos) para um
// documento de licitacao_documentos; nunca devolve o storage_uri cru. 401 sem login, 403 sem vínculo ativo, 404 para
// documento inexistente, removido do portal, sem arquivo ou fora do bucket do LicitaGym.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";
import { parseActionFromBody, parseActionFromUrl } from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";

type Doc = Record<string, unknown>;

const PDF: Doc = {
  id: 169096, nome_original: "Pedidos de Reconsiderações", mime_type: "application/pdf",
  storage_uri: "supabase://licitacao-documentos/paradigma/firjan/59/3800/processo/abc.pdf",
  sha256: "a".repeat(64), status_processamento: "baixado", removido_do_portal_em: null,
};
const HTML: Doc = { ...PDF, id: 169095, nome_original: "Resumo do processo", mime_type: "text/html",
  storage_uri: "supabase://licitacao-documentos/paradigma/firjan/59/3800/processo/resumo.html" };

function fakeClient(docs: Doc[], opts: { erroTabela?: boolean; erroAssinar?: boolean } = {}) {
  const assinadas: { bucket: string; caminho: string; segundos: number; opcoes: unknown }[] = [];
  const colunas: string[] = [];
  const client = {
    from(tabela: string) {
      assertEquals(tabela, "licitacao_documentos");
      let id: unknown;
      const q = {
        select(c: string) {
          colunas.push(c);
          return q;
        },
        eq(col: string, v: unknown) {
          assertEquals(col, "id");
          id = v;
          return q;
        },
        maybeSingle() {
          if (opts.erroTabela) return Promise.resolve({ data: null, error: { message: "falha", code: "XX000" } });
          return Promise.resolve({ data: docs.find((d) => d.id === id) ?? null, error: null });
        },
      };
      return q;
    },
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl(caminho: string, segundos: number, opcoes?: unknown) {
            assinadas.push({ bucket, caminho, segundos, opcoes });
            if (opts.erroAssinar) return Promise.resolve({ data: null, error: { message: "Object not found" } });
            return Promise.resolve({ data: { signedUrl: `https://storage.test/sign/${bucket}/${caminho}?token=t` }, error: null });
          },
        };
      },
    },
  };
  return { client, assinadas, colunas };
}

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function chamar(docs: Doc[], body: Record<string, unknown>, opts: Parameters<typeof fakeClient>[1] = {},
  tenant: number | null = 1) {
  const f = fakeClient(docs, opts);
  const res = await handleRequest(req(body), {
    getClient: () => f.client as never, requireAuth: () => null, tenantDoUsuario: () => Promise.resolve(tenant),
  });
  return { res, json: await res.json(), ...f };
}

Deno.test("K-2: parse aceita documento_id inteiro positivo por GET e POST, recusa o resto", () => {
  assertEquals(parseActionFromBody({ action: "documento_url", documento_id: 169096 }),
    { action: "documento_url", documento_id: 169096 });
  assertEquals(parseActionFromUrl(new URL("http://x/?action=documento_url&documento_id=169096")),
    { action: "documento_url", documento_id: 169096 });
  for (const v of [undefined, null, "", "0", 0, -1, "1.5", 1.5, "abc", "12345678901234567890", true]) {
    assert("error" in parseActionFromBody({ action: "documento_url", documento_id: v }), `aceitou ${String(v)}`);
  }
});

Deno.test("K-2: PDF devolve URL assinada de 10 minutos para abrir na aba, sem o storage_uri", async () => {
  const { res, json, assinadas, colunas } = await chamar([PDF], { action: "documento_url", documento_id: 169096 });
  assertEquals(res.status, 200);
  assertEquals(assinadas, [{ bucket: "licitacao-documentos", caminho: "paradigma/firjan/59/3800/processo/abc.pdf",
    segundos: 600, opcoes: undefined }]);
  assertEquals(json.action, "documento_url");
  assertEquals(json.documento_id, 169096);
  assertEquals(json.expira_em_segundos, 600);
  assertEquals(json.nome_original, "Pedidos de Reconsiderações");
  assertEquals(json.mime_type, "application/pdf");
  assertEquals(json.abrir, "aba");
  assert(String(json.url).startsWith("https://storage.test/sign/"));
  assert(!JSON.stringify(json).includes("supabase://"), "storage_uri não pode sair");
  assert(!colunas.join(",").includes("raw"), "raw não é lido");
});

Deno.test("K-2: outro formato baixa com o nome original", async () => {
  const { res, json, assinadas } = await chamar([HTML], { action: "documento_url", documento_id: 169095 });
  assertEquals(res.status, 200);
  assertEquals(assinadas[0].opcoes, { download: "Resumo do processo.html" });   // nome sem extensão ganha a do arquivo
  assertEquals(json.abrir, "download");
});

Deno.test("K-2: 404 para inexistente, removido do portal, sem arquivo, não baixado ou fora do bucket", async () => {
  const casos: [string, Doc[]][] = [
    ["inexistente", []],
    ["removido", [{ ...PDF, removido_do_portal_em: "2026-11-01T00:00:00Z" }]],
    ["sem arquivo", [{ ...PDF, storage_uri: null }]],
    ["pendente sem arquivo", [{ ...PDF, status_processamento: "pendente", sha256: null }]],
    ["caminho com %", [{ ...PDF, storage_uri: "supabase://licitacao-documentos/a/%2e%2e/b.pdf" }]],
    ["caminho com barra invertida", [{ ...PDF, storage_uri: "supabase://licitacao-documentos/a\\..\\b.pdf" }]],
    ["GCS antigo", [{ ...PDF, storage_uri: "gs://licitagym-documentos/x.pdf" }]],
    ["outro bucket", [{ ...PDF, storage_uri: "supabase://outro-bucket/x.pdf" }]],
    ["caminho com ..", [{ ...PDF, storage_uri: "supabase://licitacao-documentos/../segredo.pdf" }]],
  ];
  for (const [nome, docs] of casos) {
    const { res, json, assinadas } = await chamar(docs, { action: "documento_url", documento_id: 169096 });
    assertEquals(res.status, 404, nome);
    assertEquals(assinadas.length, 0, `${nome}: não assina`);
    assert(!JSON.stringify(json).includes("supabase://") && !JSON.stringify(json).includes("gs://"), nome);
  }
});

Deno.test("K-2: 403 sem empresa ativa, antes de ler o documento", async () => {
  const { res, assinadas, colunas } = await chamar([PDF], { action: "documento_url", documento_id: 169096 }, {}, null);
  assertEquals(res.status, 403);
  assertEquals(assinadas.length, 0);
  assertEquals(colunas.length, 0);
});

Deno.test("K-2: 401 sem login (requireUserAuth padrão)", async () => {
  const res = await handleRequest(req({ action: "documento_url", documento_id: 169096 }));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("K-2: erro do banco é 500 e falha ao assinar é 502, sem mensagem interna", async () => {
  const banco = await chamar([PDF], { action: "documento_url", documento_id: 169096 }, { erroTabela: true });
  assertEquals(banco.res.status, 500);
  assert(!JSON.stringify(banco.json).includes("XX000"));
  const assinar = await chamar([PDF], { action: "documento_url", documento_id: 169096 }, { erroAssinar: true });
  assertEquals(assinar.res.status, 502);
  assert(!JSON.stringify(assinar.json).includes("Object not found"));
});

Deno.test("K-2 (revisor): documento indexado, ignorado ou com erro de extração continua abrindo", async () => {
  for (const status of ["indexado", "extraido", "ignorado", "erro"]) {
    const { res } = await chamar([{ ...PDF, status_processamento: status }], { action: "documento_url", documento_id: 169096 });
    assertEquals(res.status, 200, status);
  }
});

Deno.test("K-2 (revisor): PDF reconhecido com MIME com parâmetro ou sem MIME e caminho .pdf", async () => {
  for (const mime of ["application/PDF; charset=binary", null]) {
    const { json, assinadas } = await chamar([{ ...PDF, mime_type: mime }], { action: "documento_url", documento_id: 169096 });
    assertEquals(json.abrir, "aba", String(mime));
    assertEquals(assinadas[0].opcoes, undefined);
  }
});

Deno.test("K-2 (revisor): erro de banco ao resolver a empresa é 500, não 403", async () => {
  const f = fakeClient([PDF]);
  const res = await handleRequest(req({ action: "documento_url", documento_id: 169096 }), {
    getClient: () => f.client as never, requireAuth: () => null,
    tenantDoUsuario: () => Promise.reject(new Error("banco fora")),
  });
  assertEquals(res.status, 500);
  assertEquals(f.colunas.length, 0);
  await res.body?.cancel();
});

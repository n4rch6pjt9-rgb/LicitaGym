// Spec 0049, K-1: busca do PNCP (/api/search/) por número de controle, editais e atas.
// Contrato medido em 09/11/2026 (docs/pncp/schemas-consultas-pncp.md, seção 6). Sem chamada real: fetch falso.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PncpSearchClient } from "../../../../../supabase/functions/_shared/pncp/search-client.ts";
import { UnifiedHttpClient } from "../../../../../supabase/functions/_shared/http-client/index.ts";

const CONTROLE = "46523262000131-1-000118/2026";

function edital(controle: string) {
  const [cnpj, , seqAno] = controle.split("-");
  const [seq, ano] = seqAno.split("/");
  return {
    document_type: "edital",
    numero_controle_pncp: controle,
    orgao_cnpj: cnpj,
    ano,
    numero_sequencial: String(Number(seq)),
    item_url: `/compras/${cnpj}/${ano}/${Number(seq)}`,
  };
}

function ata(seqAta: number, controleCompra = CONTROLE) {
  return {
    document_type: "ata",
    numero_controle_pncp: `${controleCompra}-${String(seqAta).padStart(6, "0")}`,
    numero_sequencial: String(seqAta),
    numero_sequencial_compra_ata: "118",
    title: `Ata nº ${seqAta}/2026`,
  };
}

function http() {
  return new UnifiedHttpClient({
    hostLease: {
      acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
      reportRateLimit: () => Promise.resolve(),
    },
  });
}

type Resposta = Response | Error;

async function comFetch<T>(respostas: Resposta[], fn: (urls: string[]) => Promise<T>): Promise<{ r: T; urls: string[] }> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    const prox = respostas.shift();
    if (!prox) return Promise.reject(new Error("fetch falso sem resposta"));
    if (prox instanceof Error) return Promise.reject(prox);
    return Promise.resolve(prox);
  }) as typeof fetch;
  try {
    return { r: await fn(urls), urls };
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const queda = () => new TypeError("error sending request: connection closed before message completed");

Deno.test("CA-1: buscarCompraPorControle devolve só o item de controle idêntico (q entre aspas)", async () => {
  const { r, urls } = await comFetch(
    [json({ total: 2, items: [edital("46523262000131-1-000113/2026"), edital(CONTROLE)] })],
    () => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE),
  );
  assertEquals(r?.numero_controle_pncp, CONTROLE);
  const url = new URL(urls[0]);
  assertEquals(url.pathname, "/api/search/");
  assertEquals(url.searchParams.get("q"), `"${CONTROLE}"`);
  assertEquals(url.searchParams.get("tipos_documento"), "edital");
});

Deno.test("CA-1: sem item de controle idêntico, buscarCompraPorControle devolve null", async () => {
  const { r } = await comFetch(
    [json({ total: 1, items: [edital("46523262000131-1-000113/2026")] })],
    () => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE),
  );
  assertEquals(r, null);
});

Deno.test("CA-1: 200 vazio válido (total 0) devolve null e lista vazia, sem erro", async () => {
  const { r } = await comFetch(
    [json({ total: 0, items: [] }), json({ total: 0, items: [] })],
    async () => {
      const c = new PncpSearchClient(undefined, http());
      return [await c.buscarCompraPorControle(CONTROLE), await c.buscarAtasDaCompra(CONTROLE)];
    },
  );
  assertEquals(r, [null, []]);
});

Deno.test("CA-1: buscarAtasDaCompra devolve só as atas cujo controle começa com o da compra + '-'", async () => {
  const { r, urls } = await comFetch(
    [json({ total: 3, items: [ata(1), ata(2), ata(1, "46523262000131-1-000113/2026")] })],
    () => new PncpSearchClient(undefined, http()).buscarAtasDaCompra(CONTROLE),
  );
  assertEquals(r.map((a) => a.numero_controle_pncp), [`${CONTROLE}-000001`, `${CONTROLE}-000002`]);
  assertEquals(new URL(urls[0]).searchParams.get("tipos_documento"), "ata");
});

Deno.test("CA-1: controle fora do formato não chama a busca", async () => {
  const { urls } = await comFetch([], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarCompraPorControle('x" OR 1'));
  });
  assertEquals(urls.length, 0);
});

Deno.test("CA-2: queda de conexão na 1ª tentativa e 200 na 2ª devolve o item", async () => {
  const { r, urls } = await comFetch(
    [queda(), json({ total: 1, items: [edital(CONTROLE)] })],
    () => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE),
  );
  assertEquals(r?.numero_controle_pncp, CONTROLE);
  assertEquals(urls.length, 2);
});

Deno.test("CA-2: duas quedas de conexão lançam erro (não null, não lista vazia)", async () => {
  const { urls } = await comFetch([queda(), queda(), queda()], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE));
  });
  assertEquals(urls.length, 2);
});

Deno.test("CA-2: 503 não é repetido (só queda de conexão tem 2ª tentativa)", async () => {
  const { urls } = await comFetch([new Response("<html>503</html>", { status: 503 }), json({ total: 0, items: [] })], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE));
  });
  assertEquals(urls.length, 1);
});

Deno.test("CA-2: 200 com items não-array lança erro", async () => {
  await comFetch([json({ total: 1, items: { a: 1 } })], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarCompraPorControle(CONTROLE));
  });
  await comFetch([json({ total: 1, items: "x" })], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarAtasDaCompra(CONTROLE));
  });
});

Deno.test("CA-2: atas com total maior que a página lançam erro (lista cortada não parece completa)", async () => {
  const { urls } = await comFetch([json({ total: 900, items: [ata(1)] })], async () => {
    await assertRejects(() => new PncpSearchClient(undefined, http()).buscarAtasDaCompra(CONTROLE));
  });
  assert(urls.length === 1);
});

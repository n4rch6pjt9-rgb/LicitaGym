/**
 * Item 5/8 — PostgREST range pagination with mandatory stable order.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  chunkValues,
  fetchAllByRange,
  POSTGREST_PAGE_SIZE,
} from "../../../../../supabase/functions/_shared/pncp/postgrest-paginate.ts";

Deno.test("fetchAllByRange walks until short page", async () => {
  const calls: Array<[number, number]> = [];
  const { rows, pages } = await fetchAllByRange<number>(
    async (from, to) => {
      calls.push([from, to]);
      if (from === 0) {
        return {
          data: Array.from({ length: POSTGREST_PAGE_SIZE }, (_, i) => i),
          error: null,
        };
      }
      return {
        data: [POSTGREST_PAGE_SIZE, POSTGREST_PAGE_SIZE + 1],
        error: null,
      };
    },
    { orderBy: "id" },
  );
  assertEquals(pages, 2);
  assertEquals(rows.length, POSTGREST_PAGE_SIZE + 2);
  assertEquals(calls[0], [0, POSTGREST_PAGE_SIZE - 1]);
  assertEquals(calls[1], [POSTGREST_PAGE_SIZE, POSTGREST_PAGE_SIZE * 2 - 1]);
});

Deno.test("fetchAllByRange propagates query errors", async () => {
  let threw = false;
  try {
    await fetchAllByRange(
      async () => ({ data: null, error: { message: "boom" } }),
      { orderBy: "id" },
    );
  } catch (error) {
    threw = true;
    assertEquals(error instanceof Error && error.message === "boom", true);
  }
  assertEquals(threw, true);
});

Deno.test("fetchAllByRange rejects missing orderBy", async () => {
  let threw = false;
  try {
    await fetchAllByRange(
      async () => ({ data: [], error: null }),
      { orderBy: "  " },
    );
  } catch (error) {
    threw = true;
    assertEquals(
      error instanceof Error && error.message.includes("orderBy"),
      true,
    );
  }
  assertEquals(threw, true);
});

Deno.test("fetchAllByRange 2500 ordered rows: no skip no duplicate", async () => {
  const TOTAL = 2500;
  const store = Array.from({ length: TOTAL }, (_, i) => ({ id: i + 1 }));
  const { rows, pages } = await fetchAllByRange<{ id: number }>(
    async (from, to) => {
      // Stable order by id — same contract callers must apply via .order().
      const ordered = [...store].sort((a, b) => a.id - b.id);
      return Promise.resolve({ data: ordered.slice(from, to + 1), error: null });
    },
    { orderBy: "id", pageSize: 1000 },
  );
  assertEquals(pages, 3);
  assertEquals(rows.length, TOTAL);
  const ids = rows.map((r) => r.id);
  assertEquals(new Set(ids).size, TOTAL);
  assertEquals(ids[0], 1);
  assertEquals(ids[TOTAL - 1], TOTAL);
  for (let i = 0; i < TOTAL; i++) {
    assertEquals(ids[i], i + 1);
  }
});

Deno.test("chunkValues splits large .in() lists", () => {
  const values = Array.from({ length: 2500 }, (_, i) => i);
  const chunks = chunkValues(values, 1000);
  assertEquals(chunks.length, 3);
  assertEquals(chunks[0].length, 1000);
  assertEquals(chunks[1].length, 1000);
  assertEquals(chunks[2].length, 500);
});

Deno.test("orgaos sync source uses fetchAllByRange with stable order", async () => {
  const src = await Deno.readTextFile(
    "supabase/functions/sync-pncp-orgaos/index.ts",
  );
  assertEquals(src.includes("fetchAllByRange"), true);
  assertEquals(src.includes("pca_itens_lidos"), true);
  assertEquals(src.includes('.order("id")'), true);
  assertEquals(src.includes('orderBy: "id"'), true);
  assertEquals(src.includes("async (from, to)"), false);
});

Deno.test("catmat-scope-resolver pages with stable order keys", async () => {
  const src = await Deno.readTextFile(
    "supabase/functions/_shared/pncp/catmat-scope-resolver.ts",
  );
  assertEquals(src.includes("fetchAllByRange"), true);
  assertEquals(src.includes('.order("codigo_pdm")'), true);
  assertEquals(src.includes('.order("codigo_item")'), true);
  assertEquals(src.includes('orderBy: "codigo_pdm"'), true);
  assertEquals(src.includes('orderBy: "codigo_item"'), true);
  assertEquals(src.includes(".range(from, to)"), true);
  assertEquals(src.includes("async (from, to)"), false);
});

Deno.test("fetchAllByRange requires options.orderBy", async () => {
  const src = await Deno.readTextFile(
    "supabase/functions/_shared/pncp/postgrest-paginate.ts",
  );
  assertEquals(src.includes("orderBy: string"), true);
  assertEquals(src.includes("PromiseLike<PageResult<T>>"), true);
});

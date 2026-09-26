import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  DateSlice,
  formatPncpDay,
  mayInactivateNotSeen,
  PAGE_HARD_CAP,
  PageFetchError,
  parsePncpDay,
  pendingFromPriorRun,
  runCappedDateSync,
  splitDateWindow,
  syncTerminalStatus,
} from "../../../../../supabase/functions/_shared/pncp/pagination-budget.ts";
import { readSync } from "./_harness.ts";

const HAR_INICIAL = "20260801";
const HAR_FINAL = "20260822";
const HAR_TOTAL_PAGES = 1067;

const CAP_SYNCS = [
  "sync-pncp-contratacoes-editais/index.ts",
  "sync-pncp-contratacoes-atas/index.ts",
  "sync-pncp-contratacoes-contratos/index.ts",
];

function eachDay(inicial: string, final: string): string[] {
  const days: string[] = [];
  for (let cursor = parsePncpDay(inicial); cursor <= parsePncpDay(final); cursor += 86_400_000) {
    days.push(formatPncpDay(cursor));
  }
  return days;
}

function pagesByDay(totalPages: number, inicial: string, final: string): Map<string, number> {
  const days = eachDay(inicial, final);
  const base = Math.floor(totalPages / days.length);
  const extra = totalPages % days.length;
  const map = new Map<string, number>();
  days.forEach((day, index) => map.set(day, base + (index < extra ? 1 : 0)));
  return map;
}

function pagesInSlice(slice: DateSlice, density: Map<string, number>): number {
  return eachDay(slice.dataInicial, slice.dataFinal)
    .reduce((sum, day) => sum + (density.get(day) ?? 0), 0);
}

function sliceKey(slice: DateSlice): string {
  return `${slice.dataInicial}:${slice.dataFinal}:${slice.modalidade ?? ""}`;
}

Deno.test("HAR window 20260801-20260822 splits in half and cannot be one capped walk", () => {
  assertEquals(PAGE_HARD_CAP, 200);
  assertEquals(eachDay(HAR_INICIAL, HAR_FINAL).length, 22);
  assertEquals(
    splitDateWindow({ dataInicial: HAR_INICIAL, dataFinal: HAR_FINAL, nextPage: 1 }),
    [
      { dataInicial: "20260801", dataFinal: "20260811", nextPage: 1 },
      { dataInicial: "20260812", dataFinal: "20260822", nextPage: 1 },
    ],
  );
  assertEquals(
    splitDateWindow({ dataInicial: "20260801", dataFinal: "20260801", nextPage: 1 }),
    null,
  );
  assertEquals(
    splitDateWindow({
      dataInicial: "20260801",
      dataFinal: "20260802",
      nextPage: 4,
      modalidade: 6,
    }),
    [
      { dataInicial: "20260801", dataFinal: "20260801", nextPage: 1, modalidade: 6 },
      { dataInicial: "20260802", dataFinal: "20260802", nextPage: 1, modalidade: 6 },
    ],
  );
});

Deno.test("1067 pages and cap 200 subdivide by day and only the last run is concluida", async () => {
  const density = pagesByDay(HAR_TOTAL_PAGES, HAR_INICIAL, HAR_FINAL);
  const fetched = new Map<string, Set<number>>();
  let pending: DateSlice[] = [{ dataInicial: HAR_INICIAL, dataFinal: HAR_FINAL, nextPage: 1 }];
  const statuses: string[] = [];
  let guard = 0;

  while (pending.length > 0 && guard < 40) {
    guard++;
    const run = await runCappedDateSync({
      cap: PAGE_HARD_CAP,
      slices: pending,
      fetchPage: (_slice, pagina) => {
        const total = pagesInSlice(_slice, density);
        if (pagina < 1 || pagina > total) {
          throw new Error(`page ${pagina} outside 1..${total} for ${sliceKey(_slice)}`);
        }
        const key = sliceKey(_slice);
        const pages = fetched.get(key) ?? new Set<number>();
        pages.add(pagina);
        fetched.set(key, pages);
        return Promise.resolve({
          paginasRestantes: total - pagina,
          status: 200,
          elapsedMs: 1,
          body: {
            totalPaginas: total,
            totalRegistros: HAR_TOTAL_PAGES,
            numeroPagina: pagina,
            paginasRestantes: total - pagina,
          },
        });
      },
      onPage: () => Promise.resolve(),
    });
    assert(run.pagesFetched <= PAGE_HARD_CAP, `run fetched ${run.pagesFetched}`);
    assertEquals(run.pending.length === 0, run.status === "concluida");
    statuses.push(run.status);
    pending = run.pending;
  }

  assert(statuses.length > 1, "one run cannot finish 1067 pages");
  assertEquals(statuses.at(-1), "concluida");
  assertEquals(statuses.slice(0, -1).every((status) => status === "incompleta"), true);
  assertEquals(fetched.get(`${HAR_INICIAL}:${HAR_FINAL}:`)?.has(201) ?? false, false);

  const completeWindows: Array<{ inicial: string; final: string }> = [];
  for (const [key, pages] of fetched) {
    const [inicial, final] = key.split(":");
    const total = pagesInSlice({ dataInicial: inicial, dataFinal: final, nextPage: 1 }, density);
    if (pages.size !== total) continue;
    for (let pagina = 1; pagina <= total; pagina++) {
      if (!pages.has(pagina)) throw new Error(`missing page ${pagina} in ${key}`);
    }
    completeWindows.push({ inicial, final });
  }

  const covered = new Map<string, number>();
  for (const window of completeWindows) {
    for (const day of eachDay(window.inicial, window.final)) {
      covered.set(day, (covered.get(day) ?? 0) + 1);
    }
  }
  assertEquals([...covered.keys()].sort(), eachDay(HAR_INICIAL, HAR_FINAL));
  assertEquals([...covered.values()].every((count) => count === 1), true);
});

Deno.test("single day above the cap checkpoints next page and never completes early", async () => {
  const requested: number[] = [];
  let pending: DateSlice[] = [{ dataInicial: "20260801", dataFinal: "20260801", nextPage: 1 }];
  const statuses: string[] = [];

  while (pending.length > 0) {
    const run = await runCappedDateSync({
      cap: PAGE_HARD_CAP,
      slices: pending,
      fetchPage: (_slice, pagina) => {
        requested.push(pagina);
        return Promise.resolve({
          paginasRestantes: HAR_TOTAL_PAGES - pagina,
          status: 200,
          elapsedMs: 1,
          body: {},
        });
      },
      onPage: () => Promise.resolve(),
    });
    statuses.push(run.status);
    if (run.status === "incompleta") {
      assertEquals(run.pending.length, 1);
      assertEquals(run.pending[0].nextPage, requested.at(-1)! + 1);
    }
    pending = run.pending;
  }

  assertEquals(statuses.at(-1), "concluida");
  assertEquals(statuses.slice(0, -1).every((status) => status === "incompleta"), true);
  assertEquals(requested, Array.from({ length: HAR_TOTAL_PAGES }, (_, index) => index + 1));
  assertEquals(statuses[0], "incompleta");
});

Deno.test("failed page stays pending and the next page is not requested", async () => {
  const requested: number[] = [];
  const error = await assertRejects(
    () =>
      runCappedDateSync({
        cap: PAGE_HARD_CAP,
        slices: [{ dataInicial: "20260801", dataFinal: "20260803", nextPage: 1 }],
        fetchPage: (_slice, pagina) => {
          requested.push(pagina);
          if (pagina === 3) throw new Error("PNCP consulta HTTP 500");
          return Promise.resolve({
            paginasRestantes: 2,
            status: 200,
            elapsedMs: 1,
            body: {},
          });
        },
        onPage: () => Promise.resolve(),
      }),
    PageFetchError,
    "PNCP consulta HTTP 500",
  );
  assertEquals(requested, [1, 2, 3]);
  assertEquals(error.pending[0]?.nextPage, 3);
  assertEquals(syncTerminalStatus(error.pending, 0), "incompleta");
});

Deno.test("concluida prior run is not a continuation source", () => {
  const slice: DateSlice = { dataInicial: HAR_INICIAL, dataFinal: HAR_FINAL, nextPage: 201 };
  assertEquals(
    pendingFromPriorRun({
      status: "concluida",
      parametros: { continuation: { pending: [slice] } },
    }),
    null,
  );
  assertEquals(
    pendingFromPriorRun({
      status: "incompleta",
      parametros: { continuation: { pending: [slice] } },
    }),
    [slice],
  );
  assertEquals(pendingFromPriorRun(null), null);
  assertEquals(mayInactivateNotSeen("completo", "incompleta"), false);
  assertEquals(mayInactivateNotSeen("completo", "concluida"), true);
  assertEquals(mayInactivateNotSeen("completo", "concluida_com_erros"), false);
  assertEquals(mayInactivateNotSeen("incremental", "concluida"), false);
});

Deno.test("production cap syncs use the budget runner and do not close on page 200", async () => {
  for (const file of CAP_SYNCS) {
    const src = await readSync(file);
    assertEquals(src.includes("runCappedDateSync"), true, file);
    assertEquals(src.includes("loadPendingSlices"), true, file);
    assertEquals(src.includes("mayInactivateNotSeen"), true, file);
    assertEquals(src.includes("while (paginasRestantes > 0 && pagina <= 200)"), false, file);
    assertEquals(src.includes('status: "concluida"'), false, file);
  }
});

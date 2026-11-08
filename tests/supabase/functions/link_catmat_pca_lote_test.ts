// Regressão da issue #245: link-catmat-pca estourava CPU ("CPU Time exceeded", HTTP 546) com 3 idas ao banco por
// item. gravarVinculos grava em blocos: 3 operações por bloco de BLOCO_GRAVACAO itens, mesmas linhas e contagens.
import { assertEquals } from "jsr:@std/assert@1";
import {
  BLOCO_GRAVACAO,
  gravarVinculos,
} from "../../../supabase/functions/link-catmat-pca/index.ts";

type Chamada = {
  tabela: string;
  op: string;
  linhas?: unknown[];
  filtroIn?: unknown[];
};

function clienteFalso(opts: {
  existentes?: { catalogo_item_id: string; entidade_id: string }[];
  falharPonte?: boolean;
  falharPdm?: boolean;
  /** codigo_pdm sem linha em catmat_pdms: a FK recusa qualquer upsert que contenha esse código. */
  pdmInexistente?: number;
  falharLeitura?: boolean;
} = {}) {
  const chamadas: Chamada[] = [];
  const client = {
    from(tabela: string) {
      return {
        select(_cols: string) {
          const q = {
            eq(_c: string, _v: unknown) {
              return q;
            },
            in(_c: string, valores: unknown[]) {
              chamadas.push({ tabela, op: "select", filtroIn: valores });
              const ids = new Set(valores);
              return Promise.resolve({
                data: (opts.existentes ?? []).filter((e) =>
                  ids.has(e.entidade_id)
                ),
                error: opts.falharLeitura
                  ? { message: "leitura falhou" }
                  : null,
              });
            },
          };
          return q;
        },
        upsert(linhas: unknown[], _o: unknown) {
          chamadas.push({ tabela, op: "upsert", linhas });
          const fkPdm = tabela === "pca_item_pdm" &&
            opts.pdmInexistente !== undefined &&
            (linhas as { codigo_pdm: number }[]).some((l) =>
              l.codigo_pdm === opts.pdmInexistente
            );
          const falha = (tabela === "catalogo_ponte" && opts.falharPonte) ||
            (tabela === "pca_item_pdm" && opts.falharPdm) || fkPdm;
          return Promise.resolve({
            error: falha ? { message: "falhou" } : null,
          });
        },
      };
    },
  };
  return { client, chamadas };
}

function vinculos(n: number, comPdm = true) {
  return Array.from({ length: n }, (_, i) => ({
    pcaItemId: `pca-${i}`,
    catalogoItemId: `cat-${i % 7}`,
    codigoPdm: comPdm ? String(1000 + i) : null,
    score: 0.9,
    tipo: "exata" as const,
    evidencia: "jaccard=0.900;classe=7830",
  }));
}

const zero = () => ({
  vinculos_novos: 0,
  vinculos_atualizados: 0,
  pdm_vinculos: 0,
  erros: 0,
});

Deno.test("gravarVinculos usa 3 operações por bloco, não por item", async () => {
  const { client, chamadas } = clienteFalso();
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(250), stats);
  const blocos = Math.ceil(250 / BLOCO_GRAVACAO);
  assertEquals(chamadas.length, 3 * blocos);
  assertEquals(
    chamadas.filter((c) => c.op === "select").every((c) =>
      c.filtroIn!.length <= BLOCO_GRAVACAO
    ),
    true,
  );
  assertEquals(stats, {
    vinculos_novos: 250,
    vinculos_atualizados: 0,
    pdm_vinculos: 250,
    erros: 0,
  });
});

Deno.test("gravarVinculos conta vínculo já existente como atualizado", async () => {
  const { client } = clienteFalso({
    existentes: [{ catalogo_item_id: "cat-1", entidade_id: "pca-1" }, {
      catalogo_item_id: "cat-outro",
      entidade_id: "pca-2",
    }],
  });
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(5), stats);
  // pca-2 tem ponte para OUTRO item do catálogo: o par novo é vínculo novo, como na versão item a item
  assertEquals(stats.vinculos_atualizados, 1);
  assertEquals(stats.vinculos_novos, 4);
});

Deno.test("gravarVinculos: falha na ponte conta erro por item e não grava PDM do bloco", async () => {
  const { client, chamadas } = clienteFalso({ falharPonte: true });
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(3), stats);
  assertEquals(stats.erros, 3);
  assertEquals(stats.pdm_vinculos, 0);
  assertEquals(chamadas.some((c) => c.tabela === "pca_item_pdm"), false);
});

Deno.test("gravarVinculos: sem código PDM numérico não chama upsert do PDM", async () => {
  const { client, chamadas } = clienteFalso();
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(4, false), stats);
  assertEquals(chamadas.some((c) => c.tabela === "pca_item_pdm"), false);
  assertEquals(stats.vinculos_novos, 4);
});

Deno.test("gravarVinculos: falha no PDM conta erro por linha", async () => {
  const { client } = clienteFalso({ falharPdm: true });
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(3), stats);
  assertEquals(stats.erros, 3);
  assertEquals(stats.vinculos_novos, 3);
});

Deno.test("gravarVinculos: um PDM inexistente não derruba os PDMs válidos do bloco", async () => {
  const { client, chamadas } = clienteFalso({ pdmInexistente: 1002 });
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(5), stats);
  assertEquals(stats.pdm_vinculos, 4);
  assertEquals(stats.erros, 1);
  assertEquals(stats.vinculos_novos, 5);
  // 1 upsert em massa recusado + 5 refeitos linha a linha, só no PDM
  assertEquals(chamadas.filter((c) => c.tabela === "pca_item_pdm").length, 6);
  assertEquals(
    chamadas.filter((c) => c.tabela === "catalogo_ponte" && c.op === "upsert")
      .length,
    1,
  );
});

Deno.test("gravarVinculos: falha ao ler pontes existentes conta como novo e grava", async () => {
  const { client } = clienteFalso({
    falharLeitura: true,
    existentes: [{ catalogo_item_id: "cat-1", entidade_id: "pca-1" }],
  });
  const stats = zero();
  // deno-lint-ignore no-explicit-any
  await gravarVinculos(client as any, vinculos(3), stats);
  assertEquals(stats, {
    vinculos_novos: 3,
    vinculos_atualizados: 0,
    pdm_vinculos: 3,
    erros: 0,
  });
});

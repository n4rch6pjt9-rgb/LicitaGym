import { assertEquals } from "jsr:@std/assert@1";
import { COMPRAS_GOV_PAGE_SIZE } from "../../../../../supabase/functions/_shared/compras-gov/material-client.ts";
import {
  bloqueioModoCatalogo,
  CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO,
  CATMAT_TAMANHO_PAGINA,
  continuationCatalogo,
  decidirInicioCatalogo,
  deveSincronizarCatalogo,
  fatiaPdms,
  linhaCatmatItemPdm,
  normalizarPdmsEfetivos,
  offsetPdmDaContinuation,
  paramsItemDoPdm,
  resolverIncluirInativos,
} from "../../../../../supabase/functions/_shared/pncp/catmat-catalogo-sync.ts";

Deno.test("página CATMAT padrão é 100 e o clamp acompanha", () => {
  assertEquals(CATMAT_TAMANHO_PAGINA, 100);
  assertEquals(COMPRAS_GOV_PAGE_SIZE.default, 100);
  assertEquals(COMPRAS_GOV_PAGE_SIZE.max, 500);
});

Deno.test("incluir inativos: corpo vence o env, env vence o padrão false", () => {
  assertEquals(CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO, false);
  assertEquals(resolverIncluirInativos({}, null), false);
  assertEquals(resolverIncluirInativos({}, "true"), true);
  assertEquals(resolverIncluirInativos({}, "false"), false);
  assertEquals(resolverIncluirInativos({}, "sim"), false);
  assertEquals(resolverIncluirInativos({ incluir_inativos: true }, "false"), true);
  assertEquals(resolverIncluirInativos({ incluir_inativos: false }, "true"), false);
});

Deno.test("modo catálogo é o padrão sem classe; par explícito continua na lista fixa", () => {
  assertEquals(deveSincronizarCatalogo({}), true);
  assertEquals(deveSincronizarCatalogo({ modo: "catalogo" }), true);
  assertEquals(deveSincronizarCatalogo({ modo: "catalogo", codigo_grupo: 78, codigo_classe: 7810 }), true);
  assertEquals(deveSincronizarCatalogo({ modo: "classe" }), false);
  assertEquals(deveSincronizarCatalogo({ codigo_grupo: 78, codigo_classe: 7830 }), false);
  assertEquals(deveSincronizarCatalogo({ codigo_grupo: 78, codigo_classe: 7810 }), false);
  assertEquals(bloqueioModoCatalogo({}), null);
  assertEquals(bloqueioModoCatalogo({ incluir_caracteristicas: true })?.includes("classe"), true);
  assertEquals(bloqueioModoCatalogo({ somente_caracteristicas: true })?.includes("classe"), true);
});

Deno.test("PDMs efetivos: inteiros, dedup e ordem estável por codigo_pdm", () => {
  const pdms = normalizarPdmsEfetivos([
    { codigo_pdm: 9461, codigo_classe: "9320", codigo_grupo: 93 },
    { codigo_pdm: 4405, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 4405, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: "x", codigo_classe: 1, codigo_grupo: 1 },
    null,
  ]);
  assertEquals(pdms, [
    { codigo_pdm: 4405, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 9461, codigo_classe: 9320, codigo_grupo: 93 },
  ]);
});

Deno.test("consulta por codigoPdm pede só ativos quando a flag está desligada", () => {
  const pdm = { codigo_pdm: 16190, codigo_classe: 7810, codigo_grupo: 78 };
  assertEquals(paramsItemDoPdm(pdm, false), { codigoPdm: 16190, statusItem: true });
  assertEquals(paramsItemDoPdm(pdm, true), { codigoPdm: 16190 });
});

Deno.test("fatia e retomada: limite deixa o próximo offset; sem continuation o job de retomada não recarrega", () => {
  const pdms = [
    { codigo_pdm: 1, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 2, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 3, codigo_classe: 7830, codigo_grupo: 78 },
  ];
  const pagina = fatiaPdms(pdms, 1, 1);
  assertEquals(pagina.fatia.map((p) => p.codigo_pdm), [2]);
  assertEquals(pagina.proximo, 2);
  assertEquals(fatiaPdms(pdms, 2, undefined).proximo, null);

  const cont = continuationCatalogo(2);
  assertEquals(offsetPdmDaContinuation(cont), 2);
  assertEquals(cont.pending.length > 0, true);
  assertEquals(decidirInicioCatalogo({
    inheritedContinuation: cont,
    somenteRetomada: true,
  }), { pular: false, offset: 2 });
  assertEquals(decidirInicioCatalogo({
    inheritedContinuation: null,
    somenteRetomada: true,
  }), { pular: true, offset: 0 });
  assertEquals(decidirInicioCatalogo({
    bodyOffset: 0,
    inheritedContinuation: cont,
    somenteRetomada: true,
  }), { pular: false, offset: 0 });
});

Deno.test("linha de catmat_item_pdm preserva status oficial e recusa código ausente", () => {
  assertEquals(linhaCatmatItemPdm({
    codigoItem: 10,
    codigoPdm: 16190,
    codigoClasse: 7810,
    codigoGrupo: 78,
    descricaoItem: "ANILHA",
    statusItem: false,
  }), {
    codigo_item: 10,
    codigo_pdm: 16190,
    codigo_classe: 7810,
    codigo_grupo: 78,
    descricao: "ANILHA",
    status_item: false,
  });
  assertEquals(linhaCatmatItemPdm({ codigoItem: 10, codigoPdm: 1, codigoClasse: 7810 }), null);
});

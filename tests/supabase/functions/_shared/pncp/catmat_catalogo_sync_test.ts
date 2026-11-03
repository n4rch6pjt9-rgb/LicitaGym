import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { COMPRAS_GOV_PAGE_SIZE } from "../../../../../supabase/functions/_shared/compras-gov/material-client.ts";
import {
  bloqueioModoCatalogo,
  CATMAT_SYNC_INCLUIR_INATIVOS_PADRAO,
  CATMAT_TAMANHO_PAGINA,
  codigoPdmDaContinuation,
  continuationCatalogo,
  decidirInicioCatalogo,
  deveSincronizarCatalogo,
  exigirItensOficiais,
  fatiaPdms,
  ItemCatmatInvalidoError,
  linhaCatmatItemPdm,
  modoDesconhecido,
  normalizarPdmsEfetivos,
  paramsItemDoPdm,
  parseCorpoSync,
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
  assertEquals(modoDesconhecido("outro"), true);
  assertEquals(modoDesconhecido("catalogo"), false);
  assertEquals(modoDesconhecido(undefined), false);
  assertEquals(deveSincronizarCatalogo({ modo: "outro" }), false);
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

Deno.test("fatia e retomada usam codigo_pdm, não o índice da lista", () => {
  const pdms = [
    { codigo_pdm: 10, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 20, codigo_classe: 7810, codigo_grupo: 78 },
    { codigo_pdm: 30, codigo_classe: 7830, codigo_grupo: 78 },
  ];
  const pagina = fatiaPdms(pdms, 10, 1);
  assertEquals(pagina.fatia.map((p) => p.codigo_pdm), [10]);
  assertEquals(pagina.proximo, 20);
  assertEquals(fatiaPdms(pdms, 20, undefined).proximo, null);

  const semOProcessado = pdms.filter((p) => p.codigo_pdm !== 10);
  assertEquals(fatiaPdms(semOProcessado, 20, undefined).fatia.map((p) => p.codigo_pdm), [20, 30]);

  const cont = continuationCatalogo(20);
  assertEquals(codigoPdmDaContinuation(cont), 20);
  assertEquals(codigoPdmDaContinuation({ offset_pdm: 1, pending: [{ offset_pdm: 1 }] }), null);
  assertEquals(decidirInicioCatalogo({
    inheritedContinuation: cont,
    somenteRetomada: true,
  }), { pular: false, codigoPdm: 20 });
  assertEquals(decidirInicioCatalogo({
    inheritedContinuation: null,
    somenteRetomada: true,
  }), { pular: true, codigoPdm: 0 });
  assertEquals(decidirInicioCatalogo({
    bodyCodigoPdm: 0,
    inheritedContinuation: cont,
    somenteRetomada: true,
  }), { pular: false, codigoPdm: 0 });
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
  assertEquals(linhaCatmatItemPdm({
    codigoItem: 10,
    codigoPdm: 1,
    codigoClasse: 7810,
    codigoGrupo: 78,
    descricaoItem: "HALTER",
  })?.status_item, null);
  assertEquals(linhaCatmatItemPdm({
    codigoItem: 10,
    codigoPdm: 1,
    codigoClasse: 7810,
    codigoGrupo: 78,
    descricaoItem: "HALTER",
    statusItem: "sim",
  })?.status_item, null);
  assertEquals(linhaCatmatItemPdm({
    codigoItem: 10,
    codigoPdm: 1,
    codigoClasse: 7810,
    codigoGrupo: 78,
    statusItem: true,
  })?.descricao, null);
  assertThrows(() => exigirItensOficiais([{ codigoPdm: 1 }]), ItemCatmatInvalidoError);
});

Deno.test("JSON inválido não vira corpo vazio; corpo vazio é objeto", () => {
  assertEquals(parseCorpoSync(""), { ok: true, body: {} });
  assertEquals(parseCorpoSync("  "), { ok: true, body: {} });
  assertEquals(parseCorpoSync("{"), { ok: false, error: "JSON inválido" });
  assertEquals(parseCorpoSync("[]"), { ok: false, error: "JSON do corpo precisa ser um objeto" });
  assertEquals(parseCorpoSync('{"modo":"catalogo"}').ok, true);
});

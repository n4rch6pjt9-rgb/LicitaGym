import { assertEquals } from "jsr:@std/assert@1";
import {
  PCA_CONSULTA_ATTEMPT_TIMEOUT_MS,
  PncpConsultaClient,
} from "../../../../../supabase/functions/_shared/pncp/consulta-client.ts";
import type { UnifiedHttpClient } from "../../../../../supabase/functions/_shared/http-client/unified-client.ts";

/** httpClient falso: guarda as opções de cada getJson e devolve uma página vazia. */
function fakeHttpClient() {
  const opcoes: Array<Record<string, unknown>> = [];
  const client = {
    getJson(_url: string, _init: RequestInit, options: Record<string, unknown>) {
      opcoes.push(options);
      return Promise.resolve({
        status: 200,
        body: { data: [], paginasRestantes: 0, totalRegistros: 0 },
        elapsedMs: 1,
      });
    },
  } as unknown as UnifiedHttpClient;
  return { client, opcoes };
}

Deno.test("timeout da consulta /pca/ cobre a primeira página sem cache (46 a 57 s em 09/10)", () => {
  assertEquals(PCA_CONSULTA_ATTEMPT_TIMEOUT_MS > 57_000, true);
});

Deno.test("fetchPcaPage passa o timeout do PCA ao cliente unificado", async () => {
  const { client, opcoes } = fakeHttpClient();
  const consulta = new PncpConsultaClient("https://pncp.test/api/consulta/v1", {}, client);
  await consulta.fetchPcaPage(2026, 1, "7830", 500);
  assertEquals(opcoes[0].attemptTimeoutMs, PCA_CONSULTA_ATTEMPT_TIMEOUT_MS);
  assertEquals(opcoes[0].pagina, 1);
});

Deno.test("fetchPcaPage aceita timeout explícito do chamador", async () => {
  const { client, opcoes } = fakeHttpClient();
  const consulta = new PncpConsultaClient("https://pncp.test/api/consulta/v1", {}, client);
  await consulta.fetchPcaPage(2026, 2, "7830", 500, { attemptTimeoutMs: 30_000 });
  assertEquals(opcoes[0].attemptTimeoutMs, 30_000);
  assertEquals(opcoes[0].pagina, 2);
});

Deno.test("probePcaClassificacao passa o timeout do PCA ao cliente unificado", async () => {
  const { client, opcoes } = fakeHttpClient();
  const consulta = new PncpConsultaClient("https://pncp.test/api/consulta/v1", {}, client);
  await consulta.probePcaClassificacao(2026, "7830");
  assertEquals(opcoes[0].attemptTimeoutMs, PCA_CONSULTA_ATTEMPT_TIMEOUT_MS);
});

Deno.test("outros endpoints da consulta não ganham o timeout do PCA", async () => {
  const { client, opcoes } = fakeHttpClient();
  const consulta = new PncpConsultaClient("https://pncp.test/api/consulta/v1", {}, client);
  await consulta.getJson("/atas", { pagina: 1 });
  assertEquals(opcoes[0].attemptTimeoutMs, undefined);
});

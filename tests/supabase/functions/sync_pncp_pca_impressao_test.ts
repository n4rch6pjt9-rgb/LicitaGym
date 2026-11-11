// Spec 0056: camada 1 (impressão digital por órgão via consolidado/unidades) e camada 0 (descoberta de CNPJ novo).
// CA-2 (paginação), CA-3 (404 na página 1 é erro do órgão), CA-4 (o que entra na fila; removido "a confirmar"),
// CA-8 (consulta /v1/pca/ fora do ar não para a impressão) e CA-9 (sem token de cron = 401).
// Valores fictícios; CNPJs sintéticos.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import {
  cabecalhoDaImpressao,
  executarImpressao,
  lerImpressaoOrgao,
  TAMANHO_PAGINA_IMPRESSAO,
} from "../../../supabase/functions/_shared/pncp/pca-impressao.ts";
import { handleRotinaImpressao } from "../../../supabase/functions/sync-pncp-pca/rotina-impressao.ts";
import { handleRequest } from "../../../supabase/functions/sync-pncp-pca/index.ts";

type Row = Record<string, unknown>;
const RUN = "00000000-0000-0000-0000-000000000056";
const ANO = 2026;
const ORGAO_A = "99000001000101";
const ORGAO_B = "99000002000102";
const nunca = () => false;

/** Linha de `consolidado/unidades` (PlanoContratacaoOrgaoDTO do OpenAPI de 09/10/2026). */
function linhaImpressao(cnpj: string, seq: number, extra: Row = {}): Row {
  return {
    cnpj,
    anoPca: ANO,
    sequencialPca: seq,
    codigoUnidade: String(990000 + seq),
    nomeUnidade: `Unidade ${seq}`,
    razaoSocial: "Órgão de teste",
    quantidade: 10,
    valorTotal: 1000,
    dataAtualizacao: "2026-10-01T10:00:00",
    dataAtualizacaoGlobalPCA: "2026-10-01T10:00:00",
    dataPublicacaoPncp: "2026-04-01T10:00:00",
    numeroControlePNCP: `${cnpj}-0-${String(seq).padStart(6, "0")}/${ANO}`,
    ...extra,
  };
}

/** Integração fake: `paginas[cnpj]` é a lista completa; status por página sobrescreve. */
function integracaoFake(
  listas: Record<string, Row[]>,
  forcar: Record<string, { status: number; body: unknown }> = {},
) {
  const chamadas: string[] = [];
  return {
    chamadas,
    getPcaConsolidadoUnidades(cnpj: string, ano: number, pagina: number, tamanho: number) {
      chamadas.push(`${cnpj}/${ano}/${pagina}`);
      const f = forcar[`${cnpj}/${pagina}`];
      if (f) return Promise.resolve(f);
      const tudo = listas[cnpj] ?? [];
      const pag = tudo.slice((pagina - 1) * tamanho, pagina * tamanho);
      // A página depois da última responde 404 "CNPJ do Órgão/Entidade inválido." (medido em 11/11/2026).
      return Promise.resolve(
        pag.length
          ? { status: 200, body: pag }
          : { status: 404, body: { message: "CNPJ do Órgão/Entidade inválido." } },
      );
    },
  };
}

function plano(cnpj: string, seq: number): Row {
  return {
    id: `plano-${cnpj}-${seq}`,
    id_pca_pncp: `${cnpj}-0-${String(seq).padStart(6, "0")}/${ANO}`,
    orgao_cnpj: cnpj,
    ano_exercicio: ANO,
    numero_plano: seq,
    ativo: true,
  };
}

function banco(planos: Row[] = [], impressoes: Row[] = []): FakePostgrest {
  const db = new FakePostgrest({ pca_planos: planos, pca_impressao_plano: impressoes });
  db.rpcs.pca_fila_enfileirar = (args, d) => {
    for (const it of args.p_itens as Row[]) d.rows("pca_plano_fila").push({ status: "pendente", ...it });
    return (args.p_itens as Row[]).length;
  };
  let n = 0;
  db.rpcs.acquire_sync_lock = (args, d) => {
    const id = `00000000-0000-0000-0000-0000000005${String(++n).padStart(2, "0")}`;
    d.rows("pncp_sync_run").push({ id, lock_key: args.p_lock_key, status: "executando" });
    return { already_running: false, run_id: id };
  };
  return db;
}

Deno.test("0056 CA-2: lê todas as páginas de 50 e não pede página além da última", async () => {
  const integ = integracaoFake({
    [ORGAO_A]: Array.from({ length: 20 }, (_, i) => linhaImpressao(ORGAO_A, i + 1)),
    [ORGAO_B]: Array.from({ length: 60 }, (_, i) => linhaImpressao(ORGAO_B, i + 1)),
  });
  assertEquals(TAMANHO_PAGINA_IMPRESSAO, 50);
  const a = await lerImpressaoOrgao(integ, ORGAO_A, ANO);
  const b = await lerImpressaoOrgao(integ, ORGAO_B, ANO);
  assert(a.ok && b.ok);
  assertEquals([a.planos.length, b.planos.length], [20, 60]);
  // A: página 1 com 20 (< 50) termina; B: página 1 cheia, página 2 com 10 termina. Nenhuma página 3.
  assertEquals(integ.chamadas, [`${ORGAO_A}/2026/1`, `${ORGAO_B}/2026/1`, `${ORGAO_B}/2026/2`]);

  const db = banco([plano(ORGAO_A, 1), plano(ORGAO_B, 1)]);
  const s = await executarImpressao(db as never, integracaoFake({
    [ORGAO_A]: Array.from({ length: 20 }, (_, i) => linhaImpressao(ORGAO_A, i + 1)),
    [ORGAO_B]: Array.from({ length: 60 }, (_, i) => linhaImpressao(ORGAO_B, i + 1)),
  }), { ano: ANO, classes: ["7830"], limiteOrgaos: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.orgaos_lidos, 2);
  const impressoes = db.rows("pca_impressao_plano");
  assertEquals(impressoes.filter((r) => r.orgao_cnpj === ORGAO_A).length, 20);
  assertEquals(impressoes.filter((r) => r.orgao_cnpj === ORGAO_B).length, 60);
});

Deno.test("0056 CA-2: 404 em página > 1 depois de página cheia é fim da lista, não erro", async () => {
  const integ = integracaoFake({
    [ORGAO_A]: Array.from({ length: 50 }, (_, i) => linhaImpressao(ORGAO_A, i + 1)),
  });
  const r = await lerImpressaoOrgao(integ, ORGAO_A, ANO);
  assert(r.ok);
  assertEquals(r.planos.length, 50);
  assertEquals(integ.chamadas.length, 2);
});

Deno.test("0056 CA-3: 404 na página 1 é erro do órgão; nada vira removido e a rotina segue", async () => {
  const db = banco([plano(ORGAO_A, 1), plano(ORGAO_A, 2), plano(ORGAO_B, 1)], [
    { orgao_cnpj: ORGAO_A, ano: ANO, sequencial: 1, quantidade: 10, valor_total: 1000, ausente_leituras: 0 },
  ]);
  const integ = integracaoFake({ [ORGAO_B]: [linhaImpressao(ORGAO_B, 1)] }, {
    [`${ORGAO_A}/1`]: { status: 404, body: { message: "CNPJ do Órgão/Entidade inválido." } },
  });
  const s = await executarImpressao(db as never, integ, {
    ano: ANO,
    classes: ["7830"],
    limiteOrgaos: 10,
    prazoEsgotado: nunca,
    runId: RUN,
  });
  assertEquals([s.orgaos_erro, s.orgaos_lidos, s.removidos_a_confirmar], [1, 1, 0]);
  const orgaoA = db.rows("pca_impressao_orgao").find((r) => r.orgao_cnpj === ORGAO_A);
  assert(String(orgaoA?.erro ?? "").includes("404"), "o erro do órgão fica registrado com o status");
  assertEquals(db.rows("pca_alteracoes").length, 0);
  assertEquals(db.rows("pca_impressao_plano").find((r) => r.orgao_cnpj === ORGAO_A)?.ausente_leituras, 0);
  // O órgão B foi lido e enfileirado mesmo depois da falha do A.
  assertEquals(db.rows("pca_plano_fila").map((f) => f.id_pca_pncp), [`${ORGAO_B}-0-000001/2026`]);
});

Deno.test("0056 CA-4: entram na fila só o plano novo e os alterados (data ou valor); ausente vira 'a confirmar'", async () => {
  const anterior = (seq: number, extra: Row = {}) => ({
    orgao_cnpj: ORGAO_A,
    ano: ANO,
    sequencial: seq,
    quantidade: 10,
    valor_total: 1000,
    data_atualizacao: "2026-10-01T10:00:00",
    ausente_leituras: 0,
    ...extra,
  });
  const db = banco(
    [plano(ORGAO_A, 1), plano(ORGAO_A, 2), plano(ORGAO_A, 3), plano(ORGAO_A, 9)],
    [anterior(1), anterior(2), anterior(3), anterior(9)],
  );
  db.rows("pca_itens").push({ id: "item-9", pca_plano_id: `plano-${ORGAO_A}-9`, numero_item: 1, ativo: true });
  const integ = integracaoFake({
    [ORGAO_A]: [
      linhaImpressao(ORGAO_A, 1), // igual
      linhaImpressao(ORGAO_A, 2, { dataAtualizacao: "2026-11-05T08:00:00" }), // data nova
      linhaImpressao(ORGAO_A, 3, { valorTotal: 1500 }), // valor diferente, mesma data
      linhaImpressao(ORGAO_A, 4), // sem impressão anterior
      // o plano 9 não veio
    ],
  });
  const s = await executarImpressao(db as never, integ, {
    ano: ANO,
    classes: ["7830"],
    limiteOrgaos: 10,
    prazoEsgotado: nunca,
    runId: RUN,
  });
  const fila = db.rows("pca_plano_fila");
  assertEquals(fila.map((f) => f.sequencial).sort(), [2, 3, 4]);
  assert(fila.every((f) => f.motivo === "impressao"));
  assertEquals(s.enfileirados, 3);
  // O cabeçalho vai no formato da consulta, que é o que a carga normaliza.
  assertEquals((fila.find((f) => f.sequencial === 4)?.plano as Row).idPcaPncp, `${ORGAO_A}-0-000004/2026`);

  assertEquals(s.removidos_a_confirmar, 1);
  const avisos = db.rows("pca_alteracoes");
  assertEquals(avisos.length, 1);
  assertEquals(avisos[0].evento, "pca_removido");
  assertEquals(avisos[0].pca_plano_id, `plano-${ORGAO_A}-9`);
  assertEquals((avisos[0].dados_novos as Row).situacao, "a_confirmar");
  // Não inativa nada na primeira ausência.
  assertEquals(db.rows("pca_itens")[0].ativo, true);
  assertEquals(db.rows("pca_planos").find((p) => p.numero_plano === 9)?.ativo, true);
});

Deno.test("0056 CA-4 (P-4): fora em duas leituras seguidas inativa o plano e os itens do escopo", async () => {
  const db = banco([plano(ORGAO_A, 1), plano(ORGAO_A, 9)], [
    { orgao_cnpj: ORGAO_A, ano: ANO, sequencial: 1, quantidade: 10, valor_total: 1000,
      data_atualizacao: "2026-10-01T10:00:00", ausente_leituras: 0 },
    { orgao_cnpj: ORGAO_A, ano: ANO, sequencial: 9, quantidade: 10, valor_total: 1000,
      data_atualizacao: "2026-10-01T10:00:00", ausente_leituras: 1 },
  ]);
  db.rows("pca_itens").push({
    id: "item-9",
    pca_plano_id: `plano-${ORGAO_A}-9`,
    numero_item: 1,
    classe_material_servico: "7830",
    ativo: true,
  });
  const integ = integracaoFake({ [ORGAO_A]: [linhaImpressao(ORGAO_A, 1)] });
  const s = await executarImpressao(db as never, integ, {
    ano: ANO,
    classes: ["7830"],
    limiteOrgaos: 10,
    prazoEsgotado: nunca,
    runId: RUN,
  });
  assertEquals([s.removidos_a_confirmar, s.itens_inativados, s.planos_inativados], [0, 1, 1]);
  assertEquals(db.rows("pca_itens")[0].ativo, false);
  assertEquals(db.rows("pca_planos").find((p) => p.numero_plano === 9)?.ativo, false);
});

Deno.test("0056: cabeçalho da impressão no formato da consulta /v1/pca/", () => {
  const c = cabecalhoDaImpressao(linhaImpressao(ORGAO_A, 4));
  assertEquals(c, {
    idPcaPncp: `${ORGAO_A}-0-000004/2026`,
    orgaoEntidadeCnpj: ORGAO_A,
    anoPca: ANO,
    codigoUnidade: "990004",
    nomeUnidade: "Unidade 4",
    orgaoEntidadeRazaoSocial: "Órgão de teste",
    dataPublicacaoPNCP: "2026-04-01T10:00:00",
    dataAtualizacaoGlobalPCA: "2026-10-01T10:00:00",
  });
});

Deno.test("0056 CA-8: consulta /v1/pca/ com 503 em tudo não impede a impressão de enfileirar", async () => {
  const db = banco([plano(ORGAO_A, 1)]);
  const consulta = {
    fetchPcaPage: () => Promise.reject(new Error("PNCP consulta HTTP 503")),
  };
  const res = await handleRotinaImpressao({
    client: db as never,
    consulta: consulta as never,
    integracao: integracaoFake({ [ORGAO_A]: [linhaImpressao(ORGAO_A, 1), linhaImpressao(ORGAO_A, 2)] }) as never,
    body: { rotina: "impressao" },
    ano: ANO,
    classes: ["7830"],
    isAsync: false,
  });
  const r = await res.json();
  assertEquals(r.status, "concluida");
  assertEquals(db.rows("pca_plano_fila").length, 2);
});

for (const rotina of ["impressao", "descoberta"]) {
  Deno.test(`0056 CA-9: rotina ${rotina} sem token de cron recebe 401 e nada é gravado`, async () => {
    let criou = false;
    const anterior = Deno.env.get("SYNC_CRON_SECRET");
    Deno.env.set("SYNC_CRON_SECRET", "segredo-de-teste");
    try {
      for (const auth of [undefined, "Bearer token-de-usuario", "Bearer outro-segredo"]) {
      const res = await handleRequest(
        new Request("http://local/sync-pncp-pca", {
          method: "POST",
          headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
          body: JSON.stringify({ rotina, ano: ANO }),
        }),
        {
          createServiceClient: () => {
            criou = true;
            return banco() as never;
          },
        },
      );
      assertEquals(res.status, 401);
      await res.body?.cancel();
      }
    } finally {
      if (anterior === undefined) Deno.env.delete("SYNC_CRON_SECRET");
      else Deno.env.set("SYNC_CRON_SECRET", anterior);
    }
    assertEquals(criou, false);
  });
}

Deno.test("0056: lista que termina em 404 depois de página cheia não conta ausência (pode estar truncada)", async () => {
  const db = banco([plano(ORGAO_A, 1), plano(ORGAO_A, 99)]);
  const integ = integracaoFake({
    [ORGAO_A]: Array.from({ length: 50 }, (_, i) => linhaImpressao(ORGAO_A, i + 1)),
  });
  const s = await executarImpressao(db as never, integ, {
    ano: ANO,
    classes: ["7830"],
    limiteOrgaos: 10,
    prazoEsgotado: nunca,
    runId: RUN,
  });
  assertEquals([s.orgaos_lidos, s.removidos_a_confirmar], [1, 0]);
  assertEquals(db.rows("pca_alteracoes").length, 0);
});

Deno.test("0056: página 1 vazia não marca os planos gravados como ausentes", async () => {
  const db = banco([plano(ORGAO_A, 1)]);
  const integ = integracaoFake({}, { [`${ORGAO_A}/1`]: { status: 200, body: [] } });
  const s = await executarImpressao(db as never, integ, {
    ano: ANO,
    classes: ["7830"],
    limiteOrgaos: 10,
    prazoEsgotado: nunca,
    runId: RUN,
  });
  assertEquals(s.removidos_a_confirmar, 0);
  assertEquals(db.rows("pca_alteracoes").length, 0);
});

// Spec 0012, PR 2: fila de planos (descoberta pela consulta, itens pela integração por plano).
// CA-3 (mesmo hash consulta × integração), CA-5/CA-6 (descoberta e enfileiramento), CA-7 (orçamento),
// CA-8 (inativação por plano; erro não inativa), CA-10 (ausente).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import {
  descobrirPlanos,
  enfileirarDescobertos,
  itemIntegracaoParaConsulta,
  lerItensPlano,
  planoDaConsulta,
  processarFila,
  TAMANHO_PAGINA_INTEGRACAO,
  tratarAusentes,
} from "../../../supabase/functions/_shared/pncp/pca-fila.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
import { normalizePcaItem } from "../../../supabase/functions/_shared/pncp/normalize.ts";
import { hashPayload } from "../../../supabase/functions/_shared/pncp/hash.ts";

type Row = Record<string, unknown>;
const RUN = "00000000-0000-0000-0000-000000000001";
const CNPJ = "99000001000101";
const ID = `${CNPJ}-0-000004/2026`;

/** Cabeçalho de plano no formato da consulta /pca/ (valores fictícios). */
function cabecalho(id = ID, data = "2026-09-21T11:31:57"): Row {
  return {
    codigoUnidade: "999001",
    nomeUnidade: "Unidade de teste",
    anoPca: 2026,
    orgaoEntidadeCnpj: id.slice(0, 14),
    idPcaPncp: id,
    dataPublicacaoPNCP: "2025-04-29T08:19:54",
    dataAtualizacaoGlobalPCA: data,
    orgaoEntidadeRazaoSocial: "Órgão de teste",
  };
}

/** Item no formato da integração (nomes do OpenAPI de 09/10/2026; valores fictícios). */
function itemIntegracao(n: number, classe = "7830"): Row {
  return {
    nomeClassificacao: "Material",
    descricao: `Item ${n}`,
    numeroItem: n,
    valorTotal: 100 * n,
    pdmCodigo: "2640",
    codigoItem: "480144",
    classificacaoSuperiorCodigo: classe,
    unidadeFornecimento: "UN",
    quantidade: 3,
    valorUnitario: (100 * n) / 3,
    dataDesejada: "2026-11-10",
    classificacaoCatalogoId: 1,
    categoriaItemPcaNome: "Material",
  };
}

/** O mesmo item no formato da consulta /pca/. */
function itemConsulta(n: number, classe = "7830"): Row {
  const { nomeClassificacao: _n, descricao: _d, quantidade: _q, ...resto } = itemIntegracao(n, classe);
  return { ...resto, descricaoItem: `Item ${n}`, quantidadeEstimada: 3, nomeClassificacaoCatalogo: "Material" };
}

/** Simula as funções SQL da migration 20261009210000 (comportamento coberto também pelo pca_plano_fila_check.sql). */
function banco(): FakePostgrest {
  const db = new FakePostgrest({
    catmat_pdms: [{ codigo_pdm: 2640 }],
    catalogo_itens: [{ id: "cat-1", codigo_catmat: "480144" }],
  });
  let seq = 0;
  db.rpcs.pca_fila_enfileirar = (args, d) => {
    const fila = d.rows("pca_plano_fila");
    let n = 0;
    for (const it of args.p_itens as Row[]) {
      const aberto = fila.find((f) =>
        f.id_pca_pncp === it.id_pca_pncp && ["pendente", "processando", "erro"].includes(String(f.status))
      );
      if (aberto) {
        Object.assign(aberto, { ...it, plano: it.plano ?? aberto.plano });
        if (aberto.status !== "processando") aberto.status = "pendente";
      } else {
        fila.push({ id: ++seq, status: "pendente", tentativas: 0, ...it });
      }
      n++;
    }
    return n;
  };
  db.rpcs.pca_fila_reservar = (args, d) => {
    const fila = d.rows("pca_plano_fila")
      .filter((f) =>
        f.status === "pendente" ||
        (f.status === "erro" && Number(f.tentativas) < 5 &&
          Date.parse(String(f.atualizado_em ?? 0)) < Date.now() - 10 * 60_000)
      )
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, Number(args.p_limite));
    for (const f of fila) f.status = "processando";
    return fila.map((f) => ({ ...f }));
  };
  db.rpcs.pca_marcar_descoberta = (args, d) => {
    const vistos = new Set(args.p_vistos as string[]);
    for (const p of d.rows("pca_planos")) {
      if (p.ano_exercicio !== args.p_ano) continue;
      p.descoberta_ausente_seguidas = vistos.has(String(p.id_pca_pncp))
        ? 0
        : Number(p.descoberta_ausente_seguidas ?? 0) + (p.ativo !== false ? 1 : 0);
    }
    return d.rows("pca_planos").filter((p) => p.ativo !== false && Number(p.descoberta_ausente_seguidas) >= 2).length;
  };
  return db;
}

function integracaoFake(porPlano: Record<string, Row[] | unknown>) {
  const chamadas: string[] = [];
  return {
    chamadas,
    getPcaItens(cnpj: string, ano: number, seq: number, pagina: number, tamanho: number) {
      chamadas.push(`${cnpj}/${ano}/${seq}/${pagina}`);
      const tudo = porPlano[`${cnpj}/${ano}/${seq}`];
      if (!Array.isArray(tudo)) return Promise.resolve(tudo);
      return Promise.resolve(tudo.slice((pagina - 1) * tamanho, pagina * tamanho));
    },
  };
}

const nunca = () => false;

Deno.test("planoDaConsulta: separa CNPJ, sequencial e ano e tira os itens do cabeçalho", () => {
  const p = planoDaConsulta({ ...cabecalho(), itens: [itemConsulta(1)] })!;
  assertEquals([p.orgao_cnpj, p.sequencial, p.ano], [CNPJ, 4, 2026]);
  assertEquals("itens" in p.plano, false);
  assertEquals(planoDaConsulta({ idPcaPncp: "lixo" }), null);
});

Deno.test("CA-3: item da integração e da consulta normalizam para a mesma linha e o mesmo hash", async () => {
  const a = normalizePcaItem(itemIntegracaoParaConsulta(itemIntegracao(413)), {});
  const b = normalizePcaItem(itemConsulta(413), {});
  assertEquals(a, b);
  assertEquals(await hashPayload({ ...a, pca_plano_id: "x" }), await hashPayload({ ...b, pca_plano_id: "x" }));
});

Deno.test("CA-5: descoberta junta planos repetidos entre páginas e conta linhas e pares distintos", async () => {
  const paginas: Row[] = [
    { data: [{ ...cabecalho(), itens: [itemConsulta(1), itemConsulta(2)] }], paginasRestantes: 1 },
    { data: [{ ...cabecalho(), itens: [itemConsulta(2), itemConsulta(3)] }], paginasRestantes: 0 },
  ];
  const consulta = { fetchPcaPage: (_a: number, p: number) => Promise.resolve({ status: 200, body: paginas[p - 1] }) };
  const d = await descobrirPlanos(consulta, { ano: 2026, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  assertEquals([d.completo, d.planos.size, d.paginas, d.linhas, d.pares_distintos], [true, 1, 2, 4, 3]);
});

Deno.test("descoberta: erro de página ou envelope sem data[] deixa incompleta (erro ≠ vazio)", async () => {
  const consulta = {
    fetchPcaPage: (_a: number, p: number) =>
      Promise.resolve(p === 1 ? { status: 200, body: { data: [cabecalho()], paginasRestantes: 1 } } : { status: 200, body: {} }),
  };
  const d = await descobrirPlanos(consulta, { ano: 2026, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  assertEquals(d.completo, false);
  assert(d.erro?.includes("envelope"));
  assertEquals(d.planos.size, 1);
});

Deno.test("CA-6: incremental enfileira novo, alterado e inativo; não enfileira o que não mudou", async () => {
  const db = banco();
  for (const [id, data, ativo] of [
    [`${CNPJ}-0-000001/2026`, "2026-09-21T11:31:57+00:00", true], // igual → não entra
    [`${CNPJ}-0-000002/2026`, "2026-09-01T00:00:00+00:00", true], // fonte mais nova → alterado
    [`${CNPJ}-0-000003/2026`, "2026-09-21T11:31:57+00:00", false], // inativo → alterado
  ] as [string, string, boolean][]) {
    db.rows("pca_planos").push({ id: `pl-${id}`, id_pca_pncp: id, data_atualizacao_origem: data, ativo });
  }
  const consulta = {
    fetchPcaPage: () =>
      Promise.resolve({
        status: 200,
        body: {
          data: [1, 2, 3, 4].map((s) => cabecalho(`${CNPJ}-0-00000${s}/2026`)),
          paginasRestantes: 0,
        },
      }),
  };
  const d = await descobrirPlanos(consulta, { ano: 2026, classes: ["7830"], tamanhoPagina: 500, prazoEsgotado: nunca });
  const r = await enfileirarDescobertos(db as never, d, "incremental", RUN);
  assertEquals([r.novos, r.alterados, r.sem_mudanca, r.enfileirados], [1, 2, 1, 3]);
  assertEquals(db.rows("pca_plano_fila").map((f) => f.motivo).sort(), ["alterado", "alterado", "novo"]);

  const b = await enfileirarDescobertos(db as never, d, "backfill", RUN);
  assertEquals(b.enfileirados, 4);
  assertEquals(db.rows("pca_plano_fila").length, 4); // reenfileirar atualiza a linha aberta, não duplica
});

Deno.test("CA-8: carga grava só o escopo, inativa o item que sumiu e marca o plano feito", async () => {
  const db = banco();
  // estado anterior: itens 412 e 413 gravados e ativos
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(412), itemConsulta(413)] }], {
    ano: 2026,
    runId: "run-0",
  });
  db.rpcs.pca_fila_enfileirar({
    p_itens: [{ id_pca_pncp: ID, orgao_cnpj: CNPJ, ano: 2026, sequencial: 4, motivo: "alterado", plano: cabecalho() }],
  }, db);
  // a integração agora devolve 412, 414 e um item de outra classe; o 413 sumiu
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: [itemIntegracao(412), itemIntegracao(414), itemIntegracao(900, "6505")] });
  const s = await processarFila(db as never, integ, { classes: ["7830"], limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_feitos, s.planos_erro, s.itens_inativados, s.erros], [1, 0, 1, 0]);
  const itens = db.rows("pca_itens");
  assertEquals(itens.find((r) => r.numero_item === 413)?.ativo, false);
  assertEquals(itens.find((r) => r.numero_item === 414)?.ativo ?? true, true);
  assertEquals(itens.some((r) => r.numero_item === 900), false);
  assertEquals(db.rows("pca_plano_fila")[0].status, "feito");
});

Deno.test("CA-8: integração com resposta inválida não inativa nada e soma tentativa", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(413)] }], { ano: 2026, runId: "run-0" });
  db.rpcs.pca_fila_enfileirar({
    p_itens: [{ id_pca_pncp: ID, orgao_cnpj: CNPJ, ano: 2026, sequencial: 4, motivo: "alterado", plano: cabecalho() }],
  }, db);
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: { message: "Not Found" } });
  const s = await processarFila(db as never, integ, { classes: ["7830"], limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals([s.planos_erro, s.itens_inativados], [1, 0]);
  assertEquals(db.rows("pca_itens").every((r) => r.ativo !== false), true);
  const f = db.rows("pca_plano_fila")[0];
  assertEquals([f.status, f.tentativas], ["erro", 1]);
});

Deno.test("CA-7: limite de 2 planos com 5 na fila processa 2 e deixa 3 pendentes", async () => {
  const db = banco();
  const porPlano: Record<string, Row[]> = {};
  const itens: Row[] = [];
  for (let s = 1; s <= 5; s++) {
    const id = `${CNPJ}-0-00000${s}/2026`;
    itens.push({ id_pca_pncp: id, orgao_cnpj: CNPJ, ano: 2026, sequencial: s, motivo: "novo", plano: cabecalho(id) });
    porPlano[`${CNPJ}/2026/${s}`] = [itemIntegracao(1)];
  }
  db.rpcs.pca_fila_enfileirar({ p_itens: itens }, db);
  const integ = integracaoFake(porPlano);
  const s1 = await processarFila(db as never, integ, { classes: ["7830"], limite: 2, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s1.planos_feitos, 2);
  assertEquals(db.rows("pca_plano_fila").filter((f) => f.status === "pendente").length, 3);
  const s2 = await processarFila(db as never, integ, { classes: ["7830"], limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s2.planos_feitos, 3);
  assertEquals(integ.chamadas.length, 5); // nenhum plano repetido
});

Deno.test("CA-10: ausente só é inativado quando a integração confirma que não há item do escopo", async () => {
  const db = banco();
  const outro = `${CNPJ}-0-000005/2026`;
  for (const id of [ID, outro]) {
    await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(id), itens: [itemConsulta(1)] }], { ano: 2026, runId: "r" });
  }
  for (const p of db.rows("pca_planos")) p.descoberta_ausente_seguidas = 1;
  // descoberta completa que não viu nenhum dos dois: contador vai a 2 e a reconciliação enfileira os ausentes
  const vazia = { planos: new Map(), completo: true, paginas: 1, linhas: 0, pares_distintos: 0, erro: null };
  const a = await tratarAusentes(db as never, vazia, { ano: 2026, classes: ["7830"], rotina: "reconciliacao", chainId: RUN });
  assertEquals([a.ausentes_2_ou_mais, a.enfileirados], [2, 2]);
  const integ = integracaoFake({
    [`${CNPJ}/2026/4`]: [itemIntegracao(1, "6505")], // só outra classe → inativa
    [`${CNPJ}/2026/5`]: [itemIntegracao(1)], // ainda tem item 7830 → fica
  });
  const s = await processarFila(db as never, integ, { classes: ["7830"], limite: 10, prazoEsgotado: nunca, runId: RUN });
  assertEquals(s.planos_inativados, 1);
  const planos = Object.fromEntries(db.rows("pca_planos").map((p) => [p.id_pca_pncp, p.ativo !== false]));
  assertEquals(planos, { [ID]: false, [outro]: true });
  const plano4 = db.rows("pca_planos").find((p) => p.id_pca_pncp === ID)!;
  assertEquals(db.rows("pca_itens").filter((i) => i.pca_plano_id === plano4.id).every((i) => i.ativo === false), true);
});

Deno.test("CA-10: incremental não enfileira ausentes, só atualiza o contador", async () => {
  const db = banco();
  await gravarPaginaPcaEmLote(db as never, [{ ...cabecalho(), itens: [itemConsulta(1)] }], { ano: 2026, runId: "r" });
  db.rows("pca_planos")[0].descoberta_ausente_seguidas = 5;
  const vazia = { planos: new Map(), completo: true, paginas: 1, linhas: 0, pares_distintos: 0, erro: null };
  const a = await tratarAusentes(db as never, vazia, { ano: 2026, classes: ["7830"], rotina: "incremental", chainId: RUN });
  assertEquals(a.enfileirados, 0);
  assertEquals(db.rows("pca_plano_fila").length, 0);
});

Deno.test("integração: plano com mais de 2.000 itens lê a página seguinte", async () => {
  const muitos = Array.from({ length: TAMANHO_PAGINA_INTEGRACAO + 5 }, (_, i) => itemIntegracao(i + 1));
  const integ = integracaoFake({ [`${CNPJ}/2026/4`]: muitos });
  const lidos = await lerItensPlano(integ, CNPJ, 2026, 4);
  assertEquals(lidos.length, TAMANHO_PAGINA_INTEGRACAO + 5);
  assertEquals(integ.chamadas.length, 2);
});

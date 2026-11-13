// Spec 0039, etapa 1b (K-5b): detecção e geração do alerta de convocação a partir do chat da sessão.
import { assertEquals } from "jsr:@std/assert@1";
import { detectarAlerta, gerarAlertas } from "../../../../supabase/functions/_shared/sessao_alertas.ts";
import { sincronizarCompra } from "../../../../supabase/functions/_shared/sessao_chat.ts";

// Textos reais do Compras.gov.br (08/11/2026), CNPJ trocado por um válido de exemplo.
const CONVOCACAO =
  "Sr. Fornecedor JULIO CESAR GASPARINI JUNIOR LTDA, CNPJ 11.222.333/0001-81, você foi convocado para enviar anexos " +
  "para o item G1. Prazo para encerrar o envio: 12:12:00 do dia 14/10/2026. Justificativa: Proposta, Catalogo e " +
  "Documentos de habilitação..";
const ETAPA_FECHADA =
  "A etapa fechada foi iniciada para o item G2. Fornecedores convocados poderão enviar um lance único e fechado até " +
  "às 08:54:46 do dia 14/10/2026. Fornecedores convocados apresentaram os lances entre R$ 1.523.823,1300 e " +
  "R$ 2.736.000,0000 em conformidade com o art. 24 da IN SEGES 73/2022.";

Deno.test("CA-7a: convocação de anexos real vira convocacao_anexos com item, razão social, CNPJ e prazo", () => {
  assertEquals(detectarAlerta({ texto: CONVOCACAO, identificador_item: "G1" }), {
    tipo: "convocacao_anexos",
    identificador_item: "G1",
    fornecedor_razao_social: "JULIO CESAR GASPARINI JUNIOR LTDA",
    fornecedor_cnpj: "11222333000181",
    prazo: "2026-10-14T15:12:00.000Z", // 12:12 em Brasília (UTC−3)
  });
});

Deno.test("CA-7a: texto sem prazo legível fica com prazo null; mensagem comum não é alerta", () => {
  const semPrazo = CONVOCACAO.replace("Prazo para encerrar o envio: 12:12:00 do dia 14/10/2026.", "");
  assertEquals(detectarAlerta({ texto: semPrazo, identificador_item: "G1" })?.prazo, null);
  assertEquals(detectarAlerta({ texto: "Sessão suspensa para almoço, retorno às 14h.", identificador_item: null }), null);
  assertEquals(detectarAlerta({ texto: null, identificador_item: null }), null);
  // Fim da convocação (texto do sistema) não é convocação
  assertEquals(
    detectarAlerta({
      texto: "O item G2 teve a convocação para envio de anexos encerrada às 11:57:37 de 14/10/2026.",
      identificador_item: "G2",
    }),
    null,
  );
});

Deno.test("CA-7b: etapa fechada real vira etapa_fechada com item e prazo, sem fornecedor", () => {
  assertEquals(detectarAlerta({ texto: ETAPA_FECHADA, identificador_item: "G2" }), {
    tipo: "etapa_fechada",
    identificador_item: "G2",
    fornecedor_razao_social: null,
    fornecedor_cnpj: null,
    prazo: "2026-10-14T11:54:46.000Z",
  });
});

Deno.test("CA-7b: item vem do texto quando a mensagem não traz identificador_item", () => {
  assertEquals(detectarAlerta({ texto: ETAPA_FECHADA, identificador_item: null })?.identificador_item, "G2");
});

// --- geração (CA-7c) -----------------------------------------------------------------------------------------------

const AGORA = Date.parse("2026-10-14T13:30:00Z");

interface Banco {
  destinos: Array<{ tenant_id: number; cnpj: string | null; licitacao_id: number }>;
  alertas: Array<Record<string, unknown>>;
  rpcs: string[];
}

function mock(banco: Banco) {
  // deno-lint-ignore no-explicit-any
  const m: any = {
    schema: (s: string) => ({
      rpc: (nome: string, args: Record<string, unknown>) => {
        banco.rpcs.push(`${s}.${nome}:${JSON.stringify(args)}`);
        return Promise.resolve(
          nome === "sessao_alertas_destinos" ? { data: banco.destinos, error: null } : { data: null, error: new Error(nome) },
        );
      },
    }),
    from: (tabela: string) => ({
      // deno-lint-ignore no-explicit-any
      upsert: (rows: any[], opts: { onConflict: string; ignoreDuplicates: boolean }) => {
        assertEquals(tabela, "sessao_alertas");
        assertEquals(opts, { onConflict: "tenant_id,chave_mensagem", ignoreDuplicates: true });
        const novas = rows.filter((r) =>
          !banco.alertas.some((a) => a.tenant_id === r.tenant_id && a.chave_mensagem === r.chave_mensagem)
        );
        banco.alertas.push(...novas);
        return { select: () => Promise.resolve({ data: novas.map((r) => ({ id: banco.alertas.indexOf(r) + 1 })), error: null }) };
      },
    }),
  };
  return m;
}

const msg = (chave: string, texto: string, dataHora: string, item: string | null = "G1", remetente = "0") => ({
  chave_mensagem: chave,
  texto,
  identificador_item: item,
  tipo_remetente: remetente as string | null,
  data_hora: dataHora,
});

Deno.test("CA-7c: convocação recente gera um alerta por tenant, da_empresa só no dono do CNPJ, sem duplicar", async () => {
  const banco: Banco = {
    destinos: [
      { tenant_id: 1, cnpj: "11.222.333/0001-81", licitacao_id: 2430 },
      { tenant_id: 2, cnpj: "99888777000166", licitacao_id: 2430 },
    ],
    alertas: [],
    rpcs: [],
  };
  const mensagens = [
    msg("aaaaaaaa-0000-4000-8000-000000000001", CONVOCACAO, "2026-10-14T13:11:11.306Z"),
    msg("aaaaaaaa-0000-4000-8000-000000000002", "Bom dia a todos.", "2026-10-14T13:00:00Z", null),
  ];
  assertEquals(await gerarAlertas(mock(banco), [2430], mensagens, AGORA), 2);
  assertEquals(banco.rpcs, ['private.sessao_alertas_destinos:{"p_licitacao_ids":[2430]}']);
  const porTenant = Object.fromEntries(banco.alertas.map((a) => [a.tenant_id, a]));
  assertEquals(porTenant[1].da_empresa, true);
  assertEquals(porTenant[2].da_empresa, false);
  assertEquals(porTenant[1].licitacao_id, 2430);
  assertEquals(porTenant[1].tipo, "convocacao_anexos");
  assertEquals(porTenant[1].fornecedor_razao_social, "JULIO CESAR GASPARINI JUNIOR LTDA");
  assertEquals(porTenant[1].prazo, "2026-10-14T15:12:00.000Z");
  assertEquals(porTenant[1].mensagem_em, "2026-10-14T13:11:11.306Z");

  // de novo (a consulta seguinte relê o chat inteiro): não duplica
  assertEquals(await gerarAlertas(mock(banco), [2430], mensagens, AGORA), 0);
  assertEquals(banco.alertas.length, 2);
});

Deno.test("CA-7c: convocação com mais de 24 h é histórico e não chama o banco", async () => {
  const banco: Banco = { destinos: [{ tenant_id: 1, cnpj: null, licitacao_id: 2430 }], alertas: [], rpcs: [] };
  const antiga = msg("aaaaaaaa-0000-4000-8000-000000000003", CONVOCACAO, "2026-10-13T13:29:59Z");
  assertEquals(await gerarAlertas(mock(banco), [2430], [antiga], AGORA), 0);
  assertEquals(banco.rpcs, []);
  assertEquals(banco.alertas, []);
});

Deno.test("CA-7c: licitação fora de qualquer pipeline não grava nada", async () => {
  const banco: Banco = { destinos: [], alertas: [], rpcs: [] };
  const m = msg("aaaaaaaa-0000-4000-8000-000000000004", ETAPA_FECHADA, "2026-10-14T13:00:00Z", "G2");
  assertEquals(await gerarAlertas(mock(banco), [7], [m], AGORA), 0);
  assertEquals(banco.alertas, []);
});

Deno.test("CA-7c: sincronizarCompra gera o alerta a partir do chat lido (cron e rota manual)", async () => {
  const banco: Banco = { destinos: [{ tenant_id: 1, cnpj: null, licitacao_id: 2430 }], alertas: [], rpcs: [] };
  const mensagens: Array<Record<string, unknown>> = [];
  const base = mock(banco);
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    schema: (s: string) => ({
      rpc: base.schema(s).rpc,
      from: (_t: string) => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      }),
    }),
    from: (t: string) =>
      t === "sessao_alertas" ? base.from(t) : {
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => ({
          select: () => {
            mensagens.push(...rows);
            return Promise.resolve({ data: rows.map((r) => ({ chave_mensagem: r.chave_mensagem })), error: null });
          },
        }),
      },
  };
  const conv = {
    chaveCompra: null,
    identificadorItem: "G1",
    chaveMensagem: "aaaaaaaa-0000-4000-8000-000000000005",
    tipo: "mensagem",
    categoria: "8",
    tipoRemetente: "0",
    texto: CONVOCACAO,
    dataHora: "2026-10-14T13:11:11.306Z",
    dataHoraFonte: null,
  };
  const r = await sincronizarCompra(sb, { chaveCompra: "18017805000292026", licitacaoId: 2430, origem: "cron" }, {
    // deno-lint-ignore no-explicit-any
    consultarChat: () => Promise.resolve({ status: 200, mensagens: [conv as any] }),
    consultarDiligencias: () => Promise.resolve({ status: 404, mensagens: [] }),
    agora: () => AGORA,
  });
  assertEquals(r.ok, true);
  assertEquals(r.alertas_gerados, 1);
  assertEquals(banco.alertas.length, 1);
});

// --- regressões da revisão (08/11) ---------------------------------------------------------------------------------

Deno.test("CA-7c: texto de convocação escrito por licitante ou pregoeiro não vira alerta (só o Sistema)", async () => {
  const banco: Banco = { destinos: [{ tenant_id: 1, cnpj: "11222333000181", licitacao_id: 2430 }], alertas: [], rpcs: [] };
  const forjadas = [
    msg("bbbbbbbb-0000-4000-8000-000000000001", CONVOCACAO, "2026-10-14T13:20:00Z", "G1", "1"),
    msg("bbbbbbbb-0000-4000-8000-000000000002", ETAPA_FECHADA, "2026-10-14T13:20:00Z", "G2", "3"),
    { ...msg("bbbbbbbb-0000-4000-8000-000000000003", CONVOCACAO, "2026-10-14T13:20:00Z"), tipo_remetente: null },
  ];
  assertEquals(await gerarAlertas(mock(banco), [2430], forjadas, AGORA), 0);
  assertEquals(banco.rpcs, []);
});

Deno.test("CA-7c: janela de 24 h inclui a borda exata", async () => {
  const banco: Banco = { destinos: [{ tenant_id: 1, cnpj: null, licitacao_id: 2430 }], alertas: [], rpcs: [] };
  const borda = msg("bbbbbbbb-0000-4000-8000-000000000004", CONVOCACAO, new Date(AGORA - 24 * 3600_000).toISOString());
  assertEquals(await gerarAlertas(mock(banco), [2430], [borda], AGORA), 1);
});

Deno.test("CA-7c: mesma compra em duas licitações: cada tenant recebe o alerta na licitação do pipeline dele", async () => {
  const banco: Banco = {
    destinos: [{ tenant_id: 1, cnpj: null, licitacao_id: 100 }, { tenant_id: 2, cnpj: null, licitacao_id: 200 }],
    alertas: [],
    rpcs: [],
  };
  const m = msg("bbbbbbbb-0000-4000-8000-000000000005", CONVOCACAO, "2026-10-14T13:11:11Z");
  assertEquals(await gerarAlertas(mock(banco), [100, 200], [m], AGORA), 2);
  assertEquals(banco.rpcs, ['private.sessao_alertas_destinos:{"p_licitacao_ids":[100,200]}']);
  assertEquals(banco.alertas.map((a) => [a.tenant_id, a.licitacao_id]), [[1, 100], [2, 200]]);
});

Deno.test("CA-7a: variações do cabeçalho: Sr(a)., sem acento, convocada, CNPJ sem máscara e alfanumérico", () => {
  const base = (cab: string) => cab + " para o item 3. Prazo para encerrar o envio: 12:12:00 do dia 14/10/2026.";
  const a = detectarAlerta({
    texto: base("Sr(a). Fornecedor ACADEMIA XPTO LTDA, CNPJ 11222333000181, voce foi convocada para enviar anexos"),
    identificador_item: null,
  });
  assertEquals(
    [a?.tipo, a?.identificador_item, a?.fornecedor_razao_social, a?.fornecedor_cnpj],
    ["convocacao_anexos", "3", "ACADEMIA XPTO LTDA", "11222333000181"],
  );
  const alfa = detectarAlerta({
    texto: base("Sr. Fornecedor NOVA LTDA, CNPJ 12.ABC.345/01DE-35, você foi convocado para enviar anexos"),
    identificador_item: null,
  });
  assertEquals([alfa?.fornecedor_razao_social, alfa?.fornecedor_cnpj], ["NOVA LTDA", "12ABC34501DE35"]);
});

Deno.test("CA-7a: convocado por CPF vira alerta sem nome nem documento (dado pessoal não é guardado)", () => {
  const a = detectarAlerta({
    texto: "Sr. Fornecedor FULANO DE TAL, CPF 123.456.789-09, você foi convocado para enviar anexos para o item 1. " +
      "Prazo para encerrar o envio: 10:00:00 do dia 14/10/2026.",
    identificador_item: null,
  });
  assertEquals(a, {
    tipo: "convocacao_anexos",
    identificador_item: "1",
    fornecedor_razao_social: null,
    fornecedor_cnpj: null,
    prazo: "2026-10-14T13:00:00.000Z",
  });
});

Deno.test("CA-7a: cabeçalho desconhecido ainda vira convocação, sem fornecedor", () => {
  const a = detectarAlerta({
    texto: "Atenção: o licitante foi convocado para enviar anexos para o item G4. Prazo para encerrar o envio: " +
      "16:00 do dia 15/10/2026.",
    identificador_item: null,
  });
  assertEquals(a, {
    tipo: "convocacao_anexos",
    identificador_item: "G4",
    fornecedor_razao_social: null,
    fornecedor_cnpj: null,
    prazo: "2026-10-15T19:00:00.000Z",
  });
});

Deno.test("CA-7a: prazo vira o dia e o ano em UTC; data e hora impossíveis ficam null", () => {
  const p = (h: string, d: string) =>
    detectarAlerta({
      texto: "A etapa fechada foi iniciada para o item 1. Fornecedores convocados poderão enviar um lance único e " +
        `fechado até às ${h} do dia ${d}.`,
      identificador_item: null,
    })?.prazo;
  assertEquals(p("22:30:00", "14/10/2026"), "2026-10-15T01:30:00.000Z");
  assertEquals(p("23:59:00", "31/12/2026"), "2027-01-01T02:59:00.000Z");
  assertEquals(p("10:00:00", "31/02/2026"), null);
  assertEquals(p("25:00:00", "14/10/2026"), null);
});

Deno.test("CA-7c: falha ao gerar alerta não derruba a consulta: mensagens gravadas, run com aviso, alertas null", async () => {
  const runs: Array<Record<string, unknown>> = [];
  const mensagens: Array<Record<string, unknown>> = [];
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    schema: (_s: string) => ({
      rpc: () => Promise.resolve({ data: null, error: new Error("banco fora") }),
      from: (_t: string) => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }) }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => {
            runs.push(patch);
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    }),
    from: (_t: string) => ({
      // deno-lint-ignore no-explicit-any
      upsert: (rows: any[]) => ({
        select: () => {
          mensagens.push(...rows);
          return Promise.resolve({ data: rows.map((r) => ({ chave_mensagem: r.chave_mensagem })), error: null });
        },
      }),
    }),
  };
  const conv = {
    chaveCompra: null,
    identificadorItem: "G1",
    chaveMensagem: "bbbbbbbb-0000-4000-8000-000000000006",
    tipo: "mensagem",
    categoria: "8",
    tipoRemetente: "0",
    texto: CONVOCACAO,
    dataHora: "2026-10-14T13:11:11.306Z",
    dataHoraFonte: null,
  };
  const r = await sincronizarCompra(sb, { chaveCompra: "18017805000292026", licitacaoId: 2430, origem: "cron" }, {
    // deno-lint-ignore no-explicit-any
    consultarChat: () => Promise.resolve({ status: 200, mensagens: [conv as any] }),
    consultarDiligencias: () => Promise.resolve({ status: 404, mensagens: [] }),
    agora: () => AGORA,
  });
  assertEquals(r.ok, true);
  assertEquals(r.alertas_gerados, null);
  assertEquals(r.novas_inseridas, 1);
  assertEquals(mensagens.length, 1);
  const fechamento = runs.at(-1)!;
  assertEquals(typeof fechamento.terminado_em, "string");
  assertEquals(fechamento.chamadas, { "200": 1, "404": 1 });
  assertEquals(String(fechamento.erro).includes("alertas"), true);
});

import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import {
  persistirLoteAtomico,
  PcaPersistenciaError,
  type UnidadePcaAtomica,
} from "../../../supabase/functions/_shared/pncp/pca-atomico.ts";

const RUN = "86fe5252-0ef0-44d6-a375-7c4e78f4a0b0";

function unidades(n: number): UnidadePcaAtomica[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `plano-${i + 1}`;
    return {
      tabela: "pca_planos",
      chave: { id_pca_pncp: id },
      linha: {
        id_pca_pncp: id,
        ano_exercicio: 2026,
        payload_hash: `hash-${i + 1}`,
      },
    };
  });
}

function resposta(n: number, resultado = "novo") {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    resultado,
  }));
}

Deno.test("TX02-A: chama RPC no schema private com argumentos corretos", async () => {
  const db = new FakePostgrest();
  const entrada = unidades(2);

  db.rpcs.pca_persistir_lote_atomico = (args) => {
    assertEquals(args.p_sync_run_id, RUN);
    assertEquals(args.p_unidades, entrada);
    return resposta(2);
  };

  const resultado = await persistirLoteAtomico(
    db as never,
    entrada,
    RUN,
  );

  assertEquals(resultado, resposta(2));
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 1);
});

Deno.test("TX02-A: divide 101 unidades em dois lotes", async () => {
  const db = new FakePostgrest();
  const tamanhos: number[] = [];

  db.rpcs.pca_persistir_lote_atomico = (args) => {
    const bloco = args.p_unidades as UnidadePcaAtomica[];
    tamanhos.push(bloco.length);
    return resposta(bloco.length);
  };

  const resultado = await persistirLoteAtomico(
    db as never,
    unidades(101),
    RUN,
  );

  assertEquals(tamanhos, [100, 1]);
  assertEquals(resultado.length, 101);
});

Deno.test("TX02-A: aceita novo, alterado e inalterado", async () => {
  const db = new FakePostgrest();

  const esperado = resposta(3);
  esperado[1].resultado = "alterado";
  esperado[2].resultado = "inalterado";

  db.rpcs.pca_persistir_lote_atomico = () => esperado;

  const resultado = await persistirLoteAtomico(
    db as never,
    unidades(3),
    RUN,
  );

  assertEquals(resultado, esperado);
});

Deno.test("TX02-A: erro da RPC interrompe sem fallback", async () => {
  const db = new FakePostgrest();

  db.rpcs.pca_persistir_lote_atomico = () => {
    throw new Error("falha de histórico");
  };

  await assertRejects(
    () => persistirLoteAtomico(db as never, unidades(2), RUN),
    Error,
    "falha de histórico",
  );

  assertEquals(db.chamadas, 1);
  assertEquals(db.rows("pca_planos").length, 0);
  assertEquals(db.rows("pca_alteracoes").length, 0);
});

Deno.test("TX02-A: rejeita resposta incompleta", async () => {
  const db = new FakePostgrest();

  db.rpcs.pca_persistir_lote_atomico = () => resposta(1);

  await assertRejects(
    () => persistirLoteAtomico(db as never, unidades(2), RUN),
    Error,
    "resposta inválida",
  );
});

Deno.test("TX02-A: rejeita classificação desconhecida", async () => {
  const db = new FakePostgrest();

  db.rpcs.pca_persistir_lote_atomico = () => [{
    id: "00000000-0000-4000-8000-000000000001",
    resultado: "desconhecido",
  }];

  await assertRejects(
    () => persistirLoteAtomico(db as never, unidades(1), RUN),
    Error,
    "classificação inválida",
  );
});

Deno.test("TX02-A: rejeita runId inválido sem chamar RPC", async () => {
  const db = new FakePostgrest();

  await assertRejects(
    () => persistirLoteAtomico(db as never, unidades(1), "red-01"),
    Error,
    "UUID válido",
  );

  assertEquals(db.chamadas, 0);
});

Deno.test("TX02-A: unidade 101 invalida impede todas as chamadas RPC", async () => {
  let chamadas = 0;

  const client = {
    schema(nome: string) {
      if (nome !== "private") throw new Error("Schema incorreto");
      return {
        rpc: async () => {
          chamadas++;
          return {
            data: Array.from({ length: 100 }, (_, i) => ({
              id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
              resultado: "novo",
            })),
            error: null,
          };
        },
      };
    },
  };

  const unidades = Array.from({ length: 101 }, (_, i) => ({
    tabela: "pca_planos" as const,
    chave: { id_pca_pncp: `PCA-${i}` },
    linha: {
      id_pca_pncp: `PCA-${i}`,
      payload_hash: `hash-${i}`,
    },
  }));

  unidades[100].linha.payload_hash = "";

  let rejeitou = false;

  try {
    await persistirLoteAtomico(
      client as never,
      unidades,
      "00000000-0000-4000-8000-000000000101",
    );
  } catch (erro) {
    rejeitou = true;
    if (!(erro instanceof Error) ||
        !erro.message.includes("unidade inválida no índice 100")) {
      throw erro;
    }
  }

  assertEquals(rejeitou, true);
  assertEquals(chamadas, 0);
});

Deno.test("TX02-A: falha RPC preserva codigo e causa para classificar retomada", async () => {
  for (const [code, recuperavel] of [
    [undefined, true], ["08006", true], ["53000", true], ["55P03", true],
    ["40P01", true], ["57014", true], ["40001", false],
    ["42501", false], ["23514", false], ["PGRST202", false],
  ] as const) {
    const causa = { message: "falha sintetica", code };
    const client = { schema: () => ({ rpc: () => Promise.resolve({ data: null, error: causa }) }) };
    const erro = await assertRejects(
      () => persistirLoteAtomico(client as never, unidades(1), RUN),
      PcaPersistenciaError,
    );
    assertEquals(erro.code, code);
    assertEquals(erro.cause, causa);
    assertEquals(erro.recuperavel, recuperavel);
  }
});

import { assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";

type Row = Record<string, unknown>;

const RUN = "00000000-0000-4000-8000-000000000101";

Deno.test("TX02-A: planos e itens utilizam a RPC atomica", async () => {
  const db = new FakePostgrest();
  const chamadas: Row[][] = [];
  let sequencia = 0;

  db.rpcs["pca_persistir_lote_atomico"] = (args) => {
    const unidades = args.p_unidades as Row[];
    chamadas.push(structuredClone(unidades));

    return unidades.map(() => {
      sequencia++;
      return {
        id: `00000000-0000-4000-8000-${String(sequencia).padStart(12, "0")}`,
        resultado: "novo",
      };
    });
  };

  const pagina: Row[] = [{
    idPcaPncp: "12345678000190-0-000001/2026",
    anoPca: 2026,
    orgaoEntidadeCnpj: "12345678000190",
    orgaoEntidadeRazaoSocial: "Orgao de teste",
    codigoUnidade: "123456",
    nomeUnidade: "Unidade de teste",
    dataPublicacaoPNCP: "2026-01-10T10:00:00",
    dataAtualizacaoGlobalPCA: "2026-01-11T10:00:00",
    itens: [{
      numeroItem: 1,
      descricaoItem: "Equipamento de treinamento",
      categoriaItemPcaNome: "Material",
      classificacaoCatalogoId: 1,
      classificacaoSuperiorCodigo: "7830",
      quantidadeEstimada: 1,
      unidadeFornecimento: "UN",
      valorUnitario: 100,
      valorTotal: 100,
    }],
  }];

  const stats = await gravarPaginaPcaEmLote(
    db as never,
    pagina,
    { ano: 2026, runId: RUN },
  );

  assertEquals(chamadas.length, 2);
  assertEquals(chamadas[0][0].tabela, "pca_planos");
  assertEquals(chamadas[1][0].tabela, "pca_itens");

  const chaveItem = chamadas[1][0].chave as Row;
  assertEquals(
    chaveItem.pca_plano_id,
    "00000000-0000-4000-8000-000000000001",
  );

  assertEquals(stats.novos, 2);
  assertEquals(stats.erros, 0);

  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 2);
  assertEquals(db.porOperacao["pca_planos.insert"] ?? 0, 0);
  assertEquals(db.porOperacao["pca_itens.insert"] ?? 0, 0);
  assertEquals(db.porOperacao["pca_alteracoes.insert"] ?? 0, 0);
});
Deno.test("TX02-A: falha da RPC interrompe sem fallback", async () => {
  const db = new FakePostgrest();

  db.rpcs["pca_persistir_lote_atomico"] = () => {
    throw new Error("falha simulada no historico");
  };

  const pagina: Row[] = [{
    idPcaPncp: "12345678000190-0-000002/2026",
    anoPca: 2026,
    orgaoEntidadeCnpj: "12345678000190",
    codigoUnidade: "123456",
    itens: [{
      numeroItem: 1,
      descricaoItem: "Equipamento",
      quantidadeEstimada: 1,
    }],
  }];

  let rejeitou = false;

  try {
    await gravarPaginaPcaEmLote(
      db as never,
      pagina,
      { ano: 2026, runId: RUN },
    );
  } catch (erro) {
    rejeitou = true;
    if (!(erro instanceof Error) ||
        !erro.message.includes("falha simulada no historico")) {
      throw erro;
    }
  }

  assertEquals(rejeitou, true);
  assertEquals(db.porOperacao["pca_persistir_lote_atomico.rpc"], 1);
  assertEquals(db.porOperacao["pca_planos.insert"] ?? 0, 0);
  assertEquals(db.porOperacao["pca_planos.upsert"] ?? 0, 0);
  assertEquals(db.porOperacao["pca_itens.insert"] ?? 0, 0);
  assertEquals(db.porOperacao["pca_alteracoes.insert"] ?? 0, 0);
});
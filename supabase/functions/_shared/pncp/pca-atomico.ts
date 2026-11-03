import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type UnidadePcaAtomica = {
  tabela: "pca_planos" | "pca_itens";
  chave: Record<string, unknown>;
  linha: Record<string, unknown>;
};

export type ResultadoPcaAtomico = {
  id: string;
  resultado: "novo" | "alterado" | "inalterado";
};


/** Falha devolvida pela RPC; erros de validacao/protocolo nao usam esta classe. */
export class PcaPersistenciaError extends Error {
  readonly code?: string;
  constructor(inicio: number, error: { message: string; code?: string }) {
    super("RPC PCA: falha no lote iniciado em " + inicio + ": " + error.message, { cause: error });
    this.name = "PcaPersistenciaError";
    this.code = error.code;
  }
  get recuperavel(): boolean {
    // Ausencia de SQLSTATE inclui falhas de transporte; codigos de posse/permissao
    // e validacao nunca sao promovidos a sucesso ou retry silencioso.
    return !this.code || this.code.startsWith("08") || this.code.startsWith("53") ||
      ["55P03", "40P01", "57014"].includes(this.code);
  }
}

const LIMITE_LOTE = 100;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validarResultado(
  valor: unknown,
  indice: number,
): ResultadoPcaAtomico {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) {
    throw new Error(`RPC PCA: resultado ${indice} inválido`);
  }

  const registro = valor as Record<string, unknown>;

  if (
    typeof registro.id !== "string" ||
    !UUID_RE.test(registro.id)
  ) {
    throw new Error(`RPC PCA: ID inválido no resultado ${indice}`);
  }

  if (
    registro.resultado !== "novo" &&
    registro.resultado !== "alterado" &&
    registro.resultado !== "inalterado"
  ) {
    throw new Error(
      `RPC PCA: classificação inválida no resultado ${indice}`,
    );
  }

  return {
    id: registro.id,
    resultado: registro.resultado,
  };
}

/**
 * Persiste unidades PCA por meio da RPC PostgreSQL.
 *
 * Pré-condições:
 * - Linhas normalizadas e com payload_hash calculado em TypeScript.
 * - runId é UUID de uma execução PCA ativa.
 * - Cliente autenticado como service_role.
 * - Header x-pca-run-id corresponde ao runId.
 * - Schema private exposto ao PostgREST.
 *
 * Garantias:
 * - Até 100 unidades por transação.
 * - Erros da RPC são propagados.
 * - Não existe fallback para escrita não atômica.
 *
 * Atenção:
 * - Múltiplos lotes não formam uma transação única.
 * - Falha em lote posterior não reverte lotes anteriores.
 */
export async function persistirLoteAtomico(
  client: SupabaseClient,
  unidades: UnidadePcaAtomica[],
  runId: string,
): Promise<ResultadoPcaAtomico[]> {
  if (!UUID_RE.test(runId)) {
    throw new Error("RPC PCA: runId deve ser um UUID válido");
  }

  if (!Array.isArray(unidades)) {
    throw new Error("RPC PCA: unidades devem ser um array");
  }

  if (unidades.length === 0) return [];

  // Validar todas as unidades antes de iniciar qualquer transação RPC.
  for (const [indice, unidade] of unidades.entries()) {
    if (
      !unidade ||
      !["pca_planos", "pca_itens"].includes(unidade.tabela) ||
      !unidade.chave ||
      typeof unidade.chave !== "object" ||
      Array.isArray(unidade.chave) ||
      !unidade.linha ||
      typeof unidade.linha !== "object" ||
      Array.isArray(unidade.linha) ||
      typeof unidade.linha.payload_hash !== "string" ||
      unidade.linha.payload_hash.length === 0
    ) {
      throw new Error(
        `RPC PCA: unidade inválida no índice ${indice}`,
      );
    }
  }

  const resultados: ResultadoPcaAtomico[] = [];

  for (let inicio = 0; inicio < unidades.length; inicio += LIMITE_LOTE) {
    const bloco = unidades.slice(inicio, inicio + LIMITE_LOTE);
    const { data, error } = await client
      .schema("private")
      .rpc("pca_persistir_lote_atomico", {
        p_unidades: bloco,
        p_sync_run_id: runId,
      });

    if (error) {
      throw new PcaPersistenciaError(inicio, error);
    }

    if (!Array.isArray(data) || data.length !== bloco.length) {
      throw new Error(
        `RPC PCA: resposta inválida no lote iniciado em ${inicio}`,
      );
    }

    const validados = data.map((valor, indice) =>
      validarResultado(valor, inicio + indice)
    );

    resultados.push(...validados);
  }

  return resultados;
}

// Simulador opt-in da RPC PCA: nao reproduz Auth/RLS, headers, triggers ou concorrencia.
// Esses contratos sao verificados nos checks PostgreSQL separados.
import { createHash } from "node:crypto";
import { CHAVES_UNICAS, FakePostgrest } from "./_fake_postgrest.ts";
import { listasPermitidasPca } from "./_allowlist_pca.ts";
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idPca(tabela: string, row: Row): string {
  const key = (CHAVES_UNICAS[tabela] ?? []).map((campo) => row[campo]);
  const h = createHash("sha256").update(JSON.stringify([tabela, key])).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) +
    "-8" + h.slice(17, 20) + "-" + h.slice(20, 32);
}

export class FakePcaPostgrest extends FakePostgrest {
  constructor(inicial: Record<string, Row[]> = {}) {
    super(inicial);
    this.rpcs.pca_persistir_lote_atomico = (args) => this.persistir(args);
  }

  override clone(): FakePcaPostgrest {
    const copy = new FakePcaPostgrest();
    for (const [table, rows] of this.tables) copy.tables.set(table, structuredClone(rows));
    return copy;
  }

  // Mantem IDs UUID estaveis tambem no caminho de referencia item a item.
  // A classe base e os demais simuladores nao sao alterados.
  override executar(query: Parameters<FakePostgrest["executar"]>[0]) {
    if (query.op === "insert" && ["pca_planos", "pca_itens"].includes(query.table)) {
      query.payload = (query.payload as Row[]).map((row) => ({
        ...row, id: row.id ?? idPca(query.table, row),
      }));
    }
    return super.executar(query);
  }

  private persistir(args: Row) {
    if (typeof args.p_sync_run_id !== "string" || !UUID.test(args.p_sync_run_id)) {
      throw new Error("runId deve ser UUID");
    }
    const unidades = args.p_unidades;
    if (!Array.isArray(unidades) || unidades.length < 1 || unidades.length > 100) {
      throw new Error("Lote PCA deve conter entre 1 e 100 unidades");
    }
    const snapshot = new Map([...this.tables].map(([t, rows]) => [t, structuredClone(rows)]));
    // O cliente fez uma unica chamada RPC. SQL interno nao conta como HTTP adicional.
    const chamadas = this.chamadas;
    const operacoes = { ...this.porOperacao };
    try {
      return unidades.map((entrada: unknown) => {
        if (!entrada || typeof entrada !== "object") throw new Error("Unidade PCA invalida");
        const { tabela, chave, linha } = entrada as Row;
        if (tabela !== "pca_planos" && tabela !== "pca_itens") throw new Error("Tabela PCA invalida");
        if (!chave || typeof chave !== "object" || Array.isArray(chave) ||
          !linha || typeof linha !== "object" || Array.isArray(linha)) {
          throw new Error("Chave ou linha PCA invalida");
        }
        const key = chave as Row;
        const row = linha as Row;
        const campos = CHAVES_UNICAS[tabela];
        if (Object.keys(key).length !== campos.length ||
          !campos.every((c) => key[c] != null && key[c] === row[c])) {
          throw new Error("Chave PCA inconsistente");
        }
        if (typeof row.payload_hash !== "string" || !row.payload_hash) throw new Error("payload_hash obrigatorio");
        if (["id", "created_at", "ativo", "descoberta_ausente", "reprocessar"].some((c) => c in row)) {
          throw new Error("Campo PCA protegido");
        }
        // Mesma lista da função em produção, lida da última migration que a define (incidente de 12/11/2026).
        const permitidos = listasPermitidasPca()[tabela];
        if (Object.keys(row).some((c) => !permitidos.has(c))) {
          throw new Error("Campo PCA fora da lista permitida");
        }

        let query = this.from(tabela).select("*");
        for (const campo of campos) query = query.eq(campo, key[campo]);
        query.modo = "maybeSingle";
        const leitura = this.executar(query);
        if (leitura.error) throw new Error(leitura.error.message);
        const anterior = leitura.data as Row | null;
        const reativacao = anterior?.ativo === false;
        const mudou = anterior?.payload_hash !== row.payload_hash;
        const id = anterior ? String(anterior.id) : idPca(tabela, row);
        const agora = new Date().toISOString();
        const sync = { last_synced_at: agora, last_seen_sync_id: args.p_sync_run_id };
        const escrita = anterior
          ? this.executar(this.from(tabela).update({
            ...(mudou ? { ...row, updated_at: agora } : {}), ...sync, ativo: true,
          }).eq("id", id))
          : this.executar(this.from(tabela).insert({
            ...row, ...sync, id, ativo: true, created_at: agora, updated_at: agora,
          }));
        if (escrita.error) throw new Error(escrita.error.message);
        const resultado = !anterior ? "novo" : mudou || reativacao ? "alterado" : "inalterado";
        if (resultado !== "inalterado") {
          const novo = structuredClone(this.rows(tabela).find((r) => r.id === id)!);
          const historico = this.executar(this.from("pca_alteracoes").insert({
            pca_plano_id: tabela === "pca_planos" ? id : key.pca_plano_id,
            ...(tabela === "pca_itens" ? { pca_item_id: id } : {}),
            tipo_operacao: !anterior ? "insert" : reativacao ? "reativacao" : "update",
            dados_anteriores: anterior,
            dados_novos: novo,
            payload_hash_anterior: anterior?.payload_hash ?? null,
            payload_hash_novo: row.payload_hash,
            sync_run_id: args.p_sync_run_id,
          }));
          if (historico.error) throw new Error(historico.error.message);
        }
        return { id, resultado };
      });
    } catch (error) {
      this.tables.clear();
      for (const [t, rows] of snapshot) this.tables.set(t, rows);
      throw error;
    } finally {
      this.chamadas = chamadas;
      this.porOperacao = operacoes;
    }
  }
}

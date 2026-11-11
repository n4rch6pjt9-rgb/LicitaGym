// Spec 0056 (K-4): espelho, para os testes Deno, da classificação de eventos que a migration faz no banco
// (trigger `private.pca_alteracoes_classificar_evento` em `public.pca_alteracoes`). A função real é provada em
// `supabase/tests/pca_impressao_plano_check.sql`; aqui o fake só reproduz a mesma regra para os testes da carga.
import type { FakePostgrest } from "./_fake_postgrest.ts";

type Row = Record<string, unknown>;

/** Colunas que não são mudança de negócio: metadado de sync, chave, situação e campos só de rastreio. */
export const CAMPOS_FORA_DO_EVENTO = new Set([
  "id",
  "pca_plano_id",
  "numero_item",
  "payload_hash",
  "last_synced_at",
  "last_seen_sync_id",
  "created_at",
  "updated_at",
  "ativo",
  "reprocessar",
  "descoberta_ausente",
  "data_atualizacao_origem",
  "grupo_contratacao_codigo",
  "grupo_contratacao_nome",
]);

function camposAlterados(ant: Row, nov: Row): string[] {
  const chaves = new Set([...Object.keys(ant), ...Object.keys(nov)]);
  return [...chaves]
    .filter((k) => !CAMPOS_FORA_DO_EVENTO.has(k))
    .filter((k) => JSON.stringify(ant[k] ?? null) !== JSON.stringify(nov[k] ?? null))
    .sort();
}

/** Mesma regra do trigger: devolve evento, campos_alterados e data_fonte da linha de `pca_alteracoes`. */
export function classificarEvento(alt: Row): Row {
  if (alt.evento != null) return alt;
  const ant = (alt.dados_anteriores ?? {}) as Row;
  const nov = (alt.dados_novos ?? {}) as Row;
  const item = alt.pca_item_id != null;
  const tipo = String(alt.tipo_operacao);
  const classeMudou = item && alt.dados_anteriores != null &&
    (ant.classe_material_servico ?? null) !== (nov.classe_material_servico ?? null);
  const campos = tipo === "update" || tipo === "reativacao" ? camposAlterados(ant, nov) : [];
  let evento: string | null;
  if (!item) {
    evento = tipo === "insert"
      ? "pca_novo"
      : tipo === "inativacao"
      ? "pca_removido"
      : campos.length
      ? "pca_atualizado"
      : null;
  } else if (tipo === "insert") evento = "item_detectado";
  else if (tipo === "inativacao") evento = classeMudou ? "saiu_escopo" : "item_removido";
  else if (classeMudou) evento = "entrou_escopo";
  else if (tipo === "reativacao") evento = "item_detectado";
  else evento = campos.length ? "item_atualizado" : null;
  return {
    ...alt,
    evento,
    campos_alterados: evento === "item_atualizado" || evento === "pca_atualizado" ? campos : null,
    data_fonte: nov.data_atualizacao_origem ?? ant.data_atualizacao_origem ?? null,
    detectado_em: new Date().toISOString(),
  };
}

const CHAVE: Record<string, string[]> = {
  pca_planos: ["id_pca_pncp"],
  pca_itens: ["pca_plano_id", "numero_item"],
};

/**
 * Liga no fake o que o banco faz ao gravar: a RPC de persistência escreve uma linha por unidade nova ou alterada
 * (insert/update/reativacao) e o trigger de inativação escreve a linha `inativacao`. Cada linha passa pela
 * classificação. Chamar depois de montar `db.rpcs.pca_persistir_lote_atomico`.
 */
export function instalarEventosPca(db: FakePostgrest) {
  const registrar = (tabela: string, tipo: string, antes: Row | null, depois: Row) => {
    db.rows("pca_alteracoes").push(classificarEvento({
      pca_plano_id: tabela === "pca_planos" ? depois.id : depois.pca_plano_id,
      pca_item_id: tabela === "pca_itens" ? depois.id : null,
      tipo_operacao: tipo,
      dados_anteriores: antes,
      dados_novos: structuredClone(depois),
    }));
  };
  const persistir = db.rpcs.pca_persistir_lote_atomico;
  db.rpcs.pca_persistir_lote_atomico = (args, d) => {
    const unidades = args.p_unidades as Array<{ tabela: string; chave: Row }>;
    const antes = unidades.map((u) => {
      const r = d.rows(u.tabela).find((x) => CHAVE[u.tabela].every((c) => String(x[c]) === String(u.chave[c])));
      return r ? structuredClone(r) : null;
    });
    const res = persistir(args, d) as Array<{ id: string; resultado: string }>;
    res.forEach((r, i) => {
      if (r.resultado === "inalterado") return;
      const tabela = unidades[i].tabela;
      const depois = d.rows(tabela).find((x) => x.id === r.id)!;
      const ant = antes[i];
      registrar(tabela, !ant ? "insert" : ant.ativo === false ? "reativacao" : "update", ant, depois);
    });
    return res;
  };
  db.aposUpdate = (tabela, antes, depois) => {
    if ((tabela === "pca_itens" || tabela === "pca_planos") && antes.ativo !== false && depois.ativo === false) {
      registrar(tabela, "inativacao", antes, depois);
    }
  };
}

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { upsertByNaturalKey } from "../_shared/compras-gov/upsert-natural.ts";
import type { CatmatPalavra, CatmatRegra, NivelRegra, TipoPalavra } from "./types.ts";

/** Linha nova ou alterada de regra (chave, id e datas são do banco). */
export interface RegraInput {
  nivel: NivelRegra;
  codigo_grupo: number;
  codigo_classe: number | null;
  codigo_pdm: number | null;
  codigo_item: number | null;
  nome_snapshot: string;
  ancestrais_snapshot: Record<string, unknown>;
  incluido: boolean;
  observacao: string | null;
}

export interface ItemPdmInput {
  codigo_item: number;
  codigo_pdm: number;
  codigo_classe: number;
  codigo_grupo: number;
  descricao: string | null;
  status_item: boolean | null;
}

export interface CacheLinha {
  payload: unknown;
  total: number | null;
  expira_em: string;
}

export interface Nome {
  codigo: number;
  nome: string;
  codigo_pai: number | null;
}

/**
 * Acesso a dados da api-catmat. Mantém a regra de negócio (catalog.ts) testável sem o cliente Supabase.
 */
export interface CatmatRepo {
  listarRegras(): Promise<CatmatRegra[]>;
  obterRegraPorChave(chave: string): Promise<CatmatRegra | null>;
  obterRegra(id: number): Promise<CatmatRegra | null>;
  inserirRegra(row: RegraInput, userId: string): Promise<CatmatRegra>;
  atualizarRegra(id: number, row: RegraInput, userId: string): Promise<CatmatRegra>;
  removerRegra(id: number): Promise<boolean>;

  upsertGrupo(row: { codigo_grupo: number; nome: string; status: boolean }): Promise<void>;
  upsertClasse(row: { codigo_grupo: number; codigo_classe: number; nome: string; status: boolean }): Promise<void>;
  upsertPdm(row: { codigo_pdm: number; codigo_grupo: number; codigo_classe: number; nome_pdm: string; status: boolean }): Promise<void>;
  upsertItensPdm(rows: ItemPdmInput[]): Promise<void>;
  pdmExiste(codigoPdm: number): Promise<boolean>;

  pdmsEfetivos(): Promise<Array<{ codigo_pdm: number; codigo_classe: number; codigo_grupo: number; origem_nivel: string; regra_id: number }>>;
  nomesGrupos(codigos: number[]): Promise<Nome[]>;
  nomesClasses(codigos: number[]): Promise<Nome[]>;
  nomesPdms(codigos: number[]): Promise<Nome[]>;
  itensDosPdms(codigosPdm: number[], limite: number): Promise<Array<{ codigo_item: number; codigo_pdm: number; descricao: string | null }>>;

  cacheLer(chave: string): Promise<CacheLinha | null>;
  cacheGravar(chave: string, payload: unknown, total: number, expiraEm: Date): Promise<void>;

  /** Inclusões (catmat_pdm_palavras) e exclusões (catmat_pdm_exclusoes) do PDM, com `tipo`. */
  listarPalavras(codigoPdm: number): Promise<CatmatPalavra[]>;
  /** Só inclusões ativas: exclusão não é cobertura de texto. */
  contarPalavrasPorPdm(codigosPdm: number[]): Promise<Map<number, number>>;
  /** Nós do dicionário de aparelhos que apontam para o PDM (casamento por taxonomia). */
  nosTaxonomiaDoPdm(codigoPdm: number): Promise<string[]>;
  contarNosTaxonomiaPorPdm(codigosPdm: number[]): Promise<Map<number, number>>;
  obterPalavra(id: number, tipo: TipoPalavra): Promise<CatmatPalavra | null>;
  inserirPalavra(codigoPdm: number, padrao: string, ativo: boolean, tipo: TipoPalavra, userId: string): Promise<CatmatPalavra>;
  atualizarPalavra(id: number, tipo: TipoPalavra, padrao: string, ativo: boolean, userId: string): Promise<CatmatPalavra>;
  removerPalavra(id: number, tipo: TipoPalavra): Promise<boolean>;
  regexValido(padrao: string): Promise<boolean>;
}

const REGRA_COLS =
  "id,nivel,codigo_grupo,codigo_classe,codigo_pdm,codigo_item,nome_snapshot,ancestrais_snapshot,incluido,observacao,chave,created_by,updated_by,created_at,updated_at";

/** Tabela de cada tipo de padrão (ids independentes). */
const TABELA_PALAVRA: Record<TipoPalavra, string> = { inclui: "catmat_pdm_palavras", exclui: "catmat_pdm_exclusoes" };
const PALAVRA_COLS = "id,codigo_pdm,padrao,ativo";

function comTipo(linhas: unknown, tipo: TipoPalavra): CatmatPalavra[] {
  return ((linhas ?? []) as Omit<CatmatPalavra, "tipo">[]).map((l) => ({ ...l, tipo }));
}

function falha(contexto: string, error: unknown): never {
  const msg = (error as { message?: string })?.message ?? String(error);
  throw new Error(`[api-catmat] ${contexto}: ${msg}`);
}

export function createSupabaseRepo(client: SupabaseClient): CatmatRepo {
  return {
    async listarRegras() {
      const { data, error } = await client.from("catalogo_empresa_catmat").select(REGRA_COLS).order("chave");
      if (error) falha("listar regras", error);
      return (data ?? []) as CatmatRegra[];
    },
    async obterRegraPorChave(chave) {
      const { data, error } = await client.from("catalogo_empresa_catmat").select(REGRA_COLS).eq("chave", chave).maybeSingle();
      if (error) falha("obter regra", error);
      return (data ?? null) as CatmatRegra | null;
    },
    async obterRegra(id) {
      const { data, error } = await client.from("catalogo_empresa_catmat").select(REGRA_COLS).eq("id", id).maybeSingle();
      if (error) falha("obter regra", error);
      return (data ?? null) as CatmatRegra | null;
    },
    async inserirRegra(row, userId) {
      const { data, error } = await client.from("catalogo_empresa_catmat")
        .insert({ ...row, created_by: userId, updated_by: userId })
        .select(REGRA_COLS).single();
      if (error) falha("inserir regra", error);
      return data as CatmatRegra;
    },
    async atualizarRegra(id, row, userId) {
      const { data, error } = await client.from("catalogo_empresa_catmat")
        .update({ ...row, updated_by: userId, updated_at: new Date().toISOString() })
        .eq("id", id).select(REGRA_COLS).single();
      if (error) falha("atualizar regra", error);
      return data as CatmatRegra;
    },
    async removerRegra(id) {
      const { data, error } = await client.from("catalogo_empresa_catmat").delete().eq("id", id).select("id");
      if (error) falha("remover regra", error);
      return (data ?? []).length > 0;
    },

    async upsertGrupo(row) {
      const r = await upsertByNaturalKey(client, "catmat_grupos", { codigo_grupo: row.codigo_grupo }, row);
      if (r === "erro") falha("gravar grupo", r);
    },
    async upsertClasse(row) {
      const r = await upsertByNaturalKey(
        client, "catmat_classes", { codigo_grupo: row.codigo_grupo, codigo_classe: row.codigo_classe }, row,
      );
      if (r === "erro") falha("gravar classe", r);
    },
    async upsertPdm(row) {
      // Sem lastSeenSyncId: a api-catmat não participa da reconciliação do sync-compras-catmat.
      const r = await upsertByNaturalKey(client, "catmat_pdms", { codigo_pdm: row.codigo_pdm }, row);
      if (r === "erro") falha("gravar PDM", r);
    },
    async upsertItensPdm(rows) {
      if (rows.length === 0) return;
      const agora = new Date().toISOString();
      for (let i = 0; i < rows.length; i += 500) {
        const lote = rows.slice(i, i + 500).map((r) => ({ ...r, atualizado_em: agora }));
        const { error } = await client.from("catmat_item_pdm").upsert(lote, { onConflict: "codigo_item" });
        if (error) falha("gravar itens", error);
      }
    },
    async pdmExiste(codigoPdm) {
      const { data, error } = await client.from("catmat_pdms").select("codigo_pdm").eq("codigo_pdm", codigoPdm).maybeSingle();
      if (error) falha("consultar PDM", error);
      return !!data;
    },

    async pdmsEfetivos() {
      const { data, error } = await client.rpc("catalogo_catmat_pdms_efetivos");
      if (error) falha("PDMs efetivos", error);
      return (data ?? []) as Array<{ codigo_pdm: number; codigo_classe: number; codigo_grupo: number; origem_nivel: string; regra_id: number }>;
    },
    async nomesGrupos(codigos) {
      if (codigos.length === 0) return [];
      const { data, error } = await client.from("catmat_grupos").select("codigo_grupo,nome").in("codigo_grupo", codigos);
      if (error) falha("nomes de grupos", error);
      return (data ?? []).map((r: { codigo_grupo: number; nome: string }) => ({ codigo: r.codigo_grupo, nome: r.nome, codigo_pai: null }));
    },
    async nomesClasses(codigos) {
      if (codigos.length === 0) return [];
      const { data, error } = await client.from("catmat_classes").select("codigo_grupo,codigo_classe,nome").in("codigo_classe", codigos);
      if (error) falha("nomes de classes", error);
      return (data ?? []).map((r: { codigo_grupo: number; codigo_classe: number; nome: string }) => ({
        codigo: r.codigo_classe, nome: r.nome, codigo_pai: r.codigo_grupo,
      }));
    },
    async nomesPdms(codigos) {
      if (codigos.length === 0) return [];
      const { data, error } = await client.from("catmat_pdms").select("codigo_pdm,codigo_classe,nome_pdm").in("codigo_pdm", codigos);
      if (error) falha("nomes de PDMs", error);
      return (data ?? []).map((r: { codigo_pdm: number; codigo_classe: number; nome_pdm: string }) => ({
        codigo: r.codigo_pdm, nome: r.nome_pdm, codigo_pai: r.codigo_classe,
      }));
    },
    async itensDosPdms(codigosPdm, limite) {
      if (codigosPdm.length === 0) return [];
      const { data, error } = await client.from("catmat_item_pdm")
        .select("codigo_item,codigo_pdm,descricao").in("codigo_pdm", codigosPdm).order("codigo_item").limit(limite);
      if (error) falha("itens dos PDMs", error);
      return (data ?? []) as Array<{ codigo_item: number; codigo_pdm: number; descricao: string | null }>;
    },

    async cacheLer(chave) {
      const { data, error } = await client.from("compras_catmat_cache").select("payload,total,expira_em").eq("chave", chave).maybeSingle();
      if (error) return null; // cache é melhor esforço
      return (data ?? null) as CacheLinha | null;
    },
    async cacheGravar(chave, payload, total, expiraEm) {
      const { error } = await client.from("compras_catmat_cache").upsert({
        chave, payload, total, buscado_em: new Date().toISOString(), expira_em: expiraEm.toISOString(),
      }, { onConflict: "chave" });
      if (error) console.warn("[api-catmat] cache não gravado:", error.message);
    },

    async listarPalavras(codigoPdm) {
      const [inc, exc] = await Promise.all((["inclui", "exclui"] as const).map((t) =>
        client.from(TABELA_PALAVRA[t]).select(PALAVRA_COLS).eq("codigo_pdm", codigoPdm).order("id")
      ));
      if (inc.error) falha("listar palavras", inc.error);
      if (exc.error) falha("listar exclusões", exc.error);
      return [...comTipo(inc.data, "inclui"), ...comTipo(exc.data, "exclui")];
    },
    async contarPalavrasPorPdm(codigosPdm) {
      const mapa = new Map<number, number>();
      if (codigosPdm.length === 0) return mapa;
      const { data, error } = await client.from("catmat_pdm_palavras").select("codigo_pdm").eq("ativo", true).in("codigo_pdm", codigosPdm);
      if (error) falha("contar palavras", error);
      for (const r of (data ?? []) as Array<{ codigo_pdm: number }>) mapa.set(r.codigo_pdm, (mapa.get(r.codigo_pdm) ?? 0) + 1);
      return mapa;
    },
    async nosTaxonomiaDoPdm(codigoPdm) {
      const { data, error } = await client.from("taxonomia_no_pdm").select("no_taxonomia").eq("codigo_pdm", codigoPdm).order("no_taxonomia");
      if (error) falha("nós de taxonomia", error);
      return ((data ?? []) as Array<{ no_taxonomia: string }>).map((r) => r.no_taxonomia);
    },
    async contarNosTaxonomiaPorPdm(codigosPdm) {
      const mapa = new Map<number, number>();
      if (codigosPdm.length === 0) return mapa;
      const { data, error } = await client.from("taxonomia_no_pdm").select("codigo_pdm").in("codigo_pdm", codigosPdm);
      if (error) falha("contar nós de taxonomia", error);
      for (const r of (data ?? []) as Array<{ codigo_pdm: number }>) mapa.set(r.codigo_pdm, (mapa.get(r.codigo_pdm) ?? 0) + 1);
      return mapa;
    },
    async obterPalavra(id, tipo) {
      const { data, error } = await client.from(TABELA_PALAVRA[tipo]).select(PALAVRA_COLS).eq("id", id).maybeSingle();
      if (error) falha("obter palavra", error);
      return data ? comTipo([data], tipo)[0] : null;
    },
    async inserirPalavra(codigoPdm, padrao, ativo, tipo, userId) {
      const { data, error } = await client.from(TABELA_PALAVRA[tipo])
        .insert({ codigo_pdm: codigoPdm, padrao, ativo, updated_by: userId, updated_at: new Date().toISOString() })
        .select(PALAVRA_COLS).single();
      if (error) falha("inserir palavra", error);
      return comTipo([data], tipo)[0];
    },
    async atualizarPalavra(id, tipo, padrao, ativo, userId) {
      const { data, error } = await client.from(TABELA_PALAVRA[tipo])
        .update({ padrao, ativo, updated_by: userId, updated_at: new Date().toISOString() })
        .eq("id", id).select(PALAVRA_COLS).single();
      if (error) falha("atualizar palavra", error);
      return comTipo([data], tipo)[0];
    },
    async removerPalavra(id, tipo) {
      const { data, error } = await client.from(TABELA_PALAVRA[tipo]).delete().eq("id", id).select("id");
      if (error) falha("remover palavra", error);
      return (data ?? []).length > 0;
    },
    async regexValido(padrao) {
      const { data, error } = await client.rpc("catmat_regex_valido", { p: padrao });
      if (error) falha("validar regex", error);
      return data === true;
    },
  };
}

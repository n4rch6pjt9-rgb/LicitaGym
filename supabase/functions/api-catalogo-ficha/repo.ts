import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { LinhaProduto, ProdutoExistente } from "./ficha.ts";

export interface FichaRepo {
  porUrl(url: string): Promise<ProdutoExistente | null>;
  porCodigo(tenantId: number, codigo: string): Promise<ProdutoExistente | null>;
  inserir(linha: LinhaProduto): Promise<number>;
  atualizar(id: number, linha: LinhaProduto): Promise<void>;
  gravarMedida(produtoId: number, texto: string): Promise<void>;
  gravarAtributos(
    produtoId: number,
    itens: { atributo: string; valor_texto: string; valor_num: number | null }[],
  ): Promise<void>;
}

function linhaDe(row: Record<string, unknown>): ProdutoExistente {
  const atributos = row.atributos;
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id === null || row.tenant_id === undefined ? null : Number(row.tenant_id),
    codigo: typeof row.codigo === "string" ? row.codigo : null,
    url: typeof row.url === "string" ? row.url : null,
    atributos: atributos && typeof atributos === "object" && !Array.isArray(atributos)
      ? atributos as Record<string, unknown>
      : {},
    descricao: typeof row.descricao === "string" ? row.descricao : null,
  };
}

export function createSupabaseRepo(client: SupabaseClient): FichaRepo {
  const select = "id,tenant_id,codigo,url,atributos,descricao";
  return {
    async porUrl(url) {
      const { data, error } = await client.from("catalogo_produtos").select(select).eq("url", url).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? linhaDe(data) : null;
    },
    async porCodigo(tenantId, codigo) {
      const { data, error } = await client.from("catalogo_produtos").select(select)
        .eq("tenant_id", tenantId).eq("codigo", codigo).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? linhaDe(data) : null;
    },
    async inserir(linha) {
      const { data, error } = await client.from("catalogo_produtos").insert(linha).select("id").single();
      if (error) throw new Error(error.message);
      return Number(data.id);
    },
    async atualizar(id, linha) {
      const { error } = await client.from("catalogo_produtos").update(linha).eq("id", id);
      if (error) throw new Error(error.message);
    },
    async gravarMedida(produtoId, texto) {
      const { error } = await client.from("catalogo_produto_atributos").upsert(
        { produto_id: produtoId, atributo: "medida", valor_texto: texto, valor_num: null },
        { onConflict: "produto_id,atributo" },
      );
      if (error) throw new Error(error.message);
    },
    async gravarAtributos(produtoId, itens) {
      if (!itens.length) return;
      const { error } = await client.from("catalogo_produto_atributos").upsert(
        itens.map((item) => ({
          produto_id: produtoId,
          atributo: item.atributo,
          valor_texto: item.valor_texto,
          valor_num: item.valor_num,
        })),
        { onConflict: "produto_id,atributo" },
      );
      if (error) throw new Error(error.message);
    },
  };
}

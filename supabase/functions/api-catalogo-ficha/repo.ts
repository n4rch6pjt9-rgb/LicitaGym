import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { ATRIBUTOS_ONTOLOGIA_FICHA, type AtributoFicha, type LinhaProduto, type ProdutoCatalogo, type ProdutoExistente } from "./ficha.ts";

export interface FichaRepo {
  porUrl(url: string): Promise<ProdutoExistente | null>;
  porCodigo(tenantId: number, codigo: string): Promise<ProdutoExistente | null>;
  inserir(linha: LinhaProduto): Promise<number>;
  atualizar(id: number, linha: LinhaProduto): Promise<void>;
  gravarMedida(produtoId: number, texto: string): Promise<void>;
  /** Sincroniza os atributos da ontologia: grava os de `itens` e apaga os da ontologia que a ficha deixou de
   * declarar (ex.: produto corrigido à mão para não elétrica). `medida` e outros fora da ontologia ficam. */
  gravarAtributos(
    produtoId: number,
    itens: { atributo: string; valor_texto: string; valor_num: number | null }[],
  ): Promise<void>;
  /** Até `limite` produtos da empresa, mais recentes primeiro; `truncado` avisa quando havia mais. */
  listar(tenantId: number, limite: number): Promise<{ itens: ProdutoCatalogo[]; truncado: boolean }>;
}

function numeroOuNulo(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function produtoDe(row: Record<string, unknown>, atributos: AtributoFicha[]): ProdutoCatalogo {
  const jsonb = row.atributos && typeof row.atributos === "object" && !Array.isArray(row.atributos)
    ? row.atributos as Record<string, unknown>
    : {};
  const imagens = Array.isArray(jsonb.imagens) ? jsonb.imagens.filter((i): i is string => typeof i === "string") : [];
  return {
    id: Number(row.id),
    marca: textoOuNulo(row.marca),
    codigo: textoOuNulo(row.codigo),
    nome: textoOuNulo(row.nome),
    url: textoOuNulo(row.url),
    categorias: Array.isArray(row.categorias) ? row.categorias.filter((c): c is string => typeof c === "string") : [],
    familia_equipamento: textoOuNulo(row.familia_equipamento),
    no_taxonomia: textoOuNulo(row.no_taxonomia),
    carga_maxima_kg: numeroOuNulo(row.carga_maxima_kg),
    peso_equipamento_kg: numeroOuNulo(row.peso_equipamento_kg),
    ativo: row.ativo !== false,
    last_seen_at: textoOuNulo(row.last_seen_at),
    imagens,
    atributos,
  };
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
    no_taxonomia: typeof row.no_taxonomia === "string" ? row.no_taxonomia : null,
  };
}

export function createSupabaseRepo(client: SupabaseClient): FichaRepo {
  const select = "id,tenant_id,codigo,url,atributos,descricao,no_taxonomia";
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
      const vieram = new Set(itens.map((i) => i.atributo));
      const apagar = ATRIBUTOS_ONTOLOGIA_FICHA.filter((a) => !vieram.has(a));
      if (apagar.length) {
        const { error: e0 } = await client.from("catalogo_produto_atributos").delete()
          .eq("produto_id", produtoId).in("atributo", apagar);
        if (e0) throw new Error(e0.message);
      }
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
    async listar(tenantId, limite) {
      const { data, error } = await client.from("catalogo_produtos")
        .select("id,marca,codigo,nome,url,categorias,familia_equipamento,no_taxonomia,carga_maxima_kg,peso_equipamento_kg,ativo,last_seen_at,atributos")
        .eq("tenant_id", tenantId)
        .order("last_seen_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limite + 1);
      if (error) throw new Error(error.message);
      const linhas = ((data ?? []) as Record<string, unknown>[]).slice(0, limite);
      const ids = linhas.map((l) => Number(l.id));
      const porProduto = new Map<number, AtributoFicha[]>();
      if (ids.length) {
        const { data: attrs, error: e2 } = await client.from("catalogo_produto_atributos")
          .select("produto_id,atributo,valor_texto,valor_num")
          .in("produto_id", ids)
          .order("atributo", { ascending: true });
        if (e2) throw new Error(e2.message);
        for (const a of (attrs ?? []) as Record<string, unknown>[]) {
          const pid = Number(a.produto_id);
          const lista = porProduto.get(pid) ?? [];
          lista.push({
            atributo: String(a.atributo),
            valor_texto: typeof a.valor_texto === "string" ? a.valor_texto : "",
            valor_num: numeroOuNulo(a.valor_num),
          });
          porProduto.set(pid, lista);
        }
      }
      return {
        itens: linhas.map((l) => produtoDe(l, porProduto.get(Number(l.id)) ?? [])),
        truncado: (data ?? []).length > limite,
      };
    },
  };
}

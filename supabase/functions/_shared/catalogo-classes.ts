/**
 * Classes CATMAT do catálogo da empresa (catalogo_empresa_catmat), depois da herança e das exclusões. É o padrão de
 * classes das rotas que leem o PCA por classe: nada fica fixo no código (migration 20261010100000).
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/** Lê private.catalogo_classes_efetivas() (só service_role). Erro de leitura propaga: não cai num padrão fixo. */
export async function classesDoCatalogo(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.schema("private").rpc("catalogo_classes_efetivas");
  if (error) throw new Error(`classes do catálogo CATMAT: ${error.message}`);
  return Array.isArray(data) ? [...new Set(data.map(String))].sort() : [];
}

export type ClassesResolvidas =
  | { ok: true; classes: string[] }
  | { ok: false; status: number; erro: string };

/**
 * Sem classes pedidas, usa as do catálogo. Com classes pedidas, só aceita as que estão no catálogo. Catálogo vazio é
 * erro explícito (não inventa escopo).
 */
export function resolverClasses(pedidas: unknown, catalogo: string[]): ClassesResolvidas {
  if (catalogo.length === 0) {
    return { ok: false, status: 409, erro: "catálogo CATMAT da empresa sem classe efetiva: cadastre em /catmat" };
  }
  if (pedidas == null || (Array.isArray(pedidas) && pedidas.length === 0)) return { ok: true, classes: catalogo };
  if (!Array.isArray(pedidas) || pedidas.some((c) => typeof c !== "string" || !/^\d{4}$/.test(c.trim()))) {
    return { ok: false, status: 400, erro: "classes deve ser lista de códigos CATMAT de 4 dígitos" };
  }
  const classes = [...new Set(pedidas.map((c: string) => c.trim()))].sort();
  const fora = classes.filter((c) => !catalogo.includes(c));
  if (fora.length > 0) {
    return { ok: false, status: 400, erro: `classe fora do catálogo CATMAT da empresa: ${fora.join(", ")}` };
  }
  return { ok: true, classes };
}

/** Lista de classes de query string: "7830,7220" ou parâmetro repetido. Vazia vira null (usa o catálogo). */
export function classesDaQuery(url: URL): string[] | null {
  const valores = [...url.searchParams.getAll("classes"), ...url.searchParams.getAll("classe")]
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return valores.length > 0 ? valores : null;
}

// Stub da spec 0009 (fase red): contrato exportado, comportamento ainda ausente.
import { jsonResponse } from "../_shared/http.ts";

export const FONTE = "compras.gov/pesquisa-preco";

type Resultado = { data: Record<string, unknown>[] | null; error: unknown; count?: number | null };

export interface PrecosQuery extends PromiseLike<Resultado> {
  select(cols: string, opts?: { count?: "exact" }): PrecosQuery;
  eq(col: string, v: unknown): PrecosQuery;
  gt(col: string, v: number): PrecosQuery;
  gte(col: string, v: string): PrecosQuery;
  lte(col: string, v: string): PrecosQuery;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): PrecosQuery;
  range(from: number, to: number): PrecosQuery;
}

export interface PrecosClient {
  from(tabela: string): PrecosQuery;
  rpc(funcao: string, args?: Record<string, unknown>): PrecosQuery;
}

export interface PrecosDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente?: () => PrecosClient;
  hoje?: () => string;
}

export function periodoDe(_fim: string, _meses: number): { inicio: string; fim: string } {
  return { inicio: "", fim: "" };
}

export function responderPrecos(_req: Request, _url: URL, _deps: PrecosDeps = {}): Promise<Response> {
  return Promise.resolve(jsonResponse({ error: "não implementado" }, 501));
}

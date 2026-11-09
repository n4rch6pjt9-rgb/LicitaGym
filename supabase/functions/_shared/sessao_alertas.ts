// Spec 0039, etapa 1b: esqueleto (implementação no commit seguinte).
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export function detectarAlerta(_m: { texto: string | null; identificador_item: string | null }): unknown {
  throw new Error("não implementado");
}

export function gerarAlertas(_s: SupabaseClient, _l: number, _m: unknown[], _a: number): Promise<number> {
  throw new Error("não implementado");
}

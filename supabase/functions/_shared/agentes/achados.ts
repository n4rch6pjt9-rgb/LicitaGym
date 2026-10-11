import type { Achado, Fonte } from "./tipos.ts";

const CODIGO = /^(exigencia|prazo|preco|juridico)\.[a-z_]+$/;
const SIGILOSAS = new Set(["preco_tabela", "desconto_max_pct", "piso", "piso_centavos"]);
const PRIMARIA = new Set(["chunk", "registro", "dispositivo", "cliente"]);

function chaveSigilosa(valor: unknown): string | null {
  if (Array.isArray(valor)) {
    for (const item of valor) {
      const achou = chaveSigilosa(item);
      if (achou) return achou;
    }
    return null;
  }
  if (valor !== null && typeof valor === "object") {
    for (const [chave, filho] of Object.entries(valor as Record<string, unknown>)) {
      if (SIGILOSAS.has(chave)) return chave;
      const achou = chaveSigilosa(filho);
      if (achou) return achou;
    }
  }
  return null;
}

function fonteInvalida(fonte: Fonte): string | null {
  if (fonte.tipo === "chunk" && fonte.trecho.trim().length === 0) return "fonte chunk sem trecho";
  return null;
}

export function validarAchado(a: Achado): string | null {
  if (!CODIGO.test(a.codigo)) return `código inválido: ${a.codigo}`;
  if (a.fontes.length === 0) return "achado sem fonte";
  for (const fonte of a.fontes) {
    const erro = fonteInvalida(fonte);
    if (erro) return erro;
  }
  if (a.natureza === "fato" && !a.fontes.some((f) => PRIMARIA.has(f.tipo))) return "fato sem fonte primária";
  const sigilo = chaveSigilosa(a.dados);
  if (sigilo) return `dado sigiloso em achado: ${sigilo}`;
  return null;
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor !== null && typeof valor === "object") {
    const saida: Record<string, unknown> = {};
    for (const chave of Object.keys(valor as Record<string, unknown>).sort()) {
      saida[chave] = ordenar((valor as Record<string, unknown>)[chave]);
    }
    return saida;
  }
  return valor;
}

export async function hashContexto(partes: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(ordenar(partes)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minúsculas, sem acento, espaços colapsados. `origem[i]` é o índice no texto original do caractere i. */
export function normalizarComMapa(s: string): { norm: string; origem: number[] } {
  const lower = s.toLowerCase();
  const chars: string[] = [];
  const origem: number[] = [];
  let espaco = true;
  for (let i = 0; i < lower.length; i++) {
    const base = lower[i].normalize("NFD").replace(/\p{M}/gu, "");
    for (const ch of base) {
      if (/\s/u.test(ch)) {
        if (espaco) continue;
        chars.push(" ");
        origem.push(i);
        espaco = true;
      } else {
        chars.push(ch);
        origem.push(i);
        espaco = false;
      }
    }
  }
  if (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    origem.pop();
  }
  return { norm: chars.join(""), origem };
}

export function normalizarTexto(s: string): string {
  return normalizarComMapa(s).norm;
}

/**
 * Linker determinístico edital ↔ PCA.
 * Probe Consulta /contratacoes/publicacao (2026-09-20): sem idPca / idPcaPncp.
 * Preferência: codigo_material_servico = codigo_item_origem + mesmo orgao + ano compatível.
 * Fallback: orgao + PDM confirmado + |prevista − pub| ≤ janela — só se plano único.
 */

export type LinkMetodo = "codigo_item" | "pdm_janela";

export type LinkMatchRow = {
  editalId: string;
  planoId: string;
  metodo: LinkMetodo;
  /** Detalhe auditável (código, PDM, lag). */
  detalhe: string;
};

export type LinkDecision = {
  editalId: string;
  planoId: string;
  evidencia: string;
  metodo: LinkMetodo;
};

export function buildEvidencia(metodo: LinkMetodo, detalhe: string): string {
  return `${metodo}:${detalhe}`;
}

/**
 * Agrupa candidatos por edital; emite vínculo só quando há exatamente um plano.
 * Empate multi-plano = ambíguo → descartado (não inventa FK).
 */
export function pickUniquePlanoLinks(rows: LinkMatchRow[]): LinkDecision[] {
  const byEdital = new Map<string, LinkMatchRow[]>();
  for (const row of rows) {
    const list = byEdital.get(row.editalId) ?? [];
    list.push(row);
    byEdital.set(row.editalId, list);
  }

  const out: LinkDecision[] = [];
  for (const [editalId, list] of byEdital) {
    const planos = new Set(list.map((r) => r.planoId));
    if (planos.size !== 1) continue;
    // Preferir codigo_item se houver mistura de métodos para o mesmo plano
    const preferred =
      list.find((r) => r.metodo === "codigo_item") ?? list[0];
    if (!preferred) continue;
    out.push({
      editalId,
      planoId: preferred.planoId,
      metodo: preferred.metodo,
      evidencia: buildEvidencia(preferred.metodo, preferred.detalhe),
    });
  }
  return out;
}

export function anosCompativeis(anoEdital: number, anoPlano: number): boolean {
  // Exercício do PCA costuma coincidir com ano da compra ou ano anterior (planejamento).
  return anoPlano === anoEdital || anoPlano === anoEdital - 1;
}

export function dentroJanelaDias(
  prevista: string | Date | null | undefined,
  publicacao: string | Date | null | undefined,
  janelaDias: number,
): { ok: boolean; lagDias: number | null } {
  if (prevista == null || publicacao == null) {
    return { ok: false, lagDias: null };
  }
  const p = toUtcDateOnly(prevista);
  const pub = toUtcDateOnly(publicacao);
  if (!p || !pub) return { ok: false, lagDias: null };
  const lag = Math.round((pub.getTime() - p.getTime()) / 86_400_000);
  return { ok: Math.abs(lag) <= janelaDias, lagDias: lag };
}

function toUtcDateOnly(value: string | Date): Date | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const ymd = raw.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Chaves oficiais possíveis no payload de edital (probe: todas ausentes). */
export const EDITAL_PCA_PAYLOAD_KEYS = [
  "idPcaPncp",
  "id_pca_pncp",
  "idPca",
  "id_pca",
  "numeroControlePNCPPca",
  "numeroControlePncpPca",
] as const;

/**
 * Extrai referência oficial PCA do payload de contratação/publicação, se existir.
 * Retorna null quando a API não envia vínculo (caso atual documentado).
 */
export function extractEditalIdPcaPncp(
  item: Record<string, unknown>,
): string | null {
  for (const key of EDITAL_PCA_PAYLOAD_KEYS) {
    const raw = item[key];
    if (raw == null || raw === "") continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return null;
}

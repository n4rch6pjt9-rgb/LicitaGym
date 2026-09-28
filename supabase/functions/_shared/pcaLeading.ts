/**
 * Read model de leading do PCA.
 * Unidade de contagem pode ser item, plano ou órgão.
 * O valor é sempre a soma dos itens: plano e órgão não têm valor próprio.
 * Prioridade da fonte vazia fica "não informada". Não infere Alta/Média/Baixa.
 * PDM de origem, inferido e confirmado são contagens separadas e podem se sobrepor.
 */

export type UnidadeAnalisePca = "item" | "plano" | "orgao";

export interface PcaItemLeading {
  planoId: string;
  orgaoCnpj: string | null;
  valorTotalEstimado: number | null;
  dataPrevista: string | null;
  prioridade: string | null;
  pdmCodigoOrigem: string | null;
  pdmInferido: boolean;
  pdmConfirmado: boolean;
  lastSyncedAt: string | null;
}

export interface LeadingPca {
  unidade: UnidadeAnalisePca;
  data_referencia: string;
  data_sync: string | null;
  contagem_unidade: number;
  itens: number;
  planos: number;
  orgaos: number;
  itens_sem_cnpj_orgao: number;
  valor_estimado_demanda_planejada: number | null;
  itens_sem_valor: number;
  prioridade_nao_informada: number;
  prioridade_informada: number;
  pdm_informado_origem: number;
  pdm_inferido: number;
  pdm_confirmado: number;
  janela_experimental_60_120: number;
  fora_janela_0_59: number;
  antecedencia_nao_calculada: number;
  fora_das_faixas: number;
}

const DIA_MS = 24 * 60 * 60 * 1000;

export function parseUnidade(raw: unknown): UnidadeAnalisePca | null {
  if (raw === "item" || raw === "plano" || raw === "orgao") return raw;
  if (raw === undefined || raw === null || raw === "") return "item";
  return null;
}

export function parseDataIso(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const dia = raw.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return null;
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const iso = d.toISOString().slice(0, 10);
  return iso === dia ? dia : null;
}

export function numeroOuAusente(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function cnpjDigitos(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function temPrioridade(raw: string | null): boolean {
  return raw != null && raw.trim().length > 0;
}

function pdmOrigem(raw: string | null): boolean {
  return raw != null && raw.trim().length > 0;
}

function diasAntecedencia(prevista: string, hoje: string): number | null {
  const a = parseDataIso(prevista);
  const b = parseDataIso(hoje);
  if (!a || !b) return null;
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((da - db) / DIA_MS);
}

function maxIso(atual: string | null, candidato: string | null): string | null {
  if (!candidato) return atual;
  const t = Date.parse(candidato);
  if (Number.isNaN(t)) return atual;
  if (!atual) return new Date(t).toISOString();
  return t > Date.parse(atual) ? new Date(t).toISOString() : atual;
}

export function agregarLeadingPca(
  itens: readonly PcaItemLeading[],
  opts: { hoje: string; unidade: UnidadeAnalisePca },
): LeadingPca {
  const hoje = parseDataIso(opts.hoje);
  if (!hoje) {
    throw new Error("data_referencia inválida");
  }

  const planos = new Set<string>();
  const orgaos = new Set<string>();
  let itensSemCnpj = 0;
  let soma = 0;
  let itensComValor = 0;
  let itensSemValor = 0;
  let prioridadeNaoInformada = 0;
  let prioridadeInformada = 0;
  let pdmOrigemN = 0;
  let pdmInferido = 0;
  let pdmConfirmado = 0;
  let janela = 0;
  let urgente = 0;
  let semData = 0;
  let fora = 0;
  let dataSync: string | null = null;

  for (const item of itens) {
    planos.add(item.planoId);
    const cnpj = cnpjDigitos(item.orgaoCnpj);
    if (cnpj) orgaos.add(cnpj);
    else itensSemCnpj += 1;

    if (item.valorTotalEstimado === null) itensSemValor += 1;
    else {
      soma += item.valorTotalEstimado;
      itensComValor += 1;
    }

    if (temPrioridade(item.prioridade)) prioridadeInformada += 1;
    else prioridadeNaoInformada += 1;

    if (pdmOrigem(item.pdmCodigoOrigem)) pdmOrigemN += 1;
    if (item.pdmInferido) pdmInferido += 1;
    if (item.pdmConfirmado) pdmConfirmado += 1;

    dataSync = maxIso(dataSync, item.lastSyncedAt);

    if (!item.dataPrevista) {
      semData += 1;
      continue;
    }
    const dias = diasAntecedencia(item.dataPrevista, hoje);
    if (dias === null) {
      semData += 1;
    } else if (dias >= 60 && dias <= 120) {
      janela += 1;
    } else if (dias >= 0 && dias <= 59) {
      urgente += 1;
    } else {
      fora += 1;
    }
  }

  const contagem =
    opts.unidade === "plano"
      ? planos.size
      : opts.unidade === "orgao"
        ? orgaos.size
        : itens.length;

  return {
    unidade: opts.unidade,
    data_referencia: hoje,
    data_sync: dataSync,
    contagem_unidade: contagem,
    itens: itens.length,
    planos: planos.size,
    orgaos: orgaos.size,
    itens_sem_cnpj_orgao: itensSemCnpj,
    valor_estimado_demanda_planejada: itensComValor > 0 ? soma : null,
    itens_sem_valor: itensSemValor,
    prioridade_nao_informada: prioridadeNaoInformada,
    prioridade_informada: prioridadeInformada,
    pdm_informado_origem: pdmOrigemN,
    pdm_inferido: pdmInferido,
    pdm_confirmado: pdmConfirmado,
    janela_experimental_60_120: janela,
    fora_janela_0_59: urgente,
    antecedencia_nao_calculada: semData,
    fora_das_faixas: fora,
  };
}

export function leadingPcaValido(raw: unknown): raw is LeadingPca {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    (o.unidade === "item" || o.unidade === "plano" || o.unidade === "orgao") &&
    typeof o.data_referencia === "string" &&
    typeof o.itens === "number" &&
    typeof o.contagem_unidade === "number" &&
    (o.valor_estimado_demanda_planejada === null ||
      typeof o.valor_estimado_demanda_planejada === "number")
  );
}

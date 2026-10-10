/** Enfileira o Cloud Run Job coletor-sestsenat. Não espera a coleta. */

export const PROJETO = "licitagym";
export const REGIAO = "southamerica-east1";
export const JOB = "coletor-sestsenat";
export const SEGREDO_VAULT = "coletor_sestsenat_run_key";
export const JOB_CRON = "licitagym-coletor-sestsenat";

/** Diário, no escopo fitness, incluindo processo ainda em andamento. */
export const ARGS_DIARIO = ["--todos", "--escopo", "fitness"] as const;

export type PedidoHttp = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

export type RespostaHttp = { status: number; body: string };

export function urlEnfileirar(): string {
  return `https://run.googleapis.com/v2/projects/${PROJETO}/locations/${REGIAO}/jobs/${JOB}:run`;
}

export function corpoEnfileirar(): {
  overrides: { containerOverrides: { args: string[] }[] };
} {
  return {
    overrides: {
      containerOverrides: [{ args: [...ARGS_DIARIO] }],
    },
  };
}

/** O que pode ir para cron_edge_chamadas. Sem a chave. */
export function registroCron(): {
  job: typeof JOB_CRON;
  segredo: typeof SEGREDO_VAULT;
  url: string;
  args: string[];
} {
  return {
    job: JOB_CRON,
    segredo: SEGREDO_VAULT,
    url: urlEnfileirar(),
    args: [...ARGS_DIARIO],
  };
}

export async function enfileirar(opts: {
  chave: string | null | undefined;
  obterToken: (chave: string) => Promise<string>;
  http: (pedido: PedidoHttp) => Promise<RespostaHttp>;
}): Promise<{ execucao: string }> {
  const chave = opts.chave?.trim() ?? "";
  if (!chave) {
    throw new Error(`Vault sem o segredo ${SEGREDO_VAULT}`);
  }
  const token = await opts.obterToken(chave);
  const res = await opts.http({
    url: urlEnfileirar(),
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(corpoEnfileirar()),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`enfileirar ${JOB}: HTTP ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`enfileirar ${JOB}: resposta sem name`);
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    !("name" in parsed) || typeof parsed.name !== "string" ||
    parsed.name.length === 0
  ) {
    throw new Error(`enfileirar ${JOB}: resposta sem name`);
  }
  return { execucao: parsed.name };
}

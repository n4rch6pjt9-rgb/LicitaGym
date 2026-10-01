export type OneCompilerMetrics = {
  compilation_time_ms: number | null;
  execution_time_ms: number | null;
  memory_used_kb: number | null;
  quota_remaining: number | null;
};

export type OneCompilerExecution<T> = {
  output: T;
  metrics: OneCompilerMetrics;
};

type OneCompilerResponse = {
  stdout?: unknown;
  stderr?: unknown;
  exception?: unknown;
  status?: unknown;
  compilationTime?: unknown;
  executionTime?: unknown;
  memoryUsed?: unknown;
  limitRemaining?: unknown;
  limitPerMonthRemaining?: unknown;
  error?: unknown;
};

const ONECOMPILER_RUN_URL = "https://api.onecompiler.com/v1/run";
const MAX_RESPONSE_BYTES = 200_000;

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function presentText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export class OneCompilerError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "network"
      | "provider_http"
      | "provider_failure"
      | "execution_failure"
      | "invalid_output",
    message: string,
  ) {
    super(message);
    this.name = "OneCompilerError";
  }
}

export async function executeOneCompiler<T>(input: {
  apiKey: string;
  language: string;
  filename: string;
  source: string;
  stdin: string;
  parseOutput: (value: unknown) => T;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OneCompilerExecution<T>> {
  if (!input.apiKey.trim()) {
    throw new OneCompilerError(
      "configuration",
      "ONECOMPILER_API_KEY não configurada",
    );
  }
  const timeoutMs = input.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await (input.fetchImpl ?? fetch)(ONECOMPILER_RUN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": input.apiKey,
      },
      body: JSON.stringify({
        language: input.language,
        stdin: input.stdin,
        files: [{ name: input.filename, content: input.source }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OneCompilerError(
      "network",
      `falha de rede no OneCompiler: ${reason}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const rawBody = await response.text();
  if (rawBody.length > MAX_RESPONSE_BYTES) {
    throw new OneCompilerError(
      "invalid_output",
      "resposta do OneCompiler excedeu o limite",
    );
  }
  if (!response.ok) {
    throw new OneCompilerError(
      "provider_http",
      `OneCompiler respondeu HTTP ${response.status}`,
    );
  }

  let body: OneCompilerResponse;
  try {
    body = JSON.parse(rawBody) as OneCompilerResponse;
  } catch {
    throw new OneCompilerError(
      "invalid_output",
      "OneCompiler retornou JSON inválido",
    );
  }

  const providerError = presentText(body.error);
  if (body.status !== "success" || providerError) {
    throw new OneCompilerError(
      "provider_failure",
      providerError ?? "OneCompiler não confirmou a chamada",
    );
  }

  const stderr = presentText(body.stderr);
  const exception = presentText(body.exception);
  if (stderr || exception) {
    throw new OneCompilerError(
      "execution_failure",
      exception ?? stderr ?? "execução da regra falhou",
    );
  }

  const stdout = presentText(body.stdout);
  if (!stdout) {
    throw new OneCompilerError("invalid_output", "regra não produziu saída");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    throw new OneCompilerError(
      "invalid_output",
      "saída da regra não é JSON válido",
    );
  }

  let output: T;
  try {
    output = input.parseOutput(decoded);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OneCompilerError(
      "invalid_output",
      `saída da regra rejeitada: ${reason}`,
    );
  }

  return {
    output,
    metrics: {
      compilation_time_ms: nullableNumber(body.compilationTime),
      execution_time_ms: nullableNumber(body.executionTime),
      memory_used_kb: nullableNumber(body.memoryUsed),
      quota_remaining: nullableNumber(
        body.limitPerMonthRemaining ?? body.limitRemaining,
      ),
    },
  };
}

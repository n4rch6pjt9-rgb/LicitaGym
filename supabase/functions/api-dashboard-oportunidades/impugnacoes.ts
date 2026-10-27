export interface InformativoQuadro {
  tipo?: string | null;
  dataHoraInclusao?: string | null;
  mensagem?: string | null;
  resposta?: string | null;
}

export type LeituraImpugnacoes =
  | { ok: true; informativos: InformativoQuadro[] }
  | { ok: false; motivo: "captcha_bloqueado" | "indisponivel"; detalhe: string | null };

const BASE = "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-fase-externa/public/v1/compras";

export function idCompraDaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.match(/compra=(\d{10,20})/)?.[1] ?? null;
}

export function textoAvisoImpugnacao(mensagem: string, resposta: string | null): string {
  if (!resposta) return mensagem;
  if (!mensagem) return resposta;
  return `${mensagem}\n\nResposta:\n${resposta}`;
}

function headerMensagem(headers: Headers, nome: string): string | null {
  const alvo = nome.toLowerCase();
  for (const [chave, valor] of headers.entries()) {
    if (chave.toLowerCase() === alvo && valor.trim()) return valor.trim();
  }
  return null;
}

export function interpretarCorpoImpugnacoes(status: number, headers: Headers, texto: string): LeituraImpugnacoes {
  const severidade = headerMensagem(headers, "message-severity");
  if (severidade?.toLowerCase() === "error") {
    return {
      ok: false,
      motivo: "captcha_bloqueado",
      detalhe: headerMensagem(headers, "message-detail"),
    };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, motivo: "indisponivel", detalhe: `HTTP ${status}` };
  }
  if (status === 204 || texto.trim() === "") return { ok: true, informativos: [] };
  let body: unknown;
  try {
    body = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: "indisponivel", detalhe: "Resposta do quadro não é JSON." };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, motivo: "indisponivel", detalhe: "Resposta do quadro sem objeto." };
  }
  const informativos = (body as { informativos?: unknown }).informativos;
  if (!Array.isArray(informativos)) {
    return { ok: false, motivo: "indisponivel", detalhe: "Resposta do quadro sem lista de informativos." };
  }
  return {
    ok: true,
    informativos: informativos.filter((item): item is InformativoQuadro => !!item && typeof item === "object"),
  };
}

export interface MensagemImpugnacao {
  categoria: "impugnacao";
  remetente: string;
  mensagem: string;
  data_hora_oficial: string;
  resposta: string | null;
}

export function mensagensDeImpugnacoes(informativos: readonly InformativoQuadro[]): MensagemImpugnacao[] {
  const mensagens: MensagemImpugnacao[] = [];
  for (const item of informativos) {
    if (typeof item.mensagem !== "string" || item.mensagem.trim() === "") continue;
    const resposta = typeof item.resposta === "string" && item.resposta.trim() !== "" ? item.resposta : null;
    mensagens.push({
      categoria: "impugnacao",
      remetente: "Compras.gov.br",
      mensagem: item.mensagem,
      data_hora_oficial: typeof item.dataHoraInclusao === "string" ? item.dataHoraInclusao : "",
      resposta,
    });
  }
  return mensagens;
}

async function comPrazo<T>(trabalho: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    const motivo = signal.reason;
    throw motivo instanceof Error ? motivo : new DOMException("The operation was aborted", "AbortError");
  }
  let aoAbortar: () => void = () => {};
  const abortado = new Promise<never>((_, reject) => {
    aoAbortar = () => {
      const motivo = signal.reason;
      reject(motivo instanceof Error ? motivo : new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", aoAbortar, { once: true });
  });
  try {
    return await Promise.race([trabalho, abortado]);
  } finally {
    signal.removeEventListener("abort", aoAbortar);
  }
}

export async function lerImpugnacoesComprasnet(
  idCompra: string,
  opcoes: { captcha?: string; fetchImpl?: typeof fetch; prazoMs?: number } = {},
): Promise<LeituraImpugnacoes> {
  const fetchImpl = opcoes.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opcoes.prazoMs ?? 8_000);
  const informativos: InformativoQuadro[] = [];
  let pagina = 0;
  let quantidade: number | null = null;
  while (pagina < 20) {
    const url = new URL(`${BASE}/${idCompra}/quadro-informativo/impugnacoes`);
    url.searchParams.set("tamanhoPagina", "10");
    url.searchParams.set("pagina", String(pagina));
    if (opcoes.captcha) url.searchParams.set("captcha", opcoes.captcha);
    let res: Response;
    let texto: string;
    try {
      res = await comPrazo(
        fetchImpl(url.toString(), { headers: { Accept: "application/json" }, signal }),
        signal,
      );
      texto = await comPrazo(res.text(), signal);
    } catch (erro) {
      if (signal.aborted) {
        return {
          ok: false,
          motivo: "indisponivel",
          detalhe: "Tempo esgotado ao ler o quadro de impugnações.",
        };
      }
      throw erro;
    }
    const leitura = interpretarCorpoImpugnacoes(res.status, res.headers, texto);
    if (!leitura.ok) return leitura;
    if (quantidade === null && texto.trim()) {
      try {
        const body = JSON.parse(texto) as { quantidade?: unknown };
        quantidade = typeof body.quantidade === "number" ? body.quantidade : null;
      } catch {
        quantidade = null;
      }
    }
    informativos.push(...leitura.informativos);
    if (leitura.informativos.length < 10) break;
    if (quantidade !== null && informativos.length >= quantidade) break;
    pagina++;
  }
  if (quantidade !== null && informativos.length < quantidade) {
    return {
      ok: false,
      motivo: "indisponivel",
      detalhe: `Quadro truncado em ${informativos.length} de ${quantidade}.`,
    };
  }
  return { ok: true, informativos };
}

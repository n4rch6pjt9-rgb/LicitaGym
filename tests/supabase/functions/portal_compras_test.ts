import { assertEquals } from "jsr:@std/assert@1";
import { buildOrigemUrl } from "../../../supabase/functions/_shared/edital-url.ts";
import {
  decidirAtualizacaoPortal,
  diaBrasilia,
  escolherLotePortal,
  parsePortalProcessoUrl,
  portalDesatualizado,
  situacaoPortal,
} from "../../../supabase/functions/_shared/portal-compras.ts";
import { parseAcompanhamentoParams } from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";

const PAGINA =
  "https://www.portaldecompraspublicas.com.br/processos/AC/Secretaria-Municipal-de-Infraestrutura-e-Mobilidade-Urbana-de-Rio-Branco-SEINFRA-5569/RPE-034-2026-2026-499359";

Deno.test("parsePortalProcessoUrl aceita /processos/ e monta a API pública", () => {
  const processo = parsePortalProcessoUrl(PAGINA);
  assertEquals(processo?.codigoLicitacao, "499359");
  assertEquals(processo?.uf, "AC");
  assertEquals(
    processo?.api,
    "https://compras.api.portaldecompraspublicas.com.br/v2/licitacao/AC/Secretaria-Municipal-de-Infraestrutura-e-Mobilidade-Urbana-de-Rio-Branco-SEINFRA-5569/RPE-034-2026-2026-499359",
  );
  assertEquals(buildOrigemUrl(PAGINA)?.host, "www.portaldecompraspublicas.com.br");
});

Deno.test("parsePortalProcessoUrl rejeita API, http, outro caminho e outros portais", () => {
  assertEquals(
    parsePortalProcessoUrl("https://compras.api.portaldecompraspublicas.com.br/v2/licitacao/MG/x/1"),
    null,
  );
  assertEquals(parsePortalProcessoUrl("http://www.portaldecompraspublicas.com.br/processos/MG/orgao/PE-1-1"), null);
  assertEquals(parsePortalProcessoUrl("https://www.portaldecompraspublicas.com.br/"), null);
  assertEquals(parsePortalProcessoUrl("https://bllcompras.com/Process/ProcessView?param1=abc"), null);
  assertEquals(buildOrigemUrl("https://bllcompras.com/Process/ProcessView?param1=abc"), null);
  assertEquals(buildOrigemUrl("https://bnccompras.com/Process/ProcessView?param1=abc"), null);
  assertEquals(buildOrigemUrl("https://licitanet.com.br/sessao/179812"), null);
});

Deno.test("portalDesatualizado compara o dia de Brasília", () => {
  const agora = new Date("2026-10-08T15:00:00.000Z");
  assertEquals(diaBrasilia(agora), "2026-10-08");
  assertEquals(portalDesatualizado(null, agora), true);
  assertEquals(portalDesatualizado("2026-10-08T12:00:00.000Z", agora), false);
  assertEquals(portalDesatualizado("2026-10-07T15:00:00.000Z", agora), true);
});

Deno.test("decidirAtualizacaoPortal lê o portal quando o retrato não é de hoje", () => {
  const agora = new Date("2026-10-08T15:00:00.000Z");
  assertEquals(decidirAtualizacaoPortal(false, true, null, agora), "consultado");
  assertEquals(decidirAtualizacaoPortal(false, true, "2026-10-07T15:00:00.000Z", agora), "consultado");
  assertEquals(decidirAtualizacaoPortal(false, false, "2026-10-08T12:00:00.000Z", agora), "cache");
  assertEquals(decidirAtualizacaoPortal(true, true, "2026-10-08T12:00:00.000Z", agora), "fora_do_pipeline");
  assertEquals(decidirAtualizacaoPortal(true, false, "2026-10-08T14:59:40.000Z", agora), "debounce");
  assertEquals(decidirAtualizacaoPortal(true, false, "2026-10-08T14:00:00.000Z", agora), "consultado");
});

Deno.test("escolherLotePortal prioriza quem nunca foi lido e ignora prazo encerrado fora do pipeline", () => {
  const agora = new Date("2026-10-08T15:00:00.000Z");
  const link = (n: number) =>
    `https://portaldecompraspublicas.com.br/processos/MG/Prefeitura-${n}/PE-1-2026-${n}`;
  const lote = escolherLotePortal([
    { id: 1, link: link(1), dataFim: "2026-10-01T00:00:00.000Z", emPipeline: false, consultadoEm: null },
    { id: 2, link: link(2), dataFim: "2026-10-01T00:00:00.000Z", emPipeline: true, consultadoEm: "2026-10-07T12:00:00.000Z" },
    { id: 3, link: link(3), dataFim: "2026-12-01T00:00:00.000Z", emPipeline: false, consultadoEm: null },
    { id: 4, link: link(4), dataFim: "2026-12-01T00:00:00.000Z", emPipeline: false, consultadoEm: "2026-10-08T12:00:00.000Z" },
    { id: 5, link: "https://bllcompras.com/Process/ProcessView?param1=x", dataFim: "2026-12-01T00:00:00.000Z", emPipeline: true, consultadoEm: null },
  ], agora, 10);
  assertEquals(lote.map((p) => p.codigoLicitacao), ["3", "2"]);
});

Deno.test("situacaoPortal copia o código cru e atualizar só é true no literal", () => {
  assertEquals(situacaoPortal({ statusProcesso: 13 }), "13");
  assertEquals(situacaoPortal({ statusProcesso: "  " }), null);
  const ligado = parseAcompanhamentoParams("10", true);
  const texto = parseAcompanhamentoParams("10", "true");
  const desligado = parseAcompanhamentoParams("10", "false");
  const ausente = parseAcompanhamentoParams("10");
  if ("error" in ligado || "error" in texto || "error" in desligado || "error" in ausente) {
    throw new Error("id válido não pode falhar");
  }
  assertEquals(ligado.atualizar, true);
  assertEquals(texto.atualizar, true);
  assertEquals(desligado.atualizar, false);
  assertEquals(ausente.atualizar, false);
});

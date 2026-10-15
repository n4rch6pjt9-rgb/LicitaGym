import { assertEquals } from "jsr:@std/assert@1";
import { idSislog, resolverPortalOficial } from "../../../supabase/functions/_shared/portal-oficial.ts";
import { achadoPortalOficial, agenteEdital } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";

// Caso de referência: SISLOG/GO 114655 (Pregão 105/2025, Casa Militar), homologado em 14/11/2025.
const SISLOG = {
  fonte: "pncp",
  codigo_externo: "01409580000138-1-002061/2025",
  numero_edital: "Pregão - Eletrônico nº 114655/2025",
  link_sistema_origem: null,
  usuario_nome: "SISLOG - Sistema de Logística de Goiás",
};

Deno.test("portal oficial: SISLOG sem link de origem deriva DetalhesLicitacao pelo número do edital", () => {
  assertEquals(resolverPortalOficial(SISLOG), {
    nome: "SISLOG - Sistema de Logística de Goiás",
    url: "https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=114655",
    host: "sislog.go.gov.br",
    metodo: "derivado",
    url_pncp: "https://pncp.gov.br/app/editais/01409580000138/2025/2061",
  });
});

Deno.test("portal oficial: idSislog lê pregão e dispensa, recusa formato desconhecido", () => {
  assertEquals(idSislog("Pregão - Eletrônico nº 114655/2025"), "114655");
  assertEquals(idSislog("Dispensa nº 116918/2025"), "116918");
  assertEquals(idSislog("PE 105/2025"), null);
  assertEquals(idSislog(null), null);
});

Deno.test("portal oficial: link de origem válido vence a derivação", () => {
  const p = resolverPortalOficial({
    ...SISLOG,
    usuario_nome: "ECustomize Consultoria em Software S.A",
    link_sistema_origem:
      "https://www.portaldecompraspublicas.com.br/processos/GO/Prefeitura-Municipal-de-Exemplo-1/PE-1-2025-2025-123456",
  });
  assertEquals(p.metodo, "link_origem");
  assertEquals(p.host, "www.portaldecompraspublicas.com.br");
});

Deno.test("portal oficial: host fora da allowlist fica só com o nome, sem link", () => {
  const p = resolverPortalOficial({
    fonte: "pncp",
    codigo_externo: "12345678000190-1-000010/2025",
    numero_edital: "Pregão nº 10/2025",
    link_sistema_origem: "https://bllcompras.com/Process/ProcessView?param1=abc",
    usuario_nome: "BLL Compras",
  });
  assertEquals([p.nome, p.url, p.metodo], ["BLL Compras", null, "sem_link"]);
});

Deno.test("portal oficial: sem nome e sem link não inventa portal", () => {
  const p = resolverPortalOficial({ fonte: "pncp", codigo_externo: "x", numero_edital: null });
  assertEquals(p, { nome: null, url: null, host: null, metodo: "sem_link", url_pncp: null });
  assertEquals(resolverPortalOficial(null).metodo, "sem_link");
});

Deno.test("agente edital: informa o portal oficial e passa na validação de achado", () => {
  const r = agenteEdital({
    chunks: [],
    data_abertura: null,
    licitacao_id: 2123,
    portal_oficial: resolverPortalOficial(SISLOG),
  });
  const a = r.achados.find((x) => x.codigo === "portal.oficial")!;
  assertEquals(a.severidade, "info");
  assertEquals(a.dados.url, "https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=114655");
  assertEquals(a.fontes, [{ tipo: "registro", tabela: "licitacoes_externas", id: "2123" }]);
  assertEquals(validarAchado(a), null);
  assertEquals(r.situacao, "sem_documento");
});

Deno.test("agente edital: sem link vira atenção com o nome; sem nome vira portal.nao_informado", () => {
  const comNome = achadoPortalOficial(1, { nome: "BLL Compras", url: null, host: null, metodo: "sem_link", url_pncp: null });
  assertEquals([comNome.codigo, comNome.severidade], ["portal.oficial_sem_link", "atencao"]);
  assertEquals(validarAchado(comNome), null);
  const semNome = achadoPortalOficial(1, { nome: null, url: null, host: null, metodo: "sem_link", url_pncp: null });
  assertEquals(semNome.codigo, "portal.nao_informado");
  assertEquals(validarAchado(semNome), null);
});

Deno.test("agente edital: sem portal no dossiê o resultado não muda", () => {
  const r = agenteEdital({ chunks: [], data_abertura: null });
  assertEquals(r.achados, []);
});

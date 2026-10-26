import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  idSislog,
  resolverPortalOficial,
} from "../../../supabase/functions/_shared/portal-oficial.ts";
import {
  achadoPortalOficial,
  agenteEdital,
} from "../../../supabase/functions/_shared/agentes/edital.ts";
import type { ChunkEdital } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";

// Caso de referência: SISLOG/GO 114655 (Pregão 105/2025, Casa Militar), homologado em 14/11/2025.
const SISLOG = {
  fonte: "pncp",
  codigo_externo: "01409580000138-1-002061/2025",
  numero_edital: "Pregão - Eletrônico nº 114655/2025",
  link_sistema_origem: null,
  usuario_nome: "SISLOG - Sistema de Logística de Goiás",
};
const DETALHE_114655 =
  "https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=114655";

// usuario_nome é quem enviou a compra ao PNCP (ERP do órgão, integrador), não o portal da disputa (P1 do Codex no #375).
const ERP = {
  fonte: "pncp",
  codigo_externo: "12345678000190-1-000010/2025",
  numero_edital: "Pregão Eletrônico nº 10/2025",
  link_sistema_origem: null,
  usuario_nome: "IPM Sistemas",
};

function chunk(
  id: number,
  texto: string,
  pagina: number | null = 1,
): ChunkEdital {
  return { id, documento_id: 900, pagina, texto };
}

Deno.test("portal oficial: SISLOG mapeado deriva DetalhesLicitacao pelo número do edital", () => {
  assertEquals(resolverPortalOficial(SISLOG), {
    nome: "SISLOG",
    url: DETALHE_114655,
    host: "sislog.go.gov.br",
    metodo: "derivado",
    url_pncp: "https://pncp.gov.br/app/editais/01409580000138/2025/2061",
    sistema_pncp: "SISLOG - Sistema de Logística de Goiás",
    evidencia: null,
  });
});

Deno.test("portal oficial: idSislog lê pregão e dispensa, recusa formato desconhecido", () => {
  assertEquals(idSislog("Pregão - Eletrônico nº 114655/2025"), "114655");
  assertEquals(idSislog("Dispensa nº 116918/2025"), "116918");
  assertEquals(idSislog("PE 105/2025"), null);
  assertEquals(idSislog(null), null);
});

Deno.test("portal oficial: link de origem válido vence derivação e edital", () => {
  const p = resolverPortalOficial(
    {
      ...SISLOG,
      usuario_nome: "ECustomize Consultoria em Software S.A",
      link_sistema_origem:
        "https://www.portaldecompraspublicas.com.br/processos/GO/Prefeitura-Municipal-de-Exemplo-1/PE-1-2025-2025-123456",
    },
    [chunk(
      1,
      "A sessão pública será realizada no portal https://www.licitardigital.com.br.",
    )],
  );
  assertEquals([p.metodo, p.host, p.nome], [
    "link_origem",
    "www.portaldecompraspublicas.com.br",
    "www.portaldecompraspublicas.com.br",
  ]);
  assertEquals(p.sistema_pncp, "ECustomize Consultoria em Software S.A");
  assertEquals(p.evidencia, null);
});

Deno.test("portal oficial: link de origem fora da allowlist identifica o portal pelo host, sem link", () => {
  const p = resolverPortalOficial({
    ...ERP,
    link_sistema_origem:
      "https://portal-estranho.com.br/Process/ProcessView?param1=abc",
    usuario_nome: "Portal Estranho ERP",
  });
  assertEquals([p.nome, p.url, p.host, p.metodo], [
    "portal-estranho.com.br",
    null,
    null,
    "link_origem",
  ]);
  assertEquals(p.sistema_pncp, "Portal Estranho ERP");
});

Deno.test("portal oficial: link de origem BLL Compras e regionais na allowlist gera link clicável", () => {
  const p = resolverPortalOficial({
    ...ERP,
    link_sistema_origem:
      "https://bllcompras.com/Process/ProcessView?param1=abc",
    usuario_nome: "BLL Compras",
  });
  assertEquals([p.nome, p.url, p.host, p.metodo], [
    "bllcompras.com",
    "https://bllcompras.com/Process/ProcessView?param1=abc",
    "bllcompras.com",
    "link_origem",
  ]);
  assertEquals(p.sistema_pncp, "BLL Compras");
});

Deno.test("portal oficial: usuario_nome sozinho nunca vira portal (ERP/integrador)", () => {
  for (
    const usuario_nome of [
      "IPM Sistemas",
      "ECustomize Consultoria em Software S.A",
      "Betha Sistemas",
    ]
  ) {
    const p = resolverPortalOficial({ ...ERP, usuario_nome });
    assertEquals([p.nome, p.url, p.metodo, p.sistema_pncp], [
      null,
      null,
      "nao_identificado",
      usuario_nome,
    ]);
  }
});

Deno.test("portal oficial: sem link, endereço do portal no edital vira portal com o trecho como evidência", () => {
  const p = resolverPortalOficial(ERP, [
    chunk(10, "CAPÍTULO I - DO OBJETO. Aquisição de equipamentos de academia."),
    chunk(
      11,
      "2.1. A sessão pública será realizada por meio da plataforma www.licitardigital.com.br, no dia 20/11/2025.",
      3,
    ),
  ]);
  assertEquals([p.metodo, p.nome, p.url, p.host], [
    "edital",
    "www.licitardigital.com.br",
    null,
    null,
  ]);
  assertEquals(p.evidencia?.chunk_id, 11);
  assertEquals(p.evidencia?.pagina, 3);
  assertStringIncludes(p.evidencia!.trecho, "www.licitardigital.com.br");
});

Deno.test("portal oficial: endereço gov.br no edital vira link seguro", () => {
  const p = resolverPortalOficial(ERP, [
    chunk(
      20,
      "O pregão será realizado em sessão pública, por meio do sistema Compras.gov.br, no endereço eletrônico https://www.gov.br/compras.",
    ),
  ]);
  // O endereço escrito com https vence o nome solto "Compras.gov.br" (que o edital não escreveu como link).
  assertEquals([p.metodo, p.url, p.host], [
    "edital",
    "https://www.gov.br/compras",
    "www.gov.br",
  ]);
  const soEndereco = resolverPortalOficial(ERP, [
    chunk(
      21,
      "A sessão pública ocorrerá no endereço eletrônico https://www.gov.br/compras, em data a ser divulgada.",
    ),
  ]);
  assertEquals([soEndereco.url, soEndereco.host], [
    "https://www.gov.br/compras",
    "www.gov.br",
  ]);
});

Deno.test("portal oficial: aviso 'Contratação SISLOG nº' deriva o link do SISLOG mesmo com outro publicador", () => {
  const p = resolverPortalOficial(
    { ...ERP, usuario_nome: "ECustomize Consultoria em Software S.A" },
    [chunk(
      30,
      "AVISO DE LICITAÇÃO. Contratação SISLOG nº 114655. Abertura em 02/09/2025, no sítio https://sislog.go.gov.br/.",
    )],
  );
  assertEquals([p.metodo, p.url, p.nome], ["edital", DETALHE_114655, "SISLOG"]);
  assertEquals(p.evidencia?.chunk_id, 30);
});

Deno.test("portal oficial: URL de lei, PNCP ou e-mail no edital não vira portal", () => {
  const p = resolverPortalOficial(ERP, [
    chunk(
      40,
      "Lei 14.133/2021, disponível em https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm.",
    ),
    chunk(
      41,
      "O edital também está no Portal Nacional de Contratações Públicas, https://pncp.gov.br/app/editais.",
    ),
    chunk(
      42,
      "Dúvidas sobre a sessão pública pelo e-mail licitacao@prefeitura.exemplo.sp.gov.br.",
    ),
  ]);
  assertEquals([p.metodo, p.nome, p.evidencia], [
    "nao_identificado",
    null,
    null,
  ]);
});

Deno.test("portal oficial: site do órgão, transparência, TCE e cadastro não viram portal (revisor-codigo)", () => {
  for (
    const texto of [
      "O edital foi publicado no sítio www.prefeitura.x.sp.gov.br e no Diário Oficial.",
      "Íntegra do edital disponível no Portal da Transparência https://transparencia.x.sp.gov.br/licitacoes.",
      "Conforme a sessão pública e o Decreto, consulte www.tce.sp.gov.br.",
      "A disputa ocorrerá no portal compras.gov.brasileiro, conforme o aviso.",
    ]
  ) {
    const p = resolverPortalOficial(ERP, [chunk(50, texto)]);
    assertEquals(
      [p.metodo, p.nome, p.url],
      ["nao_identificado", null, null],
      texto,
    );
  }
});

Deno.test("portal oficial: cadastro no SICAF não rouba o portal da frase seguinte", () => {
  const p = resolverPortalOficial(ERP, [
    chunk(
      51,
      "Cadastro no SICAF, portal de compras www.gov.br/compras. A disputa ocorrerá em www.bnc.org.br, às 9h.",
    ),
  ]);
  assertEquals([p.metodo, p.nome, p.url], ["edital", "www.bnc.org.br", null]);
});

Deno.test("portal oficial: link do edital segue a regra do linkSistemaOrigem (https e tenant Paradigma da fonte)", () => {
  const paradigma = resolverPortalOficial(ERP, [
    chunk(
      52,
      "A sessão pública será realizada no portal https://egov.paradigmabs.com.br/sescrj/portal.",
    ),
  ]);
  assertEquals([paradigma.metodo, paradigma.nome, paradigma.url], [
    "edital",
    "egov.paradigmabs.com.br",
    null,
  ]);
  const http = resolverPortalOficial(ERP, [
    chunk(
      53,
      "A sessão pública será realizada no portal http://compras.gov.br/x.",
    ),
  ]);
  assertEquals([http.metodo, http.url], ["edital", null]);
});

Deno.test("portal oficial: 'SISLOG, Requisição nº' não deriva link de licitação", () => {
  const p = resolverPortalOficial(ERP, [
    chunk(54, "Contratação via SISLOG, Requisição nº 987654 de 2025."),
  ]);
  assertEquals(p.url, null);
});

Deno.test("portal oficial: linkSistemaOrigem com lixo, e-mail ou o próprio PNCP não identifica portal", () => {
  for (
    const link of [
      "N/A",
      "-",
      "0",
      "mailto:a@b.com",
      "contato@pref.sp.gov.br",
      "https://pncp.gov.br/app/editais/x",
    ]
  ) {
    const p = resolverPortalOficial({ ...ERP, link_sistema_origem: link });
    assertEquals(
      [p.metodo, p.nome, p.url],
      ["nao_identificado", null, null],
      link,
    );
  }
});

Deno.test("portal oficial: sem nada não inventa portal", () => {
  const p = resolverPortalOficial({
    fonte: "pncp",
    codigo_externo: "x",
    numero_edital: null,
  });
  assertEquals(p, {
    nome: null,
    url: null,
    host: null,
    metodo: "nao_identificado",
    url_pncp: null,
    sistema_pncp: null,
    evidencia: null,
  });
  assertEquals(resolverPortalOficial(null).metodo, "nao_identificado");
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
  assertEquals(a.dados.url, DETALHE_114655);
  assertEquals(a.fontes, [{
    tipo: "registro",
    tabela: "licitacoes_externas",
    id: "2123",
  }]);
  assertEquals(validarAchado(a), null);
  assertEquals(r.situacao, "sem_documento");
});

Deno.test("agente edital: portal achado no edital cita o trecho como fonte", () => {
  const chunks = [
    chunk(
      11,
      "A sessão pública será realizada por meio da plataforma www.licitardigital.com.br.",
      3,
    ),
  ];
  const a = achadoPortalOficial(7, resolverPortalOficial(ERP, chunks));
  assertEquals([a.codigo, a.severidade, a.natureza], [
    "portal.indicado_edital",
    "atencao",
    "inferencia",
  ]);
  assertEquals(a.fontes[1], {
    tipo: "chunk",
    chunk_id: 11,
    documento_id: 900,
    pagina: 3,
    trecho: chunks[0].texto,
    // spec 0038 (K-4): trecho limpo; sem item, que não se infere da janela da evidência
    trecho_limpo: chunks[0].texto,
  });
  assertEquals(validarAchado(a), null);
});

Deno.test("agente edital: só o publicador do PNCP vira portal.nao_informado, sem chamá-lo de portal", () => {
  const a = achadoPortalOficial(1, resolverPortalOficial(ERP));
  assertEquals([a.codigo, a.severidade, a.dados.sistema_pncp], [
    "portal.nao_informado",
    "atencao",
    "IPM Sistemas",
  ]);
  assertEquals(a.detalhe.includes("IPM"), false);
  assertEquals(validarAchado(a), null);
});

Deno.test("agente edital: sem portal no dossiê o resultado não muda", () => {
  const r = agenteEdital({ chunks: [], data_abertura: null });
  assertEquals(r.achados, []);
});

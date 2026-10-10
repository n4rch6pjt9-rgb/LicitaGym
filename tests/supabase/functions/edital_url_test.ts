import { assertEquals } from "jsr:@std/assert@1";
import {
  ALLOWED_ORIGEM_HOSTS,
  buildEditalUrl,
  buildPncpEditalUrl,
  isValidHttpsUrl,
  PARADIGMA_HOSTS,
  PARADIGMA_SAAS_TENANTS,
  parsePncpControleToUrl,
} from "../../../supabase/functions/_shared/edital-url.ts";

// -----------------------------------------------------------------------------
// Testes unitários para isValidHttpsUrl
// -----------------------------------------------------------------------------

Deno.test("isValidHttpsUrl: valida e rejeita protocolos e formatos inválidos", () => {
  // URLs HTTPS válidas
  assertEquals(
    isValidHttpsUrl("https://pncp.gov.br/app/editais/123/2026/1"),
    "https://pncp.gov.br/app/editais/123/2026/1",
  );
  assertEquals(
    isValidHttpsUrl("  https://compras.gov.br/processo  "),
    "https://compras.gov.br/processo",
  );
  assertEquals(
    isValidHttpsUrl("https://portal.compras.mg.gov.br/edital/123"),
    "https://portal.compras.mg.gov.br/edital/123",
  );

  // Rejeição de HTTP não seguro
  assertEquals(isValidHttpsUrl("http://pncp.gov.br/app/editais"), null);
  assertEquals(isValidHttpsUrl("http://compras.gov.br"), null);

  // Rejeição de outros esquemas e lixo
  assertEquals(isValidHttpsUrl("javascript:alert(1)"), null);
  assertEquals(isValidHttpsUrl("ftp://pncp.gov.br"), null);
  assertEquals(isValidHttpsUrl("data:text/html,..."), null);
  assertEquals(isValidHttpsUrl("not-a-url"), null);
  assertEquals(isValidHttpsUrl(""), null);
  assertEquals(isValidHttpsUrl(null), null);
  assertEquals(isValidHttpsUrl(undefined), null);
  assertEquals(isValidHttpsUrl(12345), null);

  // Modo restrito (allowlist de hosts estáticos conhecidos)
  assertEquals(
    isValidHttpsUrl("https://pncp.gov.br/app/editais/1", true),
    "https://pncp.gov.br/app/editais/1",
  );
  assertEquals(
    isValidHttpsUrl("https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/compra", true),
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/compra",
  );
  assertEquals(
    isValidHttpsUrl("https://compras.gov.br/consulta", true),
    "https://compras.gov.br/consulta",
  );
  assertEquals(
    isValidHttpsUrl("https://malicious-domain.com/fake-edital", true),
    null,
  );

  // Allowlist de origem: *.gov.br e SEST SENAT, sem lookalikes
  assertEquals(
    isValidHttpsUrl("https://portal.compras.mg.gov.br/edital/123", true, ALLOWED_ORIGEM_HOSTS),
    "https://portal.compras.mg.gov.br/edital/123",
  );
  assertEquals(
    isValidHttpsUrl("https://compras.sestsenat.org.br/portal/x", true, ALLOWED_ORIGEM_HOSTS),
    "https://compras.sestsenat.org.br/portal/x",
  );
  assertEquals(isValidHttpsUrl("https://evilgov.br/edital", true, ALLOWED_ORIGEM_HOSTS), null);
  assertEquals(isValidHttpsUrl("https://pncp.gov.br.evil.com/edital", true, ALLOWED_ORIGEM_HOSTS), null);
  assertEquals(isValidHttpsUrl("https://pncp.gov.br@evil.com/edital", true, ALLOWED_ORIGEM_HOSTS), null);
  assertEquals(isValidHttpsUrl("https://sestsenat.org.br/portal", true, ALLOWED_ORIGEM_HOSTS), null);

  // A allowlist estática (URLs construídas) continua restrita
  assertEquals(isValidHttpsUrl("https://portal.compras.mg.gov.br/edital/123", true), null);
});

Deno.test("buildEditalUrl: linkSistemaOrigem fora da allowlist é descartado", () => {
  for (const fonte of ["pncp", "comprasnet", "sestsenat", "custom"]) {
    assertEquals(
      buildEditalUrl({ fonte, raw: { linkSistemaOrigem: "https://malicious-domain.com/fake-edital" } }),
      null,
    );
    assertEquals(
      buildEditalUrl({ fonte, linkSistemaOrigem: "https://pncp.gov.br.evil.com/edital" }),
      null,
    );
  }
});

// -----------------------------------------------------------------------------
// Testes unitários para parsePncpControleToUrl e buildPncpEditalUrl
// -----------------------------------------------------------------------------

Deno.test("buildPncpEditalUrl: constrói URL com CNPJ normalizado e sequencial inteiro", () => {
  assertEquals(
    buildPncpEditalUrl("07.486.108/0001-85", 2026, 1),
    "https://pncp.gov.br/app/editais/07486108000185/2026/1",
  );
  assertEquals(
    buildPncpEditalUrl("44892693000140", "2026", "000157"),
    "https://pncp.gov.br/app/editais/44892693000140/2026/157",
  );

  // Inválidos
  assertEquals(buildPncpEditalUrl("123", 2026, 1), null); // CNPJ < 14 dígitos
  assertEquals(buildPncpEditalUrl("44892693000140", 0, 1), null); // Ano inválido
  assertEquals(buildPncpEditalUrl("44892693000140", 2026, 0), null); // Seq <= 0
});

Deno.test("parsePncpControleToUrl: extrai CNPJ, ano e sequencial de formato estendido e legado", () => {
  // Formato estendido PNCP: {CNPJ}-{tipo}-{seqPad}/{ano}
  assertEquals(
    parsePncpControleToUrl("44892693000140-1-000157/2026"),
    "https://pncp.gov.br/app/editais/44892693000140/2026/157",
  );
  assertEquals(
    parsePncpControleToUrl("07486108000185-1-000001/2026"),
    "https://pncp.gov.br/app/editais/07486108000185/2026/1",
  );

  // Formato legado PNCP: {CNPJ}-{seqPad}/{ano}
  assertEquals(
    parsePncpControleToUrl("07486108000185-000005/2025"),
    "https://pncp.gov.br/app/editais/07486108000185/2025/5",
  );

  // Inválidos
  assertEquals(parsePncpControleToUrl("invalido"), null);
  assertEquals(parsePncpControleToUrl(""), null);
  assertEquals(parsePncpControleToUrl(null), null);
});

// -----------------------------------------------------------------------------
// Testes de buildEditalUrl por Fonte
// -----------------------------------------------------------------------------

Deno.test("buildEditalUrl: Fonte PNCP", () => {
  // 1. Linha com codigo_externo padrão PNCP
  const row1 = {
    fonte: "pncp",
    codigo_externo: "44892693000140-1-000157/2026",
    orgao_cnpj: "44892693000140",
  };
  assertEquals(
    buildEditalUrl(row1),
    "https://pncp.gov.br/app/editais/44892693000140/2026/157",
  );

  // 2. Linha sem codigo_externo mas com raw.numero_controle_pncp
  const row2 = {
    fonte: "pncp",
    raw: {
      numero_controle_pncp: "07486108000185-1-000042/2026",
    },
  };
  assertEquals(
    buildEditalUrl(row2),
    "https://pncp.gov.br/app/editais/07486108000185/2026/42",
  );

  // 3. Linha com cnpj + ano + sequencial em raw (campos da busca / consulta PNCP)
  const row3 = {
    fonte: "pncp",
    orgao_cnpj: "07486108000185",
    raw: {
      ano: 2026,
      numero_sequencial: 99,
    },
  };
  assertEquals(
    buildEditalUrl(row3),
    "https://pncp.gov.br/app/editais/07486108000185/2026/99",
  );

  // 4. PNCP com fallback para linkSistemaOrigem se codigo_externo ausente
  const row4 = {
    fonte: "pncp",
    raw: {
      linkSistemaOrigem: "https://comprasnet.gov.br/edital/123",
    },
  };
  assertEquals(
    buildEditalUrl(row4),
    "https://comprasnet.gov.br/edital/123",
  );

  // 5. PNCP com linkSistemaOrigem HTTP inseguro é descartado
  const row5 = {
    fonte: "pncp",
    raw: {
      linkSistemaOrigem: "http://inseguro.gov.br/edital",
    },
  };
  assertEquals(buildEditalUrl(row5), null);
});

Deno.test("buildEditalUrl: Fonte Compras.gov.br", () => {
  // 1. Linha com idCompra (17 dígitos) em raw
  const row1 = {
    fonte: "comprasnet",
    raw: {
      idCompra: "98703305900102026",
    },
  };
  assertEquals(
    buildEditalUrl(row1),
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=98703305900102026",
  );

  // 2. id_externo não é idCompra (int, nCdProcesso do SEST SENAT): ignorado
  assertEquals(buildEditalUrl({ fonte: "comprasgov", id_externo: "123450" }), null);
  assertEquals(buildEditalUrl({ fonte: "comprasgov", id_externo: 98703305900102026 }), null);

  // 2.1 Linha como a Edge Function recebe (sem raw): idCompra vem do codigo_externo
  const row2 = {
    fonte: "comprasgov_pesquisa_preco",
    codigo_externo: "COMPRASGOV-PP-98703305900102026",
  };
  assertEquals(
    buildEditalUrl(row2),
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=98703305900102026",
  );

  // 2.2 idCompra fora do formato de 17 dígitos ou como number (perde precisão) é rejeitado
  assertEquals(
    buildEditalUrl({ fonte: "comprasgov_pesquisa_preco", codigo_externo: "COMPRASGOV-PP-987654" }),
    null,
  );
  assertEquals(buildEditalUrl({ fonte: "comprasnet", raw: { idCompra: 987654 } }), null);
  assertEquals(buildEditalUrl({ fonte: "comprasnet", raw: { idCompra: "9870330590010202X" } }), null);

  // 3. Compras.gov com linkSistemaOrigem
  const row3 = {
    fonte: "compras_gov",
    linkSistemaOrigem: "https://www.compras.gov.br/edital/detalhe?id=555",
  };
  assertEquals(
    buildEditalUrl(row3),
    "https://www.compras.gov.br/edital/detalhe?id=555",
  );

  // 4. Compras.gov sem identificador de compra e sem link
  const row4 = {
    fonte: "comprasnet",
    objeto: "Compra sem ID",
  };
  assertEquals(buildEditalUrl(row4), null);
});

Deno.test("buildEditalUrl: Fonte SEST SENAT", () => {
  // 1. Linha com linkSistemaOrigem
  const row1 = {
    fonte: "sestsenat",
    id_externo: 1,
    linkSistemaOrigem: "https://compras.sestsenat.org.br/portal/Download.aspx?q=edital123",
  };
  assertEquals(
    buildEditalUrl(row1),
    "https://compras.sestsenat.org.br/portal/Download.aspx?q=edital123",
  );

  // 2. Sem link da origem: entra o mural do portal (não há página estável por id_externo)
  const row2 = {
    fonte: "sestsenat",
    modulo: 59,
    id_externo: 1,
    objeto: "Equipamentos de musculação",
  };
  assertEquals(
    buildEditalUrl(row2),
    "https://compras.sestsenat.org.br/portal/Mural.aspx",
  );

  // 3. Alias e tenants SaaS do Paradigma também ganham o mural
  assertEquals(buildEditalUrl({ fonte: "sest_senat" }), "https://compras.sestsenat.org.br/portal/Mural.aspx");
  assertEquals(buildEditalUrl({ fonte: "sescsp" }), "https://scr360.paradigmabs.com.br/sescsp/portal/Mural.aspx");
  assertEquals(buildEditalUrl({ fonte: "sescrj" }), "https://egov.paradigmabs.com.br/SESCRJ/portal/Mural.aspx");
  assertEquals(buildEditalUrl({ fonte: "fiesc" }), "https://portaldecompras.fiesc.com.br/portal/Mural.aspx");
});

Deno.test("buildEditalUrl: Outras fontes e casos genéricos", () => {
  // 1. Fonte estadual com linkSistemaOrigem HTTPS válido
  const row1 = {
    fonte: "compras_rj",
    linkSistemaOrigem: "https://www.compras.rj.gov.br/edital/2026/01",
  };
  assertEquals(
    buildEditalUrl(row1),
    "https://www.compras.rj.gov.br/edital/2026/01",
  );

  // 2. Linha sem fonte explícita mas com codigo_externo padrão PNCP
  const row2 = {
    codigo_externo: "07486108000185-1-000001/2026",
  };
  assertEquals(
    buildEditalUrl(row2),
    "https://pncp.gov.br/app/editais/07486108000185/2026/1",
  );

  // 3. Linha vazia ou com link HTTP inseguro -> retorna null
  assertEquals(buildEditalUrl({}), null);
  assertEquals(buildEditalUrl(null), null);
  assertEquals(buildEditalUrl(undefined), null);
  assertEquals(
    buildEditalUrl({
      fonte: "custom",
      linkSistemaOrigem: "http://inseguro.com/edital",
    }),
    null,
  );
  assertEquals(
    buildEditalUrl({
      fonte: "custom",
      linkSistemaOrigem: "javascript:alert(1)",
    }),
    null,
  );
});

// -----------------------------------------------------------------------------
// Portais Paradigma do Sistema S
// -----------------------------------------------------------------------------

/** (slug, base_url) de cada Fonte cadastrada em services/coletor-externo/coletor/paradigma.py. */
async function fontesParadigma(): Promise<Array<{ slug: string; base: URL }>> {
  const py = await Deno.readTextFile("./services/coletor-externo/coletor/paradigma.py");
  return [...py.matchAll(/Fonte\("([a-z_]+)",[^\n]*?"(https:\/\/[^"]+)"/g)].map((m) => ({ slug: m[1], base: new URL(m[2]) }));
}

Deno.test("allowlist de origem acompanha FONTES do coletor Paradigma (host próprio ou host SaaS + tenant)", async () => {
  const fontes = await fontesParadigma();
  assertEquals(fontes.length >= 15, true, `esperava >= 15 portais em FONTES, achei ${fontes.length}`);
  const proprios = new Set<string>();
  const saas = new Map<string, Map<string, string>>();
  for (const { slug, base } of fontes) {
    const host = base.hostname.toLowerCase();
    // Link real do portal, na linha da própria fonte, tem de passar
    assertEquals(
      buildEditalUrl({ fonte: slug, linkSistemaOrigem: `${base.href}/Mural.aspx` }) !== null,
      true,
      `portal ${slug} (${base.href}) recusado`,
    );
    if (host.endsWith(".paradigmabs.com.br")) {
      const tenant = base.pathname.split("/")[1].toLowerCase();
      if (!saas.has(host)) saas.set(host, new Map());
      saas.get(host)!.set(tenant, slug);
    } else {
      proprios.add(host);
    }
  }
  assertEquals([...proprios].sort(), [...PARADIGMA_HOSTS].sort(), "PARADIGMA_HOSTS diverge do paradigma.py");
  assertEquals(
    Object.fromEntries([...saas].map(([h, t]) => [h, Object.fromEntries(t)])),
    PARADIGMA_SAAS_TENANTS,
    "PARADIGMA_SAAS_TENANTS diverge do paradigma.py",
  );
});

Deno.test("buildEditalUrl aceita linkSistemaOrigem de portal Paradigma e recusa parecidos", () => {
  assertEquals(
    buildEditalUrl({ fonte: "sfiec", linkSistemaOrigem: "https://portaldecompras.sfiec.org.br/portal/Mural.aspx?nNmTela=E" }),
    "https://portaldecompras.sfiec.org.br/portal/Mural.aspx?nNmTela=E",
  );
  assertEquals(
    buildEditalUrl({ fonte: "sescdn", raw: { linkSistemaOrigem: "https://egov-br.paradigmabs.com.br/sescdn/portal/Mural.aspx" } }),
    "https://egov-br.paradigmabs.com.br/sescdn/portal/Mural.aspx",
  );
  // Tenant com maiúsculas como no cadastro (SESCRJ)
  assertEquals(
    buildEditalUrl({ fonte: "sescrj", linkSistemaOrigem: "https://egov.paradigmabs.com.br/SESCRJ/portal/Mural.aspx" }),
    "https://egov.paradigmabs.com.br/SESCRJ/portal/Mural.aspx",
  );
  // Domínio SaaS inteiro não é liberado: outro cliente do Paradigma fica de fora
  assertEquals(buildEditalUrl({ fonte: "x", linkSistemaOrigem: "https://outrocliente.paradigmabs.com.br/portal" }), null);
  assertEquals(buildEditalUrl({ fonte: "x", linkSistemaOrigem: "https://paradigmabs.com.br/portal" }), null);
  // Lookalikes
  assertEquals(buildEditalUrl({ fonte: "fiesc", linkSistemaOrigem: "https://portaldecompras.fiesc.com.br.evil.com/p" }), null);
  assertEquals(buildEditalUrl({ fonte: "fiesc", linkSistemaOrigem: "https://evil-portaldecompras.fiesc.com.br.io/p" }), null);
  assertEquals(buildEditalUrl({ fonte: "fiesc", linkSistemaOrigem: "http://portaldecompras.fiesc.com.br/portal" }), null);
});

Deno.test("host SaaS compartilhado do Paradigma: só tenant do Sistema S e da própria fonte", () => {
  const url = (u: string, fonte = "sescrj") => buildEditalUrl({ fonte, linkSistemaOrigem: u });
  // Outro cliente no mesmo host SaaS (revisão do PR #76)
  assertEquals(url("https://egov.paradigmabs.com.br/outrocliente/portal/Mural.aspx"), null);
  assertEquals(url("https://egov.paradigmabs.com.br/outrocliente/portal/Mural.aspx", "x"), null);
  // Sem tenant, tenant vazio, travessia de caminho
  assertEquals(url("https://egov.paradigmabs.com.br/"), null);
  assertEquals(url("https://egov.paradigmabs.com.br//outrocliente/portal"), null);
  assertEquals(url("https://egov.paradigmabs.com.br/sescrj/../outrocliente/portal"), null);
  // Subdomínio de host SaaS
  assertEquals(url("https://x.egov.paradigmabs.com.br/sescrj/portal"), null);
  // Tenant válido, mas de outra fonte: link do Sesc BA numa linha do Sesc RJ, ou numa linha fora do Paradigma
  assertEquals(url("https://egov.paradigmabs.com.br/sescba/portal/Mural.aspx", "sescrj"), null);
  assertEquals(url("https://egov.paradigmabs.com.br/sescba/portal/Mural.aspx", "pncp"), null);
  // isValidHttpsUrl no modo restrito também recusa tenant fora da lista
  assertEquals(isValidHttpsUrl("https://egov.paradigmabs.com.br/outrocliente/x", true, ALLOWED_ORIGEM_HOSTS), null);
  assertEquals(
    isValidHttpsUrl("https://egov.paradigmabs.com.br/sescba/x", true, ALLOWED_ORIGEM_HOSTS),
    "https://egov.paradigmabs.com.br/sescba/x",
  );
});

Deno.test("enfileiramento diário: cada fonte Paradigma coletável aponta para o próprio mural", async () => {
  const fontes = await fontesParadigma();
  const fila = fontes.filter((fonte) => fonte.slug !== "fiemg").map((fonte) => fonte.slug).sort();
  assertEquals(fontes.some((fonte) => fonte.slug === "fiemg"), true);
  assertEquals(fila.includes("fiemg"), false);
  assertEquals(fila.includes("sestsenat"), true);
  assertEquals(fila.includes("sfiec"), true);
  for (const slug of fila) {
    const fonte = fontes.find((item) => item.slug === slug)!;
    assertEquals(
      buildEditalUrl({ fonte: slug }),
      `${fonte.base.href}/Mural.aspx`,
      slug,
    );
  }
  assertEquals(
    buildEditalUrl({ fonte: "fiemg" }),
    "https://compras.fiemg.com.br/portal/Mural.aspx",
  );
});

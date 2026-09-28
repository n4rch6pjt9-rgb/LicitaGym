import { assertEquals } from "jsr:@std/assert@1";
import {
  ALLOWED_ORIGEM_HOSTS,
  buildEditalUrl,
  buildPncpEditalUrl,
  isValidHttpsUrl,
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

  // 2. Linha sem linkSistemaOrigem nem idCompras -> retorna null (regra a confirmar / sem link público direto por id)
  const row2 = {
    fonte: "sestsenat",
    modulo: 59,
    id_externo: 1,
    objeto: "Equipamentos de musculação",
  };
  assertEquals(
    buildEditalUrl(row2),
    null,
  );

  // 3. SEST SENAT sem id_externo e sem link
  const row3 = {
    fonte: "sestsenat",
  };
  assertEquals(buildEditalUrl(row3), null);
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

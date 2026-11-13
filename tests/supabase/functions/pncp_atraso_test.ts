import { assertEquals } from "jsr:@std/assert@1";
import {
  compararAtrasoPncp,
  enriquecerArquivosComPortal,
  mesclarHistoricoPortal,
  sincronizarPortalOficialEAtraso,
  type MensagemDisputaDB,
} from "../../../supabase/functions/api-dashboard-oportunidades/pncpAtraso.ts";
import type {
  ArquivoAcompanhamento,
  HistoricoEvento,
} from "../../../supabase/functions/api-dashboard-oportunidades/types.ts";

Deno.test("compararAtrasoPncp: detecta atraso quando portal tem dados mais recentes", () => {
  const pncpData = "2026-10-25T10:00:00Z";
  const portalDataMaisRecente = "2026-10-25T11:30:00Z";

  // Portal com atualização posterior
  assertEquals(compararAtrasoPncp(pncpData, portalDataMaisRecente, false, false), true);

  // Portal com dados na mesma data ou antes
  const portalDataAntiga = "2026-10-25T09:00:00Z";
  assertEquals(compararAtrasoPncp(pncpData, portalDataAntiga, false, false), false);

  // Falha técnica no PNCP (ex.: erro 422 ao baixar arquivos de S3)
  assertEquals(compararAtrasoPncp(pncpData, portalDataAntiga, true, false), true);

  // Mensagens em tempo real no portal da sessão e PNCP parado
  assertEquals(compararAtrasoPncp(pncpData, pncpData, false, true), true);
});

Deno.test("mesclarHistoricoPortal: enriquece histórico com mensagens oficiais da disputa", () => {
  const eventosPncp: HistoricoEvento[] = [
    {
      data: "2026-10-20T08:00:00Z",
      categoria: "Contratação",
      tipo: "Inclusão",
      item: null,
      documentoTitulo: null,
      justificativa: "Publicação do edital no PNCP",
    },
  ];

  const mensagensPortal: MensagemDisputaDB[] = [
    {
      data_hora_oficial: "2026-10-25T14:00:00Z",
      categoria: "chat",
      remetente: "Pregoeiro",
      mensagem: "Sessão pública aberta para propostas do item 1.",
      item_numero: 1,
    },
    {
      data_hora_oficial: "2026-10-25T14:15:00Z",
      categoria: "diligencia",
      remetente: "Comissão",
      mensagem: "Solicitado esclarecimento de proposta técnica.",
      item_numero: null,
    },
  ];

  const mesclado = mesclarHistoricoPortal(eventosPncp, mensagensPortal, "Compras.gov.br");

  assertEquals(mesclado.length, 3);
  assertEquals(mesclado[0].origem, "pncp");
  assertEquals(mesclado[1].origem, "portal_oficial");
  assertEquals(mesclado[1].tipo, "Mensagem do Pregoeiro");
  assertEquals(mesclado[1].categoria, "Portal Oficial (Compras.gov.br)");
  assertEquals(mesclado[1].justificativa, "[Pregoeiro] Sessão pública aberta para propostas do item 1.");
  assertEquals(mesclado[2].origem, "portal_oficial");
  assertEquals(mesclado[2].tipo, "Diligência Oficial");
});

Deno.test("enriquecerArquivosComPortal: vincula portal oficial a cada arquivo para contorno de erro 422", () => {
  const arquivos: ArquivoAcompanhamento[] = [
    {
      titulo: "Edital e Anexos",
      tipo: "Edital",
      url: "https://pncp.gov.br/pncp-api/v1/orgaos/46377800000127/compras/2026/4678/arquivos/1",
      sequencialDocumento: 1,
    },
  ];

  const portalUrl = "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=16021805900022026";
  const enriquecidos = enriquecerArquivosComPortal(arquivos, portalUrl);

  assertEquals(enriquecidos.length, 1);
  assertEquals(enriquecidos[0].url_portal_oficial, portalUrl);
  assertEquals(enriquecidos[0].url, arquivos[0].url);
});

Deno.test("sincronizarPortalOficialEAtraso: identifica portal oficial e sinaliza atraso do PNCP", async () => {
  const row = {
    id: 12345,
    fonte: "comprasnet",
    link_sistema_origem: "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=16021805900022026",
    numero_edital: "90002/2026",
  };

  const fakeClient = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  };

  const compraSection = {
    dados: {
      situacao: "Divulgação",
      modalidade: "Pregão Eletrônico",
      objeto: "Aquisição de equipamentos",
      valorEstimado: 10000,
      valorHomologado: null,
      datas: {
        publicacao: "2026-10-01T10:00:00Z",
        aberturaProposta: null,
        encerramentoProposta: null,
        inclusao: "2026-10-01T10:00:00Z",
        atualizacao: "2026-10-01T10:00:00Z",
      },
      linkSistemaOrigem: "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=16021805900022026",
    },
    erro: null,
  };

  const historicoSection = {
    dados: [],
    total: 0,
    erro: null,
  };

  // Simula erro no PNCP (como erro 422 em arquivos)
  const arquivosSection = {
    dados: [],
    total: 0,
    erro: "Erro 422 ao consultar storage de arquivos do PNCP",
  };

  const resultado = await sincronizarPortalOficialEAtraso(
    fakeClient as any,
    12345,
    row,
    null,
    null,
    compraSection,
    historicoSection,
    arquivosSection,
  );

  assertEquals(resultado.pncpEmAtraso, true);
  assertEquals(resultado.portalOficial !== null, true);
  assertEquals(resultado.portalOficial?.host, "cnetmobile.estaleiro.serpro.gov.br");
  assertEquals(resultado.arquivosAtualizados.url_portal_oficial, resultado.urlAcompanhamento);
});

Deno.test("sincronizarPortalOficialEAtraso: consulta ao portal sem novos eventos não marca atraso falso no PNCP", async () => {
  const row = {
    id: 999,
    fonte: "comprasnet",
    link_sistema_origem: "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=16021805900022026",
    numero_edital: "90002/2026",
  };

  const fakeClient = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                consultado_em: "2026-10-25T15:00:00Z",
                situacao: "Em andamento",
                codigo_licitacao: "123",
                erro: null,
              },
              error: null,
            }),
        }),
      }),
    }),
  };

  const compraSection = {
    dados: {
      situacao: "Divulgação",
      modalidade: "Pregão Eletrônico",
      objeto: "Aquisição de equipamentos",
      valorEstimado: 10000,
      valorHomologado: null,
      datas: {
        publicacao: "2026-10-25T10:00:00Z",
        aberturaProposta: null,
        encerramentoProposta: null,
        inclusao: "2026-10-25T10:00:00Z",
        atualizacao: "2026-10-25T10:00:00Z",
      },
      linkSistemaOrigem: null,
    },
    erro: null,
  };

  const historicoSection = { dados: [], total: 0, erro: null };
  const arquivosSection = { dados: [], total: 0, erro: null };

  const resultado = await sincronizarPortalOficialEAtraso(
    fakeClient as any,
    999,
    row,
    null,
    null,
    compraSection,
    historicoSection,
    arquivosSection,
  );

  // Embora consultado_em seja 15:00 e o PNCP seja 10:00, o robô ter consultado não significa evento novo oficial
  assertEquals(resultado.pncpEmAtraso, false);
  assertEquals(resultado.portalOficial?.consultado_em, "2026-10-25T15:00:00Z");
});

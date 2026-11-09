# 0049: Ler a busca do PNCP (editais e atas) como segunda rota do detalhe quando a Consulta cai

- **Status:** rascunho
- **Alimenta:** módulo 1 (Radar de oportunidades, "no ar, em ajuste") de `docs/produto/ESCOPO.md`. **Não** alimenta
  fase da 0032: pela regra de foco fica `parada` até o Marcelo decidir se abre exceção, como fez com a 0040 e a 0048
  (ver Perguntas em aberto).
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** pncp, edge-functions, dashboard-contrato, dashboard-tela
- **Depende do ok do Marcelo:** sim (republica Edge Function em produção; decisão de produto no aviso e na UI)

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação, fontes | sim |
| 3 | `.claude/rules/regras-negocio.md` | "falha de API nunca vira `historico`"; status desconhecido | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 1 e regra de foco | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` | regra de foco (esta spec não é fase dela) | não: ler |
| 6 | esta spec | | não: ler |
| 7 | `.claude/rules/pncp.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções | ler antes |
| 8 | `supabase/functions/api-dashboard-oportunidades/README.md` (ação `acompanhamento`) | contrato atual do detalhe | não: ler |
| 8a | `supabase/functions/api-dashboard-oportunidades/acompanhamento.ts`, `copiaLocal.ts`, `types.ts` | onde as seções e a cópia local são montadas (PR #501) | não: ler |
| 8b | `supabase/functions/_shared/pncp/search-client.ts`, `_shared/http-client/` | cliente da busca que já existe (só `pcaorgao`) e lease do host | não: ler |
| 8c | `services/coletor-externo/coletor/pncp.py` (`PncpClient.buscar`, `MODOS`) | a mesma busca no coletor: não duplicar regra | não: ler |
| 8d | Dashboard `src/components/opportunities/AvisoCopiaLocal.tsx`, `OpportunityAcompanhamentoView.tsx`, `src/test/detalhe-copia-local.test.tsx` | onde o aviso é escrito hoje | não: ler no outro repo |
| 9 | `docs/pncp/schemas-consultas-pncp.md` **seção 6 (Busca)** e `scripts/probe-pncp-busca.py` | contrato medido em 09/11/2026 | não: ler |
| 10 | `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md`, `.claude/skills/verificar-producao/SKILL.md`; no Dashboard, os `.md` de `frontend-dashboard`, `ux-ui-licitagym`, `run-dashboard`, `deploy-dashboard` | procedimento de cada etapa | quando invocados |

## Problema

Em 09/11/2026 o detalhe da oportunidade **#1892** (Guararema, Pregão Eletrônico 21/2026, controle
`46523262000131-1-000118/2026`) mostrou "O PNCP não respondeu (HTTP 503 on pncp.gov.br). Mostrando os itens da cópia
gravada pelo LicitaGym, fonte PNCP, sem data da última conferência no PNCP. Pode haver mudança posterior". O texto vem
de `AvisoCopiaLocal.tsx` (Dashboard) quando a seção chega com `origem: "copia_local"` (backend, `copiaLocal.ts`, PR #501).

Medido agora (09/11/2026, `scripts/probe-pncp-busca.py`, uma requisição por vez):
- `/api/consulta/v1/.../compras/2026/118`, `/api/pncp/v1/.../itens` e `/atas`: **503** (HTML "No server is available";
  outra compra, `01612089000100/2026/168`, também 503).
- No mesmo intervalo, `/api/search/?q="46523262000131-1-000118/2026"&tipos_documento=edital`: **200**, `total=1`, com
  objeto, situação, valores estimado e homologado, datas e `data_atualizacao_pncp`; `tipos_documento=ata`: **200**,
  as **10** atas da compra.
- A busca **não** traz itens, resultados, documentos, histórico nem `processo` (seção 6.4 da doc).
- Banco (MCP, leitura, 09/11): #1892 tem 29 linhas em `licitacao_itens`, 8 em `licitacao_documentos`;
  `pncp_data_atualizacao = 2026-08-25 13:26:11+00`, igual à `data_atualizacao_pncp` da busca (`10:26:11`, Brasília).
- A busca derruba a conexão sem responder em ≈ 63 % das tentativas (52 de 82 nas rodadas com retry).

Hoje, com a Consulta fora: Resumo da compra e Atas aparecem em erro, e Itens/Documentos vêm da cópia **sem dizer se
a compra mudou no PNCP depois da cópia**. A busca responde a essas duas lacunas, mas não substitui itens e documentos.

## Proposta de fallback (ordem das fontes por seção)

| Seção do detalhe | 1ª fonte (hoje) | 2ª fonte (nova) | 3ª fonte | Tudo falhou |
|---|---|---|---|---|
| `compra` (resumo) | Consulta `/api/consulta/v1/.../compras/{a}/{s}` | **busca** `edital`, item cujo `numero_controle_pncp` é idêntico | — | `erro` como hoje |
| `atas` | `/api/pncp/v1/.../atas` | **busca** `ata`, itens com controle `= {controle da compra}-…` | — | `erro` como hoje |
| `itens` | `/api/pncp/v1/.../itens` | — (a busca não tem itens) | cópia local (#501) + **conferência pela busca** | `erro` como hoje |
| `arquivos` | `/api/pncp/v1/.../arquivos` | — | cópia local (#501) + **conferência pela busca** | `erro` como hoje |
| `historico` | `/api/pncp/v1/.../historico` | — | — | `erro` como hoje |

Regras:
- A busca só entra quando a 1ª fonte da seção falhou sem dados (mesmo critério de `precisaDaCopia`). Nunca mistura
  campos das duas fontes numa seção. O `erro` da 1ª fonte é mantido na seção.
- **Uma** chamada à busca de edital por detalhe, reaproveitada por `compra` e pela conferência de itens/arquivos; uma
  à busca de atas. As duas passam pelo lease de `pncp.gov.br` (`UnifiedHttpClient`), como as outras.
- Casamento só por `numero_controle_pncp` exato (q entre aspas + igualdade do campo). Item que não casa = busca sem
  resultado, nunca "o primeiro da lista".
- Datas sem offset da busca são horário de Brasília (medido). Saem em ISO com `-03:00`.
- `situacao_nome` da busca é a situação da publicação: não muda `prioridade` nem `fase` (regra "falha de API nunca vira
  `historico`" continua valendo; a busca é só leitura de tela).
- **Conferência da cópia:** quando itens/arquivos vêm da cópia e a busca respondeu, a seção leva
  `conferencia_busca = { pncp_atualizado_em, gravado_em, compra_mudou: boolean | null }`, comparando
  `data_atualizacao_pncp` (busca) com `licitacoes_externas.pncp_data_atualizacao`. `null` quando uma das duas falta.
  Limite declarado na tela: a busca traz a atualização **da compra** (`dataAtualizacao`), não a global
  (`dataAtualizacaoGlobal`, que muda com item e documento): "compra sem mudança" não prova item sem mudança.

O que o usuário vê (texto final é do agente `ux-ui-licitagym`; o conteúdo é este):
- Resumo/Atas pela busca: "O PNCP não respondeu (HTTP 503). Dados do índice de busca do PNCP, atualizados no PNCP em
  25/08/2026 às 10:26. Itens, documentos e histórico não vêm por esta rota."
- Itens/Documentos da cópia, com conferência: "… cópia gravada pelo LicitaGym. A busca do PNCP mostra a última
  atualização da compra em 25/08/2026 às 10:26, a mesma da cópia" (ou "**posterior** à cópia: pode haver mudança").
- Busca também falhou: o aviso de hoje, sem mudança.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `PncpSearchClient.buscarCompraPorControle(controle)` e `.buscarAtasDaCompra(controle)` em `_shared/pncp/search-client.ts` (estende o cliente existente; não cria outro) | `numero_controle_pncp` validado por regex (`^\d{14}-\d+-\d+/\d{4}$`) | item da busca que casa exatamente, ou `null`; lista de atas cujo controle começa com `{controle}-` | queda de conexão: até 2 tentativas, timeout por tentativa ≤ 5 s; 4xx permanente sem retry; envelope sem `items` array = erro (não lista vazia) | uso interno das Edge Functions |
| K-2 | Normalizadores `compraDaBusca(item)` → `CompraMetadata` e `ataDaBusca(item)` → `AtaAcompanhamento` (puros, em `api-dashboard-oportunidades`) | item `edital`/`ata` da busca | campos mapeados conforme seção 6.4/6.5 da doc; o que a busca não traz = `null` (`processo`, `linkSistemaOrigem`, `inclusao`); `numero`/`ano` da ata extraídos de `title` por regex, senão `null`; strings vazias = `null` | — | — |
| K-3 | `api-dashboard-oportunidades` `action=acompanhamento`: seções `compra` e `atas` ganham `origem?: "busca_pncp"` e `busca_atualizado_em` (ISO, `data_atualizacao_pncp` em `-03:00`) | como hoje | seção com `dados` da busca, `erro` da 1ª fonte mantido | como hoje (401/404/500) | usuário autenticado (sem mudança de auth) |
| K-4 | Mesma ação: seções `itens`/`arquivos` com `origem: "copia_local"` ganham `conferencia_busca` | como hoje | `{ pncp_atualizado_em, gravado_em, compra_mudou }` ou ausente quando a busca falhou | — | idem |
| K-5 | Cache: resposta com qualquer seção vinda da busca continua "com erro" (`acompanhamentoCompleto` = false → no-store, cache negativo de 15 s) | — | "Tentar novamente" volta a tentar a Consulta | — | — |
| K-6 | Dashboard: `AvisoCopiaLocal` e o aviso novo para `origem: "busca_pncp"` no Resumo e em Atas; selo da aba | payload de K-3/K-4 | textos acima; nada inventado quando um campo é `null` | — | tela do detalhe |
| K-7 | `types.ts` + README da função: documentar `origem`, `busca_atualizado_em`, `conferencia_busca` | — | — | — | contrato com o Dashboard |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a busca devolvendo 2 itens para `q="…118/2026"`, um deles `…113/2026`, **quando** `buscarCompraPorControle` roda, **então** devolve só o item de controle idêntico; com nenhum idêntico, devolve `null`. | Deno `tests/supabase/functions/_shared/pncp/search_client_busca_test.ts` (fetch falso) |
| CA-2 | K-1 | **Dado** a 1ª tentativa com conexão derrubada e a 2ª com 200, **quando** busca, **então** devolve o item; **dado** 2 quedas, **então** lança erro (não `null`, não lista vazia); **dado** 200 com `items` não-array, **então** lança erro. | idem |
| CA-3 | K-2 | **Dado** o item medido da 118 (fixture copiada da doc, sem dado pessoal), **quando** `compraDaBusca`, **então** `valorEstimado=222420.95`, `valorHomologado=232620.82`, `encerramentoProposta="2026-07-15T08:00:00-03:00"`, `processo=null`, `linkSistemaOrigem=null`; `data_fim_recebimento_propostas=""` não vira data. | Deno `tests/supabase/functions/acompanhamento_busca_pncp_test.ts` |
| CA-4 | K-3 | **Dado** Consulta 503 e busca 200, **quando** `acompanhamento` da #1892 (fixture), **então** `compra.origem="busca_pncp"`, `compra.erro` contém `503`, `compra.dados.objeto` preenchido e `busca_atualizado_em="2026-08-25T10:26:11-03:00"`; `atas.dados` tem 10 atas com `origem="busca_pncp"`. | idem |
| CA-5 | K-3 | **Dado** Consulta 200, **quando** `acompanhamento`, **então** a busca **não** é chamada (contador do fetch falso = 0) e nenhuma seção tem `origem="busca_pncp"` (regressão do caminho normal). | idem |
| CA-6 | K-4 | **Dado** itens da cópia local e busca com `data_atualizacao_pncp` igual a `pncp_data_atualizacao`, **então** `conferencia_busca.compra_mudou=false`; **dado** posterior, **então** `true`; **dado** `pncp_data_atualizacao` nulo ou busca falhou, **então** `compra_mudou=null` ou campo ausente, respectivamente. | idem |
| CA-7 | K-5 | **Dado** resposta com seção vinda da busca, **então** `Cache-Control: no-store` e `acompanhamentoCompleto(payload)=false` (regressão do #501). | idem |
| CA-8 | K-3 | **Dado** requisição sem JWT (ou JWT inválido), **quando** `acompanhamento`, **então** 401 como hoje (`requireUserAuth`) e o fetch falso da busca registra 0 chamadas. A busca não lê tabela com `tenant_id` (só `licitacoes_externas`, sem tenant): não há caso de outro tenant a cobrir. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` (caso novo) |
| CA-9 | K-6 | **Dado** `compra.origem="busca_pncp"` e `atas.origem="busca_pncp"`, **quando** o detalhe renderiza, **então** aparece o aviso com a data do índice e "Itens, documentos e histórico não vêm por esta rota"; com `conferencia_busca.compra_mudou=true`, o aviso da cópia diz "posterior à cópia". | vitest `src/test/detalhe-busca-pncp.test.tsx` (Dashboard) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2 | `/spec` | `/implement` (TDD) | Deno, fetch falso (sem API real) | `revisor-codigo` | skill `verificar-producao` |
| K-3, K-4, K-5, K-7 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` (Edge Function `api-*` com `service_role`) | `verificar-producao` + abrir a #1892 em produção |
| K-6 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` (pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |
| contrato entre repos | sessão orquestradora | backend mergeado e publicado antes do front | os dois conjuntos | — | `ciclo-janelas` no fechamento |

## Avaliação: tela "Pesquisa de Editais e Atas – PNCP" na sidebar

Pedido: formulário com o texto do objeto em `q` (ex. "REGISTRO DE PREÇOS DE EQUIPAMENTOS DE ACADEMIA") e filtros de
status, órgão, modalidade e UF, lendo a mesma busca.

**Recomendação: não entra nesta spec; virar spec própria `parada`, a retomar depois da fase 3 da 0032.** Motivos:
1. **Regra de foco** do `ESCOPO.md`: tela nova que não alimenta a 0032.
2. **Duplica o Radar sem as regras do Radar.** O Radar já roda essa busca (coletor, `PncpClient.buscar`) e passa cada
   compra pela classificação TR-primeiro, pela exclusão de "ar livre" e de contrato de serviço. Uma busca crua na tela
   mostra exatamente o que essas regras tiram, sem a marcação de escopo.
3. **Contrato da busca é traiçoeiro para formulário livre** (medido): status desconhecido e `em_julgamento` são
   ignorados em silêncio; vírgula em UF/modalidade dá `total=0` em silêncio; `orgaos` usa id interno do PNCP, não
   CNPJ, e o mapa id↔CNPJ só sai do `filters` de atas (8.272 órgãos), que cai com frequência; ≈ 63 % de quedas de
   conexão. Cada pesquisa do usuário ocuparia o lease de `pncp.gov.br`, compartilhado com os coletores.
4. O ganho de curto prazo cabe no que já existe: o detalhe da oportunidade ganha atas e resumo pela busca (esta spec).

Se o Marcelo quiser a tela mesmo assim, o mínimo seguro: ação nova `api-dashboard-oportunidades action=pesquisa_pncp`
só com status `recebendo_proposta | encerradas | vigente` (lista fechada), UF e modalidade por lista fechada (pipe no
servidor), órgão por CNPJ convertido no servidor, `tam_pagina ≤ 50`, limite por usuário, e cada linha mostrando se a
compra já está no Radar e com qual classificação. Isso é uma spec inteira (contrato, CAs, UX), não um anexo desta.

## Fora de escopo

- Itens, resultados, documentos e histórico pela busca (a busca não os tem).
- Gravar no banco o que veio da busca (nada é persistido; a cópia local continua sendo só a do coletor).
- Mudar o coletor Python ou a prioridade/fase da oportunidade a partir da busca.
- Corrigir `parsePncpTimestamp` (trata data sem offset como UTC; medido em Brasília para `edital`, não medido para
  `pcaorgao`): issue própria, porque mexe no `sync-pncp-pca`.
- A tela de pesquisa na sidebar (ver avaliação).

## Impacto em dados

- **Migration:** não
- **Tabelas/views/funções tocadas:** leitura de `licitacoes_externas.pncp_data_atualizacao` (coluna existente) na ação
  `acompanhamento`; nenhuma escrita
- **ACL/RLS:** nenhum
- **Backfill/reprocessamento:** não
- **Edge Functions republicadas no merge:** todas (regra do merge); a alterada é `api-dashboard-oportunidades`;
  `sync-pncp-pca` importa `search-client.ts` e é republicada com ele (CA-5 e os testes existentes do PCA cobrem)
- **Contrato com o Dashboard:** muda, aditivo (`origem: "busca_pncp"`, `busca_atualizado_em`, `conferencia_busca`);
  backend vai ao ar antes do front, e o front antigo ignora os campos novos (a seção com `dados` aparece sem o aviso
  novo: aceitável por um ciclo? ver perguntas)
- **Dado oficial x derivado:** tudo da busca é dado oficial do PNCP, exibido como vem (inclusive homologado > estimado
  na 118); derivado é só `compra_mudou` (comparação de duas datas oficiais) e a conversão do fuso

## Decisões do Marcelo

- (vazio)

## Perguntas em aberto

1. **Regra de foco:** abrir exceção para esta spec (como 0040/0048), ou fica `parada`?
2. **Retry no caminho interativo:** o detalhe hoje faz 1 tentativa por endpoint (`PNCP_DETALHE_OPCOES`, para não
   ocupar o lease). A busca cai ≈ 63 % das vezes; com 1 tentativa o fallback falharia na maioria. Aceita até 2
   tentativas só para queda de conexão (sem HTTP), timeout de 5 s cada, só quando a Consulta já falhou?
3. **Atas pela busca vêm sem fornecedor e sem valor.** Mostrar assim (com o aviso) ou manter Atas em erro quando a
   `/api/pncp/v1` cai?
4. **Front antigo por um ciclo:** entre o deploy do backend e o do Dashboard, o Resumo pode aparecer com dados da busca
   sem o aviso de origem. Aceita, ou o backend só envia `origem="busca_pncp"` atrás de um parâmetro que o front novo
   manda (`fontes=busca`)?
5. **Tela de pesquisa na sidebar:** concorda com a recomendação (spec própria `parada`)?

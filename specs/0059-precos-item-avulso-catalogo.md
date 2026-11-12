# 0059: Avaliar o preço pelo item CATMAT na aba Preços e aceitar a exceção de item no api-precos

- **Status:** em implementação (fase 1)
- **Alimenta:** módulo 9 (Preços e BI) de `docs/produto/ESCOPO.md`; insumo da fase 3 (agente de preço) da spec-mãe 0032
- **Repositório:** os dois (o backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** edge-functions, migrations, catmat, dashboard-tela
- **Depende do ok do Marcelo:** sim (decisão de produto, migration em função SQL e republicação do `api-precos`)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega | sim |
| 2 | `AGENTS.md` | zero alucinação; `codigoItem` ≠ `codigoPdm` | sim |
| 3 | `.claude/rules/regras-negocio.md` | TR é a fonte da verdade, CATMAT é suporte; preço só de compra homologada | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 9 e decisões de preço | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` (fase 3) | o agente de preço usa o mesmo recorte | não: ler |
| 6 | esta spec | contrato e CAs | não: ler |
| 7 | `.claude/rules/edge-functions.md`, `.claude/rules/database-migrations.md`, `.claude/rules/catmat.md`, `.claude/rules/tests.md` | convenções da área | ler explicitamente |
| 8 | `supabase/functions/api-precos/precos.ts` (cabeçalho, `parsePrecosParams`, `pdmNoCatalogo`, `argsRecorte`, `responderPrecos`) | contrato atual; `item` já é aceito como filtro | não: ler |
| 9 | `supabase/migrations/20260930100000_catalogo_empresa_catmat.sql` (`catalogo_catmat_pdms_efetivos`, regras de nível `item`) | o catálogo efetivo ignora a regra de item | não: ler |
| 10 | migrations que criam `precos_praticados_recorte`, `_resumo`, `_amostras`, `_itens_pdm`, `_municipios` (a mais recente de cada uma: `git grep -l "function public.precos_praticados_" supabase/migrations`) | assinaturas que ganham `p_itens` | não: ler |
| 11 | `services/coletor-externo/coletor/compras_pdms.py` (`carregar_itens_avulsos`) | o coletor já trata o item avulso | não: ler |
| 12 | `tests/supabase/functions/api_precos_test.ts` | onde entram os CAs Deno | não: ler |
| 13 | `supabase/functions/api-dashboard-oportunidades/precoReferencia.ts`, `tests/supabase/functions/agentes_preco_test.ts` | outros leitores do preço: conferir se também comparam pelo PDM | não: ler |
| 14 | Dashboard: `src/components/opportunities/PriceIntelligenceTab.tsx`, `src/data/precosApi.ts`, `src/data/comparacaoPreco.ts`, `src/data/acompanhamentoTypes.ts` (`catalogoCodigoItem`, `codigoPdm`, `codigoPdmOrigem`), `src/components/prices/precosFiltrosUrl.ts` | a aba hoje agrupa por PDM; a /precos já aceita `item` na URL | não: ler no outro repositório |
| 15 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md`; no Dashboard, os agentes `frontend-dashboard` e `ux-ui-licitagym` e as skills `run-dashboard` e `deploy-dashboard` | procedimento de cada etapa | quando invocados |

## Problema

**1. A aba Preços compara o item com o PDM inteiro, e a amostra fica errada.**
- A aba Itens mostra o código CATMAT do item, mas a aba Preços (`PriceIntelligenceTab.tsx`) deduplica por
  `codigoPdm` e chama `resumo` só com `pdm`.
- Exemplo na oportunidade 2541 (pregão 138/2026, MJSP/PF-AL): o item 02 (CATMAT 480149, banco de panturrilha, estimado
  R$ 20.745,22) é comparado com o PDM 2640. Medição em produção, somente leitura, em 12/11/2026, nos últimos 12 meses
  e na unidade UN:

  | Recorte | Preços (n) | Mediana |
  |---|---|---|
  | PDM 2640 inteiro (96 itens distintos) | 1.789 | R$ 2.000,00 |
  | Só o item 480149 | 31 (33 em todas as unidades) | R$ 3.000,00 |

**2. A exceção de item não vale no api-precos.**
- O item 03 (CATMAT 623742) está no PDM 6827, que é excluído pela regra id 69. O item foi incluído como exceção pela
  regra id 323, criada em 12/11/2026 às 13:42 UTC.
- Mesmo assim, `api-precos?action=resumo&pdm=6827&meses=12` responde `400 pdm_fora_do_catalogo`. A causa é que
  `pdmNoCatalogo` (`precos.ts:380`) só lê `catalogo_catmat_pdms_efetivos()`, que ignora as regras de nível `item`.
- Três PDMs estão nessa situação (medido em 12/11/2026): fora do catálogo efetivo e com item avulso incluído, num total
  de 7 itens.
  - PDM 757: 1 item
  - PDM 6827: 1 item
  - PDM 11503: 5 itens
- Preços desses itens em `precos_praticados_itens`: 602274: 36; 410868: 55; 602799: 251; 464753: 50; 287852: 41;
  225133: 54; 623742: 0. São 487 preços que a aba não mostra.
- O coletor (`compras_pdms.py`) já busca o item avulso por `codigoItemCatalogo`; o bloqueio é só do api-precos.

**3. Item excluído dentro de PDM incluído.** Há 18 regras de item com `incluido=false` (medido em 12/11/2026). Hoje o
recorte pelo PDM conta os preços desses itens.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `api-precos`: checagem de catálogo pelo item | Com `item`: o item precisa estar no catálogo. Isso vale quando (a) o PDM é efetivo e não há regra de item com `incluido=false` para ele, ou (b) há regra de item com `incluido=true` (exceção), mesmo com o PDM excluído. O recorte usa `p_item` como hoje. | Resposta atual mais `filtro.escopo_catalogo` (`"item"`, `"pdm"` ou `"itens"`) e `filtro.itens_catalogo` | 400 `item_fora_do_catalogo` para item excluído ou sem regra que o inclua; 400 `pdm_fora_do_catalogo` como hoje; 401 sem sessão | usuário autenticado (`requireUserAuth`) |
| K-2 | `api-precos` sem `item` (referência secundária da aba e tela /precos) | PDM fora do efetivo com item incluído: modo `itens`, restrito aos itens incluídos. PDM efetivo: modo `pdm`; com o parâmetro novo `catalogo_estrito=true` (o que a aba usa), tira os itens excluídos por regra. Sem esse parâmetro, a /precos fica como hoje. | `filtro.itens_catalogo` lista os itens permitidos (modo `itens`) ou os excluídos que ficaram de fora (modo `pdm` estrito), em ordem crescente; `filtro.catalogo_estrito` ecoa o parâmetro | 400 `pdm_fora_do_catalogo` se não houver nenhuma regra; 400 se `catalogo_estrito` não for `true` nem `false` | usuário autenticado |
| K-3 | Migration: `p_itens int[] default null` e `p_itens_excluidos int[] default null` nas funções `precos_praticados_recorte`, `_resumo`, `_amostras`, `_itens_pdm` e `_municipios` | `null` mantém o comportamento de hoje | mesmas colunas; `item_mais_amostras` respeita os filtros | — | `execute` só para `service_role` (ACL de hoje) |
| K-4 | Dashboard: aba Preços da oportunidade avalia cada item | Para cada item com CATMAT oficial (`codigoPdmOrigem = 'catalogo_pncp'`):<br>• **principal:** `resumo` com `pdm` + `item` = `catalogoCodigoItem`, na unidade predominante do item; a comparação com o estimado sai só daqui (saída determinística pelo id do item);<br>• **referência secundária:** `resumo` do PDM com `catalogo_estrito=true`, mostrada ao lado e marcada como referência do PDM, nunca usada no lugar do item;<br>• "Ver amostras" abre `/precos/pesquisa?pdm=…&item=…`.<br>Item sem CATMAT oficial (`codigoPdmOrigem = 'casamento_texto'` ou sem PDM): sem comparação, com o motivo "Item fora do CATMAT: comparação pelo de-para de catálogo, ainda não disponível". | Estatística, comparação e motivo por item; `item_fora_do_catalogo` aparece como "item fora do catálogo da empresa" | Estados de carregando, vazio e erro; nunca um valor no lugar de dado ausente | quem vê a oportunidade |

O catálogo (`catalogo_empresa_catmat`) não tem `tenant_id` (medido em 12/11/2026): é o catálogo da plataforma, e o
api-precos não lê dado de tenant.

## Fases

- **Fase 1 (pontual, caso de Alagoas; sem migration):**
  - K-1: checagem pelo item, aceitando a exceção de item e recusando o item excluído.
  - K-4: a aba Preços avalia cada item. A referência secundária do PDM sai sem `catalogo_estrito`; se o PDM está fora
    do catálogo, a referência mostra o motivo.
  - CAs: CA-1, CA-2, CA-4, CA-5, CA-7, CA-8, CA-9 e CA-10.
  - No CA-9, a referência secundária usa o `resumo` do PDM como ele é hoje.
- **Fase 2 (com migration):**
  - K-2, K-3 e `catalogo_estrito` na referência secundária.
  - CAs: CA-3, CA-6 e CA-11.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Regressão do 400:**<br>• **Dado** o PDM 6827 fora do catálogo efetivo e o item 623742 incluído como exceção,<br>• **quando** se chama `resumo&pdm=6827&item=623742`,<br>• **então** a resposta é 200 com `escopo_catalogo = "item"` e a RPC recebe `p_item = 623742`. | Deno `tests/supabase/functions/api_precos_test.ts` |
| CA-2 | K-1 | **Item excluído:**<br>• **Dado** um PDM efetivo com uma regra de item `incluido=false` para o item B,<br>• **quando** se chama `resumo&pdm=…&item=B`,<br>• **então** a resposta é 400 `item_fora_do_catalogo` e nenhuma RPC de preço é chamada. | Deno `api_precos_test.ts` |
| CA-3 | K-2, K-3 | **Modo `itens`:**<br>• **Dado** um PDM fora do efetivo, com o item A incluído e o item B excluído,<br>• **quando** se chamam `resumo`, `amostras`, `itens` e `municipios` sem `item`,<br>• **então** toda RPC recebe `p_itens = [A]` e `itens` não lista B. | Deno `api_precos_test.ts` |
| CA-4 | K-2 | **PDM sem regra:**<br>• **Dado** um PDM sem regra efetiva e sem item incluído,<br>• **quando** se chama `resumo`,<br>• **então** a resposta é 400 `pdm_fora_do_catalogo`, como hoje. | Deno `api_precos_test.ts` |
| CA-5 | K-1 | **Acesso:**<br>• **Dado** uma chamada sem JWT ou com JWT inválido,<br>• **quando** se chama qualquer action,<br>• **então** a resposta é 401 e o cliente `service_role` não é criado. | Deno `api_precos_test.ts` |
| CA-6 | K-3 | **Funções SQL:**<br>• **Dado** linhas de dois itens do mesmo PDM,<br>• **quando** se chama `precos_praticados_resumo(..., p_itens => array[A])` ou `(..., p_itens_excluidos => array[B])`,<br>• **então** `n` e `item_mais_amostras` contam só A; com os dois parâmetros `null`, o resultado é igual ao de hoje;<br>• **e** `anon` e `authenticated` não têm `execute`. | SQL `supabase/tests/precos_itens_catalogo_check.sql` |
| CA-7 | K-4 | **Aba Preços pelo item:**<br>• **Dado** dois itens do mesmo PDM com códigos CATMAT diferentes,<br>• **quando** a aba carrega,<br>• **então** `resumoPrecos` é chamado uma vez por item, com `item` = o `catalogoCodigoItem` de cada um, e cada item mostra o próprio resumo. | vitest `src/test/PriceIntelligenceTab.test.tsx` (Dashboard) |
| CA-9 | K-4 | **Referência secundária:**<br>• **Dado** o item 480149 com n < 3 no recorte do item,<br>• **quando** a aba carrega,<br>• **então** a comparação com o estimado diz "sem comparação" pelo motivo do item, e a referência do PDM (chamada com `catalogo_estrito=true`) aparece separada, marcada como referência do PDM. | vitest `src/test/PriceIntelligenceTab.test.tsx` (Dashboard) |
| CA-10 | K-4 | **Item sem CATMAT oficial:**<br>• **Dado** um item com `codigoPdmOrigem = 'casamento_texto'`,<br>• **quando** a aba carrega,<br>• **então** nenhuma chamada ao `api-precos` é feita para ele e aparece o motivo do de-para. | vitest `src/test/PriceIntelligenceTab.test.tsx` (Dashboard) |
| CA-11 | K-2 | **Estrito só quando pedido:**<br>• **Dado** um PDM efetivo com o item B excluído por regra,<br>• **quando** se chama `resumo` sem `item`, com e sem `catalogo_estrito=true`,<br>• **então** só a chamada estrita passa `p_itens_excluidos = [B]`; a outra passa `null`, como hoje. | Deno `api_precos_test.ts` |
| CA-8 | K-4 | **Ver amostras:**<br>• **Dado** o item 480149 do PDM 2640,<br>• **quando** se clica em "Ver amostras",<br>• **então** a navegação leva `pdm=2640` e `item=480149`. | vitest `src/test/PriceIntelligenceTab.test.tsx` (Dashboard) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2 | `/spec` | `/implement` (TDD) | `deno test tests/supabase/functions/api_precos_test.ts` | `revisor-codigo` + `revisor-seguranca` | skill `verificar-producao` + GET real `resumo&pdm=6827&item=623742` (200) |
| K-3 | `/spec` | skill `nova-migration` | skill `validar-migrations` (`Tudo OK.`) | `revisor-migration` + `revisor-seguranca` (ACL das funções) | `verificar-producao` + `get_advisors` (security) |
| K-4 | `/spec` | agente `frontend-dashboard` | `npx vitest run`, `npx tsc --noEmit`, `npm run build`, skill `run-dashboard` em `/oportunidades/2541` (claro, escuro, celular) | `revisor-codigo` + agente `ux-ui-licitagym` | skill `deploy-dashboard`, depois do backend no ar |

## Fora de escopo

- Coletar preço do item 623742 (hoje há 0 linhas): é trabalho do coletor, que já trata o item avulso.
- Mudar o mapeamento item → PDM (`codigoPdmOrigem`). Esta spec usa o código que já chega no acompanhamento.
- Comparar item sem CATMAT oficial: fica para a fase do de-para de catálogos (Sistema S e outros catálogos fora do
  CATMAT → CATMAT). Até lá, esse item aparece sem comparação e com o motivo.
- Mudar o recorte padrão da /precos: ela só tira os itens excluídos se pedir `catalogo_estrito=true`.
- O agente de preço e o `precoReferencia.ts` só entram se a leitura 13 mostrar que também comparam pelo PDM. Nesse
  caso, a mudança entra como K novo antes de a spec passar a "aprovada".

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_precos_recorte_itens_catalogo.sql`.
  - É aditiva no comportamento: os dois parâmetros `null` dão o resultado de hoje.
  - A assinatura muda, então a migration faz `drop function if exists` da assinatura antiga e `create` da nova, na mesma
    transação, refazendo `revoke`/`grant`. É idempotente.
- **Funções tocadas:** as cinco `precos_praticados_*`, que só o api-precos chama, com `service_role`.
  `catalogo_empresa_catmat` é só lida.
- **ACL/RLS:** nada novo. O check SQL prova o `execute` só para `service_role`.
- **Backfill:** não.
- **Edge Functions republicadas no merge:** todas, como em todo merge; a única que muda é a `api-precos`.
- **Contrato com o Dashboard:** a mudança é aditiva: campos `filtro.escopo_catalogo` e `filtro.itens_catalogo` e o
  código `item_fora_do_catalogo`.
  - Novo parâmetro `catalogo_estrito`. Sem ele, o recorte sem `item` num PDM efetivo dá o mesmo resultado de hoje.
  - O backend vai ao ar antes do front (K-4).
- **Dado oficial × derivado:** o preço continua vindo da Pesquisa de Preço (compra homologada, com fonte e data). O
  filtro por item e por catálogo é regra da empresa. Nada é calculado fora do banco.

## Decisões do Marcelo

- 12/11/2026: a exceção de item vale mesmo quando o código CATMAT do órgão diverge do TR. O registro do órgão não muda,
  então o api-precos tem de considerar a exceção.
- 12/11/2026: liberar o PDM inteiro está proibido, porque traria preço de itens excluídos.
- 12/11/2026: a aba Preços avalia o item (código CATMAT da aba Itens), não o PDM. Comparar pelo PDM dá amostra errada.

- 12/11/2026: o PDM aparece como referência secundária ao lado do item. A comparação com o estimado continua só pelo
  item.
- 12/11/2026: item fora do CATMAT será comparado pelo de-para de catálogos (Sistema S e outros) com o CATMAT, numa
  fase própria. Nesta spec ele fica sem comparação.
- 12/11/2026: na aba Preços da oportunidade, a saída é determinística contra o id do item, e a referência do PDM tira
  os itens excluídos por regra (`catalogo_estrito=true`).

- 12/11/2026: ok para seguir com a fase 1 pontual ("vamos seguir para o Fix primeiro pontual do caso de Alagoas").
  A fase 2 continua pendente do ok dele.

## Perguntas em aberto

- Nenhuma.

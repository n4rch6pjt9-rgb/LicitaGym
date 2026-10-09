# 0006: Rota /pca como radar de itens planejados no escopo

- **Status:** aprovada (09/10)
- **Issue:** nenhuma. Pedido do Marcelo em 09/10: "551 plano(s). Página 1 de 28. O frontend não está operando como
  propomos a construção da rota". A forma escolhida foi "Radar de itens no escopo".
- **Área:** edge-functions (`api-pncp-pca`) e dashboard-contrato (`/pca` no repositório Dashboard---LicitaGym)
- **Depende do ok do Marcelo:** spec aprovada em 09/10 (sem UF; ordem padrão por data prevista). O merge do backend e
  o do front precisam, cada um, do seu ok, nesta ordem.

## Problema

- **O que a rota mostra hoje:** `/pca` (`Dashboard---LicitaGym/src/components/pca/PcaView.tsx`) chama o GET padrão de
  `api-pncp-pca`. Esse GET lista **todos os planos ativos do ano**: 551 em 2026, em 28 páginas. Cada plano aparece só
  com título, CNPJ, id e status.
- **O que falta nessa lista:** não há item, valor, mês previsto nem recorte do escopo fitness. O fornecedor não
  consegue ver o que vai ser comprado.
- **O que já existe no banco:** a view `public.v_bi_pca_radar` (migrations `20261002100000` e `20261002130000`,
  documentada em `docs/bi-cruzamento-apis.md` §4.1). Ela traz os **itens** planejados (PNCP e PGC, sem duplicar) que
  estão no escopo do catálogo da empresa (`catalogo_catmat_pdms_efetivos()`), com órgão, PDM, item, quantidade,
  valor, data e mês previstos, e se o casamento é confirmado.
- **Por que o front não lê a view direto:** só `service_role` tem acesso a ela. Nenhuma Edge Function a expõe hoje.
- **Volume:** não medido. O MCP só leitura não executa a função de escopo usada pela view; a medição sai no PR do
  backend.

## Critérios de aceite

### Backend: `api-pncp-pca`, GET `?visao=radar`

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um usuário sem JWT válido, **quando** chama `visao=radar`, **então** recebe 401, e nenhuma consulta com `service_role` é feita. | Deno `tests/supabase/functions/api_pncp_pca_radar_test.ts` |
| CA-2 | **Dado** um usuário autenticado, **quando** chama `visao=radar&ano=2026`, **então** recebe 200 com `{ itens, total, valor_total_escopo, page, limit }`, lido de `v_bi_pca_radar` com `service_role` e filtrado por `ano_pca`. | idem (mock) |
| CA-3 | Os filtros são aplicados no banco: `mes` (YYYY-MM), `pdm`, `orgao` (CNPJ ou parte do nome), `fonte` (pncp ou pgc), `valor_min`, `so_confirmados`. Parâmetro inválido devolve 400 com mensagem, e não lista vazia. | idem |
| CA-4 | A ordenação é por `data_prevista` (padrão, ascendente: o que vira compra primeiro aparece antes) ou por `valor_total` (descendente), com os nulos por último. A paginação usa `limit` até 100. | idem |
| CA-5 | Valor, data ou órgão ausentes chegam como `null`: nenhum 0 nem texto inventado. `valor_total_escopo` soma só os valores conhecidos e informa quantos itens ficaram sem valor. | idem |
| CA-6 | Um erro do banco devolve 500 com mensagem, nunca `itens: []`. | idem |
| CA-7 | O GET padrão (lista de planos) e as outras visões (`leading`, `conversao`, `priorizacao` e `motor`) não mudam. | testes existentes |

### Front: `/pca` (Dashboard---LicitaGym)

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-8 | A tela mostra a tabela de itens no escopo: órgão, descrição do item e PDM, quantidade, valor total, mês previsto, fonte e um selo de "casamento confirmado". O cabeçalho traz o total de itens e o valor planejado no escopo. | vitest `src/test/PcaRadarView.test.tsx` |
| CA-9 | Os filtros (ano, mês, PDM, órgão, fonte, valor mínimo, só confirmados) ficam na URL (`useSearchParams`) e vão para a API. A paginação funciona. | idem |
| CA-10 | Quando a lista está vazia, a tela diz "nenhum item planejado no escopo para o filtro", e o erro aparece num estado de erro com "tentar de novo". No modo demo, o comportamento continua o de hoje (indisponível no demo). | idem |
| CA-11 | Um valor ausente aparece como "—", e não como R$ 0,00. | idem |

## Fora de escopo

- Alterar a `v_bi_pca_radar` ou o escopo do catálogo (migration).
- Ranking por órgão (`v_bi_orgaos_match`) e detalhe do plano. São possíveis próximas telas.
- Filtro por UF: a view não tem UF, e incluir exigiria uma migration. Decidido em 09/10 que não entra.
- Remover a lista de planos do backend. O GET padrão continua para quem o usa.

## Impacto em dados

- **Migration:** não.
- **Tabelas e views:** leitura de `v_bi_pca_radar` com `service_role`, sempre depois de `requireUserAuth`.
- **ACL/RLS:** nenhuma mudança.
- **Edge Functions republicadas no merge:** todas; muda só `api-pncp-pca`.
- **Contrato com o Dashboard:** novo `GET api-pncp-pca?visao=radar`. **O PR do backend vai ao ar antes do front.**
- **Dado oficial x derivado:** os itens, valores e datas são do PCA oficial (PNCP e PGC). O casamento com o escopo é
  derivado e aparece marcado com `casamento_confirmado` e `metodo_identificacao`.

## Perguntas em aberto

Nenhuma. Decisões de 09/10: sem filtro de UF; ordem padrão por `data_prevista` ascendente, com nulos por último.

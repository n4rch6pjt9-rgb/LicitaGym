# 0004: Listar oportunidades do recorte CATMAT acima de 1.000 sem o 422

- **Status:** rascunho
- **Issue:** nenhuma. Relato do Marcelo em 09/10: "O recorte CATMAT casa 1012 oportunidades (limite 1000)".
- **Área:** edge-functions (`api-dashboard-oportunidades`)
- **Depende do ok do Marcelo:** sim. Escolher a abordagem antes do código. O merge publica a Edge Function.

## Problema

- **O que o usuário vê:** ao filtrar por CATMAT no Dashboard, a lista some e aparece "O recorte CATMAT casa 1012
  oportunidades (limite 1000). Refine por classe, PDM ou outro filtro."
- **De onde vem:** é um 422 do próprio código, em `api-dashboard-oportunidades/index.ts`, `MAX_IDS_CATMAT = 1000`, que
  existe desde o #121, de 02/10. Não depende do "Max rows" da Data API.
- **Como o fluxo funciona hoje:**
  1. A RPC `licitacoes_ids_por_catmat_unica` devolve todos os ids do recorte.
  2. `idsNoEscopo` reduz esses ids às Oportunidades, em lotes de 500, aplicando só `prioridade` e o escopo.
  3. A consulta principal filtra por `id in (...)` na URL do PostgREST.
- **Por que o teto existe:** evitar uma URL gigante.
- **Por que estourou agora:** a base cresceu, e 1.012 passa de 1.000. Hoje o recorte inteiro fica indisponível, não
  só a parte que passa do limite.
- **Lacuna junto:** `idsNoEscopo` não aplica os demais filtros (UF, texto, datas). Por isso o 422 pode aparecer mesmo
  quando o resultado final teria menos de 1.000 linhas.

## Abordagem proposta (escolher antes de aprovar)

**(c) Duas fases na Edge Function, sem migration.** Recomendada.
1. Para os ids do recorte, ler em lotes de 500 só `id` e a coluna de ordenação (`data_fim`, `data_publicacao` ou
   `valor_total`), com **todos** os filtros e o escopo aplicados.
2. Ordenar em memória com a mesma regra da consulta de hoje: `order_by` no sentido pedido, nulos por último, `id`
   crescente para desempatar. O `total` é o número de ids que sobram.
3. Fatiar a página pedida e ler as linhas completas só dos ids dessa página, no máximo `limit`, com URL curta.
4. Manter um teto alto só como proteção, por exemplo 20.000 ids, com o mesmo 422. Isso equivale a cerca de 40
   lotes; o tempo precisa ser medido no PR.

Alternativas consideradas:
- **(a) Recorte e paginação dentro do banco,** numa RPC nova que devolve a página já filtrada e ordenada. Escala
  melhor, mas exige migration e duplicar no SQL todos os filtros de `applyLicitacaoFilters`.
- **(b) Só subir o teto,** sem garantia do limite de URL do gateway. Descartada.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um recorte CATMAT com 1.012 oportunidades no escopo, **quando** `list` roda (página 1, `limit` 20, `order_by` `data_fim` desc), **então** responde 200 com `total = 1012` e 20 itens na ordem certa. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-2 | **Dado** o mesmo recorte, **quando** pede a última página, **então** devolve só o restante; uma página além do fim devolve `items: []` com o `total` correto. | idem |
| CA-3 | A ordenação em duas fases é igual à da consulta direta: nulos por último, `id` desempata, nos três `order_by` e nos dois sentidos. | idem (caso com nulos e empates) |
| CA-4 | Os filtros de UF, texto e datas são aplicados antes de contar. Um recorte com 1.100 ids que cai para 300 com UF responde 200, com `total = 300`. | idem |
| CA-5 | Nenhuma URL ao PostgREST leva mais de 500 ids. | idem (mock conta os ids por chamada) |
| CA-6 | Acima do teto de proteção, continua 422 com a contagem. Recorte vazio continua 200 vazio. Timeout da RPC continua 503. | idem (testes de hoje ajustados) |
| CA-7 | Erro de banco em qualquer lote vira 500, nunca lista parcial apresentada como completa. | idem |

## Fora de escopo

- Mudar a RPC `licitacoes_ids_por_catmat_unica` ou criar migration.
- Mudar o Dashboard. O contrato `list` não muda; só deixa de dar 422 entre 1.000 e o teto novo.
- O "Max rows" da Data API, que o Marcelo pôs em 1.500. Recomendação: voltar para 1.000, igual a
  `supabase/config.toml`, porque o código pagina assumindo 1.000.

## Impacto em dados

- **Migration:** não.
- **Tabelas, views e funções:** só leitura de `licitacoes_externas_prioridade_efetiva`, como hoje.
- **ACL/RLS:** nenhuma mudança.
- **Backfill:** não.
- **Edge Functions republicadas no merge:** todas, pela integração; muda só `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:** inalterado.

## Perguntas em aberto

- Aprovar a abordagem (c) e o teto de proteção de 20.000, ou preferir (a)?
- Qual filtro CATMAT deu os 1.012: grupo, classe ou "Catálogo"? Ajuda a montar o caso real do CA-1.

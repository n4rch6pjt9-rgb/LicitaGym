# 0012: Fazer o sync do PCA terminar sem estourar a CPU da Edge Function

- **Status:** rascunho
- **Issue:** #289 (P1)
- **Área:** edge-functions (`sync-pncp-pca`), pncp (`_shared/pncp/upsert.ts`, `pca-origem-link.ts`), saúde operacional
- **Depende do ok do Marcelo:** sim. Muda a ingestão de produção e precisa rodar de novo o PCA 2026 depois do merge.

## Problema

Medido em produção em 09/10, só leitura. Detalhes na #289.

- **A execução morre na página 2:** às 10:35:01 UTC, o `sync-pncp-pca` morreu com `CPU Time exceeded` (HTTP 546, 73 s de
  relógio) quando processava a página 2 (94 planos, 500 itens) da consulta `/pca/?anoPca=2026&codigoClassificacaoSuperior=7830`.
  - A execução ficou `executando` com `pagina_atual = 2`.
  - Desde 26/09, toda execução termina assim: "lock expirado" no dia seguinte.
  - A retomada recomeça na própria página 2 e nunca passa dela.
- **O banco está parado em 19/09:** a fonte declara 6.018 itens de 2026 em 13 páginas de 500, e `pca_itens` tem 3.686 ativos.
  - Da página 2, que é lida todo dia, faltam 213 itens (51 no escopo do catálogo) e 43 planos.
  - Exemplo: plano `00394429000100-0-000004/2026`, GRUPAMENTO DE APOIO DO GALEÃO. O banco tem os itens 399 a 412; a fonte
    tem também 413 a 423 e 435, todos com PDM 2640.
- **Causa provável, a confirmar no passo 1 (medição):** o trabalho por item é sequencial e roda dentro de um só worker.
  - `upsertByHash` faz select, insert ou update e histórico.
  - Depois vêm a busca do id e `linkPcaItemOrigemCodes`, com 2 selects e 2 upserts.
  - Cada linha passa por `hashPayload`/`stableStringify`.
  - A página inteira passa por `JSON.stringify` duas vezes.
  - São cerca de 8 chamadas PostgREST por item, ou seja, milhares por página de 500.
  - O custo de CPU do supabase-js por chamada (montar a requisição e fazer o parse da resposta) somado ao hash passa do
    limite do worker.
- **A falha é silenciosa:** o worker morto não grava o fim da execução. A saúde operacional não marca "sync PCA sem
  concluir há mais de 24 h" como crítico.

## Abordagem proposta

1. **Medir antes de mudar.** Teste de carga local com a página 2 real (payload de `private.source_record`, salvo como
   fixture sem dado pessoal: o PCA é dado público de órgão). O normalizador e o upsert rodam contra um cliente falso que conta
   chamadas. Saem o número de chamadas e o tempo de CPU por página, e isso vai para o PR.
2. **Gravar em lote por página, em vez de item a item:**
   - **planos:** um select de `id, payload_hash` por `id_pca_pncp in (...)`, seguido de um upsert em lote dos novos e
     alterados e de uma linha de histórico só por alterado;
   - **itens:** o mesmo, com chave `(pca_plano_id, numero_item)`;
   - `reactivateOnUnchanged` e `last_seen_sync_id` passam a ser um update em lote dos inalterados;
   - **vínculos de origem:** um select em `catmat_pdms` e outro em `catalogo_itens` para os códigos da página, seguidos
     de upserts em lote em `pca_item_pdm` e `catalogo_ponte`.

   A semântica do `upsertByHash` não muda: mesmo hash, mesmas colunas e histórico só quando o hash muda.
3. **Orçamento por invocação.** Cada invocação processa no máximo `N` itens (proposta: 500, configurável no body e no env).
   Ao atingir o limite, grava o checkpoint (código, página e posição na página), encerra a execução como `incompleta` com
   `continuation` e devolve 202. A próxima chamada recomeça do checkpoint, sem reprocessar o que já gravou.
4. **Encadeamento.** Hoje só há dois disparos por dia (06:13 e 06:43), e 13 páginas não cabem neles. Proposta:
   - a invocação incompleta agenda a continuação ela mesma, com `cron_chamar_edge` ou nova chamada assíncrona via
     `pg_net`, até um teto de elos por dia;
   - **alternativa:** um cron de continuação a cada 10 min entre 06:13 e 08:00 (pergunta 1).
5. **Inativação segura.**
   - `inactivateNotSeen` hoje compara `last_seen_sync_id` com o `runId` da invocação. Com encadeamento, inativaria o que
     outra invocação da mesma cadeia viu.
   - Passa a usar o `chain_id` e só roda quando a **cadeia inteira** terminou sem erro, em `modo = completo`.
6. **Saúde.** Nova verificação `pca_sync_sem_concluir_horas`:
   - crítico quando a última execução PCA `concluida` tem mais de 36 h;
   - atenção quando há execução `executando` sem heartbeat há mais de 10 min.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** a página 2 real (fixture com 94 planos e 500 itens), **quando** o processamento de página roda contra o cliente falso, **então** faz no máximo 20 chamadas ao banco. Hoje são cerca de 8 por item, e o número exato medido vai para o PR. | Deno `tests/supabase/functions/sync_pncp_pca_pagina_test.ts` |
| CA-2 | **Dado** a mesma página, **então** o resultado no banco falso é igual ao do caminho atual item a item: as mesmas linhas, colunas, `payload_hash` e linhas de histórico, e as mesmas contagens novos, alterados e inalterados. | idem (comparação dos dois caminhos) |
| CA-3 | **Dado** um item com hash igual ao do banco, **então** não grava histórico e só atualiza `last_seen_sync_id`, `last_synced_at` e `ativo = true`. | idem |
| CA-4 | **Dado** um orçamento de 300 itens e uma página de 500, **quando** a invocação atinge o limite, **então** grava o checkpoint (código, página e posição), termina a execução como `incompleta` com `continuation` e responde sem erro. A próxima invocação começa no item 301 da mesma página. | idem |
| CA-5 | **Dado** uma cadeia de 3 invocações que cobre todas as páginas em `modo = completo`, **então** `inactivateNotSeen` roda uma vez, no fim, e não inativa nenhum item visto pelas invocações anteriores da cadeia. | idem |
| CA-6 | **Dado** uma cadeia com erro em qualquer elo, **então** nenhuma inativação roda. | idem |
| CA-7 | **Dado** uma falha do PostgREST no upsert em lote, **então** a execução fica `falhou` ou `incompleta` com a mensagem, e nunca `concluida` com contagem zerada. Erro de página não é resultado vazio (CLAUDE.md). | idem |
| CA-8 | O vínculo de origem continua igual: `pca_item_pdm` (`exata`, `pncp:pdmCodigo`, confirmado) e `catalogo_ponte` para os mesmos itens do caminho atual. | idem |
| CA-9 | Saúde: `pca_sync_sem_concluir_horas` fica crítico quando a última `concluida` tem mais de 36 h e ok quando tem menos de 36 h. Fixtures em `private.pncp_sync_run`. | SQL `supabase/tests/saude_pca_sync_check.sql` |
| CA-10 | **Regressão de produção:** depois do merge e de uma carga completa disparada pelo Marcelo, os 32 itens da classe 7830 do plano `00394429000100-0-000004/2026` existem em `pca_itens`, e a execução termina `concluida`. | verificação pós-merge (skill `verificar-producao`), anotada no PR |

## Fora de escopo

- **Gravar os campos oficiais que hoje descartamos** (spec 0010). Ela muda o normalizador e o hash; esta não muda.
- **Outras classes** (7220 etc.) e outros `sync-*` com o mesmo padrão item a item. Ficam numa issue depois de medir.
- **Reduzir `tamanho_pagina`.** Não resolve: é a mesma CPU por item, com mais requisições ao PNCP e mais orçamento de
  rate limit. Fica como alternativa, se o lote não bastar.

## Impacto em dados

- **Migration:**
  - sim, só a da saúde (`<timestamp>_saude_pca_sync.sql`), que é aditiva: limiar novo e recriação de
    `saude_operacional_resumo`, igual à de produção mais o bloco novo;
  - se o encadeamento for por cron, mais uma migration agenda a continuação (pergunta 1).
- **Tabelas escritas:** `pca_planos`, `pca_itens`, `pca_alteracoes`, `pca_item_pdm`, `catalogo_ponte` e
  `private.pncp_sync_run`. São as mesmas de hoje, e só muda a forma (lote).
- **ACL/RLS:** nenhuma mudança.
- **Recarga:** depois do merge, uma carga completa de 2026 com `forcar: true` e `modo: completo`, disparada pelo Marcelo
  ou pelo cron.
  - Esperado: cerca de 2.300 itens novos (6.018 na fonte − 3.686 hoje), contados de verdade no PR depois da carga.
  - Os itens que saíram da fonte serão inativados, nunca apagados.
- **Edge Functions republicadas no merge:** todas, como sempre. Muda a `sync-pncp-pca`; a `api-saude` só passa a ler a
  verificação nova.
- **Contrato com o Dashboard:** inalterado. O radar só passa a ter mais itens.
- **Dado oficial x derivado:** nada novo. Os itens vêm do PNCP como hoje.

## Perguntas em aberto

1. **Encadeamento:** a invocação incompleta chama a próxima ela mesma, com um teto de elos por dia, ou um cron de
   continuação a cada 10 min numa janela da manhã? A proposta é a primeira, que termina mais rápido e não deixa job
   rodando à toa.
2. **Limiar da saúde:** 36 h sem `concluida` é crítico? O cron é diário, então 36 h equivale a uma execução perdida e
   mais uma margem.
3. **Recarga depois do merge:** pode ser `modo: completo`, que inativa os itens que saíram da fonte, ou primeiro um
   `incremental` só para trazer o que falta, deixando a inativação para depois de conferir a contagem?

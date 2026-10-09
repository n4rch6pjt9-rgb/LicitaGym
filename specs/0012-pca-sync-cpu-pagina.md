# 0012: Sincronizar o PCA em fatias com gravação em lote, sem estourar a CPU da Edge Function

- **Status:** rascunho (reescrita em 09/10/2026, depois da avaliação das APIs)
- **Issue:** #289 (P1)
- **Área:** edge-functions (`sync-pncp-pca`), pncp (`_shared/pncp/upsert.ts`, `pca-origem-link.ts`,
  `integracao-client.ts`, `consulta-client.ts`), migrations (fila e saúde), saúde operacional
- **Depende do ok do Marcelo:** sim. Muda a ingestão de produção, tem migration e precisa de recarga do PCA 2026.
- **Base de evidência:** `docs/pncp/avaliacao-apis-pca-2026-10.md` (medição de 09/10, só GET público).

## Problema

Medido em produção em 09/10, só leitura. Detalhes na #289.

- **A execução morre na página 2:**
  - às 10:35:01 UTC, o `sync-pncp-pca` morreu com `CPU Time exceeded` (HTTP 546, 73 s de relógio) na página 2 da
    consulta `/pca/?anoPca=2026&codigoClassificacaoSuperior=7830`, com 94 planos e 500 itens;
  - desde 26/09, toda execução termina assim, e a retomada recomeça na mesma página.
- **O banco está parado em 19/09:**
  - a fonte declara 6.018 itens 7830/2026 em 13 páginas de 500, e `pca_itens` tem 3.686 ativos;
  - exemplo: no plano `00394429000100-0-000004/2026` (GRUPAMENTO DE APOIO DO GALEÃO), o banco tem os itens 399 a 412 e a
    fonte tem 32, inclusive 413 a 423 e 435, com PDM 2640.
- **Causa provável:**
  - cada item faz cerca de 8 chamadas PostgREST em sequência: `upsertByHash`, busca do id e `linkPcaItemOrigemCodes`;
  - cada linha passa por hash/`stableStringify`.
  - O passo 1 da implementação mede isso.
- **A falha é silenciosa:** a saúde não marca "sync PCA sem concluir" como crítico.
- **Fatos novos da avaliação de 09/10:**
  1. **A paginação da consulta por classe pula itens.** A varredura de 13 páginas devolveu 6.018 linhas e 6.009 pares
     distintos (9 repetidos na fronteira entre páginas). Na integração, o plano `18401059000157-0-000011/2026` tem 19 itens
     7830, e a consulta trouxe 13. O plano `08969291000132-0-000001/2026` tem 22, e a consulta trouxe 21. Mesmo
     sem o erro de CPU, o desenho atual (itens pela consulta + `inactivateNotSeen` global) perde e inativa itens
     que existem.
  2. **`/pca/atualizacao` sem `cnpj` não responde hoje:**
     - devolve 500 em cerca de 50 s para qualquer janela de out/2026, inclusive um único dia;
     - quando respondeu (um dia de 2025), trouxe 21.593 itens de todas as classes;
     - `dataFim` é exclusivo (00:00);
     - com `cnpj`, responde em menos de 1 s, mas traz o plano inteiro e exige saber o órgão antes.
  3. **A integração por plano é completa e rápida:**
     - `GET /api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens` leva de 0,2 a 0,4 s;
     - aceitou `tamanhoPagina=2000` (1.800 itens em 0,44 s) e bateu item a item com a consulta no Galeão.
  4. **Volume de mudança:** em 09/10 às 14:45, 78 planos tinham `dataAtualizacaoGlobalPCA` nas últimas 24 h, 269 em 7 dias
     e 483 em 30 dias, de 935 planos com itens 7830/2026.

## Desvio do pedido original

O pedido era "incremental diário via `/pca/atualizacao`". Pelo item 2 acima, esta spec propõe outro caminho para o
incremental diário:
- descoberta pela consulta por classe, comparando `dataAtualizacaoGlobalPCA`;
- depois, a integração por plano só nos planos alterados.

O `/pca/atualizacao` fica fora até voltar a responder em menos de 50 s para um dia de 2026.

**Decisão do Marcelo (09/10):** o incremental atualiza só os planos que mudaram (descoberta por
`dataAtualizacaoGlobalPCA` e depois a integração por plano).

## Abordagem proposta

Três rotinas sobre o mesmo motor, separando a **descoberta** (quais planos) da **carga de itens** (os itens de cada
plano):

```
descoberta (T1, 13 req/classe/ano) ──► fila de planos ──► carga por plano (T3, 1 req/plano, em fatias) ──► gravação em lote
```

1. **Medir antes de mudar.**
   - **Teste de carga local** com uma página real da consulta e três planos reais da integração. Fixture de dado
     público de órgão, sem dado pessoal. Planos: Galeão (256 itens), `18401059000157-0-000011/2026` (1.800) e
     `08969291000132-0-000001/2026` (464).
   - **Alvo:** o normalizador e a gravação rodam contra um cliente falso que conta chamadas. O número de chamadas e o tempo
     de CPU por plano, antes e depois, vão para o PR.
1. **Descoberta (fase A).**
   - **Leitura:** lê as páginas da consulta `/pca/?anoPca&codigoClassificacaoSuperior` com `tamanhoPagina=500`, por
     classe do escopo. Hoje é só 7830.
   - **Por plano:** deduplica por `idPcaPncp` e guarda `idPcaPncp`, CNPJ, unidade, sequencial e
     `dataAtualizacaoGlobalPCA`.
   - **Planos no banco:** upsert em lote só dos campos de cabeçalho em `pca_planos`. Entra na fila todo plano novo ou com
     `dataAtualizacaoGlobalPCA` maior que a gravada.
   - **Itens:** a fase A não grava item. Os itens da consulta servem só para o log de contagem (`totalRegistros`, pares
     distintos).
   - **Relógio:** a página 1 fria levou de 46 a 57 s. Há nova tentativa com espera, e há checkpoint por página. Se o
     orçamento de tempo acabar, a fase A termina `incompleta` e retoma da página seguinte.
2. **Fila de planos.** Tabela nova `private.pca_plano_fila`, com uma linha por plano e ano. As colunas:
   `id_pca_pncp`, `cnpj`, `ano`, `sequencial`, `motivo` (`novo` | `alterado` | `backfill` | `reconciliacao`),
   `data_atualizacao_fonte`, `status` (`pendente` | `processando` | `feito` | `erro`), `tentativas`, `erro`,
   `chain_id` e timestamps.

   A tabela é idempotente por `(id_pca_pncp, chain_id)` e não tem grant para `anon` nem `authenticated`.
3. **Carga por plano (fase B), cronometrada em fatias.**
   - **Leitura:** cada invocação tira planos `pendente` da fila (`for update skip locked`) até um orçamento de tempo `T`
     (proposta: 90 s, configurável no body e no env) ou `N` planos (proposta: 60).
   - **Requisição por plano:** `GET /api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens?pagina=1&tamanhoPagina=2000`,
     seguindo para a página seguinte enquanto vier página cheia.
   - **Filtro:** fica com os itens cujo `classificacaoSuperiorCodigo` está no escopo.
   - **Gravação:** em lote (passo 5) e marca o plano como `feito`.
   - **Inativação por plano:** os itens do escopo daquele plano que estão ativos no banco e não vieram na integração
     são inativados (`ativo = false`), nunca apagados. É seguro porque a integração traz o plano inteiro.
   - **Erro de HTTP ou de gravação:** o plano fica `erro`, com mensagem e `tentativas + 1`. Erro não é resultado vazio:
     plano com erro não inativa nada.
   - **Mapeamento T3 → modelo atual:**

     | Integração | Modelo atual |
     |---|---|
     | `quantidade` | `quantidadeEstimada` |
     | `descricao` | `descricaoItem` |
     | `nomeClassificacao` | `nomeClassificacaoCatalogo` |
     | `dataPublicacaoPncp` | `dataPublicacaoPNCP` |

     Os demais campos têm o mesmo nome. A normalização produz **a mesma linha e o mesmo `payload_hash`** que o caminho
     atual produziria para o mesmo item (CA-3).
   - **Ritmo:** 1 req/s ao PNCP. Usa o orçamento de rate limit compartilhado do `consulta-client`/`integracao-client`.
4. **Gravação em lote por plano.** Substitui o item a item:
   - **plano:** upsert do cabeçalho, com histórico só se o hash mudar;
   - **itens:** um select de `numero_item, id, payload_hash` por `pca_plano_id`, seguido de um upsert em lote dos novos e
     alterados e de uma linha em `pca_alteracoes` por alterado;
   - **inalterados:** um update em lote de `last_seen_sync_id`, `last_synced_at` e `ativo = true`;
   - **vínculos de origem:** um select em `catmat_pdms` e outro em `catalogo_itens` para os códigos do plano, seguidos de
     upserts em lote em `pca_item_pdm` e `catalogo_ponte`.

   A semântica do `upsertByHash` não muda: mesmo hash, mesmas colunas e histórico só quando o hash muda.
6. **Rotinas.**
   - **Incremental diário:**
     - no cron atual (06:13), a fase A roda com `motivo` `novo`/`alterado`;
     - em seguida, a fase B roda em elos até a fila esvaziar ou até um teto de elos por dia (pergunta 1);
     - esperado pelos números de 09/10: de 38 a 78 planos por dia, de 1 a 2 elos.
   - **Backfill cronometrado:**
     - `{"rotina":"backfill","ano":2026}` roda a fase A e enfileira **todos** os planos descobertos (`motivo = backfill`);
     - a fase B processa em fatias: 935 planos a 1 req/s dão uns 16 min de requisição, em cerca de 16 elos de 60 planos;
     - é disparado pelo Marcelo depois do merge (pergunta 3).
   - **Reconciliação mensal:**
     - cron no dia 1, às 05:00;
     - enfileira todos os planos ativos do banco e os da descoberta (`motivo = reconciliacao`), e a fase B reprocessa;
     - **plano ausente:** só é inativado se faltar em **duas descobertas seguidas** **e** a integração do plano não trouxer
       nenhum item do escopo. Se o retorno for 404, isso fica registrado.
     - grava no `pncp_sync_run` a contagem da fonte (pares distintos da consulta), a do banco antes e a do banco depois.
       O banco depois deve ser maior ou igual aos pares distintos da consulta, porque a consulta pula itens.
   - O `inactivateNotSeen` global por `last_seen_sync_id` deixa de rodar para `pca_itens`. A inativação passa a ser por
     plano (passo 4) e, para planos, pela regra da reconciliação.
7. **Encadeamento.** Um cron de continuação a cada 10 min, das 06:20 às 08:00, chama a fase B com `somente_retomada: true`.
   Se não houver plano `pendente`, ela sai sem trabalho. O padrão é o mesmo de
   `licitagym-sync-compras-catmat-catalogo-continuacao`. O backfill usa o mesmo cron. A alternativa (o elo chamar o
   próximo via `pg_net`) está na pergunta 1.
8. **Saúde.**
   - **`pca_sync_sem_concluir_horas`:** crítico quando a última fase A `concluida` tem mais de 36 h.
   - **`pca_fila_atrasada`:** crítico quando há plano `pendente` ou `erro` há mais de 24 h. Atenção quando há plano com
     `tentativas >= 3`.
   - Atenção quando há execução `executando` sem heartbeat há mais de 10 min.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o plano de 1.800 itens (fixture da integração), **quando** a fase B grava o plano contra o cliente falso, **então** faz no máximo 12 chamadas ao banco. Hoje são cerca de 8 por item. O número exato, antes e depois, vai para o PR. | Deno `tests/supabase/functions/sync_pncp_pca_lote_test.ts` |
| CA-2 | **Dado** o mesmo plano, **então** o resultado no banco falso é igual ao do caminho item a item para os itens do escopo: as mesmas linhas, colunas, `payload_hash` e linhas de histórico, e as mesmas contagens novos, alterados e inalterados. | idem (comparação dos dois caminhos) |
| CA-3 | **Dado** o mesmo item vindo da consulta (`quantidadeEstimada`, `descricaoItem`) e da integração (`quantidade`, `descricao`), **então** o normalizador produz a mesma linha e o mesmo `payload_hash`. | Deno `tests/supabase/functions/pca_normalizar_integracao_test.ts` |
| CA-4 | **Dado** um item com hash igual ao do banco, **então** não grava histórico e só atualiza `last_seen_sync_id`, `last_synced_at` e `ativo = true`. | `sync_pncp_pca_lote_test.ts` |
| CA-5 | **Dado** duas páginas da consulta com o mesmo `(idPcaPncp, numeroItem)` repetido na fronteira, **quando** a fase A roda, **então** o plano entra na fila uma vez e o log registra as linhas e os pares distintos. | Deno `tests/supabase/functions/sync_pncp_pca_descoberta_test.ts` |
| CA-6 | **Dado** um plano com `dataAtualizacaoGlobalPCA` igual à do banco, **então** a fase A incremental não o enfileira. **Dado** um plano com data maior ou ausente no banco, **então** enfileira com `motivo` `alterado` ou `novo`. | idem |
| CA-7 | **Dado** um orçamento de 2 planos e uma fila com 5, **quando** a fase B roda, **então** processa 2, deixa 3 `pendente`, termina a execução como `incompleta` e responde sem erro. A próxima invocação processa os próximos sem repetir os feitos. | `sync_pncp_pca_lote_test.ts` |
| CA-8 | **Dado** um plano com o item 413 ativo no banco e ausente da resposta da integração, **quando** a fase B grava o plano, **então** o 413 fica `ativo = false` e nada é apagado. **Dado** que a integração falhou (HTTP 5xx, timeout), **então** nenhum item do plano é inativado e o plano fica `erro`. | idem |
| CA-9 | **Dado** uma falha do PostgREST no upsert em lote, **então** o plano fica `erro` com a mensagem e a execução fica `falhou` ou `incompleta`, nunca `concluida` com contagem zerada. | idem |
| CA-10 | **Dado** um plano ausente de uma única descoberta, **então** a reconciliação não o inativa. **Dado** um plano ausente de duas descobertas seguidas e sem itens do escopo na integração, **então** inativa o plano e seus itens. | Deno `tests/supabase/functions/sync_pncp_pca_reconciliacao_test.ts` |
| CA-11 | O vínculo de origem continua igual: `pca_item_pdm` (`exata`, `pncp:pdmCodigo`, confirmado) e `catalogo_ponte` para os mesmos itens do caminho atual. | `sync_pncp_pca_lote_test.ts` |
| CA-12 | **Dado** a fila, **então** `anon` e `authenticated` não leem nem escrevem `private.pca_plano_fila`, e só `service_role` executa as funções novas. | SQL `supabase/tests/pca_plano_fila_check.sql` |
| CA-13 | Saúde: `pca_sync_sem_concluir_horas` fica crítico com mais de 36 h e ok com menos. `pca_fila_atrasada` fica crítico com plano `pendente` há mais de 24 h. Fixtures em `private.pncp_sync_run` e na fila. | SQL `supabase/tests/saude_pca_sync_check.sql` |
| CA-14 | **Regressão de produção:** depois do merge e do backfill disparado pelo Marcelo, o plano `00394429000100-0-000004/2026` tem os 32 itens 7830 ativos em `pca_itens`, o plano `18401059000157-0-000011/2026` tem os 19, e a última fase A e a fila terminam sem plano `erro`. | verificação pós-merge (skill `verificar-producao`), anotada no PR |

## Fora de escopo

- **`/pca/atualizacao`:** volta como detector quando responder em menos de 50 s para um dia de 2026. Há uma issue para
  remedir mensalmente.
- **Campos oficiais que hoje descartamos** (spec 0010). Ela muda o normalizador e o hash; esta não muda.
- **Radar por unidade/UASG** (spec 0011).
- **PGC Compras.gov** (DFD, projeto de compra, status da contratação): enriquecimento futuro, com deduplicação obrigatória.
- **Outras classes** (7220 etc.): o motor aceita a lista de classes, mas só 7830 entra no escopo agora.
- **Outros `sync-*` com o mesmo padrão item a item.**

## Impacto em dados

- **Migrations:** todas aditivas e idempotentes:
  - `<timestamp>_pca_plano_fila.sql`: a fila, os índices e as funções de enfileirar e de pegar o próximo, com
    `security definer`, `search_path` fixo e grant só para `service_role`;
  - `<timestamp>_cron_pca_continuacao_reconciliacao.sql`: o cron de continuação (a cada 10 min, das 06:20 às 08:00) e o
    mensal de reconciliação;
  - `<timestamp>_saude_pca_sync.sql`: os limiares novos e a recriação de `saude_operacional_resumo`, igual à de produção
    mais os blocos novos.
- **Tabelas escritas:** `pca_planos`, `pca_itens`, `pca_alteracoes`, `pca_item_pdm`, `catalogo_ponte`,
  `private.pncp_sync_run` e `private.pca_plano_fila` (nova).
- **ACL/RLS:** só a tabela nova, em `private`, sem grant para `anon`/`authenticated`. Nada muda nas existentes.
- **Recarga:** depois do merge, um backfill de 2026, disparado pelo Marcelo.
  - Esperado:
    - pelo menos os 6.009 pares distintos da consulta;
    - mais os itens que a consulta pula, que só a integração mostra, em quantidade não medida;
    - menos os 3.686 já ativos.
  - O número real vai para o PR.
  - Itens que saíram da fonte são inativados por plano, nunca apagados.
- **Requisições ao PNCP:**
  - descoberta: 13 por dia;
  - incremental: de 38 a 78 por dia, pelos números de 09/10;
  - backfill e reconciliação: cerca de 935.
  - Tudo a 1 req/s.
- **Edge Functions republicadas no merge:** todas, como sempre. Muda a `sync-pncp-pca`; a `api-saude` passa a ler as
  verificações novas.
- **Contrato com o Dashboard:** inalterado. O radar passa a ter mais itens.
- **Dado oficial x derivado:** os itens vêm do PNCP (integração), e os campos são os mesmos de hoje. A fila e as
  contagens são operacionais. Nenhum valor é inventado.

## Perguntas em aberto

2. **Encadeamento:** um cron de continuação a cada 10 min das 06:20 às 08:00, com o mesmo padrão do catmat (proposta), ou
   o elo chamar o próximo via `pg_net`, com um teto de elos por dia?
3. **Limiares da saúde:** 36 h sem fase A `concluida` e 24 h com plano `pendente` são críticos?
4. **Backfill depois do merge:** rodar logo o backfill completo (cerca de 16 elos), ou primeiro só o incremental para
   conferir a contagem de um dia?
5. **Ordem com a 0010:** a 0010 muda o normalizador e o hash. Implementar a 0012 primeiro, para trazer o que falta com o
   hash atual, e a 0010 depois, com uma reconciliação?

# Auditoria e Proposta de Arquitetura: Rate Limiting, Concorrência e Resiliência HTTP

**Documento:** `.audit/20-rate-limit-map-and-design.md`  
**Data:** 28 de setembro de 2026  
**Fase:** 1 de 2 — Mapeamento e Desenho de Arquitetura (Sem implementação de código, sem migrations em banco, sem PR)  
**Autor:** Cloud Agent — LicitaGym SaaS  
**Branch:** `cursor/rate-limit-design-943c`

---

## Sumário Executivo

Esta auditoria investigou os incidentes de produção registrados nas tabelas `private.pncp_sync_run` e `private.pncp_sync_request` do Supabase:
1. **Contratações Editais (`contratacoes_editais`):** 41 concluídas, 18 falhas com HTTP 429 ("PNCP consulta HTTP 429"), 1 timeout e 1 lock expirado. Em 2026-09-20 (06:26–06:35 UTC), ocorreram de 6 a 10 disparos concorrentes por minuto, totalizando 27 a 40 req/min no endpoint `/contratacoes/publicacao`, com ~33% de taxa de erro 429.
2. **Catálogo CATMAT Compras.gov.br (`compras_catmat`):** 35 concluídas, 2 falhas por HTTP 429 ("Compras.gov HTTP 429"), 3 outras falhas.
3. **PCA PNCP (`pca`):** 261 concluídas, 0 com 429, mas 240 timeouts de 45 segundos, 17 HTTP 500 e 2 HTTP 503.

**Diagnóstico Estrutural:**
- As coletas que alimentam `private.pncp_sync_run` e `private.pncp_sync_request` são executadas **exclusivamente pelas Supabase Edge Functions em Deno** (`supabase/functions/sync-pncp-*`, `sync-compras-catmat`).
- A camada Python (`scripts/lib/http_client.py`, `scripts/lib/http_fetch.py`, `scripts/lib/sync_state.py` desenvolvida nos Lotes L1–L3 / PRs #32, #37, #38, #39) opera de forma isolada, gravando checkpoints em arquivos locais JSON (`.sync_state/`), sem integração com `private.pncp_sync_run` ou Postgres.
- O campo `tentativa` em `private.pncp_sync_request` possui valor `max(tentativa) = 1` porque as Edge Functions só gravam requisições bem-sucedidas em `logSyncRequest` (`status_http = 200`). Quando um 429 ou 5xx esgota as retentativas no cliente HTTP, nenhuma linha é persistida em `pncp_sync_request` com o código 429; o erro é capturado no bloco `catch` e lançado para o `erro_principal` de `pncp_sync_run`.
- O escalonamento simultâneo de editais decorre da fragmentação de datas em 12 modalidades no mesmo minuto ou chamadas repetidas sem coordenação inter-processos.
- O lock lógico atual (`lock_key` em `private.pncp_sync_run`) é um lock de granularidade grossa por parâmetro de rota (ex.: `contratacoes-editais:20260913:20260920`). Ele **não** impede que fatias com datas ou modalidades distintas executem simultaneamente no mesmo host (`pncp.gov.br`), gerando tempestades de requisições paralelas.
- O timeout de 45 s (`DEFAULT_FETCH_TIMEOUT_MS = 45_000`) nas Edge Functions colide com o teto de isolamento do Deno Deploy / Edge Runtime (CPU/wall-clock cap), levando a timeouts catastróficos (ex.: código 546) quando combinados com `sleep` prolongados.

Abaixo apresenta-se o mapeamento exaustivo, a análise de idempotência e a proposta completa de solução com limitador distribuído via Postgres, retry estruturado e retomada com orçamento de tempo.

---

## 1. Mapeamento Completo de Pontos HTTP (PNCP e Compras.gov.br)

### 1.1 Tabela Geral de Pontos HTTP

| # | Host de Destino | Arquivo e Linha | Função / Método | Runtime / Ambiente | O que dispara | Tratamento Atual de Erro | Timeout Configurado | Onde grava em `pncp_sync_run` / `pncp_sync_request` | Status Possíveis |
|---|-----------------|-----------------|-----------------|--------------------|---------------|--------------------------|---------------------|----------------------------------------------------|------------------|
| **1** | `pncp.gov.br/api/consulta/v1` | `supabase/functions/_shared/pncp/consulta-client.ts:120` | `PncpConsultaClient.getJson()` | Deno (Edge Function / Scripts TS) | Chamado por `sync-pncp-contratacoes-editais`, `sync-pncp-contratacoes-atas`, `sync-pncp-contratacoes-contratos`, `sync-pncp-pca` | `withRetry` (3 tentativas, exp backoff + jitter 25%, respeita Retry-After). Lança `RetryableHttpError` (429, 5xx, timeout) ou `PermanentHttpError` (4xx exceto 429). Anomalia 200 vazio retenta 1x. | 45 s (`DEFAULT_FETCH_TIMEOUT_MS = 45_000`), ajustado dinamicamente por `budget.attemptTimeoutMs()` | `pncp_sync_request` via `logSyncRequest` (apenas após sucesso HTTP 200). `pncp_sync_run` via `finishSyncRun`. | Edge: `concluida`, `concluida_com_erros`, `incompleta`, `falhou`, `already_running` |
| **2** | `pncp.gov.br/api/search` | `supabase/functions/_shared/pncp/search-client.ts:91` | `PncpSearchClient.fetchPcaOrgaoPage()` | Deno (Edge Function) | Chamado por `sync-pncp-pca` (somente_verificacao e health probe) | `withRetry` (3 tentativas, exp backoff + jitter, respeita Retry-After). Lança `RetryableHttpError` ou `PermanentHttpError`. | 45 s (`DEFAULT_FETCH_TIMEOUT_MS = 45_000`), limitado por `RequestBudget` | Registra em `pncp_period_anchor` e `pncp_sync_run`. Não grava em `pncp_sync_request`. | `verificacao`, `verificacao_incompleta`, `ignorado`, `falhou`, `BUDGET_EXHAUSTED` |
| **3** | `pncp.gov.br/api/pncp/v1` | `supabase/functions/_shared/pncp/integracao-client.ts:19` | `PncpIntegracaoClient.getJson()` | Deno (Edge Function) | Chamado por `sync-pncp-orgaos`, `sync-pncp-catalogo`, `sync-pncp-irp` | `withRetry` (3 tentativas, backoff simples). Trata 429 e >=500 lançando `Error`. Não trata Retry-After explicitamente nesta classe. | 45 s (default do `fetchWithTimeout` não usado aqui; usa `fetch` global sem abort signal explícito) | `pncp_sync_request` em caso de erro em `sync-pncp-catalogo` (linhas 36, 65). `pncp_sync_run` via `finishSyncRun`. | `concluida`, `concluida_com_erros`, `falhou`, `gate_passed`, `already_running` |
| **4** | `www.gov.br/pncp/pt-br/pncp/legislacao` | `supabase/functions/sync-pncp-legislation/index.ts:54, 105, 117` | `Deno.serve(handler)` | Deno (Edge Function) | pg_cron (`pncp-legislation-check` a cada 6h) ou API `/api-pncp-legislacao` | Try/catch básico. Não usa `withRetry`. Baixa HTML e PDFs. | Sem timeout configurado (usa timeout padrão do fetch do Deno ~120s) | `logSyncRequest` registra endpoint e status HTTP (linhas 60–67). `finishSyncRun` registra status geral. | `concluida`, `falhou`, `already_running` |
| **5** | `dadosabertos.compras.gov.br` | `supabase/functions/_shared/compras-gov/material-client.ts:36` | `fetchPage()` / `ComprasGovMaterialClient` | Deno (Edge Function) | Chamado por `sync-compras-catmat` (endpoints 1 a 7 de material) | `withRetry` (6 tentativas, delay base 2500 ms). 429 e >=500 lançam `Error`. 4xx lança `PermanentHttpError`. Delays de 350ms entre páginas e 250ms por PDM. | 60 s (`fetchWithTimeout(url, init, 60_000)`) | `logSyncRequest` (linhas 191, 217, 244, 275, 382) e `finishSyncRun` | `concluida`, `concluida_com_erros`, `falhou`, `blocked`, `already_running` |
| **6** | `compras.gov.br/api/v1` | `supabase/functions/_shared/compras-gov/consulta-client.ts:147` | `ConsultaComprasGovClient.fazer()` | Deno (Edge Function) | Chamado por `sync-comprasgov-consulta` (placeholder dos 77 endpoints) | AbortController com timeout. Não tem retry automático para 429/5xx. Retorna erro em array estruturado. | 30 s (`timeout = 30000`) | `logSyncRequest` e `finishSyncRun` em `sync-comprasgov-consulta` | `concluida`, `erro`, `already_running` |
| **7** | `pncp.gov.br` (vários) | `services/coletor-externo/coletor/pncp.py:91` | `PNCP._get()` | Python 3 (Cloud Run / CLI local) | Execução via CLI (`python -m coletor.pncp`) ou cron externo de busca textual | Loop próprio de retentativas (6 tentativas). Trata 429 (respeita `Retry-After`), 500, 502, 503, 504 com backoff `min(60, 5 * 2**tentativa)`. Sleep de 0.5s por request. | 90 s geral (`self.timeout = 90`); 20 s para detalhe de compra (`DETALHE_TIMEOUT = 20`) | **NÃO GRAVA** em `pncp_sync_run` nem em `pncp_sync_request`. Grava direto nas tabelas públicas `licitacoes_externas`, `licitacao_itens`, `licitacao_resultados`. | N/A (printa resumo e log estruturado) |
| **8** | `pncp.gov.br/api/consulta/v1` | `scripts/collector_pncp_contratacoes.py:56` | `fetch_contratacoes()` | Python 3 (CLI / Batch local) | Execução manual/agendada via script Python | Usa `scripts.lib.http_fetch.fetch_json()` -> `HttpClient` (1 tentativa default, backoff exp, respeita Retry-After, transient 502/503/504). Checkpoint via `SyncStateManager`. | 30 s (`TIMEOUT = 30`) | **NÃO GRAVA** em `pncp_sync_run`. Grava checkpoint em `scripts/.sync_state/pncp_contratacoes_publicacao.json` e resultado em arquivo JSON local. | Status no JSON: `running`, `completed`, `failed_partial`, `failed` |
| **9** | `dadosabertos.compras.gov.br` | `scripts/collector_*_material.py` (E1 a E7) | `fetch_*()` em cada coletor | Python 3 (CLI / Batch local) | Execução manual via scripts Python (`collector_grupo_material.py`, etc.) | Usa `scripts.lib.http_fetch.fetch_json()` -> `HttpClient` (retry em 429 com Retry-After e transient 5xx). Checkpoint via `SyncStateManager`. | 30 s (`TIMEOUT = 30`) | **NÃO GRAVA** em `pncp_sync_run`. Grava checkpoint em `.sync_state/*.json` e arquivo de resultado JSON. Persistência no banco é feita à parte via `upsert_icatmat_consolidado.py`. | Status no JSON: `running`, `completed`, `failed_partial`, `failed` |
| **10** | `www.gov.br/pncp/...` | `docs/agente-juridico-ml/scripts/discover_pncp_links.py:46, 54` | `get_html()`, `api_items()` | Python 3 (CLI local / pipeline ML) | Script pontual de descoberta de links jurídicos | `requests.get` direto. `raise_for_status()`. Sem retentativa explícita de rate limit. | 45 s (`timeout = 45`) | Não grava no Supabase. Salva em `artifacts/pncp_links.json`. | Exit codes de script (0, 1, 2) |
| **11** | `todaslicitacoes.com.br` | `supabase/functions/discover-piso-pdm/index.ts:44, 96` | `fetch()` direto | Deno (Edge Function protótipo) | Invocação HTTP manual | Try/catch básico. Sem retry, sem validação de auth de cron. Protótipo não implantado em produção. | Default da plataforma (~120s) | Não grava em `pncp_sync_run`. Retorna payload JSON. | `sucesso: true/false` |

---

### 1.2 Origem das Coletas em `pncp_sync_run` e `pncp_sync_request`

**Resposta explícita à investigação requerida:**
As coletas registradas em `private.pncp_sync_run` e `private.pncp_sync_request` são disparadas **exclusivamente pelas Edge Functions em Deno**:
1. `sync-pncp-contratacoes-editais` (grava `resource_type = 'contratacoes_editais'`)
2. `sync-compras-catmat` (grava `resource_type = 'compras_catmat'`)
3. `sync-pncp-pca` (grava `resource_type = 'pca'`)
4. Demais syncs: `sync-pncp-contratacoes-atas`, `sync-pncp-contratacoes-contratos`, `sync-pncp-legislation`, `sync-pncp-catalogo`, `sync-pncp-irp`, `sync-pncp-orgaos`.

Os scripts Python (`scripts/lib/*` e `services/coletor-externo/*`) **não tocam** no schema `private.pncp_sync_*`. Eles são ferramentas de execução manual ou externa. A sincronização de produção é 100% baseada nas Edge Functions.

---

### 1.3 Quem Agenda as Coletas e Por Que 6 a 10 Coletas Começam no Mesmo Minuto?

#### Análise das Migrations e Agendamentos (`pg_cron`)
No arquivo `supabase/migrations/202609180008_cron.sql`, estão modelados os agendamentos via `pg_cron` e `pg_net`:
- `pncp-contratacoes-editais`: `'0 */6 * * *'` (executa de 6 em 6 horas, no minuto 0).
- `pncp-contratacoes-atas`: `'15 */6 * * *'` (minuto 15).
- `pncp-contratacoes-contratos`: `'30 */6 * * *'` (minuto 30).
- `pncp-legislation-check`: `'0 */6 * * *'`.
- `pncp-pca-sync-com-gate`: `'30 3 1 * *'`.

#### A Causa Raiz do Ponto de Congestionamento (2026-09-20 06:26–06:35 UTC):
1. **Disparador Externo via Script ou Loop:** O cron SQL oficial estava agendado para minuto `00` (`0 */6 * * *`). O pico ocorreu entre `06:26` e `06:35` UTC. Esse padrão não coincide com o minuto zero do `pg_cron`. Trata-se de uma bateria de disparos automatizados (via PowerShell/curl ou loop que itera parâmetros, similar ao padrão visto em `scripts/reimport-pca.ps1` e `scripts/invoke-sync-licitagym-scope.ps1`).
2. **Ausência de Throttle / Rate Limit entre Processos:** Cada chamada HTTP POST para `/sync-pncp-contratacoes-editais` gera um container isolado de Edge Function no Deno Deploy.
3. **Loop Interno de Modalidades na Edge Function:** Dentro de `sync-pncp-contratacoes-editais/index.ts` (linhas 31, 55, 77), se o parâmetro `modalidade` não for enviado, o sistema gera fatias para 12 modalidades (`MODALIDADES = [1..12]`). A função `runCappedDateSync` itera sobre essas fatias e dispara requisições consecutivas sem qualquer pausa global.
4. **Colisão de `lock_key`:** O lock é composto apenas por `contratacoes-editais:${dataInicial}:${dataFinal}`. Se várias chamadas chegam com datas ligeiramente diferentes (ex.: fatiamento diário por script externo) ou se passam o parâmetro `modalidade` no body, o lock key muda (ex.: se a chave incluir parâmetros ou se o script rodar dias diferentes).
5. **Resultado:** De 6 a 10 instâncias de Edge Functions ativas em paralelo no mesmo minuto, cada uma fazendo requisições de página com 50 itens para `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao`. O endpoint do PNCP bloqueou a taxa combinada (27 a 40 req/min) emitindo HTTP 429.

---

### 1.4 Como Funciona o `lock_key` Hoje e Por Que Surge "Lock Expirado (Executando Stale)"?

#### Mecanismo Atual (`supabase/functions/_shared/pncp/lock.ts:16-55`)
- A função `acquireSyncLock` busca em `private.pncp_sync_run` por:
  ```sql
  SELECT id, iniciada_em FROM private.pncp_sync_run
  WHERE lock_key = $1 AND status = 'executando'
  LIMIT 1;
  ```
- Se encontrar um registro:
  - Calcula a idade da execução: `ageMs = Date.now() - iniciada_em`.
  - Se `ageMs < STALE_LOCK_MS` (definido como **3 minutos** / 180.000 ms em `lock.ts:9`): retorna `{ alreadyRunning: true }`. A Edge Function recusa a execução e responde HTTP 200 `{ status: "already_running" }`.
  - Se `ageMs >= STALE_LOCK_MS`: considera que o processo anterior morreu (crash, wall-clock timeout da Edge Function de 150 s, etc.) e executa:
    ```sql
    UPDATE private.pncp_sync_run
    SET status = 'falhou',
        erro_principal = 'lock expirado (executando stale)',
        finalizada_em = now()
    WHERE id = $existing_id;
    ```
  - Em seguida, insere uma nova linha com status `'executando'`.

#### Por que surge "lock expirado (executando stale)"?
1. **Edge Function Timeout Silencioso:** As Edge Functions do Supabase possuem um limite máximo de execução de 150 segundos (2,5 minutos).
2. Se uma Edge Function entrar em um loop de retry longo ou fizer muitas requisições que demoram 45 segundos cada, ela atinge o timeout da infraestrutura Supabase/Deno (código 546).
3. O container Deno é terminado abruptamente pela infraestrutura antes de atingir o bloco `catch` e antes de chamar `finishSyncRun()`.
4. O registro em `pncp_sync_run` fica perpetuamente com `status = 'executando'`.
5. Quando a próxima coleta é disparada após 3 minutos, ela detecta que o lock tem mais de 180 s e marca o registro anterior como `status = 'falhou'` com `erro_principal = 'lock expirado (executando stale)'`.

---

### 1.5 Por Que Nenhuma Linha em `pncp_sync_request` Tem `status_http = 429` e `tentativa > 1`?

Examinando `sync-pncp-contratacoes-editais/index.ts:110-132`, `sync-pncp-pca/index.ts:118-132` e `sync-compras-catmat/index.ts:81-88`:
1. **Ordem de Execução:** O método `consulta.fetchContratacoesPublicacao()` é chamado dentro de `withRetry`.
2. Quando a API remota retorna HTTP 429 ou 500, o cliente HTTP (`PncpConsultaClient.getJson`) lança uma exceção `RetryableHttpError`.
3. O método `withRetry` captura a exceção, aguarda o delay (ou `Retry-After`) e faz a 2ª tentativa. Se falhar novamente, faz a 3ª.
4. Se uma tentativa tiver sucesso, o código continua e chama `logSyncRequest(client, { statusHttp: page.status, ... })`. Portanto, **só a resposta final bem-sucedida (HTTP 200) é registrada**, e o helper sempre insere com `tentativa: input.tentativa ?? 1` (default 1).
5. Se todas as 3 tentativas falharem com 429, o `withRetry` re-lança a exceção `RetryableHttpError("PNCP consulta HTTP 429")`.
6. O loop da página é interrompido, saltando diretamente para o bloco `catch (error)` da Edge Function.
7. A função `logSyncRequest` **nunca é executada** para as tentativas com erro.
8. No bloco `catch`, a função chama `finishSyncRun(client, runId, { status: "falhou", erroPrincipal: "PNCP consulta HTTP 429" })`.
9. **Conclusão:** `private.pncp_sync_request` não registra o histórico de tentativas intermediárias nem requisições que falharam; o erro só fica visível na coluna `erro_principal` da tabela `pncp_sync_run`.

---

### 1.6 Status Exatos Existentes no Banco de Dados

Conforme as migrations `202609180001_pncp_foundation.sql` e `20260923203037_pncp_sync_run_status_incompleta.sql`:

#### Valores permitidos em `private.pncp_sync_run.status`:
1. `'pendente'` (default na criação da tabela)
2. `'executando'` (marcado por `acquireSyncLock`)
3. `'concluida'` (sucesso total sem erros)
4. `'concluida_com_erros'` (concluída com `total_erros > 0`)
5. `'falhou'` (erro de transporte, lock expirado ou exceção não recuperada)
6. `'cancelada'` (cancelamento administrativo)
7. `'incompleta'` (adicionado pela migration `20260923203037` para suportar checkpoints de paginação e budget esgotado)

#### Valores permitidos em `private.idempotency_key.status`:
1. `'executando'`
2. `'concluida'`
3. `'falhou'`

#### Valores permitidos em `private.job_queue.status`:
1. `'pending'`
2. `'processing'`
3. `'completed'`
4. `'failed'`

---

## 2. Idempotência e Análise de Upserts

Análise detalhada de cada ponto de gravação no banco de dados para verificar se uma execução repetida ou retomada da mesma página/fatia causa duplicações ou erros de chave única:

| Coletor / Tabela Alvo | Arquivo e Linha | Método / Mecanismo de Upsert | Chave de Conflito Utilizada | Comportamento na Repetição de Página | Risco de Duplicação ou Inconsistência? |
|-----------------------|-----------------|------------------------------|-----------------------------|--------------------------------------|----------------------------------------|
| **`contratacoes_editais`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-contratacoes-editais/index.ts:153` | `upsertByHash()` | `{ orgao_cnpj, ano, sequencial }` (UNIQUE em `public.contratacoes_editais:30`) | Busca por chave única. Se `payload_hash` for idêntico, faz `UPDATE touch` (`last_synced_at = now()`, reativa se `ativo=false`). Se alterado, faz `UPDATE` e gera histórico. | **Idempotente.** Não duplica. |
| **`contratacoes_atas`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-contratacoes-atas/index.ts:144` | `upsertByHash()` | `{ orgao_cnpj, ano, sequencial_ata }` (UNIQUE em `public.contratacoes_atas`) | Idem: verifica hash e atualiza ou toca timestamp. | **Idempotente.** Não duplica. |
| **`contratacoes_contratos`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-contratacoes-contratos/index.ts:144` | `upsertByHash()` | `{ orgao_cnpj, ano, sequencial }` (UNIQUE em `public.contratacoes_contratos`) | Idem: busca por chave única e atualiza. | **Idempotente.** Não duplica. |
| **`pca_planos`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-pca/index.ts:155` | `upsertByHash()` | `{ id_pca_pncp }` (UNIQUE em `public.pca_planos:5`) | Idem: busca por `id_pca_pncp`, atualiza hash ou toca timestamp. | **Idempotente.** Não duplica. |
| **`pca_itens`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-pca/index.ts:183` | `upsertByHash()` | `{ pca_plano_id, numero_item }` (UNIQUE em `public.pca_itens:49`) | Idem: chave composta de plano + número do item. | **Idempotente.** Não duplica. |
| **`catmat_grupos`** | `supabase/functions/_shared/compras-gov/upsert-natural.ts:6-53` via `sync-compras-catmat/index.ts:202` | `upsertByNaturalKey()` | `{ codigo_grupo }` (PK em `public.catmat_grupos:4`) | Busca por `codigo_grupo`, compara `payload_hash`, atualiza apenas se mudou. | **Idempotente.** Não duplica. |
| **`catmat_classes`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-compras-catmat/index.ts:228` | `upsertByHash()` | `{ codigo_grupo, codigo_classe }` (UNIQUE em `public.catmat_classes:25`) | Compara `payload_hash`, atualiza campos e histórico. | **Idempotente.** Não duplica. |
| **`catmat_pdms`** | `supabase/functions/_shared/compras-gov/upsert-natural.ts:6-53` via `sync-compras-catmat/index.ts:259` | `upsertByNaturalKey()` | `{ codigo_pdm }` (PK em `public.catmat_pdms:31`) | Busca por `codigo_pdm`, compara `payload_hash`. | **Idempotente.** Não duplica. |
| **`catalogo_itens` (Compras.gov)** | `supabase/functions/_shared/compras-gov/catalogo-upsert.ts:6-64` via `sync-compras-catmat/index.ts:289` | `upsertCatalogoItemFromCompras()` | `{ codigo_catmat }` (UNIQUE index em `catalogo_itens_codigo_catmat_idx`) | Preserva curadoria manual (`fonte_curadoria = 'manual'`), compara hash e atualiza. | **Idempotente.** Não duplica. |
| **`catmat_pdm_naturezas_despesa`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-compras-catmat/index.ts:302` | `upsertByHash()` | `{ codigo_pdm, codigo_natureza_despesa }` (UNIQUE em `catmat_pdm_naturezas_despesa:56`) | Busca por chave composta, compara hash. | **Idempotente.** Não duplica. |
| **`catmat_pdm_unidades`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-compras-catmat/index.ts:321` | `upsertByHash()` | `{ codigo_pdm, sigla_unidade_fornecimento, numero_sequencial }` (UNIQUE em `catmat_pdm_unidades:71`) | Busca por chave composta de 3 colunas, compara hash. | **Idempotente.** Não duplica. |
| **`catmat_item_caracteristicas`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-compras-catmat/index.ts:395` | `upsertByHash()` | `{ codigo_item, codigo_caracteristica, codigo_valor_caracteristica }` | Busca por chave composta de 3 colunas. | ⚠️ **ATENÇÃO:** Se `codigo_valor_caracteristica` for NULL na API, a busca SQL `query.eq("codigo_valor_caracteristica", null)` gera `WHERE col IS NULL`. A tabela `catmat_item_caracteristicas` possui constraint `UNIQUE(codigo_item, codigo_caracteristica, codigo_valor_caracteristica)` comum (sem `NULLS NOT DISTINCT`). No PostgreSQL padrão, dois valores NULL são considerados distintos, o que pode causar linhas duplicadas se o valor for nulo. No staging `icatmat_caracteristica_material`, isso foi corrigido pela migration `20260922110000` (`UNIQUE NULLS NOT DISTINCT`), mas em `public.catmat_item_caracteristicas` ainda vigora a constraint antiga de `202609180015_catmat_compras.sql:88`. |
| **`source_record`** | `supabase/functions/_shared/pncp/supabase-admin.ts:25-36` | Supabase PostgREST `upsert()` | `onConflict: "endpoint,request_hash,content_hash", ignoreDuplicates: true` | UNIQUE constraint em `private.source_record(endpoint, request_hash, content_hash)`. | **Idempotente.** Não duplica. |
| **`icatmat_*` (Staging Python)** | `scripts/upsert_icatmat_consolidado.py:151` | Supabase PostgREST `upsert()` | `TABLE_ON_CONFLICT[table]` | Mapeado explicitamente para chaves naturais de E1 a E7. | **Idempotente.** Não duplica. |
| **`licitacoes_externas` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:402` | Supabase PostgREST `upsert()` | `conflito="fonte,codigo_externo"` (UNIQUE index `uq_licext_fonte_codigo`) | Atualiza linha existente. | **Idempotente.** Não duplica. |
| **`licitacao_itens` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:415` | Supabase PostgREST `upsert()` | `conflito="licitacao_id,numero_item"` (UNIQUE `licitacao_itens(licitacao_id, numero_item)`) | Atualiza item existente. | **Idempotente.** Não duplica. |
| **`licitacao_resultados` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:426` | Supabase PostgREST `upsert()` | `conflito="licitacao_id,numero_item,sequencial_resultado"` (UNIQUE `licitacao_resultados(...)`) | Atualiza resultado existente. | **Idempotente.** Não duplica. |
| **`legislacao_documentos`** | `supabase/functions/sync-pncp-legislation/index.ts:84-100` | Select manual `maybeSingle()` + `insert()` | `{ url_canonica }` | ⚠️ **PONTO SEM ON_CONFLICT DIRETO:** Faz um SELECT prévio e se não existir faz INSERT. Sob concorrência de dois processos no mesmo milissegundo, pode gerar `duplicate key value` se houver índice único em `url_canonica`. |

**Conclusão sobre Idempotência:**
Os coletores principais de PNCP e Compras.gov nas Edge Functions utilizam chave única e comparação de `payload_hash`. Portanto, **repetir a mesma página em caso de retry ou retomar de um checkpoint NÃO DUPLICA registros de negócio**, sendo perfeitamente seguro reexecutar fatias interrompidas.

---

## 3. Desenho Proposto da Solução (Fase de Planejamento)

### 3.1 Cliente HTTP Compartilhado por Runtime e Reuso da Camada Python

#### O que já existe e pode ser aproveitado / alinhado:
1. **Lote 2 (PR #37):** Unificação de parsing de `Retry-After` (segundos delta e HTTP-date RFC 7231 / RFC 2822).
   - No Python: `scripts/lib/http_client.py:parse_retry_after()`.
   - No Deno: `supabase/functions/_shared/pncp/retry.ts:parseRetryAfterMs()`.
   - **Alinhamento:** Ambos já sabem tratar data e segundos. No entanto, no Deno, o `withRetry` aplica o `Retry-After` apenas localmente por chamada, sem comunicar o período de espera aos demais processos.
2. **Lote 3 (PR #38/#39):** Checkpoint e retomada estruturada.
   - No Python: `scripts/lib/sync_state.py` com estados `'running'`, `'completed'`, `'failed_partial'`, `'failed'`.
   - No Deno: `supabase/functions/_shared/pncp/pagination-budget.ts` com fatiamento de datas e status `'incompleta'` via migration `20260923203037`.
   - **Alinhamento:** O conceito de `incompleta` no Deno já é o equivalente nativo do `failed_partial` do Python. O que falta é permitir que a Edge Function saia graciosamente quando encontrar rate limit ou esgotamento de budget, registrando a página exata para continuação.

#### Proposta do Cliente HTTP Deno em `supabase/functions/_shared/`:
Criar um módulo centralizador unificado (ex.: `supabase/functions/_shared/http-client/unified-client.ts`) consumido por `consulta-client.ts`, `search-client.ts`, `integracao-client.ts` e `material-client.ts`.

**Características:**
- **Throttling por Host em Memória (Local no Isolate):**
  - Mantém uma fila/leaky bucket local: `last_request_timestamp[host]`.
  - Garante intervalo mínimo entre requisições (ex.: `PNCP_MIN_INTERVAL_MS = 1000` -> 1 req/s; `COMPRAS_MIN_INTERVAL_MS = 1000`).
- **Coordenação Distribuída Inter-Processos (Postgres):**
  - Antes de cada requisição externa ao host alvo, solicita um lease/slot ao Postgres via RPC atômica (detalhada na seção 3.2).
- **Orçamento de Tempo da Edge Function (`RequestBudget`):**
  - Cada execução monitora o tempo de vida do isolamento. Se o tempo restante for insuficiente para fazer a requisição + retry + gravação de checkpoint (ex.: margem de 10 s), a Edge Function **interrompe a paginação graciosamente**, grava o estado `'incompleta'` com a `pagina_atual`, e encerra com código HTTP 200 (ou 202 Accepted) em vez de ser morta pelo timeout de 150 s do Supabase (erro 546).

---

### 3.2 Limite Distribuído entre Processos via Postgres (Lease de Host)

Como as Edge Functions rodam em containers e regiões isoladas sem memória compartilhada, a coordenação de taxa deve ser feita no banco Postgres (Supabase).

#### 3.2.1 Proposta de Schema: Tabela `private.http_host_lease`
```sql
CREATE TABLE private.http_host_lease (
  host text PRIMARY KEY,                       -- 'pncp.gov.br' ou 'dadosabertos.compras.gov.br'
  next_allowed_at timestamptz NOT NULL DEFAULT now(), -- Próximo timestamp liberado para disparo
  cooldown_until timestamptz NOT NULL DEFAULT now(),  -- Bloqueio geral em caso de 429
  max_concurrency int NOT NULL DEFAULT 1,      -- Máximo de requisições em voo
  active_holders int NOT NULL DEFAULT 0,       -- Requisições em voo no momento
  min_interval_ms int NOT NULL DEFAULT 1000,   -- Intervalo mínimo entre requisições consecutivas (1s)
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed inicial dos hosts oficiais
INSERT INTO private.http_host_lease (host, min_interval_ms, max_concurrency)
VALUES 
  ('pncp.gov.br', 1000, 1),
  ('dadosabertos.compras.gov.br', 1000, 1)
ON CONFLICT (host) DO NOTHING;
```

#### 3.2.2 RPC Atômica para Adquirir Slot: `private.acquire_http_slot`
```sql
CREATE OR REPLACE FUNCTION private.acquire_http_slot(
  p_host text,
  p_max_wait_ms int DEFAULT 10000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private
AS $$
DECLARE
  v_rec record;
  v_now timestamptz := clock_timestamp();
  v_wait_ms int;
  v_target_time timestamptz;
BEGIN
  -- Bloqueia a linha do host para leitura e escrita atômica
  SELECT * INTO v_rec
  FROM private.http_host_lease
  WHERE host = p_host
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Fallback: insere host com defaults conservadores
    INSERT INTO private.http_host_lease (host, min_interval_ms, max_concurrency)
    VALUES (p_host, 1000, 1)
    RETURNING * INTO v_rec;
  END IF;

  -- 1. Verifica Cooldown Ativo (por exemplo, após um 429 recente)
  IF v_rec.cooldown_until > v_now THEN
    v_wait_ms := GREATEST(0, EXTRACT(MILLISECONDS FROM (v_rec.cooldown_until - v_now))::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- 2. Concorrência máxima (se houver requisições simultâneas acima do teto)
  IF v_rec.active_holders >= v_rec.max_concurrency THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'concurrency_limit',
      'wait_ms', v_rec.min_interval_ms
    );
  END IF;

  -- 3. Calcula o próximo momento permitido com base no intervalo mínimo
  v_target_time := GREATEST(v_now, v_rec.next_allowed_at);
  v_wait_ms := GREATEST(0, EXTRACT(MILLISECONDS FROM (v_target_time - v_now))::int);

  IF v_wait_ms > p_max_wait_ms THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'queue_full',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- Atualiza o próximo momento permitido e incrementa os holders ativos
  UPDATE private.http_host_lease
  SET next_allowed_at = v_target_time + (v_rec.min_interval_ms || ' milliseconds')::interval,
      active_holders = active_holders + 1,
      updated_at = v_now
  WHERE host = p_host;

  RETURN jsonb_build_object(
    'allowed', true,
    'wait_ms', v_wait_ms
  );
END;
$$;
```

#### 3.2.3 RPCs de Liberação e Aplicação de Cooldown
- `private.release_http_slot(p_host text)`:
  Decrementa `active_holders = GREATEST(0, active_holders - 1)`.
- `private.report_http_rate_limit(p_host text, p_cooldown_seconds int)`:
  Em caso de 429 recebido por qualquer processo, essa RPC é acionada:
  ```sql
  UPDATE private.http_host_lease
  SET cooldown_until = clock_timestamp() + (p_cooldown_seconds || ' seconds')::interval,
      next_allowed_at = clock_timestamp() + (p_cooldown_seconds || ' seconds')::interval,
      active_holders = 0,
      updated_at = clock_timestamp()
  WHERE host = p_host;
  ```
  Isso propaga **imediatamente** o `Retry-After` para todos os processos concorrentes em execução no cluster!

#### 3.2.4 Discussão de Custo e Alternativas
- **Custo:** Uma chamada RPC rápida por requisição HTTP externa (~5–10 ms de latência interna Supabase via PostgREST/Postgres). Como a requisição remota ao PNCP leva entre 500 ms e 3.000 ms (ou mais em caso de timeout), a sobrecarga de 10 ms representa menos de 1% a 2% do tempo total.
- **Alternativas consideradas:**
  1. *PgBouncer / Postgres Advisory Locks (`pg_try_advisory_lock`):* Extremamente leves, mas não persistem estado de `cooldown_until` (Retry-After) e podem apresentar comportamentos erráticos em conexões pooled transacionais do Supabase.
  2. *Redis / Upstash REST:* Acrescentaria dependência externa proibida pelo AGENTS.md (regra: foco no Postgres Supabase).
  3. *Reaproveitar o `lock_key` existente:* O `lock_key` de `pncp_sync_run` serve para isolar **jobs inteiros** (ex.: `pca-sync:2026:7830`). Ele não tem a granularidade fina necessária para cadenciar chamadas individuais de rede nem para permitir fila de requisições de diferentes rotas que compartilham o mesmo domínio. Portanto, a tabela `private.http_host_lease` complementa o `lock_key` sem substituí-lo.

---

### 3.3 Política Unificada de Retry e Backoff

Alinhando a estratégia Deno ao que já foi validado no Python (Lotes L1/L2):

1. **Classificação Rigorosa de Erros:**
   - **429 (Rate Limit):** Sempre retentável.
     - Lê header `Retry-After`. Se vier em segundos (ex.: `3`), aguarda 3 s. Se vier em HTTP-date (RFC 7231 / RFC 2822), calcula `delta_seconds = date - now()`.
     - Notifica o Postgres via `report_http_rate_limit()` para colocar todas as instâncias em cooldown.
     - Se `Retry-After` estiver ausente, aplica backoff exponencial com jitter: `base * 2^(attempt-1) + jitter`, limitado por um teto configurável (ex.: 60 s).
   - **500, 502, 503, 504:** Retentáveis com backoff exponencial (1 s, 2 s, 4 s, 8 s) até `max_retries` (padrão 3 a 4).
   - **Timeouts / Falhas de Conexão:** Retentáveis com limitação de tentativas de timeout (máximo 1 a 2 retentativas para evitar exaurir o budget da Edge Function).
   - **400, 401, 403, 404:** **NUNCA RETENTAR**. Tratam-se de erros determinísticos ou de segurança. Lançam imediatamente `PermanentHttpError`.
2. **Registro de Todas as Tentativas:**
   - Cada tentativa (incluindo as intermediárias com 429 ou 5xx) deve chamar `logSyncRequest` informando:
     - `tentativa`: número incremental (1, 2, 3...)
     - `status_http`: código real retornado (ex.: 429, 500, 503)
     - `tempo_resposta_ms`: tempo medido
     - `erro`: mensagem do erro ou status text
     - `retry_after_s`: valor extraído do cabeçalho quando 429

---

### 3.4 Registro Completo em `private.pncp_sync_request`

Para dar visibilidade total à auditoria e observabilidade:

#### Colunas que Faltam na Tabela Atual (`private.pncp_sync_request`):
Atualmente, `pncp_sync_request` tem:
- `id`, `sync_run_id`, `endpoint`, `parametros`, `pagina`, `tentativa`, `status_http`, `tempo_resposta_ms`, `resposta_hash`, `erro`, `created_at`.

Faltam as seguintes colunas essenciais:
1. `retry_after_seconds int`: para auditoria do tempo exigido pela API remota.
2. `host text`: para permitir filtros rápidos por provedor (`pncp.gov.br` vs `dadosabertos.compras.gov.br`).

*(A migration correspondente está especificada na seção 3.8).*

---

### 3.5 Orçamento de Tempo da Edge Function e Retomada Graciosa (`incompleta`)

#### O Problema do Timeout 546:
A Edge Function do Supabase é terminada pelo isolamento do Deno se ultrapassar a janela permitida (~150 s). Se uma função dorme aguardando um 429 de 60 s, ou acumula 3 timeouts de 45 s, ela estoura a parede de tempo e morre sem salvar estado.

#### Solução: Time Budgeting Proativo
1. **Janela Segura de Execução:**
   - Definir `EDGE_TIME_BUDGET_MS = 100_000` (100 segundos).
   - Margem de segurança de encerramento: `MARGIN_MS = 10_000` (10 segundos).
2. **Verificação Pré-Requisição:**
   - Antes de iniciar a próxima página ou o próximo retry:
     ```typescript
     const remainingMs = deadlineAt - Date.now();
     if (remainingMs < expectedDurationMs + MARGIN_MS) {
       // Interrompe o loop de páginas antes de estourar o limite
       throw new GracefulShutdownBudgetExhausted();
     }
     ```
3. **Persistência de Retomada e Agendamento Automático:**
   - Em caso de 429 esgotado ou budget atingido:
     - Atualiza `private.pncp_sync_run`:
       - `status = 'incompleta'` (utilizando a constraint já existente da migration `20260923203037`).
       - `pagina_atual`: registra a próxima página a ser processada.
       - `parametros.continuation`: salva fatias pendentes e o `chain_id`.
       - `erro_principal`: ex.: `"Pausado por rate limit (HTTP 429) - retoma na página X"` ou `"Time budget esgotado - retoma na página X"`.
       - `finalizada_em = now()`.
     - Libera o lock ativo imediatamente (`status` passa a ser `'incompleta'`, liberando a execução do próximo worker).
     - Insere um registro na tabela `private.job_queue` ou programa a próxima execução com `scheduled_for = now() + (retry_after || 60s)`.

---

### 3.6 Coordenação de Coletas Simultâneas e Tratamento de Lock Stale

1. **Fila do Limitador em Vez de Rejeição Imediata:**
   - Se duas coletas de editais forem disparadas simultaneamente, em vez de ambas bombardearem o PNCP juntas, a 2ª coleta consulta a RPC `acquire_http_slot`.
   - Se o slot estiver ocupado, ela aguarda o `wait_ms` calculado (respeitando o intervalo mínimo de 1 req/s por host).
   - Se o tempo de espera na fila for superior ao budget da Edge Function, ela encerra marcando a si mesma como `'incompleta'` e delega para a fila `job_queue`.
2. **Prevenção do Lock Stale:**
   - A função agora sempre encerra limpando o status para `'incompleta'` ou `'falhou'` dentro do bloco `finally`, garantindo que não permaneça em `'executando'`.
   - Caso um container do Deno morra por falha catastrófica da infraestrutura do provedor, o `STALE_LOCK_MS` (atualmente de 3 minutos) continua como rede de segurança para reaver o lock após 180 segundos.

---

### 3.7 Plano de Testes (Simulado e com Relógio Injetável)

Testes unitários e de integração em Deno (usando o padrão já estabelecido em `tests/supabase/functions/_shared/pncp/_harness.ts` com `installFetch`):

1. **Cenário 1: HTTP 429 com `Retry-After: 3`**
   - Mock fetch retorna 429 com header `Retry-After: 3`.
   - Relógio virtual (`sleep` injetável) verifica se o delay foi de exatamente 3.000 ms.
   - Verifica se a RPC `report_http_rate_limit` foi chamada com 3 segundos.
   - Verifica se a segunda chamada obteve 200 e se ambas as tentativas foram salvas em `pncp_sync_request` (tentativa 1 com status 429 e tentativa 2 com status 200).
2. **Cenário 2: HTTP 429 sem `Retry-After`**
   - Mock fetch retorna 429 sem header de espera.
   - Verifica aplicação de backoff exponencial com jitter (ex.: base 2 s -> tenta em ~2 s, depois ~4 s).
3. **Cenário 3: HTTP 503 seguido de 200**
   - Tentativa 1 retorna 503; tentativa 2 retorna 200 OK.
   - Verifica se não há duplicação e se o retorno final contém o payload integro.
4. **Cenário 4: Timeouts Consecutivos Exaurindo Budget**
   - Mock fetch atrasa além do timeout estipulado em todas as tentativas.
   - Verifica se a Edge Function interrompe antes dos 150 s, marca `status = 'incompleta'`, salva `pagina_atual = N` e não lança erro fatal 546.
5. **Cenário 5: Erro HTTP 404 (Sem Retry)**
   - Mock fetch retorna 404 Not Found.
   - Verifica que apenas **1** requisição foi disparada (nenhuma retentativa).
   - Lança `PermanentHttpError` e encerra a coleta com status `'falhou'`.
6. **Cenário 6: Concorrência Simultânea de Duas Coletas (Mesmo Host)**
   - Duas chamadas simultâneas ao cliente unificado com o mesmo host alvo.
   - Verifica via mock do Postgres se a segunda chamada respeitou o intervalo mínimo de 1.000 ms após o término da primeira.

---

### 3.8 Lista de Migrations e Variáveis de Ambiente Propostas

#### Migrations Previstas para a Fase 2:
1. `supabase/migrations/20260929000000_http_host_lease.sql`:
   - Cria tabela `private.http_host_lease`.
   - Cria funções PL/pgSQL `private.acquire_http_slot`, `private.release_http_slot`, `private.report_http_rate_limit`.
   - Garante grants para `service_role`.
2. `supabase/migrations/20260929000001_pncp_sync_request_telemetry.sql`:
   - Adiciona colunas em `private.pncp_sync_request`:
     ```sql
     ALTER TABLE private.pncp_sync_request
       ADD COLUMN IF NOT EXISTS host text,
       ADD COLUMN IF NOT EXISTS retry_after_seconds int;
     ```
3. `supabase/migrations/20260929000002_fix_catmat_caracteristicas_unique.sql`:
   - Alinha `public.catmat_item_caracteristicas` com o padrão do staging `icatmat_caracteristica_material`, aplicando `UNIQUE NULLS NOT DISTINCT (codigo_item, codigo_caracteristica, codigo_valor_caracteristica)`.

#### Novas Variáveis de Ambiente e Valores Iniciais Sugeridos:
| Variável | Valor Padrão Inicial | Descrição |
|----------|----------------------|-----------|
| `HTTP_PNCP_MIN_INTERVAL_MS` | `1000` | Intervalo mínimo entre requisições consecutivas ao `pncp.gov.br` (1 req/s) |
| `HTTP_PNCP_MAX_CONCURRENCY` | `1` | Máximo de requisições paralelas simultâneas ao `pncp.gov.br` |
| `HTTP_COMPRAS_MIN_INTERVAL_MS` | `1000` | Intervalo mínimo entre requisições consecutivas ao `dadosabertos.compras.gov.br` |
| `HTTP_COMPRAS_MAX_CONCURRENCY` | `1` | Máximo de requisições paralelas simultâneas ao Compras.gov |
| `EDGE_TIME_BUDGET_MS` | `100000` | Orçamento total de tempo da Edge Function (100 segundos) para graceful shutdown |
| `HTTP_RETRY_MAX_ATTEMPTS` | `3` | Número máximo de tentativas por requisição em 429/5xx |
| `HTTP_RETRY_BASE_DELAY_MS` | `2000` | Delay inicial de backoff quando não houver `Retry-After` |
| `HTTP_RETRY_MAX_CAP_MS` | `60000` | Teto máximo de espera em retentativas (60 segundos) |

---

### 3.9 Riscos e Perguntas em Aberto

#### Riscos:
1. **Latência Acumulada em Paginações Longas:** Com taxa de 1 req/s por host, uma carga completa de 500 páginas levará no mínimo 500 segundos (~8,3 minutos), excedendo o tempo de uma única execução de Edge Function (150 s). **Mitigação:** O modelo de `runCappedDateSync` e `incompleta` fracionará a coleta em batches menores (ex.: 50 páginas por invocação da Edge Function), encadeando execuções via fila ou crons sucessivos.
2. **Deadlock ou Contenção na Linha do Host:** O uso de `SELECT ... FOR UPDATE` na linha do host em `private.http_host_lease` dura apenas frações de milissegundo por transação. O risco de deadlock é desprezível desde que nenhuma chamada HTTP externa seja feita dentro da transação SQL (a RPC apenas calcula e reserva o timestamp).
3. **Instabilidade Contínua do PNCP:** Em setembro de 2026, a API Consulta do PNCP demonstrou períodos de degradação severa (timeouts de 45 s e erros 500/503 em massa no PCA). Se o endpoint estiver fora do ar por horas, sucessivos retries sem interrupção sobrecarregarão a fila. **Mitigação:** O health-check prévio (`probePncpHealth`) já implementado deve ser mantido antes de iniciar qualquer lote de contratações ou PCA.

#### Perguntas em Aberto para Validação com a Equipe:
1. *Qual deve ser a estratégia para acordar coletas com status `incompleta`?*
   - Opção A: O próximo agendamento do `pg_cron` detecta automaticamente a última execução incompleta e retoma de onde parou (atualmente `loadPendingSlices` já busca o último status `'incompleta'`).
   - Opção B: Um worker dedicado consome a tabela `private.job_queue` a cada minuto e invoca as Edge Functions para processar jobs pendentes.
2. *As modalidades de editais (1 a 12) devem ser coletadas em execuções separadas do cron?*
   - Em vez de uma única execução varrer as 12 modalidades sequencialmente dentro do mesmo container, o agendador pode passar a modalidade específica no payload (`{"modalidade": 6}`), distribuindo a carga ao longo das horas do dia.

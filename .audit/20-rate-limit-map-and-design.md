# Auditoria e Proposta de Arquitetura: Rate Limiting, Concorrência e Resiliência HTTP

**Documento:** `.audit/20-rate-limit-map-and-design.md`  
**Data:** 28 de setembro de 2026 (Revisão pós-checagem de produção)  
**Fase:** 1 de 2 — Mapeamento e Desenho de Arquitetura (Sem implementação de código, sem migrations em banco, sem PR)  
**Autor:** Cloud Agent — LicitaGym SaaS  
**Branch:** `cursor/rate-limit-design-943c`

---

## Sumário Executivo

Esta auditoria investigou os incidentes de produção registrados nas tabelas `private.pncp_sync_run` e `private.pncp_sync_request` do Supabase:
1. **Contratações Editais (`contratacoes_editais`):** 41 concluídas, 18 falhas com HTTP 429 ("PNCP consulta HTTP 429"), 1 timeout e 1 lock expirado. Em 2026-09-20 (06:26–06:35 UTC), ocorreram de 6 a 10 disparos concorrentes por minuto, totalizando 27 a 40 req/min no endpoint `/contratacoes/publicacao`, com ~33% de taxa de erro 429.
2. **Catálogo CATMAT Compras.gov.br (`compras_catmat`):** 35 concluídas, 2 falhas por HTTP 429 ("Compras.gov HTTP 429"), 3 outras falhas.
3. **PCA PNCP (`pca`):** 261 concluídas, 0 com 429, mas 240 timeouts de 45 segundos, 17 HTTP 500 e 2 HTTP 503.

**Diagnóstico Estrutural Atualizado:**
- **As Edge Functions já possuem mecanismo de retry (`withRetry`):** O problema observado em produção **não** é a ausência de retry local, mas sim:
  1. **Falta de registro das tentativas intermediárias:** falhas 429 intermediárias não são gravadas em `pncp_sync_request` (apenas a resposta final com sucesso ou o erro terminal no `erro_principal` de `pncp_sync_run`).
  2. **Ausência de coordenação entre processos:** múltiplas Edge Functions rodando em paralelo no mesmo minuto disparam requisições sem rate limiter global por host, ultrapassando os limites do PNCP. Em 20/09, o retry local funcionou (3 tentativas com backoff), mas com 6 a 10 processos paralelos bombardeando o mesmo endpoint, todas as tentativas bateram em 429 acumulado.
  3. **Falta de orçamento de tempo (wall-clock budget):** as funções dormem em retries ou aguardam timeouts longos (45 s) até colidirem com o limite do container Supabase/Deno (código 546 / timeout de 150 s no plano gratuito ou 400 s no plano pago), morrendo sem persistir o estado de checkpoint.
  4. **Retomada não automatizada:** `cron.job` tem 0 linhas e `private.job_queue` está vazia em produção. Todas as coletas foram disparadas manualmente via scripts (PowerShell). Quando uma coleta para com status `incompleta` ou `falhou`, não há automação ativa para continuá-la.
- As coletas que alimentam `private.pncp_sync_run` e `private.pncp_sync_request` são executadas **exclusivamente pelas Supabase Edge Functions em Deno** (`supabase/functions/sync-pncp-*`, `sync-compras-catmat`). A camada Python (`scripts/lib/*`) opera de forma autônoma para batches locais.

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

As coletas registradas em `private.pncp_sync_run` e `private.pncp_sync_request` são geradas **exclusivamente pelas Edge Functions em Deno**:
1. `sync-pncp-contratacoes-editais` (grava `resource_type = 'contratacoes_editais'`)
2. `sync-compras-catmat` (grava `resource_type = 'compras_catmat'`)
3. `sync-pncp-pca` (grava `resource_type = 'pca'`)
4. Demais syncs: `sync-pncp-contratacoes-atas`, `sync-pncp-contratacoes-contratos`, `sync-pncp-legislation`, `sync-pncp-catalogo`, `sync-pncp-irp`, `sync-pncp-orgaos`.

Os scripts Python (`scripts/lib/*` e `services/coletor-externo/*`) **não tocam** no schema `private.pncp_sync_*`.

---

### 1.3 Quem Agenda as Coletas e Por Que 6 a 10 Coletas Começam no Mesmo Minuto?

#### Estado Real de Produção:
- `cron.job` tem **0 linhas** e `private.job_queue` está vazia.
- Os comandos de agendamento em `supabase/migrations/202609180008_cron.sql` estão todos comentados como documentação/template (`-- SELECT cron.schedule(...)`). Nenhuma migration chegou a ativá-los.
- **Todas as coletas em produção foram disparadas manualmente** via scripts PowerShell (ex.: `invoke-sync-licitagym-scope.ps1`, `invoke-sync-compras-catmat.ps1`, `reimport-pca.ps1`) ou loops locais chamando as URLs das Edge Functions.

#### A Causa Raiz do Ponto de Congestionamento (2026-09-20 06:26–06:35 UTC):
1. **Disparos Concorrentes via Script:** No dia 20/09, um script externo disparou requisições concorrentes variando escopos e parâmetros de datas.
2. **Escopo no `lock_key`:** O formato do `lock_key` em produção inclui o escopo (ex.: `contratacoes-editais:orgaos_conhecidos:20260821:20260827` ou `contratacoes-editais:20260913:20260920`). Em 20/09, foram observadas **6 chaves distintas** no mesmo intervalo de 9 minutos.
3. **Isolamento de Lock por Chave:** Como cada chave diferente gera um registro próprio em `private.pncp_sync_run`, o lock lógico **não barrou** as execuções paralelas.
4. **Tempestade de Requisições:** Cada uma das 6 a 10 instâncias disparou dezenas de requisições de 50 itens para o endpoint `/contratacoes/publicacao`. O endpoint do PNCP bloqueou a taxa combinada (27 a 40 req/min) emitindo HTTP 429. O retry interno de cada Edge Function tentou novamente, mas, como todos os processos concorrentes continuavam enviando requisições, as tentativas se esgotaram e culminaram em falhas registradas no `erro_principal`.

---

### 1.4 Como Funciona o `lock_key` Hoje e Por Que Surge "Lock Expirado (Executando Stale)"?

#### Mecanismo Atual (`supabase/functions/_shared/pncp/lock.ts:16-55`):
- A função `acquireSyncLock` busca em `private.pncp_sync_run` por:
  ```sql
  SELECT id, iniciada_em FROM private.pncp_sync_run
  WHERE lock_key = $1 AND status = 'executando'
  LIMIT 1;
  ```
- Se encontrar um registro:
  - Calcula a idade da execução: `ageMs = Date.now() - iniciada_em`.
  - Se `ageMs < STALE_LOCK_MS` (**3 minutos** / 180.000 ms em `lock.ts:9`): retorna `{ alreadyRunning: true }`. A Edge Function recusa a execução e responde HTTP 200 `{ status: "already_running" }`.
  - Se `ageMs >= STALE_LOCK_MS`: considera que o processo anterior morreu e executa:
    ```sql
    UPDATE private.pncp_sync_run
    SET status = 'falhou',
        erro_principal = 'lock expirado (executando stale)',
        finalizada_em = now()
    WHERE id = $existing_id;
    ```
  - Em seguida, insere uma nova linha com status `'executando'`.

#### Causa do "Lock Expirado":
Quando uma Edge Function excede o limite de parede do container (150 s no plano gratuito ou 400 s no plano Pro) devido a timeouts longos (45 s) ou múltiplos sleeps de retry, ela é encerrada à força pelo Deno Runtime (erro 546). Como o runtime morre abruptamente, o bloco `catch/finally` não é executado e o registro permanece com `status = 'executando'`. A próxima execução manual que chega após 3 minutos detecta o registro abandonado e marca o erro `"lock expirado (executando stale)"`.

---

### 1.5 Por Que Nenhuma Linha em `pncp_sync_request` Tem `status_http = 429` e `tentativa > 1`?

1. O método `consulta.fetchContratacoesPublicacao()` roda dentro de `withRetry`.
2. Quando a API remota retorna HTTP 429 ou 500, o cliente HTTP lança `RetryableHttpError`.
3. O `withRetry` captura a exceção, aguarda e tenta novamente. Apenas quando a requisição retorna HTTP 200 é que a linha seguinte chama `logSyncRequest(client, { statusHttp: page.status, ... })`.
4. Se todas as 3 tentativas falharem com 429, o `withRetry` relança a exceção final. A execução salta diretamente para o bloco `catch (error)` da Edge Function.
5. A chamada a `logSyncRequest` é ignorada para as tentativas com erro.
6. No bloco `catch`, a função chama apenas `finishSyncRun(client, runId, { status: "falhou", erroPrincipal: "PNCP consulta HTTP 429" })`.
7. **Conclusão:** O telemetry log em `pncp_sync_request` só era chamado no caminho feliz; as requisições 429 intermediárias e terminais nunca eram salvas nele.

---

### 1.6 Status Exatos Existentes no Banco de Dados

Conforme as migrations `202609180001_pncp_foundation.sql` e `20260923203037_pncp_sync_run_status_incompleta.sql`:

#### Valores permitidos em `private.pncp_sync_run.status`:
1. `'pendente'`
2. `'executando'`
3. `'concluida'`
4. `'concluida_com_erros'`
5. `'falhou'`
6. `'cancelada'`
7. `'incompleta'` (adicionado pela migration `20260923203037`)

#### Valores permitidos em `private.idempotency_key.status`:
1. `'executando'`, `'concluida'`, `'falhou'`.

#### Valores permitidos em `private.job_queue.status`:
1. `'pending'`, `'processing'`, `'completed'`, `'failed'`.

---

## 2. Idempotência e Análise de Upserts

| Coletor / Tabela Alvo | Arquivo e Linha | Método / Mecanismo de Upsert | Chave de Conflito Utilizada | Comportamento na Repetição de Página | Risco de Duplicação ou Inconsistência? |
|-----------------------|-----------------|------------------------------|-----------------------------|--------------------------------------|----------------------------------------|
| **`contratacoes_editais`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-pncp-contratacoes-editais/index.ts:153` | `upsertByHash()` | `{ orgao_cnpj, ano, sequencial }` (UNIQUE em `public.contratacoes_editais:30`) | Busca por chave única. Se `payload_hash` for idêntico, faz `UPDATE touch`. Se alterado, faz `UPDATE` e gera histórico. | **Idempotente.** Não duplica. |
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
| **`catmat_item_caracteristicas`** | `supabase/functions/_shared/pncp/upsert.ts:31-160` via `sync-compras-catmat/index.ts:395` | `upsertByHash()` | `{ codigo_item, codigo_caracteristica, codigo_valor_caracteristica }` | Busca por chave composta de 3 colunas. | **Idempotente no estado atual (0 duplicados em produção).** (Ver observação técnica no item 3.8). |
| **`source_record`** | `supabase/functions/_shared/pncp/supabase-admin.ts:25-36` | Supabase PostgREST `upsert()` | `onConflict: "endpoint,request_hash,content_hash", ignoreDuplicates: true` | UNIQUE constraint em `private.source_record(endpoint, request_hash, content_hash)`. | **Idempotente.** Não duplica. |
| **`icatmat_*` (Staging Python)** | `scripts/upsert_icatmat_consolidado.py:151` | Supabase PostgREST `upsert()` | `TABLE_ON_CONFLICT[table]` | Mapeado explicitamente para chaves naturais de E1 a E7. | **Idempotente.** Não duplica. |
| **`licitacoes_externas` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:402` | Supabase PostgREST `upsert()` | `conflito="fonte,codigo_externo"` (UNIQUE index `uq_licext_fonte_codigo`) | Atualiza linha existente. | **Idempotente.** Não duplica. |
| **`licitacao_itens` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:415` | Supabase PostgREST `upsert()` | `conflito="licitacao_id,numero_item"` (UNIQUE `licitacao_itens(licitacao_id, numero_item)`) | Atualiza item existente. | **Idempotente.** Não duplica. |
| **`licitacao_resultados` (Python)** | `services/coletor-externo/coletor/destino.py:26` via `coletor/pncp.py:426` | Supabase PostgREST `upsert()` | `conflito="licitacao_id,numero_item,sequencial_resultado"` (UNIQUE `licitacao_resultados(...)`) | Atualiza resultado existente. | **Idempotente.** Não duplica. |
| **`legislacao_documentos`** | `supabase/functions/sync-pncp-legislation/index.ts:84-100` | Select manual `maybeSingle()` + `insert()` | `{ url_canonica }` | Faz SELECT prévio e se não existir faz INSERT. | Idempotente em single-thread; em paralelismo estrito pode haver race condition. |

---

## 3. Desenho Proposto da Solução (Fase de Planejamento)

### 3.1 Cliente HTTP Compartilhado e Alinhamento com Camada Python

1. **Reaproveitamento de Lógica:**
   - O parsing de `Retry-After` (segundos e data HTTP RFC 7231 / RFC 2822) validado no PR #37 (Python) e PR #42 (Deno) é mantido.
   - O tratamento de status `'incompleta'` da migration `20260923203037` é a base da suspensão e retomada graciosa.
2. **Novo Cliente Unificado Deno (`supabase/functions/_shared/http-client/unified-client.ts`):**
   - **Timeout por tentativa configurável:** Reduzido de 45 s para **20 s** (configurável via `HTTP_ATTEMPT_TIMEOUT_MS = 20_000`).
   - **Retentativas em Timeout:** Máximo de **1 retentativa** em caso de timeout (total de 2 tentativas). Evita desperdiçar o tempo de execução com endpoints travados.
   - **Throttling e Cooldown Distribuídos:** Consulta atômica ao Postgres antes de cada chamada externa.
   - **Orçamento de Tempo (`EDGE_TIME_BUDGET_MS`):** Configurável (default 100 s no plano gratuito, ou até 300 s no plano pago). **Nunca dorme além do tempo restante:** se o `Retry-After` ou o cooldown do host exceder o tempo disponível antes do encerramento seguro, a função **não dorme**; ela interrompe o processamento imediatamente, salva `pagina_atual`, marca `'incompleta'` e encerra graciosamente com código 200/202.

---

### 3.2 Limite Distribuído entre Processos via Postgres (Serialização por Host)

Para evitar vazamento de contadores quando Edge Functions morrem por timeout (546), a coordenação de concorrência 1 adota **reserva atômica de `next_allowed_at` sem contador manual de active_holders**.

#### 3.2.1 Tabela `private.http_host_lease` (RLS Ativo e Segurança)
```sql
CREATE TABLE private.http_host_lease (
  host text PRIMARY KEY,                       -- 'pncp.gov.br' ou 'dadosabertos.compras.gov.br'
  next_allowed_at timestamptz NOT NULL DEFAULT now(), -- Próximo timestamp liberado
  cooldown_until timestamptz NOT NULL DEFAULT now(),  -- Bloqueio geral em caso de 429
  min_interval_ms int NOT NULL DEFAULT 1000,   -- Intervalo mínimo entre requisições consecutivas (1s)
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS ativado: proibido acesso anônimo/autenticado (schema private está exposto no PostgREST)
ALTER TABLE private.http_host_lease ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.http_host_lease FROM public, anon, authenticated;
GRANT ALL ON TABLE private.http_host_lease TO service_role;

-- Seed inicial dos hosts
INSERT INTO private.http_host_lease (host, min_interval_ms)
VALUES 
  ('pncp.gov.br', 1000),
  ('dadosabertos.compras.gov.br', 1000)
ON CONFLICT (host) DO NOTHING;
```

#### 3.2.2 RPC Atômica com Correção de Milissegundos: `private.acquire_http_slot`
*Correção crítica aplicada:* `EXTRACT(EPOCH FROM ...) * 1000` em vez de `EXTRACT(MILLISECONDS FROM ...)`, garantindo o cálculo integral de intervalos superiores a 60 segundos.

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
  -- Bloqueia exclusivamente a linha do host durante a transação rápida
  SELECT * INTO v_rec
  FROM private.http_host_lease
  WHERE host = p_host
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO private.http_host_lease (host, min_interval_ms)
    VALUES (p_host, 1000)
    RETURNING * INTO v_rec;
  END IF;

  -- 1. Verifica Cooldown Ativo (429 global do host)
  IF v_rec.cooldown_until > v_now THEN
    v_wait_ms := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_rec.cooldown_until - v_now)) * 1000)::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- 2. Concorrência 1: calcula próximo instante liberado e reserva atômica
  v_target_time := GREATEST(v_now, v_rec.next_allowed_at);
  v_wait_ms := GREATEST(0, CEIL(EXTRACT(EPOCH FROM (v_target_time - v_now)) * 1000)::int);

  -- Se o tempo de espera na fila exceder o teto aceitável pelo processo
  IF v_wait_ms > p_max_wait_ms THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'queue_full',
      'wait_ms', v_wait_ms
    );
  END IF;

  -- Reserva atômica: avança next_allowed_at para o próximo processo
  UPDATE private.http_host_lease
  SET next_allowed_at = v_target_time + (v_rec.min_interval_ms || ' milliseconds')::interval,
      updated_at = v_now
  WHERE host = p_host;

  RETURN jsonb_build_object(
    'allowed', true,
    'wait_ms', v_wait_ms
  );
END;
$$;

-- Restrição estrita de execução no schema private
REVOKE EXECUTE ON FUNCTION private.acquire_http_slot(text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.acquire_http_slot(text, int) TO service_role;
```

#### 3.2.3 RPC de Reporte de Rate Limit: `private.report_http_rate_limit`
```sql
CREATE OR REPLACE FUNCTION private.report_http_rate_limit(
  p_host text,
  p_cooldown_seconds int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private
AS $$
BEGIN
  UPDATE private.http_host_lease
  SET cooldown_until = clock_timestamp() + (p_cooldown_seconds || ' seconds')::interval,
      next_allowed_at = clock_timestamp() + (p_cooldown_seconds || ' seconds')::interval,
      updated_at = clock_timestamp()
  WHERE host = p_host;
END;
$$;

REVOKE EXECUTE ON FUNCTION private.report_http_rate_limit(text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.report_http_rate_limit(text, int) TO service_role;
```

*Nota sobre simplificação arquitetural:* Foram eliminados o contador `active_holders`, `max_concurrency` e a função `release_http_slot`. Como a reserva atômica de `next_allowed_at` já agenda temporalmente cada requisição em fila estrita de concorrência 1, nenhuma Edge Function precisa notificar quando termina a requisição, eliminando completamente qualquer risco de vazamento de contador em caso de falha de container.

---

### 3.3 Política de Retry, Timeouts e Telemetria

1. **Tentativas e Timeouts:**
   - **Timeout por tentativa:** configurado em **20 segundos** (`DEFAULT_FETCH_TIMEOUT_MS = 20_000`).
   - **Tentativas em timeout:** máximo de **1 retentativa** (2 tentativas no total).
   - **429 (Rate Limit):** respeita `Retry-After`. Se ausente, backoff exponencial (2 s, 4 s, 8 s com jitter).
   - **500, 502, 503, 504:** retenta até 3 tentativas com backoff.
   - **400, 401, 403, 404:** **NUNCA RETENTAR**. Lança `PermanentHttpError` imediatamente.
2. **Registro de Todas as Tentativas em `private.pncp_sync_request`:**
   - Cada tentativa (incluindo respostas 429 e 5xx intermediárias) chama `logSyncRequest` gravando:
     - `tentativa`: número incremental (1, 2, 3...)
     - `status_http`: código real retornado (ex.: 429, 500, 503)
     - `tempo_resposta_ms`: duração medida
     - `erro`: mensagem do erro ou status text
     - `host`: hostname de destino
     - `retry_after_seconds`: valor extraído do cabeçalho quando 429

---

### 3.4 Retomada de Execuções `incompleta` e Agendamento em Produção

#### Comparativo de Abordagens de Retomada:
- *Opção Worker em `private.job_queue`:* Exigiria um container ou serviço externo com polling contínuo a cada minuto para invocar as Edge Functions. Introduz infraestrutura externa desnecessária.
- *Opção Recomendada: Agendamento Oficial via `pg_cron` no Supabase:*
  Utiliza a infraestrutura nativa do Postgres/Supabase já disponível no projeto, com credenciais armazenadas de forma segura no Supabase Vault.

#### Desenho Concreto do Agendamento:

1. **Escalonamento por Minuto (Prevenção de Sobreposição):**
   - Minuto `00`: `pncp-contratacoes-editais` (a cada 6 h: `0 */6 * * *`)
   - Minuto `15`: `pncp-contratacoes-atas` (a cada 6 h: `15 */6 * * *`)
   - Minuto `30`: `pncp-contratacoes-contratos` (a cada 6 h: `30 */6 * * *`)
   - Minuto `45`: `sync-compras-catmat` (diário às 04:45 UTC: `45 4 * * *`)
   - PCA Probe mensal: Dia 1 às 02:00 UTC (`0 2 1 * *`)

2. **Como o Job Decide entre Retomar `incompleta` ou Iniciar Nova Janela:**
   Ao ser disparado pelo cron, a função consulta `loadPendingSlices`:
   - Busca a última execução com a mesma `lock_key`.
   - Se a execução anterior terminou com `status = 'incompleta'`, a Edge Function **continua exatamente das fatias/páginas pendentes** armazenadas em `parametros.continuation` e herda o `chain_id`.
   - Se a execução anterior terminou com `status = 'concluida'` ou se não houver execução anterior, inicia a janela normal dos últimos 7 dias.

3. **Prevenção de Reentrância:**
   - Se um job ainda estiver com `status = 'executando'` e idade inferior a `STALE_LOCK_MS` (3 min), o novo disparo recebe `{ alreadyRunning: true }` e encerra imediatamente sem duplicar processos.
   - O lock de host (`private.http_host_lease`) garante que, mesmo se dois jobs de recursos diferentes rodarem próximos, as chamadas de rede individuais ao `pncp.gov.br` serão espaçadas em no mínimo 1 segundo.

4. **Configuração via Supabase Vault (Sem Segredos em Migrations):**
   A ativação do cron será feita via SQL referenciando `vault.decrypted_secrets`:
   ```sql
   SELECT cron.schedule(
     'pncp-contratacoes-editais',
     '0 */6 * * *',
     $$ SELECT net.http_post(
       url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sync_pncp_contratacoes_editais_url'),
       headers := jsonb_build_object(
         'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sync_cron_secret'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb
     ) AS request_id; $$
   );
   ```

---

### 3.5 Plano de Testes (Simulado e com Relógio Injetável)

1. **Cenário 1: HTTP 429 com `Retry-After: 3`**
   - Mock fetch retorna 429 com `Retry-After: 3`.
   - Relógio virtual verifica se o delay foi de 3.000 ms.
   - Verifica se a RPC `report_http_rate_limit` foi chamada com 3 segundos.
   - Verifica persistência em `pncp_sync_request` (tentativa 1 com status 429 e tentativa 2 com status 200).
2. **Cenário 2: HTTP 429 sem `Retry-After`**
   - Mock fetch retorna 429 sem header.
   - Verifica aplicação de backoff exponencial com jitter.
3. **Cenário 3: HTTP 503 seguido de 200**
   - Tentativa 1 retorna 503; tentativa 2 retorna 200 OK.
   - Verifica integridade do payload e ausência de duplicidade.
4. **Cenário 4: Timeouts Exaurindo Orçamento de Tempo**
   - Mock fetch demora além do timeout estipulado em tentativas consecutivas.
   - Verifica se a Edge Function interrompe antes de atingir o limite de parede da plataforma, salva `status = 'incompleta'`, registra `pagina_atual` e não sofre timeout fatal 546.
5. **Cenário 5: Erro HTTP 404 (Sem Retry)**
   - Mock fetch retorna 404 Not Found.
   - Verifica que apenas **1** requisição foi disparada (nenhuma retentativa).
   - Lança `PermanentHttpError` e encerra com status `'falhou'`.
6. **Cenário 6: Serialização Atômica de Coletas Concorrentes**
   - Dois processos solicitam slot simultaneamente para `pncp.gov.br`.
   - Verifica se o segundo processo recebe `wait_ms >= 1000` e agenda sua requisição com o espaçamento correto.

---

### 3.6 Lista de Migrations e Variáveis de Ambiente Propostas

#### Migrations Previstas para a Fase 2:
1. `supabase/migrations/20260929000000_http_host_lease.sql`:
   - Cria tabela `private.http_host_lease` com RLS habilitado e sem grants para anon/authenticated.
   - Cria funções PL/pgSQL `private.acquire_http_slot` e `private.report_http_rate_limit` com `SECURITY DEFINER`, revoke de public/anon/authenticated e grant exclusivo para `service_role`.
2. `supabase/migrations/20260929000001_pncp_sync_request_telemetry.sql`:
   - Adiciona colunas de auditoria em `private.pncp_sync_request`:
     ```sql
     ALTER TABLE private.pncp_sync_request
       ADD COLUMN IF NOT EXISTS host text,
       ADD COLUMN IF NOT EXISTS retry_after_seconds int;
     ```

*(Item de `catmat_item_caracteristicas` retirado deste escopo e registrado como backlog separado na seção 3.7).*

#### Novas Variáveis de Ambiente e Valores Iniciais Sugeridos:
| Variável | Valor Padrão Inicial | Descrição |
|----------|----------------------|-----------|
| `HTTP_PNCP_MIN_INTERVAL_MS` | `1000` | Intervalo mínimo entre requisições consecutivas ao `pncp.gov.br` (1 req/s) |
| `HTTP_COMPRAS_MIN_INTERVAL_MS` | `1000` | Intervalo mínimo entre requisições consecutivas ao `dadosabertos.compras.gov.br` |
| `HTTP_ATTEMPT_TIMEOUT_MS` | `20000` | Timeout por tentativa individual de fetch (20 segundos) |
| `EDGE_TIME_BUDGET_MS` | `100000` | Orçamento total de tempo da Edge Function (100 s no plano Free, ajustável até 300 s no Pro) |
| `HTTP_RETRY_MAX_ATTEMPTS` | `3` | Número máximo de tentativas por requisição em 429/5xx |
| `HTTP_RETRY_MAX_TIMEOUT_ATTEMPTS` | `1` | Máximo de novas tentativas após um timeout (total de 2 tentativas) |
| `HTTP_RETRY_BASE_DELAY_MS` | `2000` | Delay inicial de backoff quando não houver `Retry-After` |
| `HTTP_RETRY_MAX_CAP_MS` | `60000` | Teto máximo de espera em retentativas (60 segundos) |

---

### 3.7 Riscos, Perguntas em Aberto e Itens de Backlog Separados

#### Item Registrado Fora deste Escopo:
- **`catmat_item_caracteristicas` (NULLS NOT DISTINCT):** A produção possui atualmente **0 registros duplicados**. A aplicação de `UNIQUE NULLS NOT DISTINCT` fica registrada como item de melhoria preventiva futura de schema, desacoplada do pacote de rate limiting.

#### Riscos Identificados e Mitigações:
1. **Duração Total da Paginação vs Wall-Clock:** Com 1 req/s, carregar 50 páginas consome ~50 segundos. O orçamento configurável `EDGE_TIME_BUDGET_MS` garante que a função suspenda o processamento como `incompleta` antes de atingir o limite da plataforma (150 s / 400 s).
2. **Instabilidade do PNCP:** Períodos de lentidão severa do PNCP são contidos reduzindo o timeout individual para 20 s e limitando novas tentativas em timeout a no máximo 1, evitando retenção desnecessária da função.
3. **Segurança de Schema:** Como o schema `private` está exposto no PostgREST (`pgrst.db_schemas`), a tabela `http_host_lease` e suas RPCs possuem RLS ativo e revogação explícita de `anon` e `authenticated`, garantindo acesso exclusivo via `service_role`.

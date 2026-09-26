# Runbook P0 — reprojeção PCA (classificação + origem)

Data: 2026-09-26. Parent: `.audit/30-pncp-l6g-p0-pca-scope-resolvable.md` §1b + `.audit/34-pca-source-projection-reconciliation.md`.

Adendo pós dry-run: paginação PostgREST, legacy_v1/v2, UPDATE completo do mapper, snapshot JSON.

## Decisões (EXEC 02 + adendo 26/09)

- Sem UPDATE SQL derivado do dry-run (hash é TypeScript).
- Sem `upsertByHash` (evita `pca_alteracoes`).
- Snapshot obrigatório **em arquivo JSON** (`var/p0/`, fora do git) — **não** DDL/SQL Editor.
- Guarda de hash: bate se `payload_hash` = hash de **qualquer** mapper histórico (`legacy_v1` pré-15h 19/09 **ou** `legacy_v2` pós-origem sem classificação).
- UPDATE grava **todas** as colunas do `normalizePcaItem` atual + `payload_hash` novo.
- Stream B (98 `SOURCE_DISCOVERED_BUT_NOT_PERSISTED`) **fora** deste job — só contado como `fonte_sem_projecao`.
- `classificacao_catalogo_id` é **text**: gravar `'1'` / `'2'`.

## Snapshot: JSON em `var/p0/`

**Escolha:** `var/p0/pca_itens_snapshot_<ISO>.json` + `content_sha256` no arquivo/log.

**Por quê:** DDL de snapshot exigiria migration + PR antes de operar; regra do projeto proíbe DDL pelo SQL Editor. ~3331 linhas cabem em JSON local; rollback lê o arquivo.

## `updated_at`

Não há trigger que o job force. O UPDATE **não** envia `updated_at`.

## Lock

Mesmo padrão de `sync-pncp-pca`: `lock_key` default `pca-sync:2026:7830`. Se ocupado → erro explícito (exit 1), sem esperar.

## Sequência operacional

### 0. Snapshot

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  scripts/ops/reprojetar-pca-classificacao.ts --snapshot-only
# anotar snapshot_file + content_sha256 do JSON
```

### 1. Conferir workflows agendados

```bash
rg -n "sync-pncp-pca" .github/workflows
```

Deploy em push `main` **existe** (`.github/workflows/deploy-supabase-functions.yml`) — desejável para publicar o mapper. **Não** há cron GitHub para sync PCA. Confirmar `pg_cron`:

```sql
select jobid, schedule, command from cron.job where command ilike '%pca%';
```

Desativar se houver.

### 2. Merge

Merge do PR (job + testes) em `main`. Aguardar deploy Edge Functions.

### 3. Dry-run

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  scripts/ops/reprojetar-pca-classificacao.ts --dry-run
```

**Esperado (adendo):**

| campo | valor |
|---|---|
| `lidos_pca_itens` | 3331 |
| `match_v1 + match_v2` | ≈ 3331 |
| `STALE_SOURCE_MISMATCH` | ≈ 0 |
| `fonte_sem_projecao` | 98 |
| `diff_classificacao_catalogo_id` | 3331 |
| `diff_pdm_codigo_origem` / `diff_codigo_item_origem` | ≈ linhas v1 com PDM na fonte |
| `diff_outros` | **0** (se >0: **não** confirmar) |

### 4. Lote de teste

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  scripts/ops/reprojetar-pca-classificacao.ts --limite 50 --confirmar \
  --snapshot-file var/p0/<arquivo-do-passo-0>.json
```

### 5. Validação (leitura)

```sql
select count(*) filter (where classificacao_catalogo_id is null) as vazios,
       count(*) filter (where classificacao_catalogo_id = '1') as material,
       count(*) filter (where classificacao_catalogo_id = '2') as servico,
       (select count(*) from public.pca_alteracoes) as alteracoes
from public.pca_itens;
-- alteracoes deve permanecer 3948
```

### 6. Confirmar todos

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  scripts/ops/reprojetar-pca-classificacao.ts --confirmar \
  --snapshot-file var/p0/<arquivo-do-passo-0>.json
```

Se `diff_outros > 0`, o job **aborta sem gravar**.

### 7. Validação final

Mesmo SQL do passo 5. Esperado: vazios = 0 (ou = STALE), material ≈ 3330, serviço = 1, alteracoes = 3948.

### 8. Reativar sync

Reativar cron / jobs PCA pausados no passo 1.

## Rollback

```bash
deno run --allow-net --allow-env --allow-read --allow-write \
  scripts/ops/reprojetar-pca-classificacao.ts --rollback \
  --snapshot-file var/p0/<arquivo>.json
```

Restaura colunas do mapper + `payload_hash` a partir do JSON. Verifica SHA-256. **Não** grava `pca_alteracoes`.

## Relatório

JSON stdout: `alvo`, `lidos_pca_itens`, `lidos_source_record`, `atualizados`, `ja_atualizado`, `match_v1`, `match_v2`, `STALE_SOURCE_MISMATCH`, `sem_fonte`, `fonte_sem_projecao`, `valor_1`, `valor_2`, `outros`, `diff_*`, `erros`, `duracao_s`, `snapshot_path`, `snapshot_sha256`, `sync_run_id`.

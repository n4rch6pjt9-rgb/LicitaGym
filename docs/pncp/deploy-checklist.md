# Checklist — deploy remoto PNCP (Supabase)

Projeto de referência: `ifaiagegyicjzlpskafh` (ajuste se usar outro ref).

## Pré-requisitos

- [ ] Acesso de **Owner** ou **Admin** ao projeto Supabase (link + migrations + secrets)
- [ ] [Supabase CLI](https://supabase.com/docs/guides/cli) instalado e logado: `npx supabase login`
- [ ] Git na branch desejada com migrations `202609180001` … `202609180013` commitadas
- [ ] **Novo** `SYNC_CRON_SECRET` para produção (não reutilize `dev-local-sync-secret-change-me`)

## 1. Linkar o projeto

```powershell
cd C:\Users\marce\licitagym
npx supabase link --project-ref ifaiagegyicjzlpskafh
```

Se falhar por permissão: peça acesso no Dashboard ou use SQL Editor + deploy manual de functions.

## 2. Secrets das Edge Functions

Copie `supabase/.env.example` → `supabase/.env.local` (local only, nunca commitar) e preencha com chaves do Dashboard → Settings → API.

```powershell
# Gere segredo forte (exemplo)
# [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

npx supabase secrets set SYNC_CRON_SECRET="SEU_SEGREDO_PRODUCAO"
# Opcional — catálogo / IRP por órgão:
# npx supabase secrets set PNCP_INTEGRACAO_TOKEN="..."
```

Variáveis injetadas automaticamente pelo Supabase em runtime: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Migrations (schema + RLS + cron extensions)

```powershell
npx supabase db push
```

Conferir no SQL Editor:

```sql
SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;
-- Esperado: 202609180001 … 202609180013

SELECT extname FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');
```

Bucket `pncp-legislation` e tabelas `pca_*`, `private.pncp_period_anchor` devem existir após o push.

## 4. Deploy das Edge Functions

Sync jobs usam `Authorization: Bearer <SYNC_CRON_SECRET>` — deploy com JWT desligado:

```powershell
$fn = @(
  "sync-pncp-legislation",
  "sync-pncp-pca",
  "sync-pncp-contratacoes-editais",
  "sync-pncp-contratacoes-atas",
  "sync-pncp-contratacoes-contratos",
  "sync-pncp-catalogo",
  "sync-pncp-irp",
  "import-catmat-curadoria",
  "api-pncp-pca",
  "api-pncp-contratacoes",
  "api-pncp-legislacao",
  "api-pncp-irp",
  "calculate-distance-webrouter"
)
foreach ($f in $fn) {
  npx supabase functions deploy $f --no-verify-jwt
}
```

APIs de leitura (`api-pncp-*`) podem exigir JWT do app — se o front usar Supabase Auth, remova `--no-verify-jwt` só nessas após testar.

Script:

```powershell
.\scripts\deploy-functions.ps1 -UseApi -Debug
```

### 403 — `list functions` / `necessary privileges`

`db push` e `secrets set` podem funcionar enquanto **functions deploy** retorna 403. Isso é permissão na **Management API** (org/role), não erro nas migrations.

1. **Dashboard → Edge Functions** — a página abre? Se também der 403, o problema é role na org `xtqywunwrnembbtqnxtt`, não o CLI.
2. **Organization → Team** — sua conta precisa ser **Owner** ou **Admin** (Developer às vezes não inclui deploy de functions).
3. **Re-login explícito:**
   ```powershell
   npx supabase login --token sbp_...
   npx supabase functions deploy sync-pncp-pca --project-ref ifaiagegyicjzlpskafh --no-verify-jwt --use-api --debug
   ```
4. **CLI mais recente:** `npx supabase@latest functions deploy ...`
5. **Sem “Connect GitHub” no Dashboard** — use **GitHub Actions** no repo:
   - GitHub → repo `LicitaGym` → Settings → Secrets → `SUPABASE_ACCESS_TOKEN` = `sbp_...` (Owner)
   - Workflow: `.github/workflows/deploy-supabase-functions.yml`
   - Actions → **Deploy Supabase Edge Functions** → Run workflow
6. **MCP Supabase no Cursor** — Settings → MCP → supabase → Login → pedir ao agente deploy via MCP.
7. **Dashboard só tem Editor / CLI / AI** — Editor/AI serve para **1 function** de teste; PNCP usa `_shared/` → não escala. Prefira CLI corrigido ou Actions.
8. **CLI local — limpar token que sobrescreve o login:**
   ```powershell
   Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
   npx supabase logout
   npx supabase login
   npx supabase functions deploy sync-pncp-pca --project-ref ifaiagegyicjzlpskafh --no-verify-jwt --use-api
   ```
9. Persistindo → [Supabase Support](https://supabase.com/dashboard/support/new) (bug CLI #4802).

### 500 — probe / sync-pncp-pca

Resposta genérica `Internal Server Error` após auth OK (não é 401):

1. **Schema `private` no PostgREST** — Edge Functions usam `client.schema('private')`. No remoto, aplique:
   ```sql
   ALTER ROLE authenticator SET pgrst.db_schemas = 'public, storage, graphql_public, private';
   NOTIFY pgrst, 'reload config';
   ```
   Ou `npx supabase db push` (migration `202609180014_expose_private_schema.sql`).
2. Ou **Dashboard → Settings → API → Exposed schemas** → incluir `private`.
3. Re-deploy `sync-pncp-pca` após fix (versão nova devolve JSON com `detalhe`).

## 5. Smoke tests (remoto)

Substitua `<REF>` e `<SECRET>`:

```powershell
$base = "https://ifaiagegyicjzlpskafh.supabase.co"
$secret = "SEU_SEGREDO_PRODUCAO"

# Probe PCA (barato — Search API)
Invoke-RestMethod -Method POST `
  -Uri "$base/functions/v1/sync-pncp-pca" `
  -Headers @{ Authorization = "Bearer $secret"; "Content-Type" = "application/json" } `
  -Body '{"somente_verificacao":true,"ano":2026}'

# API leitura (JWT de usuário ou anon conforme RLS)
# GET $base/functions/v1/api-pncp-pca?ano=2026
```

| Teste | Esperado |
|-------|----------|
| POST sync-pncp-pca `somente_verificacao` | `status: verificacao`, `periodo.max_data_atualizacao` |
| POST import-catmat-curadoria | `inseridos` / `atualizados` |
| POST sync-pncp-pca `-Forcar` | Só quando PNCP Consulta estável (504 = externo) |
| GET api-pncp-legislacao | Lista ou `[]` |

Scripts locais (apontando remoto):

```powershell
.\scripts\probe-pca-periodo.ps1 -Ano 2026 -BaseUrl "https://ifaiagegyicjzlpskafh.supabase.co" -Secret $secret
```

## 6. Curadoria CATMAT

```powershell
.\scripts\import-catmat-curadoria.ps1 `
  -JsonPath "C:\caminho\export-catmat.json" `
  -BaseUrl "https://ifaiagegyicjzlpskafh.supabase.co" `
  -Secret $secret
```

## 7. Cron (pg_cron + Vault)

Os jobs são criados pela migration `20260930180000_cron_sync_jobs.sql`, aplicada no merge. Não precisa descomentar nada. Plano, horários e monitoramento estão em [cron-sync-jobs.md](./cron-sync-jobs.md).

1. Dashboard → Edge Functions → Secrets: `SYNC_CRON_SECRET` com um valor forte.
2. SQL Editor: gravar o **mesmo valor** no Vault com o nome `sync_cron_secret`:

```sql
select vault.create_secret('<valor>', 'sync_cron_secret', 'Bearer dos jobs pg_cron das Edge Functions sync-*');
```

Sem esse segredo, os jobs falham de forma visível em `cron.job_run_details` e não chamam nenhuma função.

3. Verificar:

```sql
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname LIKE 'licitagym-%';
```

## 8. Pós-deploy

- [ ] Rotacionar chaves se alguma vazou em chat/log
- [ ] Advisors: Dashboard → Database → Advisors (RLS, índices)
- [ ] Logs: Dashboard → Edge Functions → sync-pncp-pca
- [ ] Primeira carga PCA 7830 quando PNCP responder: body `{ "forcar": true, "ano": 2026, "codigos_classificacao": ["7830"], "max_paginas": 500 }`

## Rollback

- Migrations: restaurar backup / branch preview do Supabase
- Function: redeploy commit anterior `git checkout <sha> -- supabase/functions/...` + `functions deploy`
- Cron: `SELECT cron.unschedule('nome-do-job');`

## Referências

- [architecture.md](./architecture.md) — cron sugerido e fluxo PCA anual
- [contract-matrix.md](./contract-matrix.md) — endpoints PNCP
- [security-mvp.md](./security-mvp.md) — escopo auth MVP

# Arquitetura PNCP — licitagym

Monitor de licitações com banco canônico local (Postgres/Supabase) e sincronização periódica com o PNCP.

## Duas APIs PNCP

| Camada | Base URL | Uso |
|--------|----------|-----|
| **Consulta** | `https://pncp.gov.br/api/consulta/v1` | Listagens públicas: PCA, contratações, atas, contratos — DTOs em [`schemas-consultas-pncp.md`](./schemas-consultas-pncp.md) |
| **Integração** | `https://pncp.gov.br/api/pncp/v1` | CRUD por órgão, catálogo, detalhe IRP |

O app **nunca** chama o PNCP por request de usuário — apenas Edge Functions de sync.

## Camadas de dados

```
private.*     → source_record, pncp_sync_run, idempotency_key, job_queue
public.*      → domínios normalizados (pca, contratações, legislação, IRP, catálogo)
Storage       → pncp-legislation (PDFs imutáveis por versão)
```

## Sync unificado

- Um `pncp_sync_run` por execução (`resource_type` discrimina PCA, editais, etc.)
- Lock lógico via `lock_key`
- Payload bruto em `source_record` antes da normalização
- Upsert por `payload_hash`; inativação só em carga `modo=completo` via `last_seen_sync_id`

## Edge Functions

| Função | Cron sugerido | Fonte |
|--------|---------------|-------|
| `sync-pncp-pca` | **1×/ano** + verificação | Probe segmentado `GET /v1/pca/?codigoClassificacaoSuperior=7830` (primário) + Search `pcaorgao` (secundário) — ver [`plano-probe-pca-incremental.md`](./plano-probe-pca-incremental.md) |
| `import-catmat-curadoria` | manual | POST JSON exportado do catálogo HTML |
| `sync-pncp-contratacoes-editais` | `0 */6 * * *` | GET `/v1/contratacoes/*` |
| `sync-pncp-contratacoes-atas` | `15 */6 * * *` | GET `/v1/atas` |
| `sync-pncp-contratacoes-contratos` | `30 */6 * * *` | GET `/v1/contratos` |
| `sync-pncp-catalogo` | manual | GET `/v1/catalogos` (integração PNCP) |
| `sync-compras-catmat` | manual/semanal | Compras.gov Dados Abertos `/modulo-material/*` (7830 fitness; 7220 piso curadoria) |
| `link-catmat-pca` | manual | Ponte `catalogo_ponte` PCA item ↔ CATMAT (Jaccard; body `offset`/`limite` pagina por `pca_itens.id`) |
| `sync-pncp-irp` | bloqueado | Gate CLA-34 |

## API da aplicação (Fase 6)

| Função | GET | POST |
|--------|-----|------|
| `api-pncp-pca` | Lista `pca_planos` | Dispara sync (Idempotency-Key) |
| `api-pncp-contratacoes` | `?tipo=editais\|atas\|contratos` | Dispara sync por tipo |

Autenticação: JWT Supabase para leitura; sync manual exige `SYNC_CRON_SECRET` ou JWT válido.

## Gates e riscos

- **IRP**: sem listagem na API Consulta — `sync_habilitado=false` no schema; env `IRP_SYNC_ENABLED=true` só após CLA-34
- **Usuários PNCP**: fora do MVP ([security-mvp.md](./security-mvp.md))
- **Matriz de contratos**: [contract-matrix.md](./contract-matrix.md) — gate para migrations de domínio
- **Mapa de cruzamentos**: [cruzamentos.md](./cruzamentos.md) — junções PNCP × CATMAT × catálogo

## Secrets

- `SYNC_CRON_SECRET` — cron e triggers de sync
- `PNCP_INTEGRACAO_TOKEN` — catálogo e IRP por órgão (opcional no MVP)
- `SUPABASE_SERVICE_ROLE_KEY` — funções de sync (automático no runtime)

## Desenvolvimento local (Windows)

1. `npx supabase start` — se travar em backup, `npx supabase stop --no-backup` e reinicie.
2. Se `db reset` falhar na conexão `:54322`, aplique migrations com `scripts/apply-migrations-local.ps1`.
3. `config.toml` expõe schema `private` em `[api].schemas` (Edge Functions usam `service_role`).
4. Edge Functions: `npx supabase functions serve --no-verify-jwt --env-file supabase/.env.functions.local sync-pncp-pca`
5. PCA aceita `codigos_classificacao: ["7830"]` (padrão LicitaGym) ou `codigo_classificacao_superior` (legado); use `max_paginas` para smoke tests.
6. Curadoria CATMAT: exporte do app HTML → `scripts/import-catmat-curadoria.ps1` ou POST em `import-catmat-curadoria`.
7. CATMAT oficial Compras.gov: `.\scripts\invoke-sync-compras-catmat.ps1` (referência + características em lotes).
8. Ponte PCA↔CATMAT: `.\scripts\invoke-link-catmat-pca-all.ps1` (ou lote via `-Offset` em `invoke-link-catmat-pca.ps1`) após sync PCA e CATMAT.
9. Validar anti-churn PCA: `.\scripts\invoke-validate-pca-anti-churn.ps1` (2 rodadas).
7. **Carga anual PCA:** o índice Search (`/api/search?tipos_documento=pcaorgao`) expõe `data_publicacao_pncp` e `data_atualizacao_pncp` por órgão. Use `somente_verificacao:true` para checar se houve mudança; sync pesado só quando `data_atualizacao_pncp` avançar ou com `forcar:true`. Lastro em `private.pncp_period_anchor`.

```powershell
# Verificação barata (pode rodar mensalmente)
.\scripts\probe-pca-periodo.ps1 -Ano 2026

# Carga anual forçada (1× por ano de exercício)
.\scripts\invoke-sync-pca.ps1 -Ano 2026 -Forcar -MaxPaginas 500
```

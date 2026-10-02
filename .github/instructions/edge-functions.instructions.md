---
applyTo: "supabase/functions/**"
---
# Supabase Edge Functions (Deno/TypeScript)

## Deploy — Alto
- Todo merge na `main` republica **todas** as Edge Functions do repositório pela integração Supabase ↔ GitHub. PR em `supabase/functions/**` é alto risco (produção, sem staging).
- Não tratar "fora da lista de `.github/workflows/deploy-supabase-functions.yml`" como "nunca publica". Esse workflow faz deploy explícito e smoke test de um subconjunto; a publicação no merge não depende dele.
- `wrangler deploy` não publica este backend.
- `SUPABASE_SERVICE_ROLE_KEY` e qualquer credencial só em secret (`Deno.env.get`). Nada de chave no código, log ou resposta.
- O pipeline do Dashboard não é alimentado por sync, cron ou insert automático. Só pela ação explícita "Enviar para pipeline".

## Segurança — Alto ([BLOQUEANTE])
- O deploy usa `--no-verify-jwt`. **Todo handler protegido** deve chamar logo no início um helper de `_shared/http.ts` e retornar a resposta 401 que ele devolve:

  | Quem chama | Helper | Uso |
  |---|---|---|
  | Cron/sync (`SYNC_CRON_SECRET`) | `requireCronAuth(req)` | `const denied = requireCronAuth(req); if (denied) return denied;` |
  | Usuário autenticado (JWT Supabase Auth) | `requireUserAuth(req)` | `const denied = await requireUserAuth(req); if (denied) return denied;` |
  | Cron **ou** usuário | `requireCronOrUserAuth(req)` | `const denied = await requireCronOrUserAuth(req); if (denied) return denied;` |

  `validateCronAuth(req)` (booleano) está **deprecado**; é aceito em funções `sync-*` existentes, mas código novo usa `requireCronAuth`. Os helpers de usuário são assíncronos — `requireUserAuth` sem `await` é [BLOQUEANTE] (a Promise é sempre truthy, então o `if (denied)` perde o sentido e a resposta sai errada). O secret de cron nunca vale como sessão de usuário. Não criar validação de token própria.
- Ação pública (ex.: `readiness`) deve ser explícita no código e não expor dado sensível.
- `service_role` / cliente admin (`_shared/pncp/supabase-admin.ts`) só em funções de sync/cron; nunca em endpoint `api-*` chamado pelo usuário sem checar autorização.
- Nenhum secret em código, log ou resposta HTTP. Ler de `Deno.env.get`.
- Não refletir mensagens de erro internas (stack, SQL) para o cliente.

## Função nova
- Reutilizar `_shared/` antes de criar código novo: `http.ts`, `pncp/retry.ts`, `pncp/idempotency.ts`, `pncp/upsert.ts`, `pncp/hash.ts`, `pncp/checkpoint.ts`, `pncp/lock.ts`, `compras-gov/*-client.ts`. Para `tamanhoPagina`, usar `clampConsultaPageSize` (`pncp/consulta-client.ts`) ou `clampComprasGovPageSize` (`compras-gov/material-client.ts`) — não criar limitador novo.

## Chamadas às APIs oficiais
- Parâmetros conforme `docs/pncp/schemas-consultas-pncp.md` e `docs/compras-gov/schemas-consultas.md` (nomes exatos, obrigatórios, enums).
- `tamanhoPagina` por família de endpoint (contratações ≤ 50; atas/contratos ≤ 500; PCA tem contrato próprio). Nunca um limite global.
- Timeout explícito; retry limitado com backoff; respeitar `Retry-After` em 429; sem retry em 4xx permanente.
- HTTP 200 não significa payload válido: validar envelope e campos.

## Erro ≠ vazio
Falha de página intermediária deixa o sync como `partial`/`failed`, nunca como sucesso com menos dados. `catch` que devolve `[]`/`null` como se fosse resposta válida é [BLOQUEANTE].

## Sync
- Discovery separado de hydration.
- Upsert idempotente pela chave oficial/natural; `payload_hash` só detecta mudança.
- Registrar sync run com contagens (discovered, inserted, updated, unchanged, failed) e usar checkpoint em fan-out longo.
- Lock para evitar execuções concorrentes do mesmo job.

## Tipos
Sem `any` em fronteiras de API; tipar DTOs (ver `*-types.ts`).

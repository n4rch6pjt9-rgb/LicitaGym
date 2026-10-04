# LicitaGym: onboarding do agente

Regras de produto e de dados (zero alucinação, identificadores oficiais, schemas antes de requisições): **`AGENTS.md`**.
Regras por área: **`.github/instructions/*.instructions.md`** (catmat, database-migrations, document-pipeline,
edge-functions, pncp, python-ingestion, tests). Este arquivo não repete esse conteúdo: diz como o projeto roda,
entrega e é observado, e o que o agente não pode fazer.
Os `CLAUDE.md` de subpastas são logs do plugin claude-mem (histórico de sessões), não instruções.

## O que é
SaaS de monitoramento de licitações públicas (foco: equipamentos fitness e pisos de borracha). Este repositório
é o backend: banco, Edge Functions e coletores. O frontend fica em `n4rch6pjt9-rgb/Dashboard---LicitaGym`.

| Pasta | Conteúdo |
|---|---|
| `supabase/migrations/` | schema (Postgres 17, RLS, ACL explícita). Uma migration por mudança, idempotente |
| `supabase/functions/` | Edge Functions Deno (`api-*` para o Dashboard, `sync-*` para ingestão). Código comum em `_shared/` |
| `supabase/tests/*_check.sql` | checagens de ACL/regra de negócio (DO blocks que falham com EXCEPTION) |
| `services/coletor-externo/` | coletores Python (PNCP detalhe, Sistema S/Paradigma, taxonomia, escopo). Imagem Docker do Cloud Run Job |
| `scripts/` | coletores Python antigos e scripts PowerShell de operação |
| `tests/` | pytest dos `scripts/` e testes Deno (`tests/supabase/**`) |
| `Kuib-Harness/` | app desktop de administração (Electron + Vue) |
| `docs/` | arquitetura, schemas das APIs oficiais, runbooks |

## Como testar (os mesmos comandos da CI `pr-quality.yml`)
```bash
deno check supabase/functions/<funcao>/index.ts
deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt
pip install -r requirements-dev.txt && pytest tests/ -q
cd services/coletor-externo && pip install -r requirements.txt -r ../../requirements-dev.txt && python -m pytest -q
```
Migration nova: skill `validar-migrations` (Postgres descartável) antes do PR.

## Ambientes e entrega
- **Um ambiente: produção** (Supabase `ifaiagegyicjzlpskafh`). Não há staging.
- **Merge na `main` aplica em produção**:
  - migrations: integração Supabase ↔ GitHub (configurada no painel do Supabase). Aparece no commit como o check
    **"Supabase Preview"**, mas aplica em produção (~30 s após o merge). Confira depois com a skill `verificar-producao`;
  - Edge Functions: a integração Supabase ↔ GitHub republica **todas** as funções do repositório a cada merge na `main`.
    PR em `supabase/functions/**` ou `supabase/migrations/**` é de alto risco (produção, sem staging).
    O workflow `.github/workflows/deploy-supabase-functions.yml` continua no repo (deploy explícito de um subconjunto + smoke test);
    não é o que decide se a função publica.
- Coletor externo: Cloud Run Job `coletor-sestsenat` (GCP), agendamento semanal; ver `services/coletor-externo/README.md`.
- PR empilhado: merge commit (não squash), porque a branch é apagada no merge. Skill `merge-pilha`.

## Observabilidade
- **Saúde consolidada:** `private.saude_operacional_resumo()` (limiares em `private.saude_limiares`), exposta pela
  Edge Function `api-saude` (cron secret ou admin). O workflow `.github/workflows/saude.yml` (a cada 30 min) abre/fecha
  a issue com rótulo `alerta-operacional` quando há verificação crítica.
- Execuções: `private.pncp_sync_run` (heartbeat, `incompleta`/`retomada`), `private.coleta_externa_run`,
  `private.pncp_sync_request`.
- Saúde da API: `api-dashboard-oportunidades?action=readiness`.
- Logs: painel do Supabase (Edge Functions) e Cloudflare Workers Logs (Dashboard). Skill `verificar-producao`.

## MCP
`.mcp.json` e `.cursor/mcp.json`: Supabase **somente leitura**. Escrita em produção só por migration + PR, ou pelo
SQL Editor com o usuário.

## Skills e agentes (`.claude/`)
| Nome | Quando usar |
|---|---|
| skill `nova-migration` | antes de escrever qualquer migration |
| skill `validar-migrations` | antes de abrir PR com migration |
| skill `merge-pilha` | quando o usuário pedir merge de PRs empilhados |
| skill `verificar-producao` | depois de merge/deploy, ou para investigar incidente |
| agente `revisor-migration` | revisão de migration (destrutivo, ACL, RLS, idempotência) antes do PR |
| agente `revisor-seguranca` | revisão de segredos, auth e service_role antes do PR |
| agente `backend-licitagym` | implementa uma issue deste repositório até um PR em draft verificado, a pedido do orquestrador (sem merge nem deploy) |

**Orquestração entre repositórios:** uma sessão orquestradora divide o trabalho entre `backend-licitagym` (este repo) e
`frontend-dashboard` (repo do Dashboard), define a ordem (backend mergeado e publicado antes do front que depende dele),
revisa as entregas e leva ao Marcelo as decisões de produto e os pedidos de merge.

## O que o agente NÃO faz
- Não faz merge nem deploy sem o "ok" explícito do usuário (merge aplica em produção).
- Não roda `supabase db reset/push`, `supabase migration repair`, `git push --force`, push direto na `main`,
  `terraform apply/destroy`, `wrangler deploy`, `wrangler delete`: `.claude/hooks/bloquear-destrutivo.mjs` bloqueia (casos de teste em
  `.claude/hooks/bloquear-destrutivo.test.mjs`; rode `node .claude/hooks/bloquear-destrutivo.test.mjs` ao mudar o hook).
  Se for mesmo necessário, o usuário roda.
- Não usa `user_metadata` para papel: admin é `app_metadata.licitagym_role = 'admin'`.
- Não lê, copia nem versiona `.env*` (exceto `.env.example`), chaves, HAR, CSV, zip nem dados de coleta.
- Não inventa dado (ver `AGENTS.md`).

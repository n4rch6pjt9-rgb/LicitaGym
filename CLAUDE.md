# LicitaGym (backend)

<!-- Mantenha abaixo de 200 linhas. Regra que vale só para uma pasta vai para .claude/rules/ com `paths:`.
     Procedimento de vários passos vai para skill. Fato com data ("em 08/10...") vai para docs/, não aqui. -->

@AGENTS.md

Regras de negócio e escopo do produto (sempre carregadas): `.claude/rules/regras-negocio.md`.
Regras por área (carregam só ao tocar a pasta): `.claude/rules/*.md`, geradas de `.github/instructions/`.
Escopo do produto e objetivo final: `docs/produto/ESCOPO.md`. Spec-mãe em execução: `specs/0032-agentes-dentro-da-tarefa.md`.

## O que é
SaaS de licitações públicas para fornecedores do mercado fitness (cliente atual: Konnen). Este repo é o backend:
banco, Edge Functions e coletores. Frontend: `n4rch6pjt9-rgb/Dashboard---LicitaGym`.

| Pasta | Conteúdo |
|---|---|
| `supabase/migrations/` | schema (Postgres 17, RLS, ACL explícita). Uma migration por mudança, idempotente |
| `supabase/functions/` | Edge Functions Deno (`api-*` para o Dashboard, `sync-*` para ingestão). Comum em `_shared/` |
| `supabase/tests/*_check.sql` | checagens de ACL/regra de negócio (DO blocks que falham com EXCEPTION) |
| `services/coletor-externo/` | coletores Python (Cloud Run Jobs, ver o README da pasta) |
| `scripts/` | coletores antigos e scripts de operação |
| `tests/` | pytest e testes Deno (`tests/supabase/**`) |
| `specs/` | uma spec por mudança não trivial (`/spec`), template em `specs/_template.md` |
| `docs/` | produto, arquitetura, schemas das APIs oficiais, runbooks |

## Como testar (mesmos comandos da CI `pr-quality.yml`)
```bash
scripts/ci/deno-check-funcoes.sh [funcao ...]
deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt
git diff --name-only origin/main... | scripts/ci/lint-alterados.sh -
pip install -r requirements-dev.txt && pytest tests/ -q
cd services/coletor-externo && pip install -r requirements.txt -r ../../requirements-dev.txt && python -m pytest -q
scripts/validar-migrations.sh        # Postgres 17 descartável (Docker)
```
- Pre-commit: `git config core.hooksPath .githooks` uma vez por clone.
- Pendências conhecidas: `.github/ci/deno-check-pendentes.txt` e `supabase/tests/pendentes.txt`. A lista só diminui.
- Quem toca um arquivo resolve o lint dele inteiro. Não acrescente regra de lint sem limpar a base.
- Workflow novo do GitHub Actions não usa `uses:` (marketplace bloqueado): siga `pr-quality.yml`.

## Produção (não há staging)
- Supabase `ifaiagegyicjzlpskafh` é o único ambiente.
- **Merge na `main` = produção:** aplica as migrations (~30 s) e republica **todas** as Edge Functions.
  PR em `supabase/functions/**` ou `supabase/migrations/**` é alto risco.
- Depois do merge: skill `verificar-producao` e `get_advisors` (security). Achado novo vira issue.
- Branch Supabase só sob demanda, criada pelo Marcelo (DDL destrutivo, backfill grande, RLS de tenant, extensão).
- PR empilhado: merge commit, não squash (skill `merge-pilha`).

## Banco
Mudança de schema, ACL ou dado só por migration versionada + PR (skill `nova-migration`, agente `revisor-migration`).
MCP do Supabase é somente leitura. Exceção: o que o Marcelo fizer à mão, depois registrado em migration.

## Convenções
- **Edge Functions:** auth por `requireCronAuth` / `await requireUserAuth` / `await requireCronOrUserAuth`
  (`_shared/http.ts`). `service_role` em `api-*` só depois de checar o usuário. Erro de página não é resultado vazio.
  Importar de `_shared/`, nunca de `_shared_prod/`.
- **Python:** timeout explícito, retry com backoff e `Retry-After`, `DELAY_SEGUNDOS >= 1`. Teste unitário não chama API real.
- **SQL:** `YYYYMMDDHHMMSS_assunto.sql`, idempotente, `revoke all` + grant mínimo, RLS ligada,
  SECURITY DEFINER com `search_path` fixo, e `supabase/tests/<assunto>_check.sql`.
- Correção P0/P1 leva teste de regressão. Mudança de classificação leva contagem antes/depois (dry-run) no PR.
- Tudo em português: comentário, PR, mensagem de erro.

## Fluxo de trabalho
1. Mudança não trivial começa por `/spec <ideia>`. A spec diz **qual fase da spec-mãe ela alimenta**; se não alimenta
   nenhuma, fica `parada` (ver `docs/produto/ESCOPO.md`).
2. Marcelo aprova (sempre que houver migration, decisão de produto ou dado de produção).
3. `/implement specs/NNNN-slug.md`: testes dos critérios de aceite primeiro, depois o código, até PR em draft.
4. Antes de pedir merge: agentes `revisor-codigo` e `revisor-seguranca` (e `revisor-migration` se houver migration),
   mesmo que a CI e o revisor externo tenham passado. O PR registra o resultado.
5. Fechamento e início de ciclo (issues dos dois repos, aviso às outras janelas): skill `ciclo-janelas`.

## Skills e agentes (`.claude/`)
| Nome | Quando usar |
|---|---|
| `/spec`, `/implement` | criar e executar spec |
| skill `nova-migration`, `validar-migrations` | antes de escrever / antes do PR com migration |
| skill `verificar-producao` | depois de merge, ou para investigar incidente |
| skill `merge-pilha` | merge de PRs empilhados, a pedido do usuário |
| skill `ciclo-janelas` | fim e início de ciclo (regras R2 a R4) |
| agentes `revisor-codigo`, `revisor-migration`, `revisor-seguranca` | revisão antes do PR |

## Observabilidade
- Saúde: `private.saude_operacional_resumo()` via `api-saude`; `saude.yml` abre issue `alerta-operacional`.
- Execuções: `private.pncp_sync_run`, `private.coleta_externa_run`, `private.job_queue`.
- Logs: painel Supabase (Edge Functions) e Cloudflare Workers Logs (Dashboard).

## O que o agente NÃO faz
- Não altera schema, ACL ou dado de produção fora de migration + PR.
- Não faz merge nem deploy sem "ok" explícito do Marcelo.
- Não roda `supabase db reset/push`, `supabase migration repair`, `git push --force`, push na `main`,
  `terraform apply/destroy`, `wrangler deploy/delete` (bloqueado por `.claude/hooks/bloquear-destrutivo.mjs`).
- Não usa `user_metadata` para papel (admin = `app_metadata.licitagym_role = 'admin'`).
- Não lê nem versiona `.env*` (exceto `.env.example`), chaves, HAR, CSV, zip ou dados de coleta.
- Não faz login em portal de compras: só dado aberto/público.
- Não inventa dado (ver `AGENTS.md`).

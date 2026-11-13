# Matriz de automações: o que roda sozinho, o que o Claude aciona e o que você executa

Uma consulta rápida para saber **quem dispara** cada automação do repositório e **qual é o gatilho**. As regras de
fundo estão no `CLAUDE.md`; aqui está só o quando.

Legenda da coluna **Quem dispara**:

- 🤖 **Automático**: roda sem ninguém pedir, no gatilho indicado.
- 🤝 **Claude aciona**: o `CLAUDE.md` manda o Claude usar neste momento (ou ele carrega pela descrição da skill). O PR
  registra que rodou; vale conferir.
- 👤 **Você executa**: só roda se você pedir ou digitar. Não há gatilho automático.

## 1. Por gatilho: o que acontece em cada momento do fluxo

| Momento | O que dispara | Quem dispara |
|---|---|---|
| Claude vai rodar qualquer comando ou chamar uma ferramenta MCP | hook `bloquear-destrutivo` (e as regras `deny`/`ask` do `settings.json`) | 🤖 |
| Claude abre uma pasta (`supabase/functions`, `supabase/migrations`, `services/coletor-externo`...) | regra da pasta em `.claude/rules/*.md` | 🤖 |
| Claude edita ou cria um `.ts`/`.tsx` (em `supabase/functions` ou `tests/supabase`) ou um `.py` | hook `lint-pos-edicao`: lint só daquele arquivo; o erro volta para o Claude corrigir | 🤖 **novo** |
| Ideia ou mudança não trivial | `/spec <ideia>` | 👤 |
| Spec aprovada por você | `/implement specs/NNNN-slug.md` (testes primeiro, depois o código, até PR em draft) | 👤 |
| Antes de escrever migration | skill `nova-migration` | 🤝 |
| `git commit` | pre-commit (`.githooks`): higiene, lint, `deno check` e testes afetados | 🤖 (uma vez por clone: `git config core.hooksPath .githooks`) |
| Antes do PR, diff toca `supabase/migrations/**` | skill `validar-migrations` + agente `revisor-migration` | 🤝 |
| Antes do PR, qualquer PR | agentes `revisor-codigo` e `revisor-seguranca` | 🤝 |
| Antes do PR, diff toca `supabase/functions/api-*`, `_shared/tenant.ts` ou policy de tabela com `tenant_id` | agente `revisor-tenant` | 🤝 **novo** |
| Antes do PR, diff muda regra de classificação (ver seção 3) | skill `dry-run-classificacao` | 👤 **novo** (só você chama) |
| PR aberto ou atualizado | CI `pr-quality` (typecheck, lint, testes, migrations, casos dos dois hooks) | 🤖 |
| PR com migration ou Edge Function | check Supabase Preview (branch de banco do PR) | 🤖 |
| PR toca `_shared/pncp/**`, `sync-pncp-pca/**`, `tests/supabase/functions/**` ou o próprio workflow | CI `pca-harness` (também manual, `workflow_dispatch`) | 🤖 |
| Você aprova o merge na `main` | merge (nada disso o Claude faz sozinho) | 👤 |
| Merge na `main` | migrations aplicadas e **todas** as Edge Functions republicadas | 🤖 |
| Merge toca `supabase/functions/**` | workflow `deploy-supabase-functions` (deploy explícito de um subconjunto + smoke test) | 🤖 |
| Depois do merge | skill `verificar-producao` + `get_advisors` (security); achado novo vira issue | 🤝 |
| PRs empilhados prontos para merge | skill `merge-pilha` | 👤 (só a pedido seu) |
| Fim e início de ciclo (merge, spec entregue, PR fechado) | skill `ciclo-janelas` | 🤝 |

## 2. Rotinas que rodam sem o Claude

| Rotina | Gatilho | Observação |
|---|---|---|
| `saude.yml` (saúde operacional; abre issue `alerta-operacional`) | a cada 30 min (minutos 7 e 37) | 🤖 |
| `sentinela-observador.yml` (confere se o `saude.yml` está rodando) | a cada 30 min (minutos 17 e 47) | 🤖 |
| `coletor-pncp.yml` | todo dia, 06:00 em Brasília | 🤖; manual com `workflow_dispatch` (`modo`, `dry_run`, `rapido`) |
| `coletor-sistema-s.yml` | todo dia, 06:30 em Brasília | 🤖; manual com `workflow_dispatch` (`fonte`, `paginas`, `documentos`, `dry_run`) |
| pg_cron `licitagym-coleta-externa-orfaos` (spec 0063) | de hora em hora (minuto 23) | 🤖; fecha como `incompleta` execução de `coleta_externa_run` presa há mais de 6 h |
| `coletor-precos.yml` | segunda e quinta, 07:00 em Brasília | 🤖; manual com `workflow_dispatch` (`modo`, `dry_run`, `limite`) |
| `supabase-auth-check.yml` | só manual | 👤 |

## 3. Quando rodar `dry-run-classificacao` (gatilho por arquivo)

Rode antes de abrir o PR se o diff (ou a edição que você vai fazer no app) mexer em qualquer um destes:

| Se o diff toca | Meça |
|---|---|
| `escopo_termos`, `fn_escopo_item`, `fn_escopo_pca` | itens por `nivel` e `familia` (`escopo_item_calc`) |
| `catmat_pdm_palavras`, `catmat_pdm_exclusoes`, `lg_normalizar`, `lg_regex_ramos` | casamentos por PDM (`licitacao_match`) |
| `objeto_categorias` | licitações por `objeto_categoria` |
| `coletor/escopo.py`, `reclassificar_escopo_pncp.py`, regra de prioridade | licitações por `prioridade` gravada |
| `orgao_tipo_regras`, `orgao_tipo_override`, `orgao_tipos` | órgãos por `tipo_orgao` e `grupo_tipo` |
| `marca_aliases`, `marca_resolver` | marcas resolvidas |

## 4. O que só você decide (nenhuma automação faz)

- Merge na `main` e qualquer deploy.
- `--apply` do reclassificador (o dry-run é o padrão).
- `supabase migration repair`, `db reset/push`: bloqueados para o Claude; você roda, com a saída de `migration list` à vista.
- Liberar vaga ou subir o limite de branches de preview, quando o check vier "ignored ... limit of concurrent preview branches".
- Apagar branch de preview.
- Deploy do Dashboard (`npm run cf:deploy`).

## 5. Como conferir se cada automação está viva

| Automação | Como conferir |
|---|---|
| hooks do Claude | `node .claude/hooks/bloquear-destrutivo.test.mjs` e `node .claude/hooks/lint-pos-edicao.test.mjs` (a CI roda os dois) |
| pre-commit | `git config core.hooksPath` deve devolver `.githooks` |
| agentes e skills | aparecem na lista de agentes e skills do Claude Code no repositório; a tabela do `CLAUDE.md` é a referência |
| rotinas agendadas | aba Actions do GitHub; a saúde aparece como issue `alerta-operacional` quando falha |

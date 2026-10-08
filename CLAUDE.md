# LicitaGym: onboarding do agente

Regras de produto e de dados (zero alucinação, identificadores oficiais, schemas antes de requisições): **`AGENTS.md`**.
Regras por área: **`.github/instructions/*.instructions.md`** (catmat, database-migrations, document-pipeline,
edge-functions, pncp, python-ingestion, tests). Este arquivo não repete esse conteúdo: diz como o projeto roda,
entrega e é observado, e o que o agente não pode fazer.
Os `CLAUDE.md` de subpastas são logs do plugin claude-mem (histórico de sessões), não instruções.

## O que é
SaaS de monitoramento de licitações públicas (foco: equipamentos fitness e pisos de borracha). Este repositório
é o backend: banco, Edge Functions e coletores. O frontend fica em `n4rch6pjt9-rgb/Dashboard---LicitaGym`.
O produto lê compras públicas (PNCP, Compras.gov, Sistema S, Portal de Compras Públicas) e mostra ao fornecedor
o que ele pode disputar agora, o que acompanhar e o que já foi homologado (preço, marca, vencedor), sem inventar dado.

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

## Como testar (os mesmos comandos da CI `pr-quality.yml`, que roda em todo PR e push na `main`)
```bash
scripts/ci/deno-check-funcoes.sh [funcao ...]       # deno check de todas (ou das nomeadas)
deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt
git diff --name-only origin/main... | scripts/ci/lint-alterados.sh -   # deno lint + ruff só no que mudou
pip install -r requirements-dev.txt && pytest tests/ -q
cd services/coletor-externo && pip install -r requirements.txt -r ../../requirements-dev.txt && python -m pytest -q
scripts/validar-migrations.sh                       # Postgres 17 descartável (Docker); a CI roda em todo PR
```
- **Pre-commit** (lint + testes afetados pelo commit, ~segundos): `git config core.hooksPath .githooks` uma vez por
  clone. Ferramenta ausente vira aviso; pular uma vez: `git commit --no-verify`.
- **Pendências conhecidas** (podem falhar sem derrubar a CI; se passarem, saem da lista): `.github/ci/deno-check-pendentes.txt`
  (typecheck) e `supabase/tests/pendentes.txt` (checks SQL). A lista só diminui: não acrescente item sem issue.
- Fluxos críticos ainda sem teste: `docs/testes-minimos-fluxos-criticos.md`.

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
| comando `/spec <ideia>` | antes de mudança não trivial: gera `specs/NNNN-slug.md` (template em `specs/_template.md`) |
| comando `/implement <spec>` | spec `aprovada`: testes dos critérios de aceite primeiro (red), depois o código, até PR em draft |
| skill `nova-migration` | antes de escrever qualquer migration |
| skill `validar-migrations` | antes de abrir PR com migration |
| skill `merge-pilha` | quando o usuário pedir merge de PRs empilhados |
| skill `verificar-producao` | depois de merge/deploy, ou para investigar incidente |
| agente `revisor-codigo` | revisão geral do diff (corretude, regras de produto, contrato com o Dashboard, testes) antes do PR |
| agente `revisor-migration` | revisão de migration (destrutivo, ACL, RLS, idempotência) antes do PR |
| agente `revisor-seguranca` | revisão de segredos, auth e service_role antes do PR |

## Convenções de código
- **Edge Functions (Deno/TS):** auth sempre por `requireCronAuth` / `requireUserAuth` (com `await`) / `requireCronOrUserAuth`
  de `_shared/http.ts`; `service_role` em `api-*` só depois de checar o usuário. Erro de página não é resultado vazio:
  a execução fica parcial/falha. Importar de `_shared/`, nunca de `_shared_prod/` (cópia antiga, a eliminar).
- **Python:** timeout explícito, retry com backoff e `Retry-After`; valor original guardado ao lado do normalizado;
  `DELAY_SEGUNDOS >= 1` nos coletores. Teste unitário nunca chama API real.
- **SQL:** uma migration por mudança, `YYYYMMDDHHMMSS_assunto.sql`, idempotente, `revoke all` + grant mínimo, RLS ligada,
  SECURITY DEFINER com `search_path` fixo, e um `supabase/tests/<assunto>_check.sql`. Detalhe: skill `nova-migration`.
- **Correção P0/P1** leva teste de regressão. Mudança de classificação leva contagem antes/depois (dry-run) no PR.
- Texto (comentário, PR, mensagem de erro ao usuário) em português.

## Regras de negócio de licitação (resumo; fonte: migrations e `.github/instructions/`)
Itens com **CONFIRMAR** foram inferidos do código e ainda não foram validados pelo Marcelo como regra de produto.
- **Fonte oficial manda.** Identificador oficial (CNPJ do órgão, UASG, nº de controle PNCP, `codigoItem` ≠ `codigoPdm`)
  fica separado da chave interna, com proveniência. Dado ausente aparece como ausente (`AGENTS.md`).
- **Prioridade da oportunidade:** `leads` (recebendo proposta), `monitorar` (em julgamento), `historico` (encerrada,
  homologada, cancelada). A view `licitacoes_externas_prioridade_efetiva` só rebaixa: sinal de encerramento → `historico`;
  prazo vencido (horário de Brasília) → `monitorar`. Status desconhecido nunca vira lead; falha de API nunca vira `historico`.
- **Escopo:** contrato de serviço (credenciamento, locação, manutenção mesmo com peças, obra, oficineiros) nunca vira lead.
  Termo de busca sozinho não torna a linha `forte`. Academia ao ar livre só conta junto com piso.
  CATMAT núcleo 78/7830, extensão curada 72/7220, sem misturar automaticamente.
- **Classificação de equipamento:** Musculação, Cárdio ou Acessórios; determinística, idempotente e editável à mão.
- **Pisos de borracha:** SBR/EPDM (academia, crossfit, playground) = prioridade alta; piso modular PP/TPE = sinal de
  concorrente.
- **Taxonomia:** a fonte da verdade hoje são os JSON `services/coletor-externo/coletor/data/taxonomia-pisos-v0.2.json`
  e `dicionario-aparelhos-v0.3.json`; o banco recebe cópia por migration, sem histórico de versão, e
  `catalogo_itens.taxonomias` mistura atributo oficial do CATMAT com curadoria. Não gravar campo derivado nesse jsonb
  nem mudar taxonomia sem migration; o redesenho (oficial × curadoria, versão, diff idempotente) é a issue #272.
- **Mesma compra no PNCP:** a mesma compra publicada duas vezes (sistema do órgão + plataforma, ou republicação)
  ganha dois números de controle. A view `licitacoes_pncp_canonica` trata como uma só as linhas com
  `(orgao_cnpj, processo_norm, numero_edital)` iguais (ano e modalidade estão no `numero_edital`) e mostra a de prazo
  mais recente; nada é apagado. **CONFIRMAR** como regra de produto (hoje são 11 grupos de 2).
- **Regulamento:** PNCP segue a Lei 14.133; o Sistema S tem regulamento próprio (RLC antigo, RCA desde 2025). A coluna
  `regulamento` está NULL em todas as linhas e nenhuma regra (status, prazo, prioridade, tarefas) a usa; o catálogo de
  tarefas cobre só a 14.133. **CONFIRMAR** se o Sistema S precisa de fase, prazo ou tarefa própria.
- **Preço, marca e fornecedor** vêm só de compra homologada e aparecem só no BI. Cálculo financeiro é determinístico,
  com regra de arredondamento escrita.
- **Pipeline:** entra só pela ação explícita "Enviar para pipeline"; descartar exige motivo.
- **Habilitação (tenant):** documento sem validade informada vale emissão + 90 dias (marcado como calculado);
  certidão de falência e balanço não são sanáveis. Os 90 dias são decisão de produto.
- **Papéis:** admin da plataforma = `app_metadata.licitagym_role = 'admin'`; dentro do tenant, `admin` ou `operacao`
  (`operacao` não vê dados bancários).
- **Tabela com RLS e sem policy** (33 em `public`) é intencional: o cliente não lê direto, só via Edge Function
  (validado em 08/10: nenhuma tem grant a `authenticated`, o Dashboard não lê nenhuma direto).
- **Tenants em construção, desligados na prática** (1 empresa ativa, 0 membros, pipeline vazio). Antes de ligar:
  todo `service_role` que lê tabela com `tenant_id` filtra por tenant (hoje `api-dashboard-oportunidades/portal.ts` e
  `sync-portal-compras` leem `pipeline_oportunidades` sem filtro); vínculo com empresa inativa não pode cair em outra
  (#263); `api-pipeline` passa a respeitar o papel `admin`/`operacao`; teste com duas empresas e dois usuários.

## O que o agente NÃO faz
- Não altera schema, ACL ou dado de produção fora de migration versionada + PR (nem pelo MCP, nem por SQL avulso).
- Não faz merge nem deploy sem o "ok" explícito do usuário (merge aplica em produção).
- Não roda `supabase db reset/push`, `supabase migration repair`, `git push --force`, push direto na `main`,
  `terraform apply/destroy`, `wrangler deploy`, `wrangler delete`: `.claude/hooks/bloquear-destrutivo.mjs` bloqueia (casos de teste em
  `.claude/hooks/bloquear-destrutivo.test.mjs`; rode `node .claude/hooks/bloquear-destrutivo.test.mjs` ao mudar o hook).
  Se for mesmo necessário, o usuário roda.
- Não usa `user_metadata` para papel: admin é `app_metadata.licitagym_role = 'admin'`.
- Não lê, copia nem versiona `.env*` (exceto `.env.example`), chaves, HAR, CSV, zip nem dados de coleta.
- Não inventa dado (ver `AGENTS.md`).

# 0033: Receber o tenant explicitamente nas APIs e escolher a empresa no shell

- **Status:** aprovada (Marcelo, 20/10)
- **Alimenta:** módulo 2 (Pipeline e tarefas) e pré-requisito da área `/configuracoes` (`docs/produto/BACKEND-CONFIGURACOES.md`, item 2.0)
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (muda autorização de 5 Edge Functions e o shell do Dashboard)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê |
|---|---|---|
| 1 | `CLAUDE.md` (LicitaGym e Dashboard) | entrega, testes, o que não fazer |
| 2 | `AGENTS.md` (LicitaGym) | zero alucinação: nome da empresa vem do banco |
| 3 | `.claude/rules/regras-negocio.md` | seção "Tenant e papéis" |
| 4 | `docs/produto/ESCOPO.md` e `docs/produto/BACKEND-CONFIGURACOES.md` | por que o tenant explícito vem antes de tudo |
| 5 | `specs/0017-tenant-cadastro-empresa-usuarios.md` | regras de vínculo, empresa desativada, desenvolvedor (#263, #325) |
| 6 | esta spec |
| 7 | `.claude/rules/edge-functions.md` | auth com `requireUserAuth`, `service_role` só depois de checar o usuário |
| 8 | `supabase/functions/_shared/tenant.ts`; README de `api-pipeline`, `api-tenant`; `repo.ts` de `api-tarefas`, `api-agentes`; `index.ts` de `api-dashboard-oportunidades`, `api-catalogo-ficha` | os 5 chamadores de `lerTenantDoUsuario` |
| 9 | Dashboard: `src/data/providers/supabaseProvider.ts` (`invokeEdge`), `src/data/tenantApi.ts` (`minhaEmpresa`), `src/components/layout/AppShell.tsx` (linha 107 e seletor em 445-455, 542-554) | onde o tenant entra no front |
| 10 | `.claude/agents/revisor-seguranca.md` (LicitaGym); `.claude/agents/frontend-dashboard.md`, `.claude/agents/ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md` (Dashboard) | agentes e skills desta spec |

## Problema

Medido em 20/10/2026 no código da `main` (`8436bdd`) e no banco (só leitura):

- `_shared/tenant.ts` (`resolverTenantDoUsuario`) descobre a empresa pelo vínculo. Um usuário com vínculo ativo em
  duas empresas ativas recebe **409**. O desenvolvedor sem vínculo cai na "única empresa ativa" e, com duas, recebe
  **409**.
- 5 Edge Functions usam essa regra: `api-pipeline`, `api-tarefas`, `api-agentes`, `api-dashboard-oportunidades`,
  `api-catalogo-ficha`. A `api-tenant` já recebe `tenant_id` explicitamente.
- `tenants` tem 1 linha hoje. A segunda empresa ativa quebra todas as 5 funções para o desenvolvedor.
- No Dashboard, o shell mostra o texto fixo "LicitaGym Brasil Esportes" (`AppShell.tsx:107`). O seletor de empresa
  parece clicável, mas não faz nada.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `_shared/tenant.ts`: `lerTenantDaRequisicao(client, usuario, tenantPedido?)` | `tenant_id` opcional (inteiro > 0) | `{ tenant, papel }` | 400 `tenant_invalido`; 403 sem acesso (mesma resposta para tenant inexistente e alheio, sem revelar qual); 409 `tenant_ambiguo` quando falta `tenant_id` e há 2+ opções | qualquer autenticado |
| K-2 | `api-pipeline`, `api-tarefas`, `api-agentes`, `api-dashboard-oportunidades` (ações com dado de tenant), `api-catalogo-ficha`: aceitar `tenant_id` no corpo | `tenant_id?` | igual a hoje, filtrado pelo tenant pedido | os de K-1 | igual a hoje por ação |
| K-3 | Dashboard: `TenantContext` | `minha_empresa` (com `empresa_ativa_id`) | empresa ativa da sessão (`id`, `nome`, `papel`), vinda do servidor | sem empresa → tela "Sem empresa vinculada" | — |
| K-6 | Migration: `usuario_preferencias(user_id uuid pk, tenant_ativo_id bigint fk tenants on delete set null, atualizado_em)` | — | — | — | só `service_role` (RLS ligada, sem grant a `authenticated`) |
| K-7 | `api-tenant` `action=empresa_ativa_definir` (nova) e `minha_empresa` devolvendo `empresa_ativa_id` | `tenant_id` | `empresa_ativa_id` | 403 se não for membro ativo de empresa ativa (o desenvolvedor pode escolher qualquer empresa, inclusive desativada) | autenticado |
| K-4 | Dashboard: `invokeEdge` | — | acrescenta `tenant_id` da sessão no corpo das funções de K-2 | — | — |
| K-5 | Dashboard: seletor de empresa no shell | lista de `minha_empresa` | troca a empresa (grava com `empresa_ativa_definir`), limpa caches e recarrega a rota atual | — | só aparece com 2+ empresas; para o desenvolvedor lista todas, com a marca "desativada" nas inativas |

**Preferência no servidor, contexto na requisição.** A empresa escolhida fica gravada no servidor (`usuario_preferencias`)
e vale em qualquer máquina. Mesmo assim, cada chamada continua levando o `tenant_id`: o servidor nunca deduz a empresa
da preferência. Assim, duas abas em empresas diferentes não se misturam. Uma preferência que deixou de valer (vínculo
desligado, empresa desativada para quem não é desenvolvedor) é ignorada: `minha_empresa` devolve `empresa_ativa_id`
nulo e a tela pede a escolha.

**Regras de K-1:**
- Com `tenant_id`, o vínculo precisa estar ativo e a empresa ativa: a resposta traz o papel do vínculo. O
  desenvolvedor acessa qualquer empresa existente, com papel nulo, e as regras de empresa desativada da 0017 continuam
  valendo.
- Sem `tenant_id`, vale a regra de hoje, com uma diferença: com 2+ opções, a resposta passa a ser `tenant_ambiguo`
  (código estável), e não mais uma mensagem solta.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-2 | **Dado** um membro ativo da empresa A, **quando** chama `api-pipeline` `etapas_listar` com `tenant_id = A`, **então** recebe 200 e só etapas de A. | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-2 | K-1, K-2 | **Dado** um membro só da empresa A, **quando** chama cada uma das 5 funções com `tenant_id = B` (B existente) e com `tenant_id = 999999` (inexistente), **então** recebe 403 com a mesma mensagem nos dois casos. | Deno `tests/supabase/shared_tenant_test.ts` (tabela pelas 5 funções) |
| CA-3 | K-1 | **Dado** um usuário com vínculo ativo em A e em B, ambas ativas, **quando** chama sem `tenant_id`, **então** 409 `tenant_ambiguo`; **com** `tenant_id = B`, 200 e dados de B. | Deno `shared_tenant_test.ts` |
| CA-4 | K-1 | **Dado** o desenvolvedor sem vínculo e duas empresas ativas, **quando** chama com `tenant_id = A`, **então** 200 com papel nulo; sem `tenant_id`, 409 `tenant_ambiguo`. | Deno `shared_tenant_test.ts` |
| CA-5 | K-1 | **Dado** vínculo desligado, ou empresa desativada, **quando** o membro chama com `tenant_id` dessa empresa, **então** 403 (regressão de #263 e #325). | Deno `shared_tenant_test.ts` |
| CA-6 | K-1 | **Dado** `tenant_id` = `"abc"`, `0` ou `-1`, **quando** qualquer das 5 funções é chamada, **então** 400 `tenant_invalido`, sem consulta ao banco. | Deno `shared_tenant_test.ts` |
| CA-7 | K-3 | **Dado** `minha_empresa` devolvendo a empresa "Empresa X", **quando** o shell monta, **então** mostra "Empresa X" e nenhum texto fixo de empresa existe no código do shell. | vitest `src/test/app-shell-tenant.test.tsx` |
| CA-8 | K-4, K-5 | **Dado** duas empresas na sessão, **quando** o usuário troca para a segunda, **então** a próxima chamada de `invokeEdge` para `api-pipeline` leva o `tenant_id` novo e a rota recarrega. | vitest `src/test/tenant-seletor.test.tsx` |
| CA-9 | K-5 | **Dado** uma empresa só, **quando** o shell monta, **então** o seletor não aparece (nome sem controle). | vitest `app-shell-tenant.test.tsx` |
| CA-10 | K-6, K-7 | **Dado** um membro de A e B, **quando** chama `empresa_ativa_definir` com B, **então** `minha_empresa` passa a devolver `empresa_ativa_id = B`, inclusive numa sessão nova. | Deno `tests/supabase/functions/api_tenant_test.ts` |
| CA-11 | K-7 | **Dado** um membro só de A, **quando** chama `empresa_ativa_definir` com B, **então** 403 e a preferência não muda. | Deno `api_tenant_test.ts` |
| CA-12 | K-7 | **Dado** a preferência gravada em B e o vínculo com B desligado depois, **quando** chama `minha_empresa`, **então** `empresa_ativa_id` é nulo. | Deno `api_tenant_test.ts` |
| CA-13 | K-5, K-7 | **Dado** o desenvolvedor e uma empresa desativada, **quando** abre o seletor, **então** vê a empresa com a marca "desativada" e consegue escolhê-la. | Deno `api_tenant_test.ts` + vitest `tenant-seletor.test.tsx` |
| CA-14 | K-6 | **Dado** a tabela `usuario_preferencias`, **quando** `anon` ou `authenticated` tenta ler ou gravar, **então** recebe erro de permissão. | SQL `supabase/tests/usuario_preferencias_check.sql` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 `_shared/tenant.ts` | `/spec`; leitura da 0017 | `/implement` (backend) | Deno CA-2 a CA-6 | `revisor-seguranca` (obrigatório: muda autorização) + `revisor-codigo` | skill `verificar-producao` (as 5 funções respondendo; nenhum 409 novo nos logs) |
| K-2 as 5 funções | `/spec` | `/implement` (backend) | Deno CA-1, CA-2 | `revisor-seguranca` + `revisor-codigo` | `verificar-producao` |
| K-3 `TenantContext` | sessão orquestradora | agente `frontend-dashboard` | vitest CA-7 | `revisor-codigo` (pelo orquestrador) + `ux-ui-licitagym` | skill `deploy-dashboard` |
| K-4 `invokeEdge` | sessão orquestradora | `frontend-dashboard` | vitest CA-8 | `revisor-seguranca` (o tenant sai do cliente; a API decide) + `revisor-codigo` | `deploy-dashboard` |
| K-5 seletor no shell | `ux-ui-licitagym` (desenho do seletor, claro, escuro e celular) | `frontend-dashboard` | vitest CA-8, CA-9, CA-13; skill `run-dashboard` com 1 e 2 empresas no demo | `ux-ui-licitagym` + `revisor-codigo` | `deploy-dashboard` |
| K-6 migration `usuario_preferencias` | skill `nova-migration` | `/implement` (backend) | SQL CA-14 | `revisor-migration` + `revisor-seguranca` (ACL) | skill `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-7 `empresa_ativa_definir` e `minha_empresa` | `/spec`; leitura da 0017 | `/implement` (backend) | Deno CA-10 a CA-13 | `revisor-seguranca` + `revisor-codigo` | `verificar-producao` |
| Fechamento | — | — | — | — | skill `ciclo-janelas` |

Ordem: PR do backend (K-1, K-2) mergeado e publicado → PR do Dashboard (K-3 a K-5). O backend aceita `tenant_id`
opcional, então o front atual continua funcionando entre os dois merges.

## Fora de escopo

- Criar a segunda empresa (é a `api-tenant` `empresa_criar`, que já existe).
- Convite por e-mail e permissões finas (spec própria: item 7 de `BACKEND-CONFIGURACOES.md`).
- `tenant_id` em `catalogo_empresa_catmat` e nos termos de escopo (spec própria: item 6).
- Marca e white-label por tenant.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_usuario_preferencias.sql` (aditiva, idempotente, tabela nova).
- **Tabelas/views/funções tocadas:** leitura de `tenant_membros` e `tenants` (como hoje); `usuario_preferencias` (nova),
  lida e gravada só pela `api-tenant`.
- **ACL/RLS:** tabela nova com RLS ligada, `revoke all` de `anon`/`authenticated`, grant só a `service_role`.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas (é a regra do repositório). As que mudam são `_shared/tenant.ts`, `api-pipeline`,
  `api-tarefas`, `api-agentes`, `api-dashboard-oportunidades` e `api-catalogo-ficha`.
- **Contrato com o Dashboard:** muda, de forma aditiva (`tenant_id` opcional). O backend vai antes.
- **Dado oficial x derivado:** o nome da empresa vem de `tenants.nome`; nada fixo no código.

## Decisões do Marcelo

- 20/10: produto multi-tenant, configurado por metadados (`ESCOPO.md`).
- 20/10: a empresa escolhida fica gravada no servidor (K-6, K-7).
- 20/10: no MVP o desenvolvedor vê todas as empresas no seletor, inclusive as desativadas (CA-13).

## Perguntas em aberto

- Nenhuma.

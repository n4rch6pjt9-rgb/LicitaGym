# 0017: Cadastrar a empresa (tenant) e seus usuários de ponta a ponta

- **Status:** rascunho (10/10/2026; decisões 1–3 do Marcelo registradas em "Decisões")
- **Issue:** Dashboard #29 (mãe), LicitaGym #248 (backend da fase A, fechada), Dashboard #68 (tela da fase A, aberta).
  Desbloqueia #249, #250, #251 (portão), #252 (tarefas), #253/#69 (documentos), #254/#70 (produtos), #255 (pipelines).
- **Área:** edge-functions (nova `api-tenant`), migrations (pequena, ver Impacto em dados), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Cria a primeira escrita de cadastro de empresa e usuário em produção, usa fonte externa
  (CNPJ) e define quem é admin da Konnen.

## Problema

O pedido do Marcelo em 10/10: "analise o que diz a 29 e diga o que falta para fechar; é o processo de criação do tenant;
sem ele nada funciona". Medição em produção, só leitura, 10/10/2026:

| O quê | Produção hoje |
|---|---|
| `tenants` | 1 linha: `konnen`, `tipo = cliente`, `ativo = true`, **`cnpj` nulo** |
| `tenant_membros` | **0 linhas**: nenhum usuário ligado a empresa nenhuma |
| `tenant_dados_restritos` | 0 linhas |
| `auth.users` | 3 usuários, 1 com `app_metadata.licitagym_role = admin` (o desenvolvedor) |
| `pipeline_etapas` | 13 do tenant 1 (as padrão) |
| `pipeline_oportunidades` / `pipeline_historico` | 0 / 0 |
| `tenant_documentos` | 0 (`documento_tipos` tem 18) |
| `catalogo_precos` / `catalogo_produtos` | 0 / 0 |

O que já existe no banco (main):
- `tenants` (drift versionado em `20261002220000`), `tenant_membros` e `tenant_dados_restritos` (`20261007223000`, PR #261),
  `tenant_papel()`;
- a escrita do primeiro vínculo pelo desenvolvedor (`20261008140000_tenant_desenvolvedor`: policies para
  `licitagym_desenvolvedor()`), `tenant_documentos` + bucket `tenant-documentos` (`20261008030000`, PR #264).

O que falta, e por que "nada funciona" sem isto:
1. **Não existe caminho para criar ou editar uma empresa nem seus usuários.** Nenhuma Edge Function escreve em `tenants`
   ou `tenant_membros`; o Dashboard só chama Edge Function (`supabase.functions.invoke`), então as policies de RLS
   abertas para o desenvolvedor não têm quem as use. A Konnen nasceu por drift, sem CNPJ.
2. **Sem membro, o tenant é adivinhado.** `api-pipeline` (`repo.ts`, `tenantDoUsuario`) cai no "único tenant ativo". Isso
   funciona só enquanto houver uma empresa. O tenant de simulação da #251 (segundo tenant ativo) faria todo usuário sem
   vínculo receber 409, inclusive a Konnen.
3. **Tudo o que vem depois pede usuário ligado à empresa:** a decisão humana que abre o portão (`decidido_por`, #249/#250,
   PR #308 em draft), documentos anexados pelo membro (#69), preço visível a OPERAÇÃO e custo só ADMIN (#254/#70),
   tarefas com responsável (#252), quadro por esfera por tenant (#255).

### O que a Dashboard #29 pede e o que falta para fechá-la

Critério literal da #29: (1) ok do Marcelo para retomar, (2) PR no Dashboard, (3) "Enviar para pipeline" leva a
oportunidade à etapa inicial e remover em massa tira várias de uma vez.

| Critério | Estado |
|---|---|
| Ok para retomar | cumprido (comentário de 04/10) |
| Backend do pipeline | na main e publicado: PR #231 (`pipeline_*`, `api-pipeline`) e PR #261 (`tenant_membros`) |
| PR do Dashboard | **não existe**. Hoje o Kanban (`PipelineKanbanView.tsx`) lista todas as oportunidades, o provider fixa `'Sem estágio'` e `mapProviderCrmStage` troca por `'Em análise'`: toda oportunidade aparece no pipeline, e mover é só estado local. Nenhuma chamada a `api-pipeline` |
| "Enviar para pipeline" e remoção em massa | **não existem** no front |

Ou seja: a #29 em si fecha só com o PR do front sobre o backend que já está publicado; o pipeline da Konnen funciona hoje
pelo fallback de tenant único. As fases A–J (comentário de 08/10) são filhas e "não entram no critério atual da #29". O
cadastro do tenant (esta spec) é o que tira o pipeline do fallback e destrava as fases B–J e o portão.

## Desenho

### Edge Function `api-tenant` (nova)

`POST`, JWT do Supabase Auth no `Authorization` validado no código (`verify_jwt = false`, como `api-pipeline`). Banco com
`service_role`; a função confere o papel antes de cada escrita. `user_metadata` nunca decide papel.

Quem é quem:
- **desenvolvedor**: `app_metadata.licitagym_role = 'admin'` (`licitagym_desenvolvedor()`). Cria empresa e o primeiro admin
  e age como admin em **qualquer** empresa (decisão de 10/10), como já fazem as policies de `20261008140000`.
- **admin da empresa**: `tenant_membros.papel = 'admin'`, ativo. Edita a empresa, usuários e dados bancários.
- **operação**: `tenant_membros.papel = 'operacao'`. Lê a empresa e a lista de usuários; não lê dados bancários.

| action | quem | efeito |
|---|---|---|
| `minha_empresa` | autenticado | empresa(s) do usuário e o papel; sem vínculo, `{ empresas: [] }` (o front mostra "sem empresa") |
| `cnpj_consultar` | desenvolvedor ou admin | consulta o CNPJ na BrasilAPI (`GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}`) e devolve razão social, nome fantasia, situação cadastral, data da situação, CNAE principal e secundários, endereço, com `fonte` e `consultado_em`. Não grava. DV inválido (mod-11) → 400 sem chamar a fonte |
| `empresa_criar` | desenvolvedor | cria `tenants` com `slug`, `nome`, `cnpj`, `tipo`. Situação cadastral diferente de ATIVA → 400. CNPJ já cadastrado → 409. Grava o primeiro admin (`user_id` existente em `auth.users`) na mesma transação |
| `empresa_atualizar` | admin ou desenvolvedor | `nome` e `cnpj` (CNPJ novo passa pela mesma consulta); `ativo` só desenvolvedor |
| `membros_listar` | membro | `user_id`, e-mail, papel, ativo |
| `membro_adicionar` | admin ou desenvolvedor | liga um usuário existente em `auth.users` (por e-mail) com papel; e-mail sem conta → 404 nomeando a ausência. Não cria conta nem convida (decisão de 10/10) |
| `membro_atualizar` | admin ou desenvolvedor | muda papel ou desativa. Recusa (400) tirar o último admin ativo da empresa |
| `dados_restritos_obter` / `dados_restritos_salvar` | admin ou desenvolvedor | banco, agência, conta. OPERAÇÃO → 403 |

### Hidratar a Konnen

Primeiro uso da função, feito pelo desenvolvedor na tela (não por migration, porque o CNPJ e o admin são decisão do
Marcelo): `empresa_atualizar` com o CNPJ da Konnen conferido na fonte, e `membro_adicionar` dos usuários com o papel de
cada um. Depois disso, `api-pipeline` resolve a Konnen pelo vínculo, não pelo fallback.

### Tela (Dashboard #68)

Aba Empresa: busca de CNPJ, dados da fonte só leitura com fonte e data da consulta, situação não ATIVA bloqueia.
Usuários: admin vê e edita; operação vê a lista e não vê banco. A tela é o PR do Dashboard; o backend vai ao ar antes.

### Ordem dos PRs

1. **LicitaGym:** `api-tenant` + testes Deno + check SQL (este desenho). Migration só se as Perguntas pedirem (unicidade
   de CNPJ, auditoria).
2. **Dashboard #68:** aba Empresa e usuários.
3. **Operação, com o Marcelo:** hidratar a Konnen (CNPJ e membros) pela tela.
4. **Dashboard #29:** PR do front do pipeline (Kanban lendo `api-pipeline`, "Enviar para pipeline", "Mover para…",
   remoção em massa, fim do fallback `'Em análise'`). Independe de 1–3 para funcionar com a Konnen, mas só deve ir ao ar
   depois de 3 para não gravar `adicionada_por` de usuário sem vínculo.
5. Só então: tenant de simulação (#251) e portão (#249/#250, PR #308).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um usuário autenticado sem vínculo, **quando** chama `minha_empresa`, **então** 200 com `empresas: []`. | Deno `tests/supabase/functions/api_tenant_test.ts` |
| CA-2 | **Dado** um usuário ligado à Konnen como operação, **quando** chama `minha_empresa`, **então** recebe a Konnen com `papel = operacao`. | Deno `api_tenant_test.ts` |
| CA-3 | **Dado** um CNPJ com DV inválido, **quando** `cnpj_consultar`, **então** 400 e a fonte externa não é chamada (cliente falso conta 0 chamadas). | Deno `api_tenant_test.ts` |
| CA-4 | **Dado** a fonte devolvendo situação `BAIXADA`, **quando** o desenvolvedor chama `empresa_criar`, **então** 400 e nenhuma linha em `tenants`. | Deno `api_tenant_test.ts` |
| CA-5 | **Dado** um usuário sem `licitagym_role = admin`, **quando** chama `empresa_criar`, **então** 403. `user_metadata.licitagym_role = admin` também → 403. | Deno `api_tenant_test.ts` |
| CA-6 | **Dado** CNPJ já cadastrado em `tenants`, **quando** `empresa_criar`, **então** 409. | Deno `api_tenant_test.ts` |
| CA-7 | **Dado** o desenvolvedor, **quando** `empresa_criar` com o primeiro admin, **então** existem a linha em `tenants` e a linha em `tenant_membros` com `papel = admin`, ou nenhuma das duas (falha no meio não deixa empresa sem admin). | Deno `api_tenant_test.ts` (repo falso que falha no 2º insert) |
| CA-8 | **Dado** um admin da empresa X, **quando** `membro_adicionar` na empresa Y, **então** 403. | Deno `api_tenant_test.ts` |
| CA-9 | **Dado** a empresa com um só admin ativo, **quando** `membro_atualizar` o rebaixa ou desativa, **então** 400. | Deno `api_tenant_test.ts` |
| CA-10 | **Dado** um membro operação, **quando** `dados_restritos_obter`, **então** 403; admin recebe banco/agência/conta. | Deno `api_tenant_test.ts` |
| CA-11 | **Dado** e-mail sem conta em `auth.users`, **quando** `membro_adicionar`, **então** 404 com motivo nomeado, sem criar usuário. | Deno `api_tenant_test.ts` |
| CA-12 | **Dado** dois tenants ativos e um usuário ligado à Konnen, **quando** chama `api-pipeline` `etapas_listar`, **então** recebe as etapas da Konnen (regressão do 409 da #248). | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-13 | **Dado** `anon` e `authenticated` sem vínculo, **quando** leem `tenants`, `tenant_membros` e `tenant_dados_restritos` por REST, **então** 0 linhas / permissão negada. | SQL `supabase/tests/tenant_membros_check.sql` (estender) |
| CA-14 | **Dado** a consulta de CNPJ, **quando** o log é escrito, **então** não contém banco/agência/conta nem o JWT. | Deno `api_tenant_test.ts` (captura de log) |
| CA-15 | **Dado** o desenvolvedor sem linha em `tenant_membros`, **quando** chama `membro_adicionar` e `dados_restritos_obter` na Konnen, **então** 200 nos dois (decisão 3). | Deno `api_tenant_test.ts` |
| CA-16 | **Dado** a BrasilAPI respondendo 429 e depois 200, **quando** `cnpj_consultar`, **então** 200 após nova tentativa; 404 da fonte devolve 404 "CNPJ não encontrado na fonte" sem nova tentativa. | Deno `api_tenant_test.ts` (fetch falso) |

## Fora de escopo

- Tela do pipeline (Dashboard #29, passo 4 acima): PR próprio no Dashboard sobre o backend já publicado.
- Portão, decisão humana e recomendação (#249/#250, PR #308), simulação (#251).
- Documentos (#253/#69), produtos e preços (#254/#70), escopo CNAE (#256), pipelines por esfera (#255), tarefas (#252).
- Cadastro self-service de empresa por qualquer usuário (hoje só o desenvolvedor cria empresa).
- Convite por e-mail e criação de conta (decisão 2).
- Botão "indexar e analisar" por oportunidade (pedido de 10/10): spec própria depois desta, porque precisa da fila e dos
  agentes (PR #307) e da decisão sobre score × recomendação.

## Impacto em dados

- **Migration:** a decidir nas Perguntas. Candidata, aditiva e idempotente: índice único parcial em
  `tenants (cnpj) where cnpj is not null` (conferir antes que não há duplicado; hoje há 1 linha com `cnpj` nulo).
- **Tabelas tocadas:** `tenants`, `tenant_membros`, `tenant_dados_restritos` (escrita pela `api-tenant` com
  `service_role`); leitura de `auth.users` por e-mail (Admin API do Auth, só na função).
- **ACL/RLS:** nenhum grant novo. As policies existentes continuam; a função é o único caminho do Dashboard.
- **Backfill:** não. A hidratação da Konnen é operação na tela, com o Marcelo.
- **Edge Functions republicadas no merge:** todas (integração Supabase ↔ GitHub); nova `api-tenant` com
  `verify_jwt = false` em `supabase/config.toml`.
- **Contrato com o Dashboard:** novo (`api-tenant`). `api-pipeline` inalterada.
- **Dado oficial x derivado:** razão social, situação, CNAE e endereço vêm da fonte de CNPJ com `fonte` e `consultado_em`;
  nada é preenchido sem a fonte. `nome` do tenant pode ser o nome fantasia escolhido pelo admin.

## Decisões

Do Marcelo, 10/10/2026:
1. **Fonte do CNPJ: BrasilAPI** (`/api/cnpj/v1/{cnpj}`). Mesma fonte prevista na entrega 2 da spec 0008; o cliente HTTP
   pode ser compartilhado quando aquela entrega existir.
   - Proposta de configuração, a confirmar no PR: timeout de 10 s; até 2 novas tentativas com backoff exponencial e jitter
     em 429/5xx/timeout, respeitando `Retry-After`; 404 é "CNPJ não encontrado na fonte", sem nova tentativa.
   - Sem cache gravado: a consulta é feita na hora do cadastro, e o que for gravado leva `fonte` e `consultado_em`.
2. **Só quem já tem conta.** `membro_adicionar` liga usuário existente em `auth.users`. Sem convite por e-mail e sem
   criação de conta pela função (CA-11).
3. **Desenvolvedor em qualquer empresa.** `licitagym_role = admin` cria empresa e age como admin em qualquer tenant
   (ler, editar empresa, membros e dados restritos). Continua sem usar `user_metadata` (CA-5).

## Perguntas em aberto

1. **CNPJ da Konnen** e **papel de cada um dos 3 usuários** de `auth.users`. Não bloqueia o código: é a hidratação feita
   pela tela, com o Marcelo (passo 3 da ordem dos PRs).
2. **Índice único de CNPJ** em `tenants` (migration pequena, aditiva) agora ou depois? Sem ele, a unicidade fica só na
   `api-tenant` (CA-6), sujeita a corrida entre duas criações simultâneas.
3. **Auditoria:** registrar quem criou/alterou empresa e membro (`updated_by` já existe em `tenant_dados_restritos`;
   `tenants` e `tenant_membros` não têm). Precisa de coluna nova?

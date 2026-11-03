# 0022: Filtrar por empresa a leitura direta do catálogo do tenant

- **Status:** em implementação
- **Issue:** #358
- **Área:** migrations
- **Depende do ok do Marcelo:** sim (migration, mudança de RLS em tabela de tenant; opção "filtrar" escolhida por ele em 14/10/2026)

## Problema

Qualquer usuário logado lê, pelo PostgREST, o catálogo de produtos de **todas** as empresas. Medido em produção em
14/10/2026 (MCP somente leitura, `pg_policy` e `has_table_privilege`):

- `catalogo_produtos`: policy `catprod_select` (`for select to authenticated using (true)`, migration
  `20260926160000`) e `authenticated` com SELECT. 3 produtos, 1 empresa, 0 linhas com `tenant_id` nulo.
- `catalogo_produto_atributos`: policy `catalogo_produto_atributos_select` (`using (true)`, migration
  `20261011100600`) e `authenticated` com SELECT. 2 linhas, mesma empresa. A tabela não tem `tenant_id`; a empresa
  vem do produto (`produto_id`).
- `tenant_membros`: 5 vínculos ativos, 1 empresa.

Hoje nenhum cliente lê essas tabelas direto: o Dashboard não cita nenhuma das duas (busca no repositório
`Dashboard---LicitaGym`, 0 ocorrências em 14/10) e usa a `api-catalogo-ficha` (`gravar` e `listar`, #356/#359), que
filtra pela empresa de quem chama com `service_role`. O isolamento existe só na função. A tabela
`catalogo_produto_atributos` guarda só característica técnica (sem preço); `catalogo_produtos` tem código, nome, URL,
taxonomia e `atributos`. Padrão já usado nas outras tabelas de tenant: `tenant_documentos` usa
`tenant_papel(tenant_id) is not null` (migração `20261008030000`); `catalogo_precos` e `catalogo_de_para` não dão
SELECT a `authenticated`.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova (resultado em 14/10/2026) |
|---|---|---|
| CA-1 | **Dado** um produto com `tenant_id = T` e um usuário com vínculo ativo em T (`auth.uid()` substituído no teste e `tenant_membros` com `ativo = true`, empresa `tenants.ativo = true`), **quando** `set local role authenticated` e `select` em `catalogo_produtos`, **então** a linha do produto aparece. | SQL `supabase/tests/catalogo_rls_tenant_check.sql` (fixtures em `begin … rollback`, `auth.uid()` redefinido dentro da transação): passa |
| CA-2 | **Dado** o mesmo produto, **quando** o papel `authenticated` sem vínculo em T lê `catalogo_produtos` (`auth.uid()` nulo, como o stub de `pre.sql`, ou vínculo só em outra empresa U), **então** 0 linhas. | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |
| CA-3 | **Dado** um atributo de produto da empresa T, **quando** `authenticated` com vínculo em U lê `catalogo_produto_atributos`, **então** 0 linhas; com vínculo em T, 1 linha. | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |
| CA-4 | **Dado** vínculo em T com `tenant_membros.ativo = false`, ou empresa `tenants.ativo = false`, **quando** `authenticated` lê as duas tabelas, **então** 0 linhas (mesma regra da `tenant_papel`, #263). | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |
| CA-5 | **Dado** `anon`, **quando** tenta `select` nas duas tabelas, **então** `has_table_privilege` é falso (nenhum grant) e não há policy para `anon`. | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |
| CA-6 | **Dado** a migration aplicada duas vezes, **então** a segunda aplicação termina sem erro e as policies `catprod_select` e `catalogo_produto_atributos_select` existem uma vez cada, com a expressão nova (sem `true`, sem `user_metadata`). | `scripts/validar-migrations.sh` (reaplicação: `ok 2a vez`) + SQL `supabase/tests/catalogo_rls_tenant_check.sql` (`pg_policy`): passa |
| CA-7 | **Dado** a `api-catalogo-ficha` com `service_role`, **quando** `action: "listar"` e `action: "gravar"` rodam, **então** o comportamento dos testes atuais não muda (`service_role` ignora RLS). | Deno `tests/supabase/functions/api_catalogo_ficha_test.ts` (suite existente): passa |
| CA-8 | **Dado** um produto com `tenant_id` nulo (catálogo de fabricantes) e seus atributos, **quando** `authenticated` sem vínculo algum lê as duas tabelas, **então** o produto e os atributos aparecem (decisão do Marcelo em 14/10: liberado). | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |
| CA-9 | **Dado** um usuário desenvolvedor (`licitagym_desenvolvedor()` verdadeiro, `app_metadata.licitagym_role = 'admin'`, `auth.jwt()` redefinido no teste) sem vínculo em T, **quando** lê as duas tabelas, **então** vê o produto de T e seus atributos (decisão do Marcelo em 14/10: lê tudo). | SQL `supabase/tests/catalogo_rls_tenant_check.sql`: passa |

## Fora de escopo

- `catalogo_documentos` e `catalogo_chunks` (catálogo de fabricantes, sem `tenant_id`): continuam `using (true)`.
  Se o Marcelo quiser fechá-las, issue própria.
- Policies de escrita para `authenticated`: não existem hoje e não entram; a escrita segue só pela Edge Function.
- `catalogo_precos` e `catalogo_de_para`: já sem SELECT para `authenticated` (medido em 14/10); nada muda.
- Ligar o Dashboard à leitura direta: a tela `/catalogo` continua pela `api-catalogo-ficha`.
- Backfill de `tenant_id` nulo: hoje 0 linhas; produto sem empresa continua visível a todo logado (CA-8).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/20261014150000_catalogo_rls_tenant.sql`, aditiva (só `drop policy if exists`
  + `create policy` nas duas tabelas), idempotente, sem alteração de grant (SELECT de `authenticated` fica, a policy
  é quem filtra). Timestamp maior que `20261013210000`.
- **Tabelas/views/funções tocadas:** `catalogo_produtos` (lê: `api-catalogo-ficha` com service_role,
  `coletor/catalogos.py` com service_role; escreve: os mesmos), `catalogo_produto_atributos` (lê/escreve:
  `api-catalogo-ficha`). Reutiliza `public.tenant_papel(bigint)` (security definer, `search_path` fixo); nenhuma
  função nova.
- **ACL/RLS:** `catprod_select` passa a
  `using (tenant_id is null or tenant_papel(tenant_id) is not null or licitagym_desenvolvedor())`;
  `catalogo_produto_atributos_select` passa a
  `using (exists (select 1 from public.catalogo_produtos p where p.id = produto_id and (p.tenant_id is null or tenant_papel(p.tenant_id) is not null or licitagym_desenvolvedor())))`.
  A subconsulta em `catalogo_produtos` roda como o papel corrente e, portanto, sob `catprod_select`: o resultado é o
  mesmo (quem vê o produto vê os atributos), e a expressão explícita deixa a regra legível sem depender disso.
  Grants inalterados. Atualizar `supabase/tests/sistema_s_catalogos_acl_check.sql` e
  `supabase/tests/aderencia_tecnica_check.sql` só se eles asserirem a expressão antiga (hoje conferem grants e
  existência; conferir no `/implement`).
- **Backfill/reprocessamento:** não. Contagem antes/depois no PR: linhas visíveis a `authenticated` sem vínculo
  (hoje 3 e 2; esperado 0 e 0).
- **Edge Functions republicadas no merge:** todas (integração), sem mudança de código.
- **Contrato com o Dashboard:** inalterado (`api-catalogo-ficha` segue igual).
- **Dado oficial x derivado:** nenhum dado novo; só controle de acesso.
- **Branch Supabase:** não (decisão do Marcelo em 14/10). A migration é só `create policy`, sem DDL destrutivo nem
  backfill; o portão `validar-migrations.sh` prova os CAs.

## Perguntas em aberto

Nenhuma. Respondidas em 14/10/2026 pelo Marcelo: produto sem `tenant_id` fica liberado a todo logado (CA-8);
desenvolvedor lê tudo (CA-9); sem branch Supabase; nenhuma outra janela edita `catalogo_produtos`, as policies ou
`tenant_papel` neste momento (o catálogo do tenant é a base futura de preço/desconto, histórico, folder por certame
e de-para contra o CATMAT; `catalogo_precos` e `catalogo_de_para` já estão fechadas a `authenticated`). Spec
aprovada em 14/10/2026.

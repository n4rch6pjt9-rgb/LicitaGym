# 0005: Deixar os grants de tabela, view, matview e sequência iguais às migrations

- **Status:** em implementação
- **Issue:** nenhuma. Achado de 09/10, depois do #278.
- **Área:** migrations (ACL), checks SQL
- **Depende do ok do Marcelo:** sim. O PR foi pedido em 09/10 ("Sim, abra o PR"). O **merge** aplica a migration em
  produção.

## Problema

Medição só de leitura em produção, em 09/10/2026, com `has_table_privilege` e `has_sequence_privilege`:

- Quase todas as relações de `public` e `private` dão SELECT, INSERT, UPDATE e DELETE a `anon` e `authenticated`,
  com grantor `postgres`. Isso dá cerca de 330 pares relação × papel com algum privilégio.
- Num banco limpo, gerado só pelas migrations, `anon` não tem nenhum grant de tabela, view ou matview, e
  `authenticated` tem 88 pares (sequências incluídas).
- A medição anterior ("0 grants") usava `information_schema.role_table_grants`, que só lista o que o papel do MCP
  enxerga. Estava errada.
- **Exposição real:**
  - `private` não é acessível, porque `anon` e `authenticated` não têm USAGE no schema;
  - as tabelas de `public` têm todas RLS, e nenhuma policy `true` vale para `anon`;
  - as views são todas `security_invoker`;
  - **o que vazava eram as 2 materialized views, `catmat_item_completo` e `mv_escopo_demanda`, que não têm RLS:
    qualquer pessoa com a chave publishable conseguia ler.** O advisor `materialized_view_in_api` aponta as duas.
- Os default privileges de `postgres` em `public` dão `arwd` a `anon` e `authenticated` em toda tabela, sequência e
  função nova. Isso também vale no stub `pre.sql`.
- **Origem provável:** o painel do Supabase (Data API, "Exposed tables" e exposição automática).

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** grants `arwd` a `anon` e `authenticated` em todas as relações de `public` e `private` (a simulação de produção), **quando** a migration roda, **então** só sobram os 88 pares intencionais. | `tabelas_acl_check.sql` falha antes (1.997 falhas, com MAINTAIN e grant por coluna na simulação) e passa depois (1.317 revogados) |
| CA-2 | Nenhuma materialized view continua legível por `anon`. | `tabelas_acl_check.sql`, bloco 3 |
| CA-3 | `authenticated` mantém os grants intencionais: as tabelas com policy de leitura e as tabelas de tenant, com as policies `*_desenvolvedor` para o admin. `service_role` não muda. | `tabelas_acl_check.sql`, bloco 2, e a simulação |
| CA-4 | Uma tabela nova criada por `postgres` em `public` não nasce aberta a `anon` nem a `authenticated` (default privileges). | `tabelas_acl_check.sql`, bloco 4, e a simulação |
| CA-5 | Reaplicar a migration não muda nada: "0 privilégios revogados". | `validar-migrations.sh`, na segunda aplicação |
| CA-6 | **Dado** um privilégio que o REVOKE não remove (por exemplo, herdado de PUBLIC), **então** a migration aborta pela pós-checagem. | Simulação com `grant ... to public` |
| CA-7 | Grants por coluna fora da lista e o MAINTAIN do PG17 também são revogados e conferidos. Em produção, 33 relações tinham MAINTAIN para `authenticated` e nenhuma tinha grant por coluna. | Simulação com `grant select (col)` e `grant maintain` |

## Fora de escopo

- **Endurecer a lista intencional.** Cerca de 35 tabelas de dados oficiais dão a `authenticated` também INSERT, UPDATE,
  DELETE, TRUNCATE, REFERENCES e TRIGGER, que vêm dos default privileges do stub e não de uma decisão.
  - A RLS só permite SELECT, e o PostgREST não emite TRUNCATE. Mesmo assim, o certo é deixar só SELECT.
  - Também ficam para depois as sequências abertas a `anon`, que vêm da mesma origem.
  - Os dois pontos vão para uma issue própria.

- Policies de RLS. O acesso do admin/dev fora de vínculo com tenant em `tenant_documentos` e no storage
  `tenant-documentos` hoje não existe (não há policy `_desenvolvedor`). Isso fica para um PR próprio.
- Os default privileges de `supabase_admin`, que `postgres` não consegue alterar.
- O EXECUTE que toda função nova herda de PUBLIC (padrão global do Postgres).
  - `alter default privileges ... in schema public revoke execute on functions from public` não tem efeito: o default
    por schema só soma ao global (testado no PG17).
  - O revoke global (`for role postgres`, sem schema) vale para extensão criada depois: no teste, as 118 funções do
    pgvector instalado num schema novo perderam o EXECUTE de PUBLIC. Isso quebraria a mudança do `vector` para
    `extensions`.
  - Quem barra função nova aberta é `funcoes_acl_check.sql`, bloco 1, que roda na CI (`has_function_privilege`
    inclui PUBLIC). A convenção continua: a migration que cria função faz `revoke all ... from public`.
- A migração da API para o schema `api`.

## Impacto em dados

- **Migration:** `supabase/migrations/20261009130000_tabelas_acl_drift.sql`. Só faz REVOKE e
  `alter default privileges`. É idempotente.
- **Clientes:**
  - O Dashboard não lê tabelas diretamente; tudo passa pelas Edge Functions com `service_role`.
  - As Edge Functions com JWT do usuário (`api-pncp-*`, `analyze-public-material`) leem tabelas e views que estão
    na lista intencional de `authenticated`.
  - O coletor Python e o Kuib-Harness usam `service_role`.
- **Backfill:** não. **Contrato com o Dashboard:** não muda.

## Perguntas em aberto

Nenhuma.

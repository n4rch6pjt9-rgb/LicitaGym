# 0002: Corrigir o CNPJ válido, a idempotência e a precedência manual do resolvedor de marcas

- **Status:** em implementação
- **Issue:** #262 (P1). Follow-up de #148, #228, #235, #236 e #241.
- **Área:** migrations (marcas), checks SQL
- **Depende do ok do Marcelo:** sim. Implementação autorizada em 09/10 ("Implemente"). O **merge** aplica a migration
  em produção e precisa de um ok próprio.

## Problema

`private.cnpj_valido` (migration `20261005160000`, md5 da definição em produção `8facd335…`) calcula os dígitos
verificadores sobre os dígitos 1–8 e 1–9 e compara com as posições 9 e 10. O certo seria calcular sobre os 12 e os 13
primeiros dígitos e comparar com as posições 13 e 14. Também falta um `search_path` fixo, apontado pelo advisor
`function_search_path_mutable`.

Medição só de leitura em produção, em 09/10/2026, com as duas fórmulas replicadas em SQL:
- **CNPJs:** dos 2.706 CNPJs de 14 dígitos em `precos_praticados_itens`, a função atual aceita 102 e a correta aceita
  2.706. Nenhum CNPJ inválido é aceito pela função atual.
- **Vendas:** o número de vendas com data cujo CNPJ é aceito passa de 1.133 para 25.459 (de 25.465 linhas no total).
- **Ranking:** a #262 mediu em 08/10 que `v_marca_ocorrencias` tem 917 linhas com `entra_ranking = true`, e que seriam
  18.495 com a fórmula correta.

Há mais dois pontos, que estavam no #236 revertido (falhou em produção com `42P13`, porque mudava o nome dos
parâmetros):
- `private.marca_normalizar` colapsa a frase repetida uma vez só. Com 4 repetições, normalizar duas vezes dá resultado
  diferente de normalizar uma vez.
- No `private.marca_resolver`, um alias manual curto perde para um alias de semente mais longo, porque a ordenação usa
  `tamanho desc` antes de `manual desc`.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um CNPJ com os dígitos verificadores do módulo 11 corretos (`11222333000181`, `12345678000195`, `08973569000145`, com ou sem máscara), **quando** `private.cnpj_valido` roda, **então** devolve `true`. | SQL `marcas_resolvedor_acl_check.sql`, bloco 7 |
| CA-2 | **Dado** um DV errado (`11222333000180`, `12345678000190`), 14 dígitos iguais (`00000000000000`, `11111111111111`), menos de 14 dígitos, `''` ou `NULL`, **quando** a função roda, **então** devolve `false` sem erro. | SQL `marcas_resolvedor_acl_check.sql`, bloco 7 |
| CA-3 | **Dado** `private.cnpj_valido`, **então** ela tem `search_path` fixo, EXECUTE só para `service_role`, owner `postgres` e o mesmo parâmetro `cnpj_bruto`. | SQL `advisors_warn_security_check.sql` (sai de `pendentes.txt`) + bloco 7 |
| CA-4 | **Dado** `'FUNDIBAN FUNDIBAN FUNDIBAN FUNDIBAN'`, **quando** normaliza, **então** dá `'FUNDIBAN'`. Para toda entrada do bloco 6, `marca_normalizar(marca_normalizar(x)) = marca_normalizar(x)`. | SQL `marcas_resolvedor_acl_check.sql`, bloco 8 |
| CA-5 | **Dado** um alias regex de semente mais longo (`^ZZPRE TEXTO`) e um manual mais curto (`^ZZPRE`) que casam com a mesma marca, **quando** resolve, **então** vence o manual. | SQL `marcas_resolvedor_views_check.sql`, caso P |
| CA-6 | **Dado** venda de CNPJ válido, **então** `entra_ranking = true`. **Dado** `00000000000000` ou DV errado, **então** `ni_tipo = 'cnpj'` e `entra_ranking = false`. | SQL `marcas_resolvedor_views_check.sql`, casos A, N e O |
| CA-7 | **Dada** a migration aplicada sobre o schema atual, **então** as linhas existentes de `marca_aliases` continuam passando nos CHECKs `marca_norm` e `valor` (pós-checagem dentro da migration). Reaplicar a migration não muda nada (idempotência). | `validar-migrations.sh` (2ª aplicação) + pós-checagem |
| CA-8 | **Dada** uma assinatura diferente da de produção (parâmetro renomeado), **então** a migration aborta antes de qualquer `create or replace`, com mensagem clara, e não com `42P13` no meio. | Pré-checagem na migration; reprodução do `42P13` registrada no PR |

## Fora de escopo

- Repetição em número ímpar (`ZZQ ZZQ ZZQ`), que vai para outro PR, conforme a #262.
- Recalcular ou materializar o ranking. As views são lidas na hora e passam a usar a função nova sem backfill.
- `v_fornecedor_marcas*` e o Dashboard: o contrato não muda, só aumentam as linhas elegíveis.

## Impacto em dados

- **Migration:** `supabase/migrations/20261009030000_marcas_cnpj_valido_mod11.sql`. É aditiva: só `create or replace`
  de 3 funções, com as mesmas assinaturas, o mesmo owner e os mesmos grants. É idempotente e tem `lock_timeout`.
- **Funções:** `private.cnpj_valido(text)`, `private.marca_normalizar(text)` e `private.marca_resolver(text,text)`.
  Dependem delas `v_marca_ocorrencias`, `v_fornecedor_marcas_ranking`, `v_fornecedor_marcas`,
  `v_marca_aliases_pendentes` e os 2 CHECKs de `marca_aliases`.
- **ACL/RLS:** não muda. EXECUTE continua só para `service_role`.
- **Backfill:** não. A medição de antes e depois está no Problema; `marca_normalizar` muda 0 das 25.465 marcas, pela
  medição da #262.
- **Edge Functions:** nenhuma muda. Todas são republicadas pela integração no merge.
- **Contrato com o Dashboard:** não muda. O ranking de marcas passa a ter mais fornecedores.
- **Dado oficial x derivado:** o CNPJ vem da fonte oficial (Compras.gov). A validade é derivada, por regra pública da
  Receita (módulo 11).

## Perguntas em aberto

Nenhuma.

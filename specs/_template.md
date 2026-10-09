# NNNN: <título curto, verbo no infinitivo>

- **Status:** rascunho | aprovada | em implementação | entregue
- **Issue:** #<n> (ou "nenhuma")
- **Área:** edge-functions | migrations | coletor | pncp | catmat | dashboard-contrato | ...
- **Depende do ok do Marcelo:** sim | não (sim sempre que houver migration, decisão de produto ou dado de produção)

## Problema

<2 a 6 linhas: o que está errado ou faltando hoje, para quem, e a evidência (consulta, log, issue, número de produção
com data). Nada de número estimado: o que não foi medido aparece como "não medido".>

## Critérios de aceite

Cada critério é testável e nomeia o teste que o prova. O `/implement` escreve esses testes antes do código.

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** <estado>, **quando** <ação>, **então** <resultado observável>. | Deno `tests/supabase/...` \| pytest `.../test_*.py` \| SQL `supabase/tests/<assunto>_check.sql` |
| CA-2 | ... | ... |

Regras: um comportamento por CA; o "então" é verificável por máquina (status HTTP, linha no banco, valor
retornado, exceção); CA de regressão para todo bug P0/P1; CA negativo para todo controle de acesso (anon,
authenticated sem papel, outro tenant).

## Fora de escopo

- <o que parece parte disto, mas não entra; vira issue própria se valer>

## Impacto em dados

- **Migration:** não | sim, `supabase/migrations/<timestamp>_<assunto>.sql` (aditiva? destrutiva? idempotente?)
- **Tabelas/views/funções tocadas:** <lista> e quem lê/escreve cada uma
- **ACL/RLS:** <grants e policies novos ou alterados; "nenhum">
- **Backfill/reprocessamento:** não | sim, com contagem antes/depois (dry-run) no PR
- **Edge Functions republicadas no merge:** <lista> (o merge na `main` republica todas e aplica a migration em produção)
- **Contrato com o Dashboard:** inalterado | muda (qual ação/campo; o PR do backend vai ao ar antes do front)
- **Dado oficial x derivado:** <o que vem da fonte oficial e o que é calculado; nenhum valor inventado>

## Perguntas em aberto

- <o que a spec não sabe e precisa de resposta antes de "aprovada"; vazio quando aprovada>

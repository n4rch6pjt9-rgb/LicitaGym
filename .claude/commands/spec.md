---
description: Gera uma spec (problema, critérios de aceite testáveis, fora de escopo, impacto em dados) a partir de uma ideia
argument-hint: <ideia em uma frase, ou número de issue>
---

Escreva uma spec para esta ideia: **$ARGUMENTS**

Você só lê o código e o banco e escreve um arquivo em `specs/`. Não altera código, migration nem produção.

1. **Contexto.** Leia `CLAUDE.md`, `AGENTS.md`, `specs/_template.md` e as `.github/instructions/*.instructions.md`
   da área. Se o argumento for um número de issue, leia a issue e os comentários. Procure no código o que já existe
   (função, view, teste, Edge Function) antes de propor algo novo.
2. **Evidência.** Todo número no "Problema" vem de uma fonte que você consultou agora: consulta somente leitura pelo
   MCP do Supabase (sem dado pessoal na spec), log, teste ou issue, com a data. O que não foi medido aparece como
   "não medido". Nunca estime valor, quantidade, código CATMAT/PDM, UASG ou data.
3. **Critérios de aceite.** De 2 a 8 CAs no formato Dado/Quando/Então, cada um com o arquivo de teste que o prova
   (Deno em `tests/supabase/**`, pytest, ou `supabase/tests/<assunto>_check.sql`). Inclua CA negativo para controle
   de acesso e CA de regressão para bug P0/P1. Se um CA não puder ser testado por máquina, reescreva-o até poder.
4. **Impacto em dados.** Preencha todos os itens do template. Migration, mudança de ACL/RLS, backfill ou republicação
   de função em produção marcam "Depende do ok do Marcelo: sim".
5. **Perguntas em aberto.** Toda decisão de produto ou ambiguidade vira pergunta. Não assuma.
6. **Arquivo.** Número = maior `NNNN` em `specs/` + 1 (4 dígitos); slug curto em minúsculas com hífen.
   Status `rascunho`. Grave em `specs/NNNN-slug.md`.
7. **Resposta.** Mostre o caminho do arquivo, os CAs em uma linha cada e as perguntas em aberto. Só abra issue no
   GitHub com a spec se o usuário pedir.

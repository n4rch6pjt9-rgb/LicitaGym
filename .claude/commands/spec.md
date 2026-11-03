---
description: Gera uma spec (leitura obrigatória, contrato, critérios de aceite testáveis, skills e agentes por contrato, impacto em dados) a partir de uma ideia
argument-hint: <ideia em uma frase, ou número de issue>
---

Escreva uma spec para esta ideia: **$ARGUMENTS**

Você só lê o código e o banco e escreve um arquivo em `specs/`. Não altera código, migration nem produção.

1. **Contexto, nesta ordem.** `CLAUDE.md` (já carregado, com `AGENTS.md` e `.claude/rules/regras-negocio.md`) →
   `docs/produto/ESCOPO.md` → a spec-mãe ou de fase que a ideia alimenta → `specs/_template.md` →
   `.claude/rules/<area>.md` da área → README da Edge Function ou da tela envolvida → schemas das APIs oficiais, se
   houver chamada externa. Se o argumento for um número de issue, leia a issue e os comentários. Procure no código o
   que já existe (função, view, teste, Edge Function) antes de propor algo novo.
2. **Alimenta.** Diga qual módulo do `ESCOPO.md` ou qual fase da spec-mãe a spec alimenta. Se não alimenta nenhum,
   status `parada` e uma linha no `ESCOPO.md` proposta na resposta.
3. **Evidência.** Todo número no "Problema" vem de uma fonte que você consultou agora: consulta somente leitura pelo
   MCP do Supabase (sem dado pessoal na spec), log, teste ou issue, com a data. O que não foi medido aparece como
   "não medido". Nunca estime valor, quantidade, código CATMAT/PDM, UASG ou data.
4. **Leitura obrigatória.** Preencha a tabela do template com os arquivos reais desta spec (caminhos que existem
   hoje). Inclua o `.md` de cada agente e o `SKILL.md` de cada skill citados no passo 6.
5. **Contrato e critérios de aceite.** Cada ação de API, tela ou objeto de banco ganha um ID `K-n`. De 2 a 9 CAs
   Dado/Quando/Então, cada um ligado a um `K-n` e ao arquivo de teste que o prova (Deno, pytest, SQL `_check` ou
   vitest). Inclua CA negativo para controle de acesso (inclusive outro tenant) e CA de regressão para bug P0/P1.
6. **Skills e agentes por contrato.** Para cada `K-n`, preencha quem desenha, implementa, testa, revisa e verifica,
   usando só skills e agentes que existem em `.claude/` dos dois repositórios (tabela de referência no template).
   Mudança de auth, `service_role`, tenant, ACL ou RLS sempre leva `revisor-seguranca`; migration sempre leva
   `nova-migration`, `validar-migrations` e `revisor-migration`; tela sempre leva `ux-ui-licitagym` e `run-dashboard`.
7. **Impacto em dados.** Preencha todos os itens do template. Migration, mudança de ACL/RLS, backfill ou republicação
   de função em produção marcam "Depende do ok do Marcelo: sim".
8. **Perguntas em aberto.** Toda decisão de produto ou ambiguidade vira pergunta. Não assuma.
9. **Arquivo.** Número = maior `NNNN` em `specs/` + 1 (4 dígitos); slug curto em minúsculas com hífen.
   Status `rascunho`. Grave em `specs/NNNN-slug.md`.
10. **Resposta.** Mostre o caminho do arquivo, os contratos e CAs em uma linha cada e as perguntas em aberto. Só abra
    issue no GitHub com a spec se o usuário pedir.

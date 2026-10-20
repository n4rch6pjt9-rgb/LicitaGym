# NNNN: <título curto, verbo no infinitivo>

- **Status:** rascunho | aprovada | em implementação | entregue | parada
- **Alimenta:** spec-mãe 0032, fase <1–4> | módulo <n> de `docs/produto/ESCOPO.md` | nenhuma (→ status `parada`)
- **Repositório:** LicitaGym | Dashboard | os dois (backend vai ao ar antes do front)
- **Issue:** #<n> (ou "nenhuma")
- **Área:** edge-functions | migrations | coletor | pncp | catmat | dashboard-contrato | dashboard-tela | ...
- **Depende do ok do Marcelo:** sim | não (sim sempre que houver migration, decisão de produto ou dado de produção)

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` do repositório | como roda, testa e entrega; o que não fazer | sim, no início da sessão |
| 2 | `AGENTS.md` (backend) | zero alucinação, fontes, identificadores oficiais | sim, importado pelo `CLAUDE.md` do backend; no Dashboard, ler no repositório LicitaGym |
| 3 | `.claude/rules/regras-negocio.md` (backend) | regras de produto decididas | sim no backend; no Dashboard, ler no repositório LicitaGym |
| 4 | `docs/produto/ESCOPO.md` | módulo que a spec alimenta, decisões e pendências | não: ler |
| 5 | spec-mãe ou de fase (`specs/0032-...`, se "Alimenta" apontar para ela) | o objetivo maior e o que está fora | não: ler |
| 6 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 7 | `.claude/rules/<area>.md` da área tocada (gerado de `.github/instructions/`) | convenções da área | só ao abrir arquivo da pasta: ler antes, explicitamente |
| 8 | README da Edge Function ou da tela tocada | contrato atual | não: ler |
| 9 | `docs/pncp/schemas-consultas-pncp.md`, `docs/compras-gov/schemas-consultas.md` | só se a spec chama API oficial | não: ler |
| 10 | `SKILL.md` de cada skill e o `.md` de cada agente da seção "Skills e agentes por contrato" | o procedimento de cada etapa | quando invocados |

<Liste aqui os arquivos específicos desta spec que entram nos itens 5, 7, 8 e 9.>

## Problema

<2 a 6 linhas: o que está errado ou faltando hoje, para quem, e a evidência (consulta, log, issue, número de produção
com data). Nada de número estimado: o que não foi medido aparece como "não medido".>

## Contrato

<Para cada ação de API, tela ou objeto de banco que a spec cria ou muda: entrada, saída, erros e quem pode chamar.
Cada linha ganha um ID (K-1, K-2...) usado nas seções abaixo.>

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `api-x` `action=...` | ... | ... | 400 / 403 / 404 / 409 | admin \| membro \| desenvolvedor |

## Critérios de aceite

Cada critério é testável e nomeia o teste que o prova. O `/implement` escreve esses testes antes do código.

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** <estado>, **quando** <ação>, **então** <resultado observável>. | Deno `tests/supabase/...` \| pytest `.../test_*.py` \| SQL `supabase/tests/<assunto>_check.sql` \| vitest `src/test/...` |

Regras: um comportamento por CA; o "então" é verificável por máquina (status HTTP, linha no banco, valor
retornado, exceção, elemento na tela); CA de regressão para todo bug P0/P1; CA negativo para todo controle de acesso
(anon, authenticated sem papel, outro tenant).

## Skills e agentes por contrato

Quem faz cada etapa de cada contrato. Agente ou skill que não existe no repositório não entra aqui.

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | `/implement` (TDD) | ... | `revisor-codigo` + ... | skill `verificar-producao` |

Referência (o que existe hoje):

| Tipo de contrato | Implementação | Revisão obrigatória | Verificação |
|---|---|---|---|
| Migration (tabela, ACL, RLS, função SQL) | skill `nova-migration` | `revisor-migration` + `revisor-seguranca` (se ACL/RLS) | skill `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| Edge Function `api-*` / `sync-*` | `/implement` | `revisor-codigo` + `revisor-seguranca` (auth, `service_role`, tenant) | `verificar-producao` |
| Coletor Python | `/implement` | `revisor-codigo` | `verificar-producao` |
| Tela do Dashboard | agente `frontend-dashboard` | `revisor-codigo` + `revisor-seguranca` (do repo LicitaGym, pela sessão orquestradora) + agente `ux-ui-licitagym` | skill `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |
| Contrato entre os dois repositórios | sessão orquestradora: backend mergeado e publicado antes do front | os dois conjuntos acima | `verificar-producao` e `deploy-dashboard` |
| PRs empilhados | — | — | skill `merge-pilha` (a pedido do Marcelo) |
| Fechamento | — | — | skill `ciclo-janelas` (issues dos dois repositórios e aviso às janelas) |

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

## Decisões do Marcelo

- <data: decisão. Ao fechar a spec, as decisões de produto sobem para `docs/produto/ESCOPO.md`>

## Perguntas em aberto

- <o que a spec não sabe e precisa de resposta antes de "aprovada"; vazio quando aprovada>

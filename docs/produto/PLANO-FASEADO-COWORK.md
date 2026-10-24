# Plano faseado: Cowork na implementação das specs

<!-- Mudança neste arquivo exige ok do Marcelo. -->

Como usar o Claude no Cowork (sessão na nuvem, ligada ao Projeto LicitaGym) junto com o Claude Code no repositório,
fase por fase. Modelos de cada etapa: `docs/produto/PLANO-MODELOS.md`. Ordem das specs:
`docs/produto/BACKEND-CONFIGURACOES.md` e `docs/produto/ESCOPO.md`.

## Quem faz o quê

| | Cowork (orquestrador) | Claude Code no repositório (implementação) |
|---|---|---|
| Onde roda | sessão na nuvem, com GitHub, Supabase (só leitura), navegador e tarefas agendadas | máquina com o clone, Docker, Deno, Node, hooks e os agentes de `.claude/` |
| Faz | spec (`/spec` no formato do template), análise de dados, decisões no `ESCOPO.md`, revisão de PR, acompanhamento, verificações agendadas | `/implement`: testes primeiro, código, `validar-migrations`, revisores, PR em draft |
| Não faz | implementação com migration (não roda o Postgres descartável), merge, deploy | decisão de produto, merge, deploy |
| Modelo padrão | `sonnet`; `opus` só para desenho N2/N3 | `opusplan` |

Regra de ouro: **o Cowork nunca escreve código de produção; o Claude Code nunca decide escopo.** O que um decide vira
arquivo (`ESCOPO.md`, spec aprovada) antes de o outro agir.

## Fase 0: preparar a esteira

**Entrada:** PRs #406, #407 e o PR deste plano abertos.

| # | Ação | Quem | Modelo | Situação (20/10) |
|---|---|---|---|---|
| 0.1 | Merge de #406 → #407 → PR deste plano (merge commit) e os passos manuais do #406 (`.gitignore`, `git rm` dos logs do claude-mem, passo de CI) | Marcelo + Claude Code | N0 `haiku` | pendente |
| 0.2 | Adicionar `LicitaGym` e `Dashboard---LicitaGym` às fontes da sessão do Cowork. Sem o repositório nas fontes, o Cowork só publica pela API do GitHub, reenviando cada arquivo inteiro (caro em tokens, não apaga arquivo nem edita workflow); com o repositório nas fontes, publica por `git push` | Marcelo | — | feito (os dois salvos no Projeto) |
| 0.3 | Aplicar o frontmatter `model`/`effort` da tabela do `PLANO-MODELOS.md` nos agentes, skills e comandos dos dois repositórios | Claude Code | N1 `sonnet` | pendente |
| 0.4 | No Dashboard: `CLAUDE.md` apontando para o `AGENTS.md` do backend; R1–R4 resumidas na skill `ciclo-janelas` | Claude Code | N1 `sonnet` | pendente |
| 0.5 | Projeto LicitaGym no claude.ai com `docs/produto/instrucoes-projeto-claude-ai.md` e os arquivos de conhecimento | Marcelo | — | pendente |
| 0.6 | Tarefas agendadas do Cowork (seção "Recorrente") | Cowork | N0 | feito |

**Saída:** `/context` mostra `CLAUDE.md`, `AGENTS.md` e `regras-negocio.md`; os agentes têm `model` declarado.

## Fase 1: piloto com a 0034 (etapas editáveis)

Risco baixo: serve para calibrar o plano de modelos com números reais. Issue: #408.

1. Cowork: confere a spec contra a `main` (arquivos citados existem) e abre a issue. N0. **Feito (#408).**
2. Claude Code (LicitaGym): `/implement` de K-5/K-6 (`etapas_reordenar`, `versao`). `opusplan`; `revisor-codigo` e
   `revisor-seguranca`. PR em draft.
3. Marcelo: merge do backend. Cowork: `verificar-producao` (agendada para logo depois do merge). N0.
4. Claude Code (Dashboard): `frontend-dashboard` para K-1 a K-4, `ux-ui-licitagym` antes do código. N1.
5. Marcelo: merge do front. Cowork: `deploy-dashboard` + `ciclo-janelas`. N0.

**Saída:** CA verdes, `/usage` de cada etapa registrado no PR; ajuste do `PLANO-MODELOS.md` se algum nível gastou
fora do esperado.

## Fase 2: 0033 (tenant explícito)

N2/N3: muda autorização. Pré-requisito de tudo que é multi-tenant.

- Marcelo cria a branch Supabase (RLS e tabela nova).
- Claude Code: backend (K-1, K-2, K-6, K-7) com `revisor-seguranca` em `opus`; depois o front (K-3 a K-5).
- Cowork: depois do merge, consulta de verificação (nenhum 409 novo nos logs das 5 funções) e cadastro de uma
  segunda empresa de teste para provar o isolamento.

**Saída:** duas empresas ativas sem erro; seletor no shell.

## Fase 3: texto do TR disponível e escopo pelo TR

1. Operação da fase 1 da 0032: o job `preparar-triagem` no ar (deploy do Cloud Run Job e agendamento, pelo Marcelo).
   Sem isso não há texto de TR: em 20/10, só 7 das 755 oportunidades `leads` tinham texto indexado.
2. Spec 0035 (escopo pelo texto do TR, CATMAT como apoio): Claude Code, N2.
3. Cowork: amostra semanal de 20 itens com "CATMAT divergente" para o Marcelo validar a regra. N1.

**Saída:** a #2691 aparece no radar com os 3 itens marcados "CATMAT divergente".

## Fase 4: alicerces de configuração

Specs 3, 4 e 5 do `BACKEND-CONFIGURACOES.md` (`api-metadados` com visões salvas da equipe, catálogo por CSV, preços por
CSV) e o kit único de filtros no front (`FASE-1-FRONTEND.md`, seção 4).

- Duas janelas de Claude Code em paralelo, no máximo (backend e front), com o Cowork como orquestrador (regras R3 e R4).
- Cowork escreve as specs (N2 no desenho) e testa o CSV com uma planilha real do tenant.

## Fase 5: escopo e usuários por tenant

Specs 6 a 9: escopo CATMAT e termos por tenant (branch Supabase, backfill), usuários com convite, atributos do catálogo
no lugar do Modelo de Dados, página inicial `/configuracoes`.

## Fase 6: comercial e módulos seguintes

Spec 10 (regras comerciais, habilitação, alertas) e os módulos 4 a 6 do `ESCOPO.md` (proposta, alerta de disputa,
sessão do certame).

## Recorrente (tarefas agendadas do Cowork)

| Quando (horário de Brasília) | O quê | Modelo |
|---|---|---|
| Dias úteis, 07:41 | Resumo: PRs abertos e CI, issues `alerta-operacional`, oportunidades com prazo nas próximas 48 h | N0 `haiku` |
| Depois de cada merge (disparo manual) | `verificar-producao` e `get_advisors` | N0 `haiku` |
| Sexta-feira, 16:41 | `ciclo-janelas`, revisão do `ESCOPO.md` (pendências) e `/usage` da semana por spec | N1 `sonnet` |

As três rodam na thread "Plano faseado Cowork + Claude Code" do Projeto e postam o resultado lá.

## Portões (valem para todas as fases)

- Spec só vai para o Claude Code com status `aprovada` e sem perguntas em aberto.
- Merge e deploy são do Marcelo; o Cowork só prepara e verifica.
- Backend publicado antes do front que depende dele.
- Cada PR registra: arquivos lidos, CA com resultado, revisores rodados e o `/usage` por etapa.

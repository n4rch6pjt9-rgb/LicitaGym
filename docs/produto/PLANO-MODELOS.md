# Plano de modelos: que modelo e esforço usar em cada etapa

<!-- Calibrado pela Fase 1 (spec 0034). Mudança aqui exige ok do Marcelo. -->

- **Dono:** Marcelo Rosas
- **Usado por:** `docs/produto/PLANO-FASEADO-COWORK.md` (coluna "Modelo") e pelo frontmatter `model`/`effort` dos
  agentes, skills e comandos em `.claude/` dos dois repositórios
- **Revisão:** sexta-feira (tarefa agendada do Cowork), comparando o `/usage` registrado nos PRs com a faixa esperada

## Níveis

| Nível | Quando | Modelo | `effort` | Exemplos |
|---|---|---|---|---|
| **N0** | leitura, conferência, rotina mecânica, resumo | `haiku` | `low` | resumo matinal, `verificar-producao`, `deploy-dashboard`, `merge-pilha`, abrir issue a partir de spec aprovada |
| **N1** | mudança dentro de um contrato que já existe; revisão padrão; documentação | `sonnet` | `medium` | front que consome API pronta, `revisor-codigo`, `ux-ui-licitagym`, `ciclo-janelas` de sexta |
| **N2** | contrato novo, migration, desenho de spec | `opusplan` (implementação) ou `opus` (desenho) | `high` | `/spec`, `/implement` com migration, `revisor-migration` |
| **N3** | autorização, RLS, multi-tenant, dado sensível | `opus` | `high` (ou `xhigh` no desenho) | spec 0033 (tenant explícito), `revisor-seguranca` quando o diff muda autorização |

Regras:
- O nível vem da **etapa**, não da spec inteira: a 0034 tem backend N2 (função transacional) e front N1.
- Na dúvida entre dois níveis, comece pelo menor e suba se o revisor achar problema de desenho.
- `opusplan` = `opus` no modo de planejamento e `sonnet` na execução (padrão do Claude Code no repositório).

## Tabela por agente, skill e comando

Valor a declarar no frontmatter (tarefa 0.3 do plano faseado). `inherit` = usa o modelo da sessão que chamou.

### LicitaGym (backend)

| Tipo | Nome | `model` | `effort` | Nível | Observação |
|---|---|---|---|---|---|
| comando | `/spec` | `opus` | `high` | N2 | desenho; N3 quando mexe em autorização |
| comando | `/implement` | `opusplan` | `high` | N2 | testes primeiro; chama os revisores |
| agente | `revisor-codigo` | `sonnet` | `medium` | N1 | todo PR |
| agente | `revisor-migration` | `opus` | `high` | N2 | todo diff com `supabase/migrations/` |
| agente | `revisor-seguranca` | `sonnet` | `high` | N1/N3 | sobe para `opus` quando o diff muda autorização, RLS ou tenant (a spec diz) |
| skill | `nova-migration` | `inherit` | — | — | roda dentro do `/implement` |
| skill | `validar-migrations` | `haiku` | `low` | N0 | mecânica: sobe o Postgres descartável e lê o resultado |
| skill | `verificar-producao` | `haiku` | `low` | N0 | só leitura |
| skill | `merge-pilha` | `haiku` | `low` | N0 | só quando o Marcelo pede o merge |
| skill | `ciclo-janelas` | `haiku` | `low` | N0 | depois de cada merge; a revisão de sexta é N1 no Cowork |

### Dashboard---LicitaGym (front)

| Tipo | Nome | `model` | `effort` | Nível | Observação |
|---|---|---|---|---|---|
| agente | `frontend-dashboard` | `sonnet` | `medium` | N1 | N2 se a tela muda contrato com o backend |
| agente | `ux-ui-licitagym` | `sonnet` | `medium` | N1 | mockup antes do código |
| skill | `run-dashboard` | `haiku` | `low` | N0 | sobe o demo e tira screenshots |
| skill | `deploy-dashboard` | `haiku` | `low` | N0 | só confere o que o merge publicou |
| skill | `ciclo-janelas` | `haiku` | `low` | N0 | mesma regra do backend |

### Cowork (sessão na nuvem)

| O quê | Modelo | Nível |
|---|---|---|
| padrão (issue, conferência de spec, revisão de PR, verificação) | `sonnet` | N0/N1 |
| desenho de spec N2/N3 | `opus` | N2/N3 |
| tarefas agendadas | criadas pela sessão na nuvem (as 3 de hoje): usam o modelo da sessão, porque a ferramenta de agendamento da nuvem não tem campo de modelo, e o nível vai escrito no texto da tarefa. Criadas à mão no app do Cowork: fixar o modelo do nível (`haiku` para N0, `sonnet` para N1) no campo de modelo | N0/N1 |

## Registro de uso

Cada PR registra o `/usage` por etapa (desenho, implementação, cada revisor). A tarefa de sexta junta numa tabela
spec × etapa × nível × uso. A faixa esperada por nível fica em branco até a Fase 1 dar números reais:

| Nível | Faixa esperada por etapa | Medido na 0034 |
|---|---|---|
| N0 | a calibrar | — |
| N1 | a calibrar | — |
| N2 | a calibrar | — |
| N3 | a calibrar | — |

Se uma etapa gastar mais que o dobro da faixa do seu nível, a tarefa de sexta propõe subir o nível dessa etapa (ou
quebrar a spec) aqui, para o Marcelo aprovar.

# Estrutura de instruções do LicitaGym: diagnóstico e padrão

Base: repositório `n4rch6pjt9-rgb/LicitaGym` (commit `8436bdd`) e a documentação oficial do Claude Code sobre memória
(code.claude.com/docs/en/memory), lidos em 20/10/2026.

## 1. O que está errado hoje

| # | Problema | Efeito | Correção neste pacote |
|---|---|---|---|
| 1 | O `CLAUDE.md` cita o `AGENTS.md` entre crases, sem `@AGENTS.md` | Com `CLAUDE.md` na raiz, o Claude Code **não carrega** o `AGENTS.md`. A regra de zero alucinação e a de consultar schemas não estão no contexto | `@AGENTS.md` na 1ª linha útil do `CLAUDE.md` |
| 2 | Regras por área estão só em `.github/instructions/*.instructions.md` (`applyTo:`) | Formato do Copilot. O Claude Code não lê essa pasta | Script gera `.claude/rules/<area>.md` com `paths:`; CI confere |
| 3 | 20 arquivos `CLAUDE.md` do plugin claude-mem versionados em subpastas (`supabase/`, `docs/`, `.claude/agents/`...) | Carregam como **instrução** quando o Claude abre arquivo da pasta: log de sessão vira ruído no contexto | `claudeMdExcludes` no `.claude/settings.json` + tirar do git |
| 4 | `CLAUDE.md` com 15 KB, fatos datados ("em 08/10: 12 no-unused-vars", "em 10/10 a Konnen...") e itens CONFIRMAR | Doc oficial: alvo < 200 linhas; arquivo longo reduz a aderência; fato datado envelhece | `CLAUDE.md` novo (95 linhas); regras de negócio em `.claude/rules/regras-negocio.md`; pendências no `ESCOPO.md` |
| 5 | `AGENTS.md` com trecho colado no lugar errado (a lista "BDI, impostos, margens" caiu dentro da regra de schemas) e fontes desatualizadas | Regra ambígua | `AGENTS.md` reescrito, mesma substância |
| 6 | Regras do `CLAUDE.md` em conflito com decisões suas | O Claude pode seguir qualquer uma das duas | Ver seção 2 |
| 7 | Escopo espalhado em 30 specs; a 0032 se declara spec-mãe, mas nada obriga as outras a apontar para ela | "Andando em círculos" | `docs/produto/ESCOPO.md` + campo **Alimenta** no template + status `parada` |
| 8 | `.claude/skills/revisor-codigo` é arquivo solto (o agente está em `.claude/agents/revisor-codigo.md`) | Skill não reconhecida; duplicata | Apagar ou mover para `.claude/skills/revisor-codigo/SKILL.md` |
| 9 | Raiz com `untitled/` e arquivo vazio `licitagym-coletor-sistema-s` | Ruído | Apagar |

## 2. Conflitos que eu resolvi a favor das suas decisões (confira)

| Tema | `CLAUDE.md` atual dizia | Novo texto (sua decisão) |
|---|---|---|
| Academia ao ar livre | "só conta junto com piso" | fora de escopo; "ar livre" desqualifica o item |
| Fonte da verdade do escopo | JSON de taxonomia / catálogo CATMAT | **TR primeiro, CATMAT como suporte** (decisão de 20/10) |
| Fonte de acompanhamento | PNCP/Compras.gov como fontes | portal oficial do edital é primário; PNCP é alternativa |

Se algum deles não vale mais, ajuste `regras-negocio.md` e `ESCOPO.md` antes do PR.

## 3. Padrão adotado (boas práticas do Claude)

**Cada coisa em um lugar, carregada só quando precisa:**

| Camada | Arquivo | Carrega | O que vai |
|---|---|---|---|
| Projeto | `CLAUDE.md` | toda sessão | como roda, testa, entrega; o que nunca fazer. < 200 linhas |
| Dados (multi-ferramenta) | `AGENTS.md` (importado) | toda sessão | zero alucinação, fontes, identificadores |
| Negócio | `.claude/rules/regras-negocio.md` (sem `paths`) | toda sessão | regras decididas e estáveis |
| Área | `.claude/rules/<area>.md` (com `paths`) | ao tocar a pasta | edge functions, migrations, coletor, CATMAT... |
| Procedimento | `.claude/skills/*` | quando invocado ou relevante | nova-migration, verificar-producao, ciclo-janelas |
| Bloqueio | `settings.json` deny + hook | sempre, à força | o que não pode acontecer nem se o modelo quiser |
| Escopo | `docs/produto/ESCOPO.md` | quando lido | objetivo, módulos, fora de escopo, decisões |
| Mudança | `specs/NNNN.md` | quando lido | uma mudança, critérios testáveis, aponta para o ESCOPO |
| Pessoal | `CLAUDE.local.md` (gitignored) | toda sessão, só sua | preferências suas, não do time |

Princípios da documentação oficial que guiaram isso:
- Instrução específica e curta é seguida com mais consistência; duas regras contraditórias fazem o Claude escolher uma ao acaso.
- `@import` organiza, mas não economiza contexto (o importado carrega na hora). Para economizar, use `paths:`.
- `CLAUDE.md` é contexto, não trava. O que não pode acontecer fica em `permissions.deny` ou hook `PreToolUse`
  (vocês já fazem isso bem).
- Comentário HTML `<!-- -->` no `CLAUDE.md` não vai para o contexto: use para nota de mantenedor.
- Rode `/doctor prompt-audit` de tempos em tempos: ele aponta instrução velha, arquivo citado que não existe e conflito.

## 4. O que este PR aplicou e o que fica manual

Aplicado: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/` (negócio + regras por área geradas), `.claude/settings.json`
(`claudeMdExcludes`), `scripts/ci/sincronizar-regras-claude.sh`, `docs/produto/`, `specs/_template.md`, `/spec` e
`/implement`.

Manual (a ferramenta usada para abrir o PR não apaga arquivos nem edita workflow):
```bash
printf '\n# logs do plugin claude-mem (só o CLAUDE.md da raiz é instrução)\n**/CLAUDE.md\n!/CLAUDE.md\nCLAUDE.local.md\n' >> .gitignore
git ls-files '*CLAUDE.md' | grep -v '^CLAUDE.md$' | xargs git rm --cached   # logs do claude-mem
git rm -r untitled licitagym-coletor-sistema-s
git rm .claude/skills/revisor-codigo     # duplicata do agente .claude/agents/revisor-codigo.md
```
No job `lint` da `.github/workflows/pr-quality.yml`, logo depois do checkout:
```yaml
      - name: Regras do Claude (.claude/rules) sincronizadas com .github/instructions
        run: bash scripts/ci/sincronizar-regras-claude.sh --check
```
Ao editar uma `.github/instructions/*.instructions.md`, rode `bash scripts/ci/sincronizar-regras-claude.sh` e
commite o `.claude/rules/` gerado (a CI confere).

No Dashboard, troque a menção a `AGENTS.md` por um link para o arquivo do backend; as regras R1–R4 podem virar só a
linha "rotina R1–R4: skill `ciclo-janelas`" nos dois repositórios.

Depois do merge, numa sessão nova do Claude Code: `/context` deve listar `CLAUDE.md`, `AGENTS.md` e
`regras-negocio.md` em **Memory files**, e nenhum `CLAUDE.md` de subpasta.

## 5. Projeto no claude.ai

`docs/produto/instrucoes-projeto-claude-ai.md`: texto para colar em Instruções do projeto, mais a lista de arquivos de
Conhecimento. O projeto usa os mesmos arquivos do repositório, então uma decisão tomada na conversa vira uma linha
no `ESCOPO.md` e chega também ao Claude Code.

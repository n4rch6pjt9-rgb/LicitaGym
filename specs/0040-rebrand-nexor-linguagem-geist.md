# 0040: Aplicar a marca NEXOR Licitações e a linguagem visual do Geist ao Dashboard

- **Status:** parada (não alimenta fase da 0032; ver "Perguntas em aberto", P1)
- **Alimenta:** nenhuma fase da 0032 e nenhum módulo de `docs/produto/ESCOPO.md` (linha proposta ao fim da spec)
- **Repositório:** Dashboard (worktree `C:\Users\marce\dash-rebrand-nexor`, branch `feat/rebrand-nexor`, sem push)
- **Issue:** nenhuma
- **Área:** dashboard-tela
- **Depende do ok do Marcelo:** sim (decisão de produto: marca, cor de ação e estrutura do Dashboard)

Esta spec substitui, se aprovada, `docs/produto/PLANO-DASHBOARD-EXECUTIVO-V2-NEXOR-GEIST.md` e
`docs/produto/IDENTIDADE-VISUAL.md`. Os dois arquivos não estão versionados e se contradizem.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` do Dashboard | como roda, testa e entrega; merge publica em produção | sim, no início da sessão |
| 2 | `AGENTS.md` (LicitaGym) | zero alucinação; dado ausente aparece como ausente | ler no repositório LicitaGym |
| 3 | `.claude/rules/regras-negocio.md` (LicitaGym) | TR decide o escopo; CATMAT é apoio | ler no repositório LicitaGym |
| 4 | `docs/produto/ESCOPO.md` (LicitaGym) | regra de foco e decisões | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` (LicitaGym) | fase em andamento; define a regra de foco | não: ler |
| 6 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 7 | `README.md` do Dashboard, seção "Design system" | estado documentado dos primitivos | não: ler |
| 8 | `src/theme.css`, `src/index.css`, `src/hooks/useTheme.ts` | tokens e temas atuais | não: ler |
| 9 | `src/components/ui/Button.tsx`, `Card.tsx`, `DataTable.tsx`, `PageHeader.tsx`, `Kpi.tsx`, `index.ts` | primitivos a ajustar | não: ler |
| 10 | `src/components/layout/AppShell.tsx` | menu, topo e marca | não: ler |
| 11 | `src/components/dashboard/*.tsx` | blocos do Dashboard | não: ler |
| 12 | `src/components/intelligence/IntelligenceHub.tsx`, `src/components/layout/CommandPalette.tsx`, `src/components/common/ErrorBoundary.tsx`, `src/App.tsx` | textos com a marca antiga | não: ler |
| 13 | `.claude/agents/frontend-dashboard.md`, `.claude/agents/ux-ui-licitagym.md` (Dashboard) | implementação e revisão de tela | quando invocados |
| 14 | `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md` (LicitaGym) | revisão antes do PR | quando invocados |
| 15 | `.claude/skills/run-dashboard/SKILL.md`, `.claude/skills/deploy-dashboard/SKILL.md`, `.claude/skills/ciclo-janelas/SKILL.md` (Dashboard) | verificação e fechamento | quando invocados |
| 16 | https://vercel.com/geist/code-block e https://vercel.com/geist/button | referência visual pedida pelo Marcelo | não: ler |

## Problema

O rebrand local mudou logo, fonte e Dashboard, mas as outras telas seguem com praticamente o mesmo layout, e o Marcelo
não gostou do resultado. O plano que o originou cita `geist/introduction`, nunca `geist/code-block`, e prescreve parte
das falhas.

Medido no worktree (`051d967` mais edições sem commit, base `origin/main` `be6d29e`), modo demo, salvo indicação:

- **Tokens (07/11):** nenhum `--ds-*` em `src/`; 3 temas com a mesma cor primária. O Geist usa escala neutra.
- **Peso visual (07/11, `src/components`):** 1463 classes de cor fixa da paleta, 469 `text-[10px]`/`text-[11px]`,
  176 sombras, 179 `rounded-xl`/`2xl`, 396 `font-bold`/`black`/`extrabold`.
- **Componentes (07/11):** 312 `<button>` crus, `Button` usado em 17 arquivos; 26 `<h1>` diretos, `PageHeader` em 8.
- **Dashboard (06/11, 1440 px):** altura de 2703 px contra 1722 px na `main` (antes dos ajustes de largura de 07/11;
  não medido de novo) e 11 de 18 botões primários contra 5 de 10.
- **Dado sem fonte (leitura do código, 07/11):** `status="processing"` fixo em `ExecutiveDashboard.tsx`; pilares de
  saúde "OK" sem consultar `api-saude`; "Alta aderência" a partir de CATMAT ou categoria, contra a regra do TR.
- **Marca (07/11):** 28 ocorrências de "LicitaGym" e 22 de "NEXOR" em `src/components` e `index.html`.
- **Geist, tema escuro (06 e 07/11):** bloco `#0a0a0a` sobre página `#000`, sem sombra, raio de 8 px; H1 40 px/600/-2.4px,
  H2 24 px/600/-0.96px, H3 20 px/600/-0.4px; botão primário `rgb(237,237,237)` com texto `rgb(10,10,10)`, peso 500,
  alturas de 32/36/40 px e raio de 6/6/8 px. **Tema claro: não medido.**
- **Testes (07/11):** `tsc`, `vite build` e `check-bundle` passam. Suíte completa: 621 de 622 nas 2 últimas rodadas; a
  falha é `catmat.test.tsx`, que passa sozinho (10 de 10). Na `main`: não medido.

## Contrato

Sem API nova. Todos os contratos são de tela; quem acessa cada tela não muda.

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tokens em `src/theme.css` e `src/index.css`: tema único, escala neutra do Geist, claro e escuro | valores medidos no Geist | `--color-*` atuais apontando para a escala nova; sem `data-brand-theme` | valor não medido não entra | desenvolvedor |
| K-2 | `Button`, `Card`, `DataTable` | props atuais, sem quebra | sem sombra, borda de 1 px, raio do Geist, peso 500, cor de ação conforme P3 | — | todas as telas |
| K-3 | Tipografia: `PageHeader` e escala de títulos | título e descrição | hierarquia H1 → H2 → H3 sem saltos; texto mínimo de 12 px, conforme P5 | — | todas as telas |
| K-4 | `AppShell`: marca e topo | `useTheme` só claro/escuro | sem seletor V1/V2/V3; logo único; mantém os ajustes de largura, menu recolhido e remoção de "Nova Oportunidade" | — | todas as telas |
| K-5 | `ExecutiveDashboard` enxuto | dados de `listarOportunidades` e `listarEtapas` | blocos definidos em P4; nenhum estado fixo; ausente aparece como "—" ou "Não verificada" | erro com "Tentar de novo" | membro do tenant |
| K-6 | Textos visíveis: "LicitaGym" → "NEXOR" | `src/components`, `src/App.tsx`, `index.html` | marca única na interface; `og:image` com URL absoluta | — | todas as telas |
| K-7 | Saúde e aderência sem dado inventado | `api-saude` existente na `main`, se atender (P6) | pilar sem verificação real não mostra "OK"; aderência não vira "Alta" só por CATMAT ou categoria | leitura falha mostra "Não verificada" | membro do tenant |

Identificadores técnicos não mudam: `app_metadata.licitagym_role`, jobs, buckets, URLs de função e chave
`licitagym_theme` no `localStorage`.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** `src/theme.css`, **quando** lido pelo teste, **então** não contém `data-brand-theme` e define os tokens nos dois modos. | vitest `src/test/tokens-geist.test.ts` |
| CA-2 | K-2 | **Dado** `Card` e `Button` renderizados, **quando** inspecionadas as classes, **então** não há `shadow-*`, e a variante primária usa a cor definida em P3. | vitest `src/test/ui-base-50.test.tsx` |
| CA-3 | K-3 | **Dado** o Dashboard e as telas `/agentes/*`, **quando** renderizados, **então** há um único `h1` e nenhum salto de nível de título. | vitest `src/test/hierarquia-titulos.test.tsx` |
| CA-4 | K-4 | **Dado** o `AppShell`, **quando** renderizado, **então** não há seletor de versão nem "Nova Oportunidade", e o logo existe com o menu aberto e recolhido. | vitest `src/test/appshell-marca.test.tsx` |
| CA-5 | K-4 | **Regressão P1. Dado** telas de 1024, 1440 e 1768 px, **quando** abertas pelo `run-dashboard`, **então** Sair, logo e valor do KPI ficam inteiros e visíveis. | vitest `src/test/strategic-kpis.test.tsx` + screenshots da skill `run-dashboard` |
| CA-6 | K-5 | **Regressão P0. Dado** o Dashboard, **quando** não há fonte de preços, **então** o texto "Processando base histórica..." não aparece e o bloco mostra estado explícito de ausência ou não é exibido. | vitest `src/test/painel-dados-honestos.test.tsx` |
| CA-7 | K-6 | **Dado** `src/components`, `src/App.tsx` e `index.html`, **quando** varridos, **então** não há "LicitaGym" em texto visível, salvo exceção listada no teste. | vitest `src/test/marca-nexor.test.ts` |
| CA-8 | K-7 | **Regressão P0. Dado** oportunidade com CATMAT casado e sem análise do TR, **quando** classificada, **então** a aderência não é "Alta". | vitest `src/test/painel-dados-honestos.test.tsx` |
| CA-9 | K-7 | **Negativo. Dado** membro sem acesso a `api-saude` ou leitura com falha, **quando** o Dashboard abre, **então** o pilar mostra "Não verificada", nunca "OK", e nenhum dado de outro tenant aparece. | vitest `src/test/painel-dados-honestos.test.tsx` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 a K-4, K-6 | `/spec`, agente `ux-ui-licitagym` | agente `frontend-dashboard` | vitest + skill `run-dashboard` (claro, escuro, celular) | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | skill `deploy-dashboard` |
| K-5, K-7 | `/spec`, agente `ux-ui-licitagym` | agente `frontend-dashboard` | vitest + skill `run-dashboard` | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | skills `deploy-dashboard` e `ciclo-janelas` |

## Fora de escopo

- Falhas de rota herdadas da `main`: busca que não abre, tela branca com URL malformada, menu sem links reais, `adminOnly`
  não aplicado, título fixo da aba e breadcrumb errado. Valem spec ou issue próprias.
- Renomear o repositório, o domínio ou identificadores técnicos.
- Trocar as 1463 cores fixas de uma vez, salvo decisão em P5.
- Aplicar `resumo_executivo`, `dimensoes` e a migration `20261105120000`, que seguem sem commit no LicitaGym.
- Componente `CodeBlock` para exibir código, porque o pedido é a linguagem visual; ver P2.

## Impacto em dados

- **Migration:** não.
- **Tabelas/views/funções tocadas:** nenhuma.
- **ACL/RLS:** nenhum.
- **Backfill/reprocessamento:** não. Mudança de aderência é só de exibição, salvo decisão em P6.
- **Edge Functions republicadas no merge:** nenhuma, porque o PR é só do Dashboard. O merge publica o front em produção na hora.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:** esta spec não cria valor; o que não tem fonte aparece como ausente.

## Decisões do Marcelo

- 06/11/2026: não gostou do resultado do rebrand local; pediu seguir `vercel.com/geist/code-block`.
- 06/11/2026: conteúdo mais largo, logo visível com o menu recolhido, sem "Nova Oportunidade" e KPI sem corte (já
  aplicados no worktree, sem commit).

## Perguntas em aberto

- **P1. Foco:** a 0032 não tem registro de fase 3 concluída, e o `ESCOPO.md` só admite spec que alimente uma fase dela.
  O Marcelo abre exceção para o rebrand? Sem exceção, a spec segue `parada`.
- **P2. Referência:** "seguir o Code Block" significa a linguagem visual em todo o produto, como esta spec assume, ou só
  o componente para exibir código?
- **P3. Cor de ação:** botão primário neutro, como no Geist, com verde só para marca e oportunidade ativa, ou verde em
  todas as ações principais?
- **P4. Dashboard:** quais blocos ficam? Proposta: estrutura da `main` (KPIs, funil, prazos, leads) mais a Saúde só se
  houver fonte real. O Centro de Ações, o NEXOR Intelligence e Preços saem?
- **P5. Alcance:** vale o tema único mais primitivos em todas as telas, deixando as cores fixas para trocar aos poucos,
  ou todas as telas de uma vez? O mínimo de 12 px entra agora, trocando os 469 usos?
- **P6. Saúde e aderência:** `api-saude` hoje só atende admin e cron? Se membro comum não lê, o pilar sai do Dashboard ou
  aparece como "Não verificada"? Qual regra define aderência "Alta" sem análise do TR?
- **P7. Alvo de toque:** manter 44 px, como no plano antigo, ou adotar 32/36/40 px, como no Geist?
- **P8. Tema claro:** qual modo é o padrão? Os valores do Geist no claro ainda precisam ser medidos.
- **P9. Documentos antigos:** apagar os dois arquivos substituídos e os ativos de `docs/produto/assets`, ou guardá-los?
- **P10. CATMAT:** `catmat.test.tsx` falha na suíte completa e passa sozinho. Ainda sem medição na `main`; precisa ser
  resolvido antes do PR?

## Linha proposta para `docs/produto/ESCOPO.md`

| 11 | Marca e linguagem visual | NEXOR Licitações e Geist no Dashboard | 0040 (`parada`) | a decidir |

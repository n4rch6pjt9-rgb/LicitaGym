# 0045: Tirar credenciamento de leads (regra "credenciamento nunca vira lead")

- **Status:** parada (09/11/2026: o Marcelo decidiu que credenciamento vira oportunidade numa aba própria; substituída
  pela spec 0046. As medições abaixo seguem válidas como registro.)
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades, "no ar, em ajuste"). Não alimenta fase
  da spec-mãe 0032. Pela "regra de foco" do `ESCOPO.md`, o Marcelo decide se entra como correção de regra já decidida
  ou fica `parada` (ver Perguntas em aberto).
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** coletor (`services/coletor-externo/`), reclassificação de dado de produção
- **Depende do ok do Marcelo:** sim (mudança de classificação com backfill em produção)

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` | como roda, testa e entrega; o que não fazer | sim |
| 2 | `AGENTS.md` | zero alucinação; não duplicar conceito | sim |
| 3 | `.claude/rules/regras-negocio.md` | "contrato de serviço (credenciamento...) nunca vira lead"; TR é a fonte do escopo | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 1; "Fora de escopo: contrato de serviço: credenciamento..." | não: ler |
| 5 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 6 | `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/pncp.md`, `.claude/rules/tests.md` | convenções do coletor e dos testes | ao abrir a pasta: ler antes |
| 7 | `services/coletor-externo/coletor/pncp.py` (`avaliar`, `motivo_prioridade`, gravação da linha ~1484) | onde a compra é classificada e onde `modalidade` é gravada | não: ler |
| 8 | `services/coletor-externo/coletor/escopo.py` (`excluir_compra`, `servico_sem_material`) | exclusões de compra que já existem | não: ler |
| 9 | `services/coletor-externo/coletor/reclassificar_escopo_pncp.py` (docstring, `SELECT`, `_nova_prioridade`) | backfill: compra fora do escopo vai para `prioridade = NULL`, dry-run por padrão | não: ler |
| 10 | `supabase/functions/api-dashboard-oportunidades/query.ts` (`applyOportunidadesScope`) e `README.md` da função | por que NULL já fica fora de Oportunidades | não: ler |
| 11 | `supabase/migrations/20261026000000_varredura_certames_historico.sql` (view `licitacoes_externas_prioridade_efetiva`) | a view só rebaixa; não muda nesta spec | não: ler |
| 12 | `supabase/migrations/20261004140000_objeto_canonico.sql` | `objeto_categoria = 'credenciamento'` é regex `CREDENCIAMENTO` sobre o objeto | não: ler |
| 13 | `services/coletor-externo/tests/test_escopo_servicos.py`, `tests/test_reclassificar_escopo_pncp.py` | padrão dos testes (Angatuba, id 229) | não: ler |
| 14 | `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md`, `.claude/skills/verificar-producao/SKILL.md` | revisão e verificação | quando invocados |

## Problema

Medido em 09/11/2026 em `public.licitacoes_externas` (MCP somente leitura, prioridade **gravada**; a view efetiva não é
legível pelo papel do MCP, então "prazo aberto" abaixo é `data_fim > now()`, não a prioridade efetiva):

- 44 compras são credenciamento: 43 com `modalidade = 'Credenciamento'` (único valor de modalidade com "credenc") e 1
  só pelo texto do objeto (id 191, Inexigibilidade, já com `prioridade` NULL). Todas `fonte = 'pncp'`.
- **18 estão em `leads`**: 15 com `objeto_categoria = 'credenciamento'` (12 `fraco`, 2 `forte`, 1 `piso`) e 3 com
  modalidade Credenciamento e outra categoria (`aquisicao_material`/fraco, `equipamento_fisioterapia`/forte,
  `servico_manutencao`/fraco). 17 das 18 têm `data_fim` futura.
- Outras: 3 em `monitorar`, 6 em `historico`, 17 já com `prioridade` NULL (fora do escopo).
- Das 18 em `leads`: 0 no pipeline (`pipeline_oportunidades`), 0 com `decisoes_comerciais`, 0 com
  `licitacao_escopo_decisao`, 0 com `agente_execucoes`.
- Exemplo: id 125 (PNCP `31710696000173-1-000003/2026`), credenciamento de material de expediente; `fraco` porque 13 de
  148 itens são bolas e uma mesa de tênis de mesa.

Causa: `pncp.avaliar` só tira da compra o credenciamento de **serviço de pessoas** (`servico_sem_material`);
credenciamento de fornecimento de material passa. `motivo_prioridade` decide só pelo estado da compra e
`applyOportunidadesScope` não olha `modalidade` nem `objeto_categoria`.

## Onde corrigir (decisão proposta)

| Opção | O que muda | A favor | Contra |
|---|---|---|---|
| **A. Coletor + reclassificador (proposta)** | `avaliar` devolve fora do escopo para credenciamento; o reclassificador grava `prioridade = NULL` nas linhas existentes | é o caminho que já existe para compra fora do escopo (id 229, 02/10/2026); um lugar só decide escopo; `applyOportunidadesScope` já esconde NULL; sem migration | precisa de backfill com dry-run; só vale para PNCP (hoje todas as 44 são PNCP) |
| B. View `licitacoes_externas_prioridade_efetiva` | `case` novo devolvendo NULL para credenciamento | vale para toda fonte | migration em view usada por BI e API; a view hoje "só rebaixa" para `monitorar`/`historico`, NULL seria semântica nova; segunda implementação do conceito de escopo (contra `AGENTS.md`) |
| C. Recorte da API | `applyOportunidadesScope` filtra modalidade/categoria | rápido | dado gravado continua errado (BI, contagens, `prioridade = leads` no banco); terceira regra de escopo; com filtro explícito de prioridade a linha voltaria |

A spec segue a opção **A**. B e C ficam fora de escopo (ver Perguntas em aberto se o Marcelo quiser defesa extra).

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `coletor.escopo.credenciamento(compra) -> bool` (nova, pura) | `modalidade` da compra (`modalidade_licitacao_nome` da busca, `modalidadeNome` do detalhe ou coluna `modalidade` da linha gravada) e o objeto | `True` quando a modalidade normalizada é `CREDENCIAMENTO` **ou** o objeto normalizado começa por / contém `CREDENCIAMENTO` como natureza do objeto (mesma regra de `objeto_categoria`) | nenhum (ausente = `False`) | coletor e reclassificador |
| K-2 | `coletor.pncp.avaliar` | compra + itens | com K-1 verdadeiro: `(None, False, {n: (None, False)})`, igual a `excluir_compra`/`servico_sem_material` | — | coletor PNCP |
| K-3 | `coletor.reclassificar_escopo_pncp` (dry-run e `--apply`) | linhas PNCP (o `SELECT` passa a ler `modalidade`) | compra credenciamento: `categoria_escopo = NULL`, `interesse_borracha = false`, `prioridade = NULL`; relatório com `transicoes_prioridade` | dry-run por padrão; `--apply` só com ok do Marcelo | desenvolvedor, com `service_role` fora do código |
| K-4 | dado de produção (backfill) | as 44 linhas credenciamento | 0 linhas credenciamento com `prioridade = 'leads'` | — | Marcelo autoriza; desenvolvedor roda |

Contrato com o Dashboard: inalterado (NULL já fica fora de Oportunidades sem filtro). Nenhuma Edge Function muda.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-2 | **Dado** a compra do id 125 (modalidade "Credenciamento", objeto de material de expediente, itens com bolas e mesa de tênis de mesa), **quando** `avaliar` roda, **então** a categoria é `None` e todo item é `(None, False)`. Regressão do caso real. | pytest `services/coletor-externo/tests/test_escopo_credenciamento.py` |
| CA-2 | K-1, K-2 | **Dado** compra com modalidade "Credenciamento" cujo objeto não cita credenciamento e tem item `forte` (caso `equipamento_fisioterapia`/forte), **quando** `avaliar` roda, **então** a categoria é `None`. | pytest `.../test_escopo_credenciamento.py` |
| CA-3 | K-1, K-2 | **Dado** compra de modalidade Inexigibilidade cujo objeto é "CREDENCIAMENTO DE PESSOAS ... TREINAMENTO" (id 191), **quando** `avaliar` roda, **então** a categoria é `None`. | pytest `.../test_escopo_credenciamento.py` |
| CA-4 | K-1 | **Dado** pregão eletrônico de aquisição de equipamento de musculação sem "credenciamento" no objeto nem na modalidade, **quando** `avaliar` roda, **então** a categoria continua a de hoje (`forte`/`catmat`), sem regressão. Inclui os casos de `test_escopo_casos_compartilhados.py` passando sem mudança. | pytest `.../test_escopo_credenciamento.py` + suíte existente |
| CA-5 | K-3 | **Dado** linha gravada `prioridade = 'leads'`, `modalidade = 'Credenciamento'`, **quando** o reclassificador roda em dry-run, **então** `prioridade_depois` é NULL, a transição `leads->NULL` é contada e nada é gravado (cliente somente leitura). | pytest `services/coletor-externo/tests/test_reclassificar_escopo_pncp.py` |
| CA-6 | K-3 | **Dado** o mesmo cenário com `--apply`, **quando** roda, **então** grava só `categoria_escopo`, `interesse_borracha` e `prioridade` (NULL) daquela linha; itens e documentos não são apagados. | pytest `.../test_reclassificar_escopo_pncp.py` |
| CA-7 | K-4 | **Dado** o backfill aplicado, **quando** se consulta `licitacoes_externas` com `prioridade = 'leads' and (modalidade = 'Credenciamento' or objeto_categoria = 'credenciamento')`, **então** o resultado é 0. | consulta da skill `verificar-producao` registrada no PR |

Controle de acesso: a spec não cria nem altera ação de API, ACL ou RLS; o backfill roda com `service_role` lido do
ambiente, nunca do código. Por isso não há CA de outro tenant (`licitacoes_externas` não tem `tenant_id`).

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2 | `/spec` | `/implement` (TDD) | pytest do coletor | `revisor-codigo` | — (o coletor roda no Cloud Run Job; ver Impacto) |
| K-3 | `/spec` | `/implement` (TDD) | pytest do coletor | `revisor-codigo` + `revisor-seguranca` (script com `service_role`) | — |
| K-4 | `/spec` | desenvolvedor roda dry-run, anexa ao PR; `--apply` só com ok do Marcelo | CA-7 | — | skill `verificar-producao` |

## Dry-run (contagem antes/depois)

Antes = medido em 09/11/2026 (prioridade gravada). Depois = efeito esperado da regra K-1 sobre as mesmas linhas, por
consulta SQL somente leitura, **não** pelo reclassificador. O dry-run do reclassificador
(`python -m coletor.reclassificar_escopo_pncp --consultar-pncp`, com itens) **não foi medido** nesta spec (exige
`service_role`); o `/implement` roda e anexa o relatório (`transicoes_prioridade`) ao PR antes do `--apply`.

| prioridade gravada | antes (credenciamento) | depois |
|---|---|---|
| `leads` | 18 | 0 |
| `monitorar` | 3 | 0 |
| `historico` | 6 | 0, ou 6 se o Marcelo decidir preservar o histórico (pergunta 2) |
| NULL | 17 | 44 (ou 38) |

Compras fora de credenciamento: nenhuma mudança esperada (CA-4).

## Fora de escopo

- Mudar a view `licitacoes_externas_prioridade_efetiva` (opção B) ou o recorte da API (opção C).
- Sistema S/Paradigma e Portal de Compras Públicas: hoje nenhuma das 44 linhas é dessas fontes
  (`paradigma.py` já trata "credenciamento" como serviço). Se aparecer, vira issue.
- Outros contratos de serviço da mesma regra (locação, manutenção, obra) que hoje viram lead: não medidos aqui.
- Latência do detalhe da oportunidade (branch `fix/detalhe-pncp-latencia`) e o erro de embed em `api-pipeline`
  (`listarCatalogo`), vistos no mesmo diagnóstico.

## Impacto em dados

- **Migration:** não.
- **Tabelas/views/funções tocadas:** `public.licitacoes_externas` (`categoria_escopo`, `interesse_borracha`,
  `prioridade`) e `public.licitacao_itens` (`categoria_escopo`, `interesse_borracha`), escritas pelo coletor PNCP e
  pelo reclassificador (`service_role`); lidas pela view efetiva → `api-dashboard-oportunidades` e BI.
- **ACL/RLS:** nenhum.
- **Backfill/reprocessamento:** sim, 44 linhas candidatas (18 leads), com dry-run anexado ao PR e `--apply` só com
  ok do Marcelo. Nenhuma linha apagada.
- **Edge Functions republicadas no merge:** o merge na `main` republica todas, sem mudança de código nelas.
  O coletor novo só vale depois do deploy do Cloud Run Job (ver `services/coletor-externo/README.md`).
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:** `modalidade` vem do PNCP (`modalidadeNome`/`modalidade_licitacao_nome`); escopo e
  prioridade são derivados. Nada é inventado; a linha e a proveniência ficam.

## Decisões do Marcelo

- (pendente)

## Perguntas em aberto

1. **Foco:** a spec alimenta o módulo 1, não uma fase da 0032. Entra agora como correção de regra já decidida
   (`regras-negocio.md`, `ESCOPO.md` "Fora de escopo") ou fica `parada`?
2. **Histórico:** as 6 compras credenciamento em `historico` também vão para NULL (somem do BI de preços), ou ficam
   em `historico` e a regra só impede `leads`/`monitorar`?
3. **Texto x modalidade:** basta a modalidade oficial "Credenciamento", ou o objeto com "CREDENCIAMENTO" em outra
   modalidade (hoje só o id 191, Inexigibilidade) também tira do escopo? A spec assume as duas.
4. **Exceção:** existe credenciamento de **fornecimento** de equipamento que a Konnen disputaria? Se sim, a regra
   absoluta perde lead real; hoje 2 das 18 são `forte` e 1 é `piso` (conferir pelo TR antes do `--apply`).
5. **Defesa extra:** quer também o filtro no recorte da API (opção C) enquanto o reclassificador não roda, mesmo
   sendo uma segunda regra de escopo?

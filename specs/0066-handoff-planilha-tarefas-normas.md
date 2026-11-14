# 0066: Executar o handoff da planilha `nexor_spec.xlsx` (tarefas, normas, sessão e unidade da oportunidade) em 7 PRs

- **Status:** aprovada (14/11/2026: respostas do Marcelo às 8 perguntas; PR-1 liberado)
- **Alimenta:** módulo 2 de `docs/produto/ESCOPO.md` (Pipeline e tarefas) e a spec-mãe 0032, fases 3 e 4 (agentes
  com tarefa, norma e evidência). Regra de foco suspensa desde 11/11/2026.
- **Repositório:** LicitaGym. O gerador de proposta (CHG-28) sai para a spec do módulo 4 (Proposta).
- **Issue:** nenhuma
- **Área:** migrations | scripts (`scripts/import-spec.ts`) | edge-functions (`_shared/sessao_alertas.ts`) | coletor
- **Depende do ok do Marcelo:** sim (migrations, ACL, regra de produto e dado de produção)

## Origem

`specs/nexor_spec.xlsx`, versão de 12/11/2026 15:33, que entrou no repositório pelo PR da spec 0065. Abas usadas:

- `Handoff_ClaudeCode`: a ordem dos PRs, a seção 2 "regras que não mudam", o que o `import-spec.ts` deve ler e o
  prompt de execução;
- `DB_Mudancas`: CHG-01 a CHG-31, com estado atual, estado proposto, dependências e critério de aceite;
- `DB_Dicionario`: campo a campo, com os status Mantém, Altera, Novo e Depreciar;
- `Auditoria_Abas`: qual aba vence em caso de conflito e o que fica de fora.

São fontes de evidência e de fixture `Sessao_DB_Vinculos`, `Oportunidade_DB_Vinculos` e `Comparacao_PE138_Tarefas`,
com o PE 138/2026 da SR/PF/AL e a Concorrência Eletrônica 14/2026 de Iguaraçu/PR (`Recorte_PR_Iguacu`,
`Sessao_PE138`, `Gabarito_edital_norma`).

### Prompt de execução (da aba `Handoff_ClaudeCode`, seção 4)

> Leia specs/nexor_spec.xlsx (versão anexada) nas abas DB_Dicionario, DB_Mudancas, Auditoria_Abas e
> Handoff_ClaudeCode. Execute os PRs na ordem de handoff_prs, um PR por vez, cada um com a migration, o teste
> supabase/tests/<nome>_check.sql e o critério de aceite da coluna 'critério de aceite' de db_mudancas. Siga as regras
> da seção 2 desta aba. Campos com status 'Mantém' em db_dicionario não podem mudar de tipo nem de regra; 'Altera'
> muda só como descrito; 'Novo' é aditivo; 'Depreciar' deixa de ser lido, sem apagar. Antes de cada PR, liste o que
> vai mudar e pare se encontrar no repositório algo diferente do 'estado atual' descrito na linha do CHG. Use as abas
> Sessao_DB_Vinculos, Oportunidade_DB_Vinculos e Comparacao_PE138_Tarefas como evidência e fonte das fixtures (PE 138
> da SR/PF/AL e Concorrência 14/2026 de Iguaraçu/PR).

### Regras que não mudam (seção 2 da aba `Handoff_ClaudeCode`)

- Migration aditiva e idempotente; nunca apagar dado; `lock_timeout` curto.
- Tabela nova com RLS ligada, `revoke` de `PUBLIC`/`anon`/`authenticated` e grant só a `service_role`. Função
  `security invoker` com `search_path` fixo.
- O tenant Konnen (etapas sem `fase_codigo`) não muda, e nada é reaplicado nele (CHG-19).
- Bloco gerado por `scripts/import-spec.ts` não é editado à mão: o `import_spec_test.ts` compara o bloco com a
  planilha.
- Condição: chave ausente = não verificada (null); `false` nunca é gravado; tarefa com condição falsa não nasce.
- Nenhuma data inventada: `prazo_em` só vem de SLA, de evento oficial (chat do Sistema ou PNCP) ou da equipe.
- Alerta só de mensagem do Sistema, salvo a exceção do CHG-14.
- Em conflito, `DB_Dicionario` e `DB_Mudancas` vencem o PRD, o `PRD_ClaudeCode` e o `PRD_v0.1`. Não usar `PRD_v0.1`
  nem `licitagym_sesc_126135_comparaca`.

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template. Específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/nexor_spec.xlsx` (abas acima) | a fonte do pacote |
| 5 | `specs/0017-*`, `specs/0018-tarefas-padrao-por-etapa.md`, `specs/0019-tarefas-equipe-instancia-por-certame.md`, `specs/0036-grupos-certame-e-regras-edital.md`, `specs/0041-calendario-feriados-e-gates-do-tr.md`, `specs/0044-*` | tarefas, unidade da oportunidade, feriados e legislação curada já especificados |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md`, `.claude/rules/tests.md` | convenções |
| 8 | `supabase/migrations/20260927100000_catalogo_tarefas_licitacao.sql`, `20261011110000_tarefas_equipe.sql`, `20261107180000_*` (regimes, `feriados_nacionais`), `20261107220000_nexor_modelos_nx.sql`, `20261108230000_*` (`blocos_legais`), `20261109010000_nexor_tenant_novo.sql`, `20261109030000_sessao_alertas.sql`, `20261011100500_*` (`norma_dispositivos`) | o estado atual de cada CHG |
| 8 | `scripts/import-spec.ts`, `tests/supabase/scripts/import_spec_test.ts`, `supabase/functions/_shared/sessao_alertas.ts`, `supabase/functions/_shared/prazos/dias-uteis.ts`, `services/coletor-externo/coletor/verificar_legislacao.py`, `services/coletor-externo/coletor/data/legislacao_corpus.json` | código tocado |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-tenant.md` | procedimento de cada etapa |

## Problema

O pacote da planilha (31 mudanças) só existe no `.xlsx`. Em 13/11/2026, cada "estado atual" de `DB_Mudancas` foi
conferido contra o repositório (`origin/main` em 2550222). **5 linhas divergem e 3 têm ressalva.** Pela regra do
prompt, o PR que contém uma delas para até a planilha ser corrigida ou a divergência ser decidida.

| CHG | Estado atual segundo a planilha | O que o repositório tem (13/11/2026) | Efeito |
|---|---|---|---|
| CHG-03 | `ordem` = ordem do código | `ordem` de 10 em 10 pela posição na etapa (`20261109010000:65-99`; NX-T18 com 10/11 em S11) | PR-2 para |
| CHG-12 | sem `prazo_evento` | `tarefas_catalogo.prazo_evento` já existe (text, FK `processo_eventos.codigo`, `20260927100000:115`) e é lido em `api-tarefas/repo.ts:10`. Faltam só `prazo_evento_offset` e `prazo_origem_ref`. Modelo NX com SLA já nasce `calculado` (`20261109010000:287-290`) | PR-5 para |
| CHG-22 | sem catálogo canônico de origem | há o corpus curado `coletor/data/legislacao_corpus.json` e a tabela `norma_dispositivos` | PR-7 para |
| CHG-26 | `chunk.normas_citadas[]` em texto; chunks na `20260929183258_sec_rag_chunks_*` | `normas_citadas` não existe; a `20260929183258` é o trigger de classificação, não a tabela de chunks | PR-3 para |
| CHG-29 | sem feriados nem dias úteis | `public.feriados_nacionais` com carga de 2026 e 2027 (`20261107180000:21`) e `somarDiasUteis`/`contarDiasUteis` em TS (`_shared/prazos/dias-uteis.ts:114,143`). Falta só a versão SQL | PR-5 para |
| CHG-16 (ressalva) | só `processo_fases.artigos` | também existem `public.regimes`, `norma_dispositivos` e `blocos_legais.base_legal` | `nx_norma` e `nx_regime_codigo` têm de reaproveitar, não duplicar (regra de arquitetura do `AGENTS.md`) |
| CHG-25 (ressalva) | temas em listas diferentes | os temas do RAG estão em `blocos_legais.temas_rag`; "topic" não existe | `nx_vocabulario_tema` parte de `blocos_legais` |
| CHG-28 (ressalva) | `nx_cert_*` digitados à parte | não há gerador de proposta nem `nx_cert_*` no repositório | PR-6 sem consumidor do CHG-28 |

As outras 23 linhas conferem. Exemplos:
- CHG-01: o check `^NX-T[0-9]{2}$` está em `20261107220000:69` e em `20261109010000:50`.
- CHG-02: há 23 modelos NX e nenhum NX-N, NX-C ou NX-P.
- CHG-13: só os tipos `convocacao_anexos` e `etapa_fechada`.
- CHG-19: 13 etapas sem `fase_codigo`, e nada é reaplicado.
- CHG-23: literais no gate da `20261109010000:239`.

## Contrato

Um contrato por PR do handoff, na ordem da aba. Os CHGs de cada PR estão em `DB_Mudancas`, com o estado proposto.

| ID | PR | CHGs | Objeto | Situação em 13/11/2026 |
|---|---|---|---|---|
| K-1 | PR-1 Estrutura aditiva | CHG-01, CHG-04, CHG-05 | check `^NX-[TNCP][0-9]{2}$`; `tarefas_catalogo.subetapa_codigo` e `nexor_subetapas`; `processo_fases.entrada_auto_pncp`, `entrada_auto_plataforma`, `fonte_gatilho`, `guardrail` | pode seguir |
| K-2 | PR-2 import-spec | CHG-02, 03, 05, 06, 18, 24 | 26 modelos NX-N, NX-C e NX-P; `ordem = sequencia × 10` (mantém o formato de 10 em 10); S08; leitura dos intervalos novos; ID `Origem.Regime.Etapa.Bloco.Seq-DV` | liberado (CHG-03 decidido em 14/11) |
| K-3 | PR-3 Normas e contexto | CHG-07, 08, 09, 16, 20, 21, 23, 25, 26, 27 | contexto v2; condição em jsonb; `licitacoes_externas.contexto_edital`; `nx_norma` (origem do corpus, ligada a `legislacao_corpus.json` e `norma_dispositivos` por `norma_id`), `nx_tarefa_norma`, `edital_norma`; crosswalk de regime como colunas novas em `public.regimes` (código do RAG, do Glossário e `norma_id`), sem `nx_regime_codigo`; `topic` acrescentado a `blocos_legais`, sem `nx_vocabulario_tema`; `licitacao_chunks.normas_citadas` (lista de `norma_id`) e `edital_norma.chunk_id` → `licitacao_chunks`; JSON Schema versionado | liberado (decisões de 14/11) |
| K-4 | PR-4 Unidade | CHG-10, 11 | `oportunidade_unidade`; tarefa por unidade (`escopo`, `unidade_id`, índice com `coalesce(unidade_id, 0)`) | pode seguir depois do PR-2 |
| K-5 | PR-5 Prazo e sessão | CHG-12, 13, 14, 29, 30 | prazo por evento sobre o `tarefas_catalogo.prazo_evento` que já existe: acrescenta `prazo_evento_offset` (quantidade, unidade, sentido) e `tarefas_equipe.prazo_origem_ref`; eventos que faltam (convocação de anexo, intenção de recurso, convocação da ata) entram como linhas novas em `processo_eventos` (o vocabulário do CHG-30); 6 tipos de alerta novos e `fase`; negociação vinda do pregoeiro; versão SQL de `somarDiasUteis`/`contarDiasUteis` sobre `feriados_nacionais`, com o mesmo resultado dos testes de `dias-uteis.ts`; certame estadual ou municipal → prazo marcado "sem calendário local" | liberado (decisões de 14/11) |
| K-6 | PR-6 Status por item e entrada automática | CHG-15, 17 | status de `oportunidade_unidade` pelo chat e pelo PNCP; card movido por evento. O CHG-28 sai para a spec do módulo 4; aqui fica só o critério e o benefício por unidade, que já estão no CHG-10 | liberado |
| K-7 | PR-7 Captação de normas | CHG-22 | `verificar_legislacao.py` lê `nx_norma` (url, formato, captação) como origem; o texto e os dispositivos continuam em `legislacao_corpus.json` e `norma_dispositivos` | liberado (decisão de 14/11) |

CHG-19 (tenant Konnen) vale em todo PR. CHG-31 (inteligência de órgão) está descartado.

## Critérios de aceite

Os critérios de cada CHG são os da coluna "critério de aceite" de `DB_Mudancas`. Cada PR leva um
`supabase/tests/<nome>_check.sql` (e o teste Deno ou pytest do código que tocar). Os desta spec são os que provam o
pacote:

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a migration, **quando** se insere o apelido NX-P01, NX-N01 ou NX-C01, **então** passa; NX-X01 falha com `check_violation`; os apelidos atuais continuam intactos (CHG-01). | SQL `supabase/tests/nexor_estrutura_aditiva_check.sql` |
| CA-2 | K-1, K-3, K-4 | **Dado** as tabelas novas (`nexor_subetapas`, `nx_norma`, `nx_tarefa_norma`, `edital_norma`, `oportunidade_unidade`), **então** RLS ligada, `anon` e `authenticated` sem privilégio e só `service_role` com acesso (negativo de acesso). | SQL `supabase/tests/nexor_handoff_acl_check.sql` |
| CA-3 | K-2 | **Dado** a planilha nova, **quando** roda o import-spec, **então** `select count(*) from tarefas_catalogo where norma = 'NX'` = 49; cada NX-[NCP]## tem apelido; a etapa S08 recebe 3 tarefas; o bloco gerado bate com a planilha (CHG-02, 06, 18). | Deno `tests/supabase/scripts/import_spec_test.ts` + SQL `supabase/tests/nexor_import_spec_check.sql` |
| CA-4 | K-3 | **Dado** a fixture de Iguaraçu, **então** `contexto_edital` traz `inversao_fases = true`, `garantia = 5` e `normas_citadas` com PR-DEC-4889-2005; PR-DEC-4889 ativa (citada) e PR-DEC-10086 não ativa (esfera municipal) (CHG-09, CHG-20). | SQL `supabase/tests/nexor_normas_contexto_check.sql` |
| CA-5 | K-4 | **Dado** a fixture do PE 138, **então** `oportunidade_unidade` tem 29 linhas (28 homologadas e 1 fracassada); a NX-T16 nasce uma vez por item da empresa e a NX-T10 uma vez por edital (CHG-10, CHG-11). | SQL `supabase/tests/oportunidade_unidade_check.sql` |
| CA-6 | K-4 | **Dado** um usuário do tenant A, **quando** lê `oportunidade_unidade` ou as tarefas por unidade do tenant B pela API, **então** 403 ou vazio, e nada do B aparece (negativo de tenant). | Deno `tests/supabase/functions/api_tarefas_unidade_test.ts` |
| CA-7 | K-5 | **Dado** os textos do PE 138 em fixture, **então** cada um gera 1 alerta do tipo certo; uma mensagem de licitante com o mesmo texto da negociação não gera alerta (CHG-13, CHG-14). | Deno `tests/supabase/functions/_shared/sessao_alertas_test.ts` |
| CA-8 | K-5 | **Dado** o calendário, **então** a impugnação de Iguaraçu cai em 18/11/2026 (feriado em 20/11) e a ata do PE 138 em 5 dias úteis depois de 28/10 = 04/11; a função SQL dá o mesmo resultado que `dias-uteis.ts` nos casos de teste dele; certame estadual ou municipal sai com a marca "sem calendário local" (CHG-29). | SQL `supabase/tests/nexor_dias_uteis_check.sql` |
| CA-9 | todos | **Regressão (CHG-19):** **dado** o tenant Konnen, **quando** qualquer migration do pacote roda, **então** nenhuma linha da Konnen muda em `tarefas_equipe`, `pipeline_etapas` e `pipeline_etapa_tarefas`. | SQL `supabase/tests/nexor_konnen_intacto_check.sql` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-3, K-4 (migrations) | `/spec` | skill `nova-migration` | SQL `_check` + skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL, RLS) + `revisor-tenant` (K-4: `tenant_id`) | skill `verificar-producao` + `get_advisors` |
| K-2 (import-spec) | `/spec` | `/implement` (TDD) | Deno `import_spec_test.ts` | `revisor-codigo` + `revisor-migration` (migration gerada) | `verificar-producao` |
| K-5 (sessão e prazo) | `/spec` | `/implement` + `nova-migration` | Deno + SQL | `revisor-codigo` + `revisor-seguranca` + `revisor-migration` | `verificar-producao` |
| K-6 (status e entrada automática) | `/spec` | `/implement` | Deno + SQL | `revisor-codigo` + `revisor-tenant` | `verificar-producao` |
| K-7 (coletor de normas) | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | `verificar-producao` |

## Fora de escopo

- CHG-31 (inteligência de órgão; descartado na planilha).
- Gerador de proposta (CHG-28): não existe no repositório (ver pergunta 4).
- Tela do Dashboard para as tarefas por unidade e o status por item: entra depois do backend, numa spec do
  Dashboard.
- Abas `PRD_v0.1` e `licitagym_sesc_126135_comparaca` (a planilha manda não usar).

## Impacto em dados

- **Migration:** sim, uma ou mais por PR, todas aditivas e idempotentes, com `lock_timeout` curto.
- **Tabelas/views/funções tocadas:**
  - novas: `nexor_subetapas`, `oportunidade_unidade`, `nx_norma`, `nx_tarefa_norma` e `edital_norma`;
  - colunas novas em tabelas que já existem: `public.regimes` (crosswalk), `blocos_legais.topic`,
    `licitacao_chunks.normas_citadas`, `tarefas_catalogo.prazo_evento_offset`, `tarefas_equipe.prazo_origem_ref`;
    linhas novas em `processo_eventos`;
  - alteradas: `processo_fases`, `tarefas_catalogo`, `tarefas_catalogo_apelidos`, `nexor_etapa_tarefas_padrao`,
    `tarefas_equipe`, `sessao_alertas` e `licitacoes_externas` (`contexto_edital`);
  - funções alteradas: `tarefas_contexto_certame()`, `pipeline_etapa_tarefas_criar()` e
    `catalogo_condicao_avaliar()`.

  Quem lê e escreve: as colunas "Fonte na planilha" de `DB_Dicionario`.
- **ACL/RLS:** tabelas novas só `service_role`. As que têm `tenant_id` (`oportunidade_unidade`, `tarefas_equipe`) são
  lidas pela API com o filtro da empresa de quem chama (`_shared/tenant.ts`).
- **Backfill/reprocessamento:** carga das tabelas de normas pela planilha (44, 83, 6 e 221 linhas, segundo a
  planilha). O resto não tem backfill: tarefa nova nasce só em card novo (CHG-19).
- **Edge Functions republicadas no merge:** todas (regra do merge). Mudam `api-tarefas`, `api-pipeline` e o
  `_shared/sessao_alertas.ts` (sync da sessão).
- **Contrato com o Dashboard:** muda no PR-4 e no PR-6 (tarefas por unidade, status por item e card movido por
  evento). O backend vai antes.
- **Dado oficial x derivado:**
  - oficial: o texto do edital e o chat da sessão (Sistema e PNCP);
  - derivado: `contexto_edital` (com a página de cada valor), status por item, prazos por evento.

  Nenhuma data inventada.

## Decisões do Marcelo

- 14/11/2026, regra geral: aproveitar o que já existe e acrescentar só o que falta, sem tabela paralela.
- 14/11/2026, CHG-03: corrigir a regra de hoje, não a planilha. O import-spec grava `ordem = sequencia × 10`.
- 14/11/2026, CHG-12 e CHG-30: aproveitar `tarefas_catalogo.prazo_evento` (FK `processo_eventos`). Acrescentar só
  `prazo_evento_offset` (quantidade, unidade, sentido) e `tarefas_equipe.prazo_origem_ref`. O vocabulário de eventos
  é a própria `processo_eventos`, e os eventos que faltam entram como linhas novas.
- 14/11/2026, CHG-29: aproveitar `feriados_nacionais` e escrever em SQL as funções de `dias-uteis.ts`, com o mesmo
  resultado nos testes. Feriados estaduais e municipais ficam para depois (PRD 3.2). Até lá, o prazo de certame
  estadual ou municipal leva a marca "sem calendário local", e a equipe confere. O 20/11 de Iguaraçu é nacional.
- 14/11/2026, CHG-28: sai para a spec do módulo 4 (Proposta). Aqui fica só o critério e o benefício por unidade
  (CHG-10).
- 14/11/2026, CHG-22: `nx_norma` é a origem do corpus, não um substituto. `legislacao_corpus.json` e
  `norma_dispositivos` continuam guardando o texto e os dispositivos, ligados pelo `norma_id`.
- 14/11/2026, CHG-26: a referência é a tabela de chunks que a ingestão grava hoje, `public.licitacao_chunks`
  (`coletor/indexador.py`). `normas_citadas` entra nela como coluna nova (lista de `norma_id`), e
  `edital_norma.chunk_id` aponta para ela.
- 14/11/2026, CHG-16 e CHG-25: o crosswalk de regime vira colunas novas em `public.regimes` (código do RAG, do
  Glossário e `norma_id`); o vocabulário de temas parte de `blocos_legais` (`temas_rag` existe; entra `topic`). Não
  se criam `nx_regime_codigo` nem `nx_vocabulario_tema`.
- 14/11/2026, ordem com a 0065: correm em paralelo. A 0065 não mexe em `tarefas_catalogo`,
  `pipeline_etapa_tarefas_criar`, `sessao_alertas` nem `import-spec.ts`; ela toca o coletor Paradigma e as tabelas
  do catálogo do Sistema S.
- 14/11/2026: o PR-1 (CHG-01, CHG-04, CHG-05) pode seguir já.
- 13/11/2026: incluir o handoff da planilha (abas `DB_Dicionario`, `DB_Mudancas`, `Auditoria_Abas` e
  `Handoff_ClaudeCode`) no rascunho, com o prompt de execução da seção 4 e as regras da seção 2.
- 12/11/2026 (registrado em `DB_Dicionario`): check NX-[TNCP]##; o tenant Konnen não muda.

## Perguntas em aberto

- Registro das decisões de 14/11 na planilha: acrescentar a coluna "decisão 0066" em `DB_Mudancas`, trocar
  "estado atual" e "estado proposto" das 8 mudanças que divergiram ou tiveram ressalva, e atualizar as linhas
  correspondentes de `DB_Dicionario` (por exemplo, `prazo_evento` passa de "Novo" para "Mantém" e o offset entra como
  "Novo"). Até isso entrar na planilha, esta spec vence a planilha nas 8 linhas.

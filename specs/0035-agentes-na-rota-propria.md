# 0035: Rodar os agentes de Edital e Jurídico na rota própria e enviar os alertas para a oportunidade

- **Status:** aprovada (Marcelo, 21/10/2026)
- **Alimenta:** spec-mãe 0032, fase 2 (ligação: o agente roda pelo botão e o resultado chega à oportunidade para revisão)
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma (pedido do Marcelo em 21/10, comentário no print da rota antiga `/agentes/editais`)
- **Área:** edge-functions | migrations | dashboard-contrato | dashboard-tela (rotas dos agentes, aba da oportunidade, Etapas e tarefas do pipeline)
- **Depende do ok do Marcelo:** sim (decisão de produto, migration e mudança na tela da oportunidade)

## Leitura obrigatória antes de implementar

Os itens 1 a 4 e 10 do template valem como estão. Arquivos específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` | fase 2, "Analisar" só no botão, revisão por admin e operação |
| 7 | `.claude/rules/edge-functions.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções das áreas |
| 8 | `supabase/functions/api-agentes/{index,repo,validation}.ts` | contrato atual (`analise_executar`, `analise_obter`, `analise_revisar`) |
| 8 | `supabase/functions/api-dashboard-oportunidades/README.md` | busca (`busca`/`q`) usada no filtro de oportunidade |
| 8 | Dashboard `src/components/intelligence/EditalAgentView.tsx`, `LegalAgentView.tsx`, `src/components/editais/EditalAnalysisView.tsx` | o formato aprovado (rota antiga) |
| 8 | Dashboard `src/components/opportunities/AnaliseAgentesTab.tsx` | a aba que esta spec substitui |
| 8 | `supabase/migrations/20261011120000_pipeline_etapa_tarefas.sql`, `20261011110000_tarefas_equipe.sql` | modelo de tarefa por etapa e instância por licitação (origem, responsável) |
| 8 | `supabase/functions/api-pipeline/` (tarefas por etapa) e `api-tarefas/` | onde o modelo é salvo e onde a tarefa nasce |
| 8 | `specs/0018-*.md`, `specs/0019-*.md` | regras de tarefa padrão por etapa e de responsável |

## Problema

Em 21/10 o Marcelo não aprovou o formato da aba "Análise dos agentes" (Dashboard #102) e pediu para avaliar a rota antiga
do Agente de Edital. A rota antiga tem o formato que ele quer: seletor de oportunidade, documentos oficiais listados,
riscos com trecho e página, citações verificáveis e o atalho para o Agente Jurídico. Mas tudo nela é dado de exemplo
(`EditalAgentView.tsx` tem a resposta fixa da cláusula 8.4.2) e só aparece para o admin da plataforma como protótipo.

Comentário dele no print (21/10):
- "Criar filtro de pesquisa de oportunidade."
- "Selecionada, documentos oficiais devem ser listados."
- "A função do agente de edital de análise deve ser feita por essa rota e depois enviada para a aba de oportunidade com os
  alertas nesse formato em badge para análise."
- "Isso vale também para o agente jurídico."

Respostas dele às perguntas da spec (21/10, com print da tela "Etapas e tarefas do pipeline"):
- "Só as do pipeline na fase de Nova."
- "Devemos criar na rota de Etapas e tarefas do pipeline: já criar tarefa default por agente."
- "Criação de tarefas também deve considerar o role: usuários cadastrados e Agentes, com o nome da API de execução, para
  deixar preparado para futuros eventuais usos de agentes em novas etapas."

E, na mesma manhã: "não quero nada de múltipla escolha". Nesta spec isso quer dizer que a tela não tem checklist
Exige / Não exige / Não encontrado nem filtro por tipo de achado. Um item dispensado pelo edital não vira alerta.

## Desenho

1. **Rota do Agente de Edital (`/agentes/editais`)**, com dado real, mantendo o formato da rota antiga:
   - um campo de busca de oportunidade no lugar do seletor fixo;
   - ao escolher, a coluna "Documentos oficiais" lista os documentos da licitação, com nome, data, páginas e situação
     (baixado, indexado, erro);
   - o botão **"Analisar"** roda o agente de edital;
   - o resultado aparece no formato antigo:
     - o risco principal em destaque, com evidência e página;
     - os demais riscos, cada um com a página;
     - as citações verificáveis (documento, página e trecho);
     - o botão "Fundamentar no Agente Jurídico".
   - o botão **"Enviar para a oportunidade"** manda os alertas para a aba da oportunidade.
2. **Rota do Agente Jurídico (`/agentes/juridico`)**, no mesmo padrão: busca, documentos, "Analisar", base legal por alerta
   (artigo, se o texto foi conferido com a fonte oficial, peça sugerida) e "Enviar para a oportunidade".
3. **Aba da oportunidade:** só mostra o que foi enviado. Cada alerta é um **badge**, por exemplo "Visita técnica
   obrigatória · pág. 23". O clique abre o trecho e a página. Cada badge é aprovado ou rejeitado ali (rejeitar exige
   nota). Um link "Abrir no Agente de Edital" leva para a rota com a oportunidade já escolhida.

4. **Tarefa de agente nas "Etapas e tarefas do pipeline"** (`/configuracoes/pipeline`, aba "Tarefas por etapa"):
   - o responsável de uma tarefa passa a ter três tipos: **papel** (admin ou operação, como hoje), **usuário cadastrado**
     na empresa e **agente**;
   - um agente vem de um catálogo de agentes, com nome e a **API de execução** (ex.: `api-agentes` / `edital`). A tela mostra
     a API ao lado do nome, e um agente novo entra só por linha nova no catálogo, sem mudar a tela;
   - cada empresa já nasce com uma **tarefa padrão por agente na etapa Nova**: "Analisar o edital" (Agente de Edital) e
     "Conferir a base legal" (Agente Jurídico). O admin pode tirá-las ou pôr tarefa de agente em outra etapa.
5. **Quais oportunidades a busca encontra:** só as do pipeline da empresa que estão numa etapa com tarefa ativa daquele
   agente. Com a semente, isso é a etapa **Nova**. Se o admin puser a tarefa do agente em outra etapa, a busca acompanha.
6. **A tarefa do agente na licitação:** nasce com o responsável "Agente de Edital" quando a oportunidade entra na etapa. O
   cartão da tarefa leva para a rota do agente com a oportunidade escolhida. "Enviar para a oportunidade" liga a execução à
   tarefa, e a tarefa só é concluída quando a execução é aprovada na aba.

Fluxo: oportunidade entra em Nova → nasce a tarefa do agente → Analisar (rota) → revisar na rota → Enviar → badges na
aba → aprovar (conclui a tarefa) ou rejeitar com nota (a tarefa volta a aberta).

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-0 | `api-agentes` `action=oportunidades_buscar` | `agente` (`edital`\|`juridico`), `busca` (texto, opcional), `pagina` | oportunidades do pipeline da empresa que estão numa etapa com tarefa ativa daquele agente: `licitacao_id`, número, órgão, UF, objeto, etapa, prazo | 400 / 401 / 403 | membro da empresa |
| K-1 | `api-agentes` `action=documentos_listar` | `licitacao_id` | `documentos[]`: `id`, `secao`, `nome` (`nome_original` ou `arquivo_origem`), `data_documento`, `status_processamento`, `paginas` (páginas distintas em `licitacao_chunks`, `null` se não indexado), `erro` | 400 / 401 / 403 / 404 | membro da empresa (admin ou operação); admin da plataforma |
| K-2 | `api-agentes` `action=analise_executar` ganha `agentes` opcional | `licitacao_id`, `proposta`, `agentes?: ("edital"\|"juridico"\|"preco")[]` | igual ao atual, só com os agentes pedidos. `juridico` roda o `edital` antes quando a execução de edital falta ou está desatualizada (o jurídico usa os sinais do edital) | 400 (agente desconhecido) | membro da empresa |
| K-3 | migration: `agente_execucoes.enviada_em timestamptz`, `enviada_por uuid` | — | colunas novas, nulas por padrão; ACL inalterada (só `service_role`) | — | — |
| K-4 | `api-agentes` `action=analise_enviar` | `execucao_id` | `execucao` com `enviada_em` e `enviada_por` | 404; 409 se desatualizada (mesma regra do `analise_revisar`); 409 se já enviada | membro da empresa |
| K-5 | `api-agentes` `action=analise_obter` ganha `somente_enviadas?: boolean` | `licitacao_id`, `somente_enviadas` | execuções enviadas (a aba usa `true`; a rota usa o padrão `false`) | — | membro da empresa |
| K-6 | `api-agentes` `action=analise_revisar` | igual | igual; 409 se a execução não foi enviada | 409 | membro da empresa |
| K-10 | migration: catálogo `public.agentes_catalogo` (`codigo`, `nome`, `api`, `acao_api`, `agente_api`, `ativo`), semente `edital` e `juridico` (`api-agentes` / `analise_executar` / `agentes:[...]`) e `preco` (inativo nesta spec) | — | tabela nova, só `service_role` | — | — |
| K-11 | migration: responsável no modelo e na instância. `pipeline_etapa_tarefas` e `tarefas_equipe` ganham `responsavel_tipo` (`papel`\|`usuario`\|`agente`, padrão `papel`), `responsavel_user_id` (no modelo) e `responsavel_agente` (FK para `agentes_catalogo`). Nova `origem = 'agente'` no modelo, com `chave` e `titulo`. Check: `agente` exige `responsavel_agente`; `usuario` exige `responsavel_user_id` membro da empresa | — | colunas novas com padrão que mantém o comportamento atual | — | — |
| K-12 | migration: semente da tarefa padrão por agente na etapa Nova de cada empresa (idempotente, por `chave` fixa `agente-edital` e `agente-juridico`) e o mesmo na criação de empresa nova | — | 2 linhas por empresa, com contagem antes/depois no PR | — | — |
| K-13 | `api-pipeline`, salvar tarefas por etapa: aceita `responsavel_tipo`, `responsavel_user_id` (só membro ativo da empresa) e `responsavel_agente` (só agente ativo do catálogo); listar devolve o catálogo de agentes com `api` para a tela | — | — | 400 (usuário de outra empresa, agente inexistente ou inativo) | admin da empresa |
| K-14 | liberação de tarefa (`tarefas_equipe_liberar` e a entrada na etapa): copia o responsável do modelo; tarefa de agente nasce `aberta` com `responsavel_agente` | — | — | — | — |
| K-15 | `analise_enviar` (K-4) liga a execução à tarefa de agente aberta da licitação; `analise_revisar` aprovada conclui a tarefa; rejeitada a devolve a `aberta` | — | — | — | — |
| K-16 | Dashboard, "Etapas e tarefas do pipeline", aba "Tarefas por etapa": campo **Responsável** nas tarefas (papel, usuário cadastrado ou agente) e um terceiro quadro **Tarefa de agente** (escolher o agente; a tela mostra o nome e a API de execução) | K-13 | — | — | admin da empresa |
| K-7 | Dashboard `/agentes/editais` real (sai do protótipo) | busca → K-0; K-2 com `agentes:["edital"]`; K-4 | formato da rota antiga, com dado real | estados de carregando, vazio, erro e "em preparação" | membro da empresa |
| K-8 | Dashboard `/agentes/juridico` real | busca; K-1; K-2 com `agentes:["juridico"]`; K-4 | base legal por alerta e "Enviar para a oportunidade" | idem | membro da empresa |
| K-9 | Dashboard, aba da oportunidade | K-5 com `somente_enviadas:true`; K-6 | badges dos alertas enviados; aprovar/rejeitar por execução; link para a rota | sem nada enviado: "Nenhuma análise enviada. Abrir no Agente de Edital" | membro da empresa |

O que **não** vira badge: achado `dispensa.*` (o edital diz que não exige) e achado informativo sem risco. Eles continuam
visíveis na rota, como fato com trecho e página, mas não vão para a aba.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-0 | K-0 | **Dado** a #3558 na etapa Nova e outra oportunidade em Qualificação, **quando** `oportunidades_buscar` com `agente:"edital"`, **então** só a #3558 volta. Fora do pipeline nunca volta. | Deno `tests/supabase/functions/agentes_busca_test.ts` |
| CA-0b | K-0 | **Dado** o admin pôs a tarefa do Agente de Edital também em Qualificação, **então** a busca passa a trazer as duas. | idem |
| CA-0c | K-0 | **Dado** um usuário de outra empresa, **então** nenhuma oportunidade desta empresa volta. | idem |
| CA-1 | K-1 | **Dado** a licitação #3558 com 8 documentos, **quando** `documentos_listar`, **então** volta 8 itens com `status_processamento` e `paginas` (`null` nos não indexados). | Deno `tests/supabase/functions/agentes_documentos_test.ts` |
| CA-2 | K-1 | **Dado** um usuário sem vínculo com empresa, **quando** `documentos_listar`, **então** 403. | idem |
| CA-3 | K-2 | **Dado** `agentes:["edital"]`, **quando** `analise_executar`, **então** só a execução de edital é gravada. | Deno `tests/supabase/functions/agentes_contrato_test.ts` |
| CA-4 | K-2 | **Dado** `agentes:["juridico"]` sem execução de edital, **quando** executa, **então** grava edital e jurídico, e o jurídico usa os sinais do edital recém-gravado. | idem |
| CA-5 | K-2 | **Dado** `agentes:["xyz"]`, **então** 400. | Deno `tests/supabase/functions/agentes_contrato_test.ts` |
| CA-6 | K-3 | **Dado** a migration aplicada, **então** as colunas existem, são nulas por padrão e `anon`/`authenticated` continuam sem acesso à tabela. | SQL `supabase/tests/agente_execucoes_check.sql` |
| CA-7 | K-4 | **Dado** uma execução atual, **quando** `analise_enviar`, **então** `enviada_em` e `enviada_por` ficam preenchidos. Na segunda vez, 409. | Deno `tests/supabase/functions/agentes_envio_test.ts` |
| CA-8 | K-4 | **Dado** uma execução desatualizada, **quando** `analise_enviar`, **então** 409 "Análise desatualizada". | idem |
| CA-9 | K-4 | **Dado** uma execução de outra empresa, **quando** `analise_enviar`, **então** 404 (nunca cai em outra empresa). | idem |
| CA-10 | K-5 | **Dado** uma execução enviada e outra não, **quando** `analise_obter` com `somente_enviadas:true`, **então** volta só a enviada. | Deno `tests/supabase/functions/agentes_envio_test.ts` |
| CA-11 | K-6 | **Dado** uma execução não enviada, **quando** `analise_revisar`, **então** 409. | Deno `tests/supabase/functions/agentes_envio_test.ts` |
| CA-12 | K-7 | **Dado** o modo supabase, **quando** abre `/agentes/editais`, **então** não há texto de exemplo (nenhum "8.4.2", "Edital_PE_048_2026") nem banner de protótipo. | vitest `src/test/agente-edital-rota.test.tsx` |
| CA-13 | K-7 | **Dado** uma busca "Horizontina", **quando** escolhe a #3558, **então** a coluna lista os documentos de K-1 com página e situação. | idem |
| CA-14 | K-7 | **Dado** o clique em "Analisar", **então** a chamada é `analise_executar` com `agentes:["edital"]`, e os riscos aparecem com trecho e página. Não há checklist Exige / Não exige nem filtro por tipo. | idem |
| CA-15 | K-7 | **Dado** um resultado, **quando** "Enviar para a oportunidade", **então** a chamada é `analise_enviar` e a tela confirma com o link para a oportunidade. | idem |
| CA-16 | K-8 | Como CA-12 a CA-15, na rota do jurídico, com `agentes:["juridico"]` e o artigo de cada alerta. | vitest `src/test/agente-juridico-rota.test.tsx` |
| CA-20 | K-10, K-11 | **Dado** a migration, **então** `agentes_catalogo` existe com RLS ligada e sem grant para `anon`/`authenticated`; uma tarefa `agente` sem `responsavel_agente` é recusada; uma `usuario` sem `responsavel_user_id` é recusada; as linhas antigas ficam `papel`. | SQL `supabase/tests/agentes_catalogo_check.sql` |
| CA-21 | K-12 | **Dado** N empresas, **quando** a migration roda duas vezes, **então** há exatamente 2N tarefas de agente na etapa Nova. | SQL idem + contagem no PR |
| CA-22 | K-13 | **Dado** `responsavel_user_id` de outra empresa, **quando** salva, **então** 400 e nada muda. | Deno `tests/supabase/functions/pipeline_tarefas_responsavel_test.ts` |
| CA-23 | K-14 | **Dado** a #3558 entra em Nova, **então** nascem as tarefas "Analisar o edital" e "Conferir a base legal" com o responsável agente. | SQL `supabase/tests/tarefas_equipe_check.sql` |
| CA-24 | K-15 | **Dado** a execução enviada e aprovada, **então** a tarefa do agente fica `concluida`; rejeitada, volta a `aberta`. | Deno `tests/supabase/functions/agentes_envio_test.ts` |
| CA-25 | K-16 | **Dado** a aba "Tarefas por etapa", **então** o quadro "Tarefa de agente" lista os agentes do catálogo com a API (`api-agentes · edital`), e o campo Responsável oferece papel, usuários da empresa e agentes. | vitest `src/test/pipeline-config-tarefas.test.tsx` |
| CA-17 | K-9 | **Dado** uma execução enviada com 2 riscos e 1 `dispensa.amostra`, **então** a aba mostra 2 badges (com página) e nenhum para a dispensa. | vitest `src/test/analise-agentes.test.tsx` |
| CA-18 | K-9 | **Dado** nada enviado, **então** a aba mostra "Nenhuma análise enviada" e o link para `/agentes/editais` com a oportunidade escolhida. | idem |
| CA-19 | K-9 | **Dado** rejeitar sem nota, **então** o botão fica desabilitado; com nota, chama `analise_revisar`. | idem |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-0, K-1, K-2, K-4, K-5, K-6, K-13, K-14, K-15 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` | skill `verificar-producao` |
| K-3, K-10, K-11, K-12 | `/spec` | skill `nova-migration` | SQL check | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-7, K-8, K-9, K-16 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `run-dashboard` antes; `deploy-dashboard` depois |

## Fora de escopo

- **Perguntar ao edital em texto livre** (a caixa "Pergunte sobre este edital" da rota antiga). Precisa de backend novo, com
  citação obrigatória e sem resposta inventada. Vira spec própria.
- Leitor do documento com a cláusula destacada na página (`/editais/:id`). Fica para depois da K-7. Até lá, cada alerta
  mostra o trecho e a página.
- Agente de preço na rota própria. O botão "Ver no histórico de preços" do #102 continua na aba.
- Relatório em PDF.
- Peça jurídica (fase 4 da 0032).

## Impacto em dados

- **Migration:** sim, aditivas e idempotentes: `<timestamp>_agente_execucoes_envio.sql` (K-3), `<timestamp>_agentes_catalogo.sql` (K-10), `<timestamp>_tarefas_responsavel_agente.sql` (K-11, troca o check de origem do modelo por um que inclui `agente`) e `<timestamp>_tarefas_agente_semente.sql` (K-12).
- **Tabelas tocadas:** `agente_execucoes` (envio e ligação com a tarefa), `agentes_catalogo` (nova), `pipeline_etapa_tarefas` e `tarefas_equipe` (responsável), `licitacao_documentos` e `licitacao_chunks` (só leitura, K-1).
- **ACL/RLS:** `agentes_catalogo` com RLS ligada, `revoke all` e só `service_role`, como as demais. Nenhuma mudança nas outras.
- **Backfill:** a semente K-12 cria 2 tarefas de modelo por empresa (contagem antes/depois no PR). Tarefas já nascidas não mudam. Execuções antigas ficam com `enviada_em` nulo e não aparecem na aba até serem enviadas de novo (hoje são só testes).
- **Edge Functions republicadas no merge:** todas (regra do repositório). Muda a `api-agentes`.
- **Contrato com o Dashboard:** muda (ações novas `oportunidades_buscar`, `documentos_listar` e `analise_enviar`; responsável e catálogo de agentes na `api-pipeline`; `agentes` e `somente_enviadas` opcionais). O backend vai ao ar antes do front.
- **Dado oficial x derivado:** os documentos e os trechos vêm da fonte oficial indexada; o alerta é derivado por regra determinística, com fonte, trecho e página. Nada inventado.

## Relação com PRs abertos

- **LicitaGym #405** (dispensa "( X ) Não"): é regra do backend e evita alerta falso (amostra dispensada virando risco). Esta
  spec usa o resultado dela (dispensa não vira badge). Recomendação: manter o #405 e mergear antes do backend desta spec.
- **Dashboard #102** (aba atual): é substituído pela K-9. O que dele se aproveita: o aviso de análise desatualizada, o botão
  "Ver no histórico de preços" e a trava de protótipo só para admin. Recomendação: não mergear o #102; a K-9 parte dele num
  PR novo.

## Decisões do Marcelo

- 21/10: o formato da aba atual (#102) não está aprovado; a referência é a rota antiga do Agente de Edital.
- 21/10: sem múltipla escolha (nem checklist Exige / Não exige, nem filtro por tipo).
- 21/10: a análise de Edital e a do Jurídico rodam na rota própria e são enviadas para a aba da oportunidade como badges para análise.
- 21/10: a busca da rota traz só oportunidades do pipeline na etapa Nova (generalizado: etapa com tarefa daquele agente).
- 21/10: as Etapas e tarefas do pipeline já criam uma tarefa padrão por agente.
- 21/10: o responsável de uma tarefa pode ser usuário cadastrado ou agente; o agente carrega o nome da API de execução,
  para servir a agentes futuros em outras etapas.
- 21/10: "Enviar para a oportunidade" manda a análise inteira (sem escolher alerta por alerta).
- 21/10: protótipos da rota antiga só para o admin da plataforma até esta spec entrar (prazo para desligar: 21/11/2026).

## Perguntas em aberto

Nenhuma.

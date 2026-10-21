# 0035: Rodar os agentes de Edital e Jurídico na rota própria e enviar os alertas para a oportunidade

- **Status:** rascunho
- **Alimenta:** spec-mãe 0032, fase 2 (ligação: o agente roda pelo botão e o resultado chega à oportunidade para revisão)
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma (pedido do Marcelo em 21/10, comentário no print da rota antiga `/agentes/editais`)
- **Área:** edge-functions | migrations | dashboard-contrato | dashboard-tela
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

Fluxo: Analisar (rota) → revisar o resultado na rota → Enviar → badges na aba → aprovar/rejeitar na aba.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `api-agentes` `action=documentos_listar` | `licitacao_id` | `documentos[]`: `id`, `secao`, `nome` (`nome_original` ou `arquivo_origem`), `data_documento`, `status_processamento`, `paginas` (páginas distintas em `licitacao_chunks`, `null` se não indexado), `erro` | 400 / 401 / 403 / 404 | membro da empresa (admin ou operação); admin da plataforma |
| K-2 | `api-agentes` `action=analise_executar` ganha `agentes` opcional | `licitacao_id`, `proposta`, `agentes?: ("edital"\|"juridico"\|"preco")[]` | igual ao atual, só com os agentes pedidos. `juridico` roda o `edital` antes quando a execução de edital falta ou está desatualizada (o jurídico usa os sinais do edital) | 400 (agente desconhecido) | membro da empresa |
| K-3 | migration: `agente_execucoes.enviada_em timestamptz`, `enviada_por uuid` | — | colunas novas, nulas por padrão; ACL inalterada (só `service_role`) | — | — |
| K-4 | `api-agentes` `action=analise_enviar` | `execucao_id` | `execucao` com `enviada_em` e `enviada_por` | 404; 409 se desatualizada (mesma regra do `analise_revisar`); 409 se já enviada | membro da empresa |
| K-5 | `api-agentes` `action=analise_obter` ganha `somente_enviadas?: boolean` | `licitacao_id`, `somente_enviadas` | execuções enviadas (a aba usa `true`; a rota usa o padrão `false`) | — | membro da empresa |
| K-6 | `api-agentes` `action=analise_revisar` | igual | igual; 409 se a execução não foi enviada | 409 | membro da empresa |
| K-7 | Dashboard `/agentes/editais` real (sai do protótipo) | busca → `api-dashboard-oportunidades` `list` com `busca`; K-1; K-2 com `agentes:["edital"]`; K-4 | formato da rota antiga, com dado real | estados de carregando, vazio, erro e "em preparação" | membro da empresa |
| K-8 | Dashboard `/agentes/juridico` real | busca; K-1; K-2 com `agentes:["juridico"]`; K-4 | base legal por alerta e "Enviar para a oportunidade" | idem | membro da empresa |
| K-9 | Dashboard, aba da oportunidade | K-5 com `somente_enviadas:true`; K-6 | badges dos alertas enviados; aprovar/rejeitar por execução; link para a rota | sem nada enviado: "Nenhuma análise enviada. Abrir no Agente de Edital" | membro da empresa |

O que **não** vira badge: achado `dispensa.*` (o edital diz que não exige) e achado informativo sem risco. Eles continuam
visíveis na rota, como fato com trecho e página, mas não vão para a aba.

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
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
| CA-17 | K-9 | **Dado** uma execução enviada com 2 riscos e 1 `dispensa.amostra`, **então** a aba mostra 2 badges (com página) e nenhum para a dispensa. | vitest `src/test/analise-agentes.test.tsx` |
| CA-18 | K-9 | **Dado** nada enviado, **então** a aba mostra "Nenhuma análise enviada" e o link para `/agentes/editais` com a oportunidade escolhida. | idem |
| CA-19 | K-9 | **Dado** rejeitar sem nota, **então** o botão fica desabilitado; com nota, chama `analise_revisar`. | idem |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-4, K-5, K-6 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` | skill `verificar-producao` |
| K-3 | `/spec` | skill `nova-migration` | SQL check | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-7, K-8, K-9 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `run-dashboard` antes; `deploy-dashboard` depois |

## Fora de escopo

- **Perguntar ao edital em texto livre** (a caixa "Pergunte sobre este edital" da rota antiga). Precisa de backend novo, com
  citação obrigatória e sem resposta inventada. Vira spec própria.
- Leitor do documento com a cláusula destacada na página (`/editais/:id`). Fica para depois da K-7. Até lá, cada alerta
  mostra o trecho e a página.
- Agente de preço na rota própria. O botão "Ver no histórico de preços" do #102 continua na aba.
- Relatório em PDF.
- Peça jurídica (fase 4 da 0032).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_agente_execucoes_envio.sql` (aditiva, idempotente: `add column if not exists`).
- **Tabelas tocadas:** `agente_execucoes` (escreve `enviada_em`/`enviada_por` pela `api-agentes`), `licitacao_documentos` e `licitacao_chunks` (só leitura, K-1).
- **ACL/RLS:** nenhuma mudança; a tabela segue só para `service_role`, lida pela Edge Function com filtro de empresa.
- **Backfill:** não. Execuções antigas ficam com `enviada_em` nulo e não aparecem na aba até serem enviadas de novo (hoje são só testes).
- **Edge Functions republicadas no merge:** todas (regra do repositório). Muda a `api-agentes`.
- **Contrato com o Dashboard:** muda (ações novas `documentos_listar` e `analise_enviar`; `agentes` e `somente_enviadas` opcionais). O backend vai ao ar antes do front.
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
- 21/10: protótipos da rota antiga só para o admin da plataforma até esta spec entrar (prazo para desligar: 21/11/2026).

## Perguntas em aberto

1. A busca da rota encontra só oportunidades que já estão no pipeline da empresa, ou qualquer oportunidade? Recomendação:
   só do pipeline. A aba de destino só existe para oportunidade no pipeline, e assim nada roda sobre licitação que a
   empresa não escolheu.
2. "Enviar" manda a execução inteira ou o usuário escolhe quais alertas vão? Recomendação: a execução inteira. Quem
   revisa na aba aprova ou rejeita, e escolher alerta por alerta seria uma revisão em dobro.

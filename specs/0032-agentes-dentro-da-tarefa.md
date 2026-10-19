# 0032: Fazer os agentes de Edital, Preço e Jurídico trabalharem dentro das tarefas da oportunidade

- **Status:** em implementação (aprovada pelo Marcelo em 19/10)
- **Issue:** nenhuma (pedido do Marcelo em 19/10: "estamos andando em círculos, specs espalhadas")
- **Área:** edge-functions | coletor (indexação) | dashboard-contrato
- **Depende do ok do Marcelo:** sim (muda o que a tela de tarefas mostra e quando os agentes rodam)

Esta é a spec-mãe do objetivo final. As outras specs abertas só entram aqui como **insumo de uma fase**. O que não alimenta
uma fase fica parado (ver "Fora de escopo").

## Objetivo único

Para cada oportunidade no pipeline, as tarefas padrão de Triagem e Em análise (spec 0018) **já abrem com o parecer do agente
responsável**. Cada achado traz fonte, trecho e página. A equipe só aprova ou rejeita, e o resultado fica na própria tarefa.

**Caso de aceite (decisão do Marcelo, 19/10): uma esteira de ponta a ponta.** Oportunidade **#3558**, Município de
Horizontina (RS), Pregão Eletrônico 58/2026, SRP, **exclusivo ME/EPP**. Abertura em 29/10/2026. Item 67: 3 esteiras,
estimado de R$ 15.632,46 por unidade. É o único caso aberto com a cadeia completa publicada: **ETP, termo de referência,
pesquisa de preço, planilha de valores médios por CNPJ e edital retificado** (8 documentos, todos `pendente`, 0 chunks).

O texto do item exercita as três frentes de uma vez:

- **Edital e jurídico:** "esteira profissional", "motor AC", usuário de **180 a 200 kg**, mas potência de "**3.0 HP peak
  power**". Só pico, o que pela regra de mercado é cerca de 1,5 HP contínuo. A especificação é **inconsistente**: o perfil é
  profissional e o motor é de esteira residencial. Isso vira sugestão de pedido de esclarecimento (potência contínua mínima).
- **Restrição por lote:** edital exclusivo ME/EPP, contra o porte da empresa.
- **Preço:** a pesquisa de preço e a planilha por CNPJ estão publicadas, então o agente de preço confere o estimado contra
  as cotações do próprio órgão e contra a faixa praticada da classe "profissional / motor AC".

**Caso de controle:** **#3641**, Fundo Municipal de Saúde de Escada (PE), PE 049/2026, item 1: "5.0 HPM" (pico),
16 km/h, 130 kg, dobrável 73 × 177 × 131 cm, R$ 3.859,73. Termo e estimado coerentes entre si, mas residenciais. Serve de
caso em que a aderência de um produto profissional dá `supera` e o preço dá "abaixo do piso".

## Problema (medido em 19/10/2026)

| Fato | Evidência |
|---|---|
| Os agentes existem no código, mas **nunca rodaram em produção** | `_shared/agentes/{edital,preco,juridico,aderencia}.ts` e `api-agentes` na `main` (#307). `public.agente_execucoes` tem **0 linhas** |
| A tela de tarefas **não mostra nada dos agentes** | `/tarefas?licitacao=2540`: tarefa da empresa, "Prazo não informado", responsável "Fila dos admins" |
| O agente de edital **não tem o que ler** | #2540 tem 4 documentos e **0 chunks**. Só 99 licitações da base têm `licitacao_chunks` |
| O conhecimento produzido ficou fora do produto | estudo da esteira (CATMAT 373980: 106 preços e 7 termos de referência lidos), specs 0009, 0030 e 0031, painel de editais abertos |

**O ciclo que se repete:** cada estudo vira uma spec nova de dado, e nenhuma liga o dado à tarefa que o usuário abre.

## Mapa: tarefa → agente → o que aparece

| Etapa | Tarefa (0018) | Agente | O que a tarefa passa a mostrar | O estudo da esteira entra como |
|---|---|---|---|---|
| Triagem | Confirmar a aderência item a item | aderência | Por item: veredito `atende`, `supera`, `nao_atende`, `nao_comprovado`, `ambiguo` contra o catálogo da empresa | atributos que separam as linhas: potência **contínua × pico**, motor **AC × DC**, garantia do motor, norma (ASTM F2276 / EN 957), dimensões mínimas da lona |
| Triagem | Conferir as restrições de participação por lote | edital | ME/EPP por lote × porte da empresa, marca de referência, norma exigida, assistência técnica | marca de referência nomeada (TRT-2: Movement X 4.6; PF-ES: Movement/Matrix) |
| Em análise | Ler o edital | edital + jurídico | Exigências com trecho e página, **limite de impugnação**, peça sugerida (esclarecimento ou impugnação) com o artigo da 14.133 | sinal "especificação ambígua" ("3/5 HP", "entre 3 a 5 HP" sem contínuo/pico) → sugere **pedido de esclarecimento** |
| Em análise | Conferir o preço de referência contra o piso | preço | Referência praticada do item (mín. 5 homologados), faixa de exequibilidade, piso da empresa | referência pelo **mesmo CATMAT e mesma classe de termo de referência**. Alerta **"estimado incompatível com a especificação"** (Paranavaí: termo frouxo e estimado de R$ 7 mil; Itatiaiuçu: termo residencial e estimado de R$ 18 mil) |
| Em análise | Montar o dossiê por item | edital | Lista do exigido por item (ficha, certificado, atestado) | certificado de norma e garantia do motor como itens do dossiê |

## Achado na implementação da fase 1 (19/10)

A fase 1 já está quase toda construída (spec 0018, PR 4b): ao entrar em Triagem, a oportunidade ganha um pedido na fila
`private.job_queue` (`preparar_triagem`), e o job `coletor.preparar_triagem` baixa e indexa o edital. **O job não está
rodando:** 3 pedidos `pending` com 0 tentativas, o mais antigo de 11/10 (licitações 133, 3954 e 2540). Por isso
#2540 e #3558 têm 0 chunks. O que falta é **operação** (Marcelo: deploy do Cloud Run Job `preparar-triagem` e do
agendamento a cada 15 min, README do coletor) e, no código, a `api-agentes` dizer "em preparação". Esta segunda parte
entra neste PR (`preparacao`, `em_preparacao` e aviso `preparacao_indisponivel` em `analise_executar` e `analise_obter`).

## Fases (nesta ordem; cada uma termina com a #3558 funcionando)

1. **Insumo: o edital da oportunidade vira texto.** No clique em "Analisar", se os documentos ainda não estiverem
   indexados, eles são baixados e indexados (`licitacao_chunks`), e a tarefa mostra "análise em preparação" até terminar.
   Sem documento, mostra "sem documento", nunca vazio.
2. **Ligação: o agente roda e aparece na tarefa.** **Só pelo botão "Analisar"** no cartão da tarefa (decisão de 19/10;
   nada roda sozinho ao entrar na etapa). A tarefa chama `api-agentes` (`analise_executar`). Os achados aparecem dentro do cartão da tarefa, e aprovar ou rejeitar
   (`analise_revisar`) fica no mesmo cartão, liberado para **admin e operação** (decisão de 19/10). O limite de impugnação calculado vira o prazo sugerido da tarefa "Ler o edital".
3. **Conteúdo: regras do estudo nos agentes.** Atributos novos na aderência e no edital (tabela acima), mais o alerta de
   estimado incompatível no preço. `REGRA_VERSAO` sobe. A referência praticada usa as colunas estimado e homologado e a
   marcação "fora do perfil" da **0031**, que vira insumo desta fase.
4. **Peça jurídica.** O agente jurídico gera a minuta do pedido de esclarecimento ou da impugnação a partir dos achados
   aprovados, com o artigo citado e os precedentes do estudo. O texto final é sempre revisado por quem assina.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** uma oportunidade sem chunks com pedido de preparação `pending` ou `processing`, **quando** o usuário clica "Analisar", **então** a resposta traz `em_preparacao = true` e o estado do pedido, e a tarefa mostra "análise em preparação". Operação: com o job no ar, `licitacao_chunks` da #3558 > 0 | Deno `api_agentes_test.ts` (0032 CA-1) + SQL de verificação depois do deploy do job |
| CA-2 | **Dado** uma oportunidade sem chunks e sem pedido na fila (ou com pedido concluído como `sem_documento`), **quando** o usuário clica "Analisar", **então** `em_preparacao = false` e o agente de edital grava `situacao = sem_documento` | Deno `api_agentes_test.ts` (0032 CA-2) |
| CA-3 | **Dado** a #3558 indexada, **quando** "Ler o edital" é analisada, **então** aparecem os achados com página e trecho e o limite de impugnação vira o prazo sugerido da tarefa, e existe 1 linha em `agente_execucoes` (agente `edital`) | Deno + SQL |
| CA-4 | **Dado** o item 67 da #3558 ("profissional", motor AC, 180 a 200 kg, "3.0 HP peak power"), **quando** o agente de edital roda, **então** gera o achado `especificacao_inconsistente` (potência só de pico com perfil profissional), e o jurídico sugere pedido de esclarecimento pedindo potência contínua mínima | Deno `agentes_edital_test.ts` com o texto real |
| CA-5 | **Dado** a #3558 exclusiva ME/EPP, **quando** "Conferir as restrições de participação por lote" é analisada, **então** o achado mostra a exclusividade e o porte da empresa pelo CNPJ | Deno `agentes_edital_test.ts` |
| CA-6 | **Dado** a pesquisa de preço publicada da #3558, **quando** o agente de preço roda, **então** mostra o estimado de R$ 15.632,46, as cotações do órgão por CNPJ, a faixa praticada da mesma classe de termo e o piso da empresa, e não gera `estimado_incompativel` | Deno `agentes_preco_test.ts` |
| CA-7 | **Dado** a #3641 (5.0 HPM, dobrável, 130 kg, R$ 3.859,73), **quando** a aderência roda com um produto profissional (motor AC, 150 kg ou mais), **então** o veredito é `supera`, e o preço indica estimado abaixo do piso da empresa | Deno `agentes_aderencia_test.ts` + `agentes_preco_test.ts` |
| CA-8 | **Dado** um usuário com papel `operacao` da empresa, **quando** aprova ou rejeita um achado, **então** a revisão grava; usuário de outra empresa recebe 403 | Deno (controle de acesso) |
| CA-9 | **Dado** um achado, **quando** o usuário rejeita sem nota, **então** recebe erro; com nota, `revisao = rejeitada` | Deno (`analise_revisar`) |

## Fora de escopo (parado até a fase 3 estar no ar)

- Painel de editais abertos (artifact) e de-para no painel: protótipos. O que valeu vira regra na fase 3.
- Coleta de propostas perdedoras e chat (o portal exige captcha) e o mapa de conformidade por fichas de fabricante.
  Voltam como evolução da aderência depois da fase 3.
- Partes da 0031 que não alimentam o agente de preço (rodapé e coluna única UASG na /precos): seguem no ritmo da 0031,
  sem bloquear esta.
- Modelo de IA nos agentes: continuam por regra (`metodo = regra`), como hoje.

## Specs existentes e onde cada uma entra

| Spec | Papel aqui |
|---|---|
| 0018 tarefas padrão | o lugar onde tudo aparece (base) |
| #307 / #308 agentes | o motor (já na `main`) |
| 0029 coleta do dia e acervo | fase 1 (documentos e indexação) |
| 0030 taxonomia PDM 2640 | insumo da aderência (atributo por aparelho) |
| 0031 /precos estimado × homologado | insumo da fase 3 (agente de preço) |
| estudo esteira 373980 | regras e testes reais da fase 3 (CA-4, CA-6 e CA-7) |

## Impacto em dados

- **Migration:** provável na fase 2 (ligar `agente_execucoes` à tarefa: `tarefa_id` opcional). Aditiva.
- **Edge Functions:** `api-agentes`, `api-pipeline` (cartão da tarefa). Republicadas no merge.
- **Contrato com o Dashboard:** muda. A tarefa ganha bloco "Análise do agente". O backend vai antes do front.
- **Dado oficial × derivado:** achados citam o documento oficial (página e trecho). Classe de termo, alertas e minutas são
  marcações do LicitaGym, rotuladas como tal.

## Decisões do Marcelo (19/10)

1. O agente roda **só no botão "Analisar"**, nunca sozinho ao entrar na etapa.
2. Aprovam e rejeitam achados: **admin e operação**.
3. Caso de aceite: **uma esteira de ponta a ponta** (#3558 Horizontina, com #3641 Escada como controle).

## Perguntas em aberto

- Nenhuma para começar. **Prazo do caso real:** a abertura da #3558 é em 29/10. O limite de impugnação ou esclarecimento
  cai por volta de 23 a 26/10 (o agente calcula; feriados não verificados). Se a fase 1 e o CA-4 não estiverem prontos
  até lá, o caso continua válido como teste com o texto real, só sem uso na disputa.

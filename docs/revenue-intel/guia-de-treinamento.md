# Guia de Treinamento da Equipe

**Versão:** 1.1 · **Data-base:** 27/09/2026 · **Uso:** onboarding, treinamento, reciclagem e revisão de qualidade de analistas que usam ou supervisionam o Revenue Intel.

**Novo na v1.1:** Módulo 2 corrigido (certame em andamento e pós-homologação), Módulo 19 (fases e tarefas da Lei 14.133), caso 6 e questões 16 a 18 do teste.

## 1. Objetivo

Ao final, cada pessoa deve conseguir:

- diferenciar PCA, oportunidade, certame em andamento e histórico;
- separar fato, inferência, cenário e recomendação;
- interpretar corretamente CATMAT e PDM;
- analisar Leading e Lagging sem extrapolar;
- calcular taxa de vitória corretamente;
- reconhecer limitações de amostra;
- tratar ausência, zero e falha de consulta corretamente;
- analisar preço, concorrência, prazo e geografia com cautela;
- priorizar contas sem inventar scores;
- saber o que o fornecedor pode fazer em cada fase e em que prazo;
- produzir recomendações rastreáveis e acionáveis.

## 2. As 10 regras para memorizar

| # | Regra |
| --- | --- |
| 1 | PCA é sinal de demanda, não oportunidade. |
| 2 | Valor do PCA é estimativa do órgão, não receita. |
| 3 | PCA→edital nunca é vínculo automático. |
| 4 | CATMAT é o identificador governamental; SKU é interno. |
| 5 | PDM inferido deve ser identificado como inferido. |
| 6 | Toda estatística histórica informa N. |
| 7 | Cenário não é forecast. |
| 8 | Distância é proxy logístico, não causa comprovada. |
| 9 | Erro nunca vira vazio; ausência nunca vira zero. |
| 10 | Toda recomendação mostra evidência, limitação e próxima ação. |

## 3. Modelo mental obrigatório

```
DADO
 ├── Foi observado diretamente?        → FATO
 ├── Foi derivado dos dados?            → INFERÊNCIA
 ├── Depende de premissa não calibrada? → CENÁRIO
 └── Indica o que devemos fazer?        → RECOMENDAÇÃO
```

Exemplo:

- **Fato:** o PCA contém seis itens compatíveis com CATMAT do cliente.
- **Inferência:** o conjunto é um sinal relevante de demanda futura.
- **Cenário:** se 30% desses itens virarem edital, o volume acionável seria X.
- **Recomendação:** monitorar o órgão e iniciar abordagem comercial antecipada.

## 4. Módulo 1 — PCA

PCA = Plano de Contratações Anual: planejamento de compras do órgão. Pode indicar produto, quantidade, órgão, valor estimado, prioridade, data prevista e demanda futura. **Não** significa edital aberto, oportunidade, venda, pipeline, receita ou vitória provável.

**Exercício:** PCA de R$ 900 mil para equipamentos de condicionamento físico. Qual frase está correta?

A) Temos uma oportunidade de R$ 900 mil. B) Temos R$ 900 mil de pipeline. C) Existe R$ 900 mil em demanda planejada. D) O órgão comprará R$ 900 mil.

**Resposta:** C.

## 5. Módulo 2 — PCA, oportunidade, em andamento e histórico

| Situação | Classificação |
| --- | --- |
| PCA sem edital | Sinal de demanda / Leading |
| Edital publicado com prazo de propostas aberto | Oportunidade |
| Propostas encerradas; julgamento, habilitação ou fase recursal | Em andamento — o vencedor ainda pode mudar |
| Resultado homologado | Histórico / Lagging para preço e vencedor, com acompanhamento pós-homologação |
| Anulada, revogada, fracassada ou deserta | Encerrado sem resultado |

Na Lei 14.133 os recursos vêm **antes** da homologação (art. 17 e art. 165). Depois dela ainda pode haver anulação ou revogação (com recurso), convocação dos remanescentes se o vencedor não assinar (art. 90) e adesão de outros órgãos à ata (art. 86).

- ✅ "Foram identificados R$ 850 mil em demanda planejada no PCA. Não existe edital acionável verificado."
- ✅ "Pregão em fase recursal; vencedor provisório."
- ❌ "Encontramos R$ 850 mil em oportunidades."
- ❌ "Já homologou, não há mais nada a fazer."

## 6. Módulo 3 — PCA → edital

Nunca assumir que um edital veio de determinado PCA. Verifique CNPJ, CATMAT, PDM, descrição, quantidade, valor, proximidade temporal e especificações. Classifique como forte, moderada, fraca ou não verificada — e nunca transforme "associação forte" em "90% de probabilidade".

## 7. Módulo 4 — Produto

Identificador governamental: `codigo_item_origem` (CATMAT). SKU interno não serve para pesquisar demanda governamental.

```
SKU: HALTER-10-PRO → CATMAT: [código] → PDM: [código] → Classe: 7830
```

O SKU identifica o produto no cliente; o CATMAT permite o cruzamento com dados do governo.

## 8. Módulo 5 — PDM

- **PDM informado na origem:** a fonte informou.
- **PDM inferido pelo LicitaGym:** classificado por descrição ou outra regra. Nunca vira "PDM oficial".

Limitação atual: 3.331 itens PCA; só 225 com `pdm_codigo_origem`; `codigo_pdm` vazio. Grande parte da classificação depende de inferência.

## 9. Módulo 6 — Leading

Pergunta: _onde pode surgir demanda futura?_ Analise PCA, órgãos, CATMAT, quantidade, valor planejado, prioridade, data prevista, antecedência e concentração geográfica. "18 itens PCA aderentes em sete órgãos" é Leading — não são 18 oportunidades.

## 10. Módulo 7 — Lagging

Pergunta: _o que aconteceu no mercado observado?_ Analise vencedores, preços, frequência, participação, taxa de vitória, órgãos, produtos e regiões — só de resultados homologados. Toda conclusão informa numerador, denominador, N, período, filtros e unidade.

## 11. Módulo 8 — Taxa de vitória

```
taxa_vitoria = vitórias / participações com resultado
```

- ✅ "Taxa de vitória observada: 18% — 9 vitórias em 50 participações com resultado, N=50, jan–set/2026, unidade=item."
- ❌ "O cliente tem 18% de chance de ganhar."

Taxa histórica ≠ probabilidade futura.

## 12. Módulo 9 — Tamanho da amostra

Sempre mostrar N e qualificar: "2 vitórias em 5 resultados, 40%, N=5. Amostra pequena; resultado apenas descritivo." Nunca "win rate estrutural de 40%" com cinco observações.

## 13. Módulo 10 — Receita potencial

```
Receita potencial = Valor PCA × conversão PCA→edital × taxa de vitória
```

A conversão ainda não está calibrada, então não use como forecast. Com hipótese fornecida ("simule 30%"), calcule e comece com **CENÁRIO ILUSTRATIVO — NÃO É FORECAST**.

## 14. Módulo 11 — Probabilidade

Sem modelo calibrado, não usar "80% de chance", "73% de probabilidade", "90% de confiança" ou "alta chance de vitória". Use sinal forte / moderado / fraco e explique por quê.

## 15. Módulo 12 — Geografia

Antes de calcular distância, precisamos da origem operacional (fábrica, CD, cidade, unidade expedidora). Sem origem: "Distância não calculada — origem operacional não informada." Nunca "distância = 0".

## 16. Módulo 13 — Distância versus frete

Distância é proxy logístico, não custo de frete conhecido.

- ✅ "A distância pode aumentar o esforço logístico, mas não há evidência suficiente para estabelecer impacto causal."
- ❌ "O fornecedor perdeu porque estava longe."

Sem frete real: "Frete não verificado; distância utilizada apenas como proxy."

## 17. Módulo 14 — Preços

Preço homologado é referência histórica, não preço recomendado. Antes de comparar, verifique CATMAT, especificação, quantidade, unidade, local, frete, instalação, garantia, prazo, data, modalidade e lote. Na dúvida: "Comparabilidade de preço não verificada."

## 18. Módulo 15 — Concorrência

- ✅ "Fornecedor A venceu 12 de 43 resultados compatíveis, N=43."
- ❌ "Fornecedor A possui 28% do mercado brasileiro."

Market share só com universo e cobertura definidos; até lá, "participação na amostra observada".

## 19. Módulo 16 — Qualidade do dado

| Estado | Significado | Exemplo |
| --- | --- | --- |
| Valor observado | Fonte retornou um valor | "Quantidade = 50." |
| Zero observado | Consulta funcionou e retornou zero | "0 resultados encontrados." |
| Não disponível | Fonte não contém o dado | "Data prevista não disponível." |
| Não verificado | Não foi possível confirmar | "Não verificado — falha na consulta." |

## 20. Golden Rule

> **Erro nunca vira vazio. Ausência nunca vira zero.**

Cenário: a API falhou. ❌ "0 oportunidades." ✅ "Não verificado — falha na consulta."

## 21. Módulo 17 — CRM

| Fator | Peso |
| --- | --- |
| PCA | 40% |
| Histórico | 25% |
| Preço | 15% |
| Prazo | 10% |
| Distância | 10% |

Os pesos estão definidos; as fórmulas internas dos componentes ainda não. Não inventar "PCA Score = 82/100" nem "Score final = 91". Até a calibração, usar Prioridade Alta / Média / Baixa.

## 22. Como priorizar sem score

```
PRIORIDADE: ALTA
A favor:
- forte demanda PCA;
- CATMAT aderente;
- contratação prevista próxima;
- histórico recorrente.
Contra:
- distância elevada.
Dados ausentes:
- frete real.
Próxima ação:
- validar capacidade logística.
```

## 23. Módulo 18 — GO / NO-GO

| Decisão | Quando |
| --- | --- |
| GO | Requisitos críticos conhecidos e compatíveis |
| GO CONDICIONADO | Aderência com pendências |
| NO-GO | Incompatibilidade material conhecida |
| MONITORAR | Sem oportunidade acionável, faltam informações, certame em andamento ou pós-homologação |

## 24. Exemplo de GO condicionado

**RECOMENDAÇÃO: GO CONDICIONADO**

- **A favor:** CATMAT aderente; especificação compatível; prazo aparentemente viável.
- **Riscos:** instalação ainda não validada.
- **Dados ausentes:** frete; atestado técnico.
- **Próxima ação:** validar instalação, frete e atestado antes de aprovar a participação.

Nunca "GO — 80% de chance de vitória".

## 25. Módulo 19 — Fases e tarefas da Lei 14.133

O [Catálogo de tarefas](../tarefas/catalogo-tarefas-14133.md) lista 84 tarefas do fornecedor, com código, evento que abre a janela, prazo e artigo. A equipe cita a tarefa pelo código e nunca inventa prazo.

| Fase | O que o fornecedor faz | Prazos que não podem ser perdidos |
| --- | --- | --- |
| F01 Divulgação | Ler o edital, esclarecer, impugnar, preparar proposta, garantia e declarações | Esclarecimento e impugnação: até 3 dias úteis antes da abertura (art. 164) |
| F02 Propostas e lances | Disputar, desempatar, exercer preferência ME/EPP | Durante a sessão |
| F03 Julgamento | Negociar, demonstrar exequibilidade, analisar a proposta aceita | Prazo da diligência |
| F04 Habilitação | Enviar documentos; atender diligência (só complementar ou atualizar) | Prazo da convocação |
| F05 Recursal | Intenção imediata, razões, contrarrazões, vista | Intenção: imediata. Razões e contrarrazões: 3 dias úteis (art. 165) |
| F06 Homologação | Manifestar-se e recorrer contra anulação/revogação | Recurso: 3 dias úteis (art. 165, I, d) |
| F07 Contratação | Assinar, pedir prorrogação uma vez, prestar garantia, responder como remanescente | Prazo da convocação (art. 90) |
| F08 Execução | Executar, atender o fiscal, receber, faturar | Atraso de pagamento acima de 2 meses dá direito à extinção (art. 137, § 2º, IV) |
| F09 Alteração e equilíbrio | Reajuste, repactuação, reequilíbrio, prorrogação | Reequilíbrio: durante a vigência e antes da prorrogação (art. 131) |
| F10 Extinção | Pedir extinção, defender-se, recorrer, liberar garantia | Recurso: 3 dias úteis (art. 165, I, e) |
| F11 Sanções | Defesa, recurso, reabilitação | Defesa e recurso: 15 dias úteis (arts. 157, 158, 166 e 167) |
| F12 Ata de registro de preços | Cumprir a ata; aceitar ou recusar adesões | Vigência de 1 ano, prorrogável (art. 84) |

**Inversão de fases (art. 17, § 1º):** a habilitação vem antes das propostas e a intenção de recurso abre no resultado do julgamento.

## 26. Fluxo operacional do analista

1. **Classificar:** PCA / oportunidade / em andamento / histórico
2. **Identificar a fase e as tarefas liberadas:** catálogo de tarefas
3. **Identificar produto:** CATMAT / PDM / classe
4. **Validar dados:** observado / zero / indisponível / não verificado
5. **Analisar:** Leading / Lagging
6. **Verificar amostra:** N / período / filtros / unidade
7. **Qualificar incerteza:** fato / inferência / cenário
8. **Priorizar:** Alta / Média / Baixa
9. **Decidir:** GO / GO condicionado / NO-GO / Monitorar
10. **Recomendar:** próxima ação

## 27. Exercícios

| Caso | Situação | Resposta esperada |
| --- | --- | --- |
| 1 | PCA do órgão X, R$ 1,2 mi, equipamentos fitness, contratação prevista em 90 dias, nenhum edital | MONITORAR — prioridade potencialmente alta. Há sinal de demanda planejada de R$ 1,2 mi, mas nenhuma oportunidade acionável verificada. |
| 2 | Fornecedor venceu 3 de 6 resultados | "3 vitórias em 6 resultados, 50%, N=6. Amostra pequena; percentual apenas descritivo." |
| 3 | Consulta ao portal falhou | "Não verificado — falha na consulta." Nunca 0. |
| 4 | PDM não veio da fonte, descrição indica grama sintética | "PDM 18481 inferido pelo LicitaGym a partir da descrição." |
| 5 | Preço vencedor anterior: R$ 2.779,46/t | "Referência histórica; comparabilidade deve ser validada (especificação, quantidade, local, frete…)." |
| 6 | Cliente ficou em 2º num pregão homologado; o vencedor ainda não assinou | MONITORAR. Se o vencedor não assinar, a Administração pode convocar o cliente nas condições do vencedor (tarefa 14133-F07-T04, art. 90, § 2º). |

## 28. Teste rápido de certificação

| # | Afirmação | V/F |
| --- | --- | --- |
| 1 | PCA pode ser chamado de oportunidade se a data prevista estiver próxima. | F |
| 2 | Valor PCA representa estimativa do órgão. | V |
| 3 | Toda taxa histórica deve informar N. | V |
| 4 | PDM inferido pode ser chamado de oficial se a descrição for muito clara. | F |
| 5 | Falha de API pode ser registrada como zero. | F |
| 6 | Distância pode ser usada como proxy logístico. | V |
| 7 | Distância prova impacto no resultado da licitação. | F |
| 8 | Preço homologado é automaticamente o preço recomendado. | F |
| 9 | Win rate histórico é igual à probabilidade futura de vitória. | F |
| 10 | PCA→edital ainda não possui conversão calibrada. | V |
| 11 | Os pesos do CRM estão definidos. | V |
| 12 | As fórmulas 0–100 dos componentes do CRM estão definidas. | F |
| 13 | Um edital encerrado pode alimentar Lagging. | V (depois de homologado) |
| 14 | SKU interno deve ser usado como identificador governamental. | F |
| 15 | Toda recomendação deve terminar com próxima ação quando houver decisão comercial. | V |
| 16 | Na Lei 14.133, os recursos contra julgamento e habilitação vêm depois da homologação. | F |
| 17 | Um pregão em fase recursal já tem vencedor definitivo. | F |
| 18 | A intenção de recorrer deve ser manifestada imediatamente, sob pena de preclusão. | V |

**Critério:** 18/18 apto · 16–17 apto com revisão · 15 ou menos: refazer o treinamento antes de operar sem supervisão.

## 29. Template da equipe

```
## Resumo executivo
[3–5 conclusões]
## Classificação
[PCA / Oportunidade / Em andamento / Histórico]
## Fase e tarefas liberadas
[códigos do catálogo]
## Leading
[sinais futuros]
## Lagging
[resultados homologados]
## Evidências
- ...
## Amostra
N: / Período: / Filtros: / Unidade:
## Dados inferidos
- ...
## Dados não disponíveis
- ...
## Dados não verificados
- ...
## Cenário
[se aplicável — explicitar que não é forecast]
## Prioridade
[Alta / Média / Baixa]
## Recomendação
[GO / GO CONDICIONADO / NO-GO / MONITORAR]
## Justificativa
- ...
## Próxima ação
- ...
```

## 30. Checklist do supervisor

- **Semântica:** PCA não virou oportunidade nem receita; certame em andamento não virou resultado; cenário não virou forecast.
- **Produto:** CATMAT correto; PDM informado/inferido identificado; 7810 tratado como candidato.
- **Estatística:** N, período e unidade informados; amostra pequena qualificada.
- **Dados:** ausência e falha não viraram zero; inferência identificada.
- **Prazos:** todo prazo legal citado tem o código da tarefa do catálogo.
- **Comercial:** prioridade explicável; sem probabilidade ou score inventados; recomendação com evidências; próxima ação clara.

## 31. Cartão de bolso — 8 perguntas antes de enviar

1. É PCA, oportunidade, em andamento ou histórico?
2. O produto está identificado por CATMAT?
3. O PDM é informado ou inferido?
4. Se usei histórico, mostrei N?
5. Existe algum dado ausente ou não verificado?
6. Estou confundindo cenário com previsão?
7. Minha recomendação é explicável pelos dados?
8. Qual é a próxima ação — e qual o prazo legal dela?

## Regra final da equipe

Fato observado → afirmar · Inferência → identificar · Premissa → cenário · Dado ausente → não disponível · Consulta falhou → não verificado · Histórico → sempre mostrar N · PCA → sinal, nunca oportunidade · Recomendação → evidência + limitação + próxima ação.

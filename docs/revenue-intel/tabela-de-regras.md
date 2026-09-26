# Tabela de regras e matriz de decisão

Referência rápida das [Instruções Canônicas v1.2](instrucoes-canonicas.md) (data-base 27/09/2026). A v1.2 reescreveu a regra 3 e incluiu a regra 59.

## As 59 regras

| # | Tema | Regra canônica | Exceção / condição | ✅ Correto | ❌ Incorreto |
| --- | --- | --- | --- | --- | --- |
| 1 | PCA | PCA = Plano de Contratações Anual e é um dado de entrada. | Nenhuma. Nunca tratar como métrica interna. | "O PCA registra demanda planejada pelo órgão." | "Qual é a fórmula do PCA?" |
| 2 | PCA → oportunidade | Item de PCA = sinal de demanda, não oportunidade. | Só vira oportunidade com edital publicado e prazo de propostas aberto. | "R$ 850 mil de demanda planejada; edital não verificado." | "R$ 850 mil em oportunidades." |
| 3 | Certame em andamento | Propostas encerradas sem homologação = EM ANDAMENTO; o vencedor ainda pode mudar. | Julgamento, habilitação e fase recursal (Lei 14.133, art. 17). | "Pregão em fase recursal; vencedor provisório." | "Pregão encerrado ontem; vencedor definido." |
| 4 | Valor PCA | Valor estimado da demanda planejada. | Nenhuma. | "R$ 2,4 mi em demanda planejada." | "R$ 2,4 mi de receita." |
| 5 | Pipeline | PCA não é pipeline comercial. | Pode existir pipeline de oportunidades qualificadas. | "Sinal futuro de demanda." | "Pipeline público de R$ 5 mi." |
| 6 | PCA → edital | Não existe vínculo determinístico. | Só com evidência documental explícita. | "Provável associação: mesmo CNPJ, CATMAT, quantidade e período." | "Este edital veio daquele PCA." |
| 7 | Força da associação | Forte, moderada, fraca ou não verificada. | Sem percentual até modelo calibrado. | "Associação forte pelas quatro evidências." | "87% de chance de ser o mesmo PCA." |
| 8 | CATMAT | Cruzamento governamental por `codigo_item_origem`. | SKU só como referência interna. | SKU → CATMAT → PDM → classe | Pesquisar compras públicas pelo SKU GYM-10KG. |
| 9 | PDM informado | `pdm_codigo_origem` preenchido = PDM informado na origem. | Nenhuma. | "PDM informado na origem: 18481." | "PDM inferido" quando a fonte informou. |
| 10 | PDM inferido | Marcar explicitamente como inferido. | Nenhuma. | "PDM 18481 inferido pela descrição." | "PDM oficial 18481" quando inferido. |
| 11 | PDM ausente | Ausência não significa PDM = 0. | Pode inferir com regra aprovada, identificando. | "`pdm_codigo_origem` não disponível; PDM inferido…" | `pdm_codigo_origem = 0`. |
| 12 | Classe 7830 | Escopo principal atual. | Aplicar aderência por item/produto. | "CATMAT 7830 dentro do escopo." | Todo item esportivo como aderente sem verificar. |
| 13 | Classe 7810 | `OUT_OF_SCOPE_CANDIDATE_7810`. | Só entra com aprovação explícita. | "7810 — escopo em avaliação." | "7810 faz parte da cobertura definitiva." |
| 14 | Piso esportivo | PDM 10779 exige contexto esporte/borracha. | Não aceitar só "piso". | "Piso emborrachado para academia: aderência provável." | "Piso cerâmico administrativo: oportunidade." |
| 15 | Leading | Sinais anteriores à contratação, principalmente PCA. | Não confundir com histórico. | "18 itens PCA em 7 órgãos." | "Fornecedor venceu 12 vezes" como Leading. |
| 16 | Lagging | Resultados homologados observados. | Sempre informar amostra; certame em andamento não entra. | "12 vitórias em 43 resultados, N=43." | "Fornecedor domina o segmento." |
| 17 | Antecedência | `data_prevista_contratacao` − data atual. | Sem data, não calcular. | "Antecedência: 87 dias." | Inventar data. |
| 18 | Janela 60–120 dias | Hipótese comercial experimental. | Orienta prospecção, não prevê publicação. | "Dentro da janela experimental." | "O edital sairá em até 120 dias." |
| 19 | Conversão PCA→edital | Ainda não calibrada. | Só com metodologia aprovada e medição real. | "Conversão ainda não calibrada." | "Assumimos conversão de 70%." |
| 20 | Receita potencial | PCA × conversão × taxa de vitória. | Sem calibração, apenas cenário. | "CENÁRIO ILUSTRATIVO — NÃO É FORECAST." | "Receita prevista: R$ 700 mil." |
| 21 | Premissa do usuário | Pode calcular cenário com premissas fornecidas. | Mostrar premissas e rotular cenário. | "Com conversão hipotética de 30% fornecida pelo usuário…" | Tratar 30% como taxa histórica. |
| 22 | Probabilidade | Não inventar probabilidade. | Só com modelo calibrado e aprovado. | "Sinal forte pelas evidências." | "73% de chance de vitória." |
| 23 | Confiança | Sem confiança percentual sem calibração. | Qualitativa com evidências. | "Sinal moderado." | "85% de confiança." |
| 24 | Win rate | vitórias / participações com resultado. | Só com definição consistente. | "9/50 = 18%, N=50, unidade=item." | "18% de chance de ganhar." |
| 25 | N da amostra | Toda estatística histórica informa N. | Nenhuma. | "27 resultados compatíveis, N=27." | "A empresa costuma ganhar 32%." |
| 26 | Amostra pequena | Descrever sem generalizar. | Não há N mínimo universal. | "2/5, 40%, N=5; amostra pequena." | "Win rate estrutural de 40%." |
| 27 | Unidade de análise | Declarar item, lote, edital ou participação. | Não misturar. | "N=50, unidade=item." | Numerador por lote e denominador por edital. |
| 28 | Período | Estatísticas informam período. | Nenhuma. | "jan–set/2026." | "Historicamente, 18%." |
| 29 | Preço homologado | Evidência histórica, não recomendação. | Apoia decisão após comparabilidade. | "R$ 2.779,46/t é referência histórica." | "Nosso lance deve ser R$ 2.779,46/t." |
| 30 | Comparabilidade de preço | Verificar especificação, quantidade, unidade, local, frete etc. | Se insuficiente, "não verificada". | "Comparabilidade não verificada." | Comparar só pela mesma palavra. |
| 31 | Concorrência | Frequência descreve a amostra. | Market share só com universo definido. | "12 de 43 resultados, N=43." | "28% do mercado brasileiro." |
| 32 | Origem logística | Exige cidade/CD/fábrica aplicável. | Várias origens: escolher a aplicável. | "Origem operacional: Navegantes/SC." | Usar a sede fiscal arbitrariamente. |
| 33 | Origem ausente | Não calcular distância. | Nenhuma. | "Distância não calculada — origem não informada." | "Distância = 0." |
| 34 | Distância | Apenas proxy logístico. | Não equivale a frete. | "Pode aumentar esforço logístico." | "Perdeu porque estava longe." |
| 35 | Frete | Custo conhecido só com dado de frete. | Distância como proxy. | "Frete não verificado; distância como proxy." | Converter km em custo sem regra. |
| 36 | Pesos CRM | 40/25/15/10/10. | Só muda com nova regra canônica. | "Pesos experimentais iniciais." | Agente decide 50/20/10/10/10. |
| 37 | Fórmula dos componentes | Ainda não definida. | Pesos não autorizam inventar 0–100. | Mostrar fatores sem score final. | "PCA score = valor/1 milhão × 100". |
| 38 | Score numérico | Não gerar até aprovação das fórmulas. | Pode calcular com metodologia aprovada. | "Prioridade Alta; score não calculável." | "Score 92/100." |
| 39 | Componente ausente | Nunca atribuir zero. | Não redistribuir peso. | "Distância não disponível; score integral não calculado." | "Distância = 0/100." |
| 40 | Normalização | Não normalizar silenciosamente. | Cálculo parcial explicado, se solicitado. | "Parcial sobre 90% dos pesos observáveis." | 71/90 virar 79/100 sem aviso. |
| 41 | Priorização | Alta / Média / Baixa com explicação. | Não depende de score. | "Alta: PCA forte, prazo próximo, histórico recorrente." | "Lead quente: 94 pontos." |
| 42 | GO | Requisitos críticos compatíveis. | Não significa chance de vitória. | "GO — requisitos críticos verificados." | "GO — 80% de chance." |
| 43 | GO CONDICIONADO | Aderência com pendências. | Explicitar pendências. | "Validar frete, instalação e atestado." | Sem dizer a condição. |
| 44 | NO-GO | Incompatibilidade material conhecida. | Explicar o bloqueio. | "NO-GO: prazo de entrega incompatível." | "NO-GO porque o score ficou baixo." |
| 45 | MONITORAR | Sem oportunidade acionável, faltam dados, certame em andamento ou pós-homologação. | PCA sem edital normalmente aqui. | "MONITORAR: sinal PCA; edital não publicado." | "GO" só com PCA. |
| 46 | Valor observado | Preservar o valor recuperado. | Derivados identificados como calculados. | "Quantidade observada: 50." | Alterar para preencher lacuna. |
| 47 | Zero observado | Só com consulta válida retornando zero. | Nenhuma. | "0 resultados encontrados." | Zero após timeout. |
| 48 | Não disponível | Fonte não contém o dado. | Diferente de falha técnica. | "Data prevista não disponível." | "Data prevista = 0." |
| 49 | Não verificado | Não foi possível confirmar. | Inclui falha de consulta. | "Não verificado — falha na consulta." | "0 resultados." |
| 50 | Golden Rule | Erro nunca vira vazio; ausência nunca vira zero. | Nenhuma. | Falha → "não verificado". | Falha → NULL, vazio ou zero. |
| 51 | Rastreabilidade | Preservar fonte, data, órgão, CATMAT/PDM, filtros e status. | Não inventar metadados. | "Fonte X, CNPJ Y, CATMAT Z, consulta em…" | Conclusão sem origem. |
| 52 | Fato | Informação observada/recuperada. | Distinguir de inferência. | "A fonte informa quantidade 100." | "Provavelmente 100" com dado explícito. |
| 53 | Inferência | Conclusão derivada dos dados. | Identificar como inferência. | "PDM inferido pela descrição." | Inferência como dado oficial. |
| 54 | Cenário | Depende de premissas não calibradas. | Mostrar premissas. | "Cenário com conversão hipotética de 30%." | "Forecast de R$ X" com hipótese. |
| 55 | Recomendação | Decorre de evidências e limitações. | Pode ser comercial com incerteza qualificada. | "Priorizar contato porque…" | "Atacar imediatamente" sem justificativa. |
| 56 | Próxima ação | Análise acionável termina com ação concreta. | Não criar ação artificial. | "Cadastrar CD e validar 6 CATMATs." | "Continuar acompanhando." |
| 57 | Coordenação concorrencial | Nunca recomendar coordenação de preços, lances ou comportamento. | Nenhuma. | Analisar concorrentes com dados públicos. | Sugerir combinar preço ou participação. |
| 58 | Promessa de vitória | Nunca prometer resultado. | Nenhuma. | "Melhora a qualidade da decisão go/no-go." | "Aumenta sua chance para 80%." |
| 59 | Resultado homologado | Histórico para preço e vencedor, com acompanhamento pós-homologação. | Anulação/revogação (art. 165, I, d), remanescentes (art. 90), adesão à ata (art. 86). | "Homologado; cliente em 2º. MONITORAR assinatura." | "Homologou; não há mais nada a fazer." |

## Matriz de decisão rápida

| Situação | Classificação | Pode calcular? | Linguagem |
| --- | --- | --- | --- |
| Item somente no PCA | Sinal de demanda / Leading | Antecedência, se houver data | "Demanda planejada" |
| PCA + edital semelhante | Provável associação | Comparações objetivas | "Associação forte/moderada/fraca" |
| Edital com prazo de propostas aberto | Oportunidade | Métricas verificáveis | "Oportunidade acionável" |
| Propostas encerradas, sem homologação | Em andamento | Não usar como preço/vencedor | "Vencedor provisório; fase X" |
| Resultado homologado | Histórico / Lagging + acompanhamento | Preço, vencedor, win rate | "Resultado homologado" |
| Anulada, revogada, fracassada ou deserta | Encerrado sem resultado | Não entra em preço | "Sem resultado" |
| Valor PCA | Estimativa do órgão | Soma/agregação | "Valor estimado da demanda planejada" |
| Conversão desconhecida | Não calibrada | Não calcular forecast | "Cenário, não previsão" |
| PDM ausente, descrição suficiente | Inferido | Conforme regra aprovada | "PDM inferido pelo LicitaGym" |
| PDM ausente, descrição insuficiente | Não classificável | Não | "Classificação não determinada" |
| Consulta válida sem registros | Zero observado | Sim | "0 resultados encontrados" |
| Campo ausente | Não disponível | Não substituir por zero | "Dado não disponível" |
| Consulta falhou | Não verificado | Não | "Não verificado — falha na consulta" |
| Origem logística ausente | Distância não calculável | Não | "Origem operacional não informada" |
| Preço pouco comparável | Comparabilidade não verificada | Evitar benchmark direto | "Referência histórica não normalizada" |
| N pequeno | Resultado descritivo | Sim, com N | "Na amostra observada…" |
| Fórmula CRM não definida | Prioridade qualitativa | Não gerar score | "Alta / Média / Baixa" |
| Aderência + pendências | GO CONDICIONADO | — | "Avançar após resolver…" |
| PCA sem edital | MONITORAR | — | "Monitorar publicação" |

## Regra-mãe para desempate

1. Não inventar.
2. Não transformar ausência ou erro em zero.
3. Preservar a natureza original do dado.
4. Separar fato de inferência.
5. Separar PCA de oportunidade.
6. Separar cenário de previsão.
7. Informar N em qualquer conclusão histórica.
8. Preferir classificação qualitativa a falsa precisão.
9. Explicar limitações antes de recomendar.
10. Terminar com uma próxima ação concreta quando houver decisão comercial.

## Exemplo completo de aplicação

**PRIORIDADE: ALTA — MONITORAR**

- **Fato:** 6 itens no PCA do órgão, valor estimado agregado de R$ 780 mil, contratação prevista entre 74 e 96 dias.
- **Produto:** 4 itens com CATMAT compatível com o catálogo do cliente. Em 2 itens, o PDM foi inferido pelo LicitaGym porque `pdm_codigo_origem` não está disponível.
- **Leading:** existe sinal relevante de demanda planejada.
- **Lagging:** 14 resultados históricos comparáveis (N=14, unidade=item, período informado na consulta).
- **Geografia:** não calculada; origem operacional do cliente ainda não cadastrada.
- **Limitação:** conversão PCA→edital não calibrada; os R$ 780 mil não representam oportunidade, pipeline ou previsão de receita.
- **Recomendação:** MONITORAR, porque ainda não existe edital acionável verificado.
- **Próxima ação:** cadastrar a origem logística do cliente, validar os 4 CATMATs e monitorar publicações do órgão na janela comercial experimental.

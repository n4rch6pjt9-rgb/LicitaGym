# Checklist Operacional

Use antes de entregar qualquer análise, ranking, alerta, cenário ou recomendação.

## A. Classificar o registro

- [ ] Identifiquei se o registro é PCA, edital com prazo aberto, certame em andamento, resultado homologado ou encerrado sem resultado.
- [ ] Só PCA → **SINAL DE DEMANDA / LEADING**.
- [ ] Só usei OPORTUNIDADE com edital publicado e prazo de propostas aberto.
- [ ] Propostas encerradas, sem homologação (julgamento, habilitação ou recursos) → **EM ANDAMENTO**; não tratei o vencedor como definitivo.
- [ ] Resultado homologado → **HISTÓRICO / LAGGING** para preço e vencedor, e verifiquei o pós-homologação: anulação/revogação, convocação de remanescentes, adesão à ata.
- [ ] Anulada, revogada, fracassada ou deserta → **ENCERRADO SEM RESULTADO**, fora da estatística de preço.
- [ ] Não chamei PCA de oportunidade, pipeline, receita ou forecast.
- [ ] Prazos legais citados vêm do [Catálogo de tarefas](../tarefas/catalogo-tarefas-14133.md), com o código da tarefa.

Se falhar: corrigir a classificação antes de continuar.

## B. Validar PCA

- [ ] Tratei PCA como Plano de Contratações Anual, nunca como métrica.
- [ ] Chamei o valor de **valor estimado da demanda planejada**.
- [ ] Não tratei `data_prevista_contratacao` como data garantida de publicação.
- [ ] Antecedência = `data_prevista_contratacao − data_atual`.
- [ ] Sem data: "Antecedência não calculada — data prevista não disponível."
- [ ] Janela de 60–120 dias identificada como **experimental**.

## C. Verificar PCA → edital

- [ ] Mesmo órgão/CNPJ?
- [ ] Mesmo CATMAT?
- [ ] Mesmo PDM, quando disponível?
- [ ] Descrição compatível?
- [ ] Quantidade compatível?
- [ ] Valor compatível?
- [ ] Datas próximas?
- [ ] Especificações compatíveis?

Classificar só como associação **forte**, **moderada**, **fraca** ou **não verificada**, sem percentual. Linguagem padrão: _"Provável associação PCA→edital baseada em [evidências]. O vínculo não é determinístico."_

## D. Validar produto

- [ ] Usei `codigo_item_origem` / CATMAT como identificador governamental.
- [ ] Não usei SKU interno para compras públicas.
- [ ] Mantive `SKU cliente → CATMAT → PDM → classe`.

**PDM:** da fonte → "PDM informado na origem"; classificado pelo LicitaGym → "PDM inferido pelo LicitaGym"; sem classificação → "PDM não disponível/não classificável". Nunca inferido como oficial.

**Escopo:** 7830 → principal · 7810 → `OUT_OF_SCOPE_CANDIDATE_7810` · grama sintética → 7220 / PDM 18481 · piso esportivo → PDM 10779 + contexto esportivo/borracha · borracha granulada → PDM 9461.

## E. Validar qualidade dos dados

Para cada dado importante, exatamente um estado: valor observado · zero observado · não disponível · não verificado.

- [ ] Erro não virou vazio.
- [ ] Ausência não virou zero.
- [ ] Falha marcada como "Não verificado — falha na consulta."
- [ ] Zero só quando a consulta funcionou e retornou zero ("0 resultados encontrados na consulta realizada.").
- [ ] Campo ausente como "Dado não disponível."

## F. Validar Leading

- [ ] Quantidade de itens PCA.
- [ ] Quantidade de órgãos, quando relevante.
- [ ] Produtos/CATMAT.
- [ ] Valor como demanda planejada.
- [ ] Data prevista/antecedência, quando disponível.
- [ ] Leading não virou oportunidade nem receita.

## G. Validar Lagging

- [ ] Só resultados homologados entraram na estatística.
- [ ] Numerador, denominador e N.
- [ ] Período e filtros.
- [ ] Unidade: item, lote, edital ou participação — sem misturar.

## H. Validar taxa de vitória

- [ ] Cliente, participação, resultado, vencedor, período e unidade definidos.
- [ ] `taxa_vitoria = vitórias / participações_com_resultado`.
- [ ] Formato: "Taxa de vitória: X% — A vitórias em B participações com resultado, N=B, período [...], unidade=[...]."
- [ ] Amostra pequena: informei N, linguagem descritiva, sem generalizar.

## I. Validar conversão PCA → edital

- [ ] Existe taxa calibrada e aprovada? Se não: "Conversão PCA→edital ainda não calibrada", sem inventar taxa, probabilidade ou forecast.
- [ ] Hipótese do usuário: rotulada **CENÁRIO ILUSTRATIVO — NÃO É FORECAST**, com todas as premissas.

## J. Validar receita potencial

- [ ] Sem calibração, não apresentei como previsão.
- [ ] Premissas hipotéticas chamadas de cenário.
- [ ] Valor PCA não chamado de receita; cenário não chamado de pipeline; sem "receita esperada".

## K. Validar probabilidade e confiança

- [ ] Sem "chance de vitória", "chance de virar edital" ou confiança percentual inventadas.
- [ ] Só sinal forte / moderado / fraco, com evidências.

## L. Validar geografia e logística

- [ ] Existe cidade/UF/CD/fábrica de origem? Várias origens: escolhi a aplicável.
- [ ] Sem origem: "Distância não calculada — origem operacional aplicável não definida."
- [ ] Distância só como proxy; sem causalidade; sem converter em frete.
- [ ] Sem frete: "Frete não verificado; distância utilizada apenas como proxy."

## M. Validar preços

- [ ] CATMAT, descrição e especificação compatíveis.
- [ ] Quantidade comparável e mesma unidade.
- [ ] Localização, frete, instalação, garantia e prazo considerados.
- [ ] Data/período e modalidade/lote considerados.
- [ ] Sem comparabilidade: "Comparabilidade de preço não verificada." Nunca preço homologado como preço recomendado.

## N. Validar concorrência

- [ ] N, período e segmento/filtro informados.
- [ ] Falei em amostra observada; frequência não virou market share.

## O. Validar CRM

- [ ] Pesos 40/25/15/10/10 (PCA/Histórico/Preço/Prazo/Distância), identificados como experimentais e sem alteração.
- [ ] Não inventei fórmula 0–100 nem score final.
- [ ] Não atribuí zero a componente ausente, não redistribuí nem normalizei silenciosamente.
- [ ] Usei Prioridade Alta / Média / Baixa.

## P. Validar recomendação operacional

Escolher exatamente uma: **GO** (requisitos críticos compatíveis) · **GO CONDICIONADO** (aderência com pendências) · **NO-GO** (incompatibilidade material) · **MONITORAR** (sem oportunidade acionável, faltam dados, certame em andamento ou pós-homologação). Nunca associar GO a probabilidade de vitória.

## Q. Estruturar a recomendação

```
RECOMENDAÇÃO: [GO / GO CONDICIONADO / NO-GO / MONITORAR]
Evidências a favor:
- ...
Riscos/contra:
- ...
Dados ausentes ou não verificados:
- ...
Próxima ação:
- ...
```

## Checklist final de liberação

- [ ] PCA não foi chamado de oportunidade, pipeline ou receita.
- [ ] Oportunidade possui prazo de propostas aberto.
- [ ] Certame em andamento não foi tratado como resultado definitivo.
- [ ] Toda estatística histórica possui N, período e unidade.
- [ ] CATMAT como identificador governamental.
- [ ] PDM inferido identificado como inferido.
- [ ] Ausência e erro não viraram zero; falha marcada como não verificado.
- [ ] Associação PCA→edital não determinística.
- [ ] Nenhuma probabilidade, confiança percentual, prazo legal ou fórmula CRM inventada.
- [ ] Distância com origem operacional e tratada como proxy.
- [ ] Preços testados quanto à comparabilidade.
- [ ] Frequência histórica não virou market share.
- [ ] Fatos separados de inferências; cenários separados de previsões.
- [ ] Recomendação com evidências e limitações explícitas.
- [ ] Existe próxima ação concreta.

> **Regra de bloqueio:** se qualquer item crítico falhar, não liberar a análise até corrigir.

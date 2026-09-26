# Conceitos essenciais

## As 10 regras para memorizar

| # | Regra |
| --- | --- |
| 1 | PCA é sinal de demanda, não oportunidade. |
| 2 | Valor do PCA é estimativa do órgão, não receita. |
| 3 | PCA → edital nunca é vínculo automático. |
| 4 | CATMAT é o identificador do governo; o código interno do seu produto (SKU) não. |
| 5 | Classificação inferida deve aparecer como inferida. |
| 6 | Toda estatística histórica informa o tamanho da amostra (N). |
| 7 | Cenário não é previsão. |
| 8 | Distância é aproximação logística, não causa comprovada. |
| 9 | Erro nunca vira vazio; ausência nunca vira zero. |
| 10 | Toda recomendação mostra evidência, limitação e próxima ação. |

## Fato, inferência, cenário e recomendação

```
DADO
 ├── Foi observado diretamente?          → FATO
 ├── Foi derivado dos dados?             → INFERÊNCIA
 ├── Depende de premissa não comprovada? → CENÁRIO
 └── Indica o que fazer?                 → RECOMENDAÇÃO
```

| Categoria | Exemplo |
| --- | --- |
| Fato | O PCA contém seis itens compatíveis com o seu catálogo. |
| Inferência | Existe um sinal relevante de demanda futura. |
| Cenário | Se parte desses itens virar edital, o volume seria X. |
| Recomendação | Monitorar o órgão e iniciar a prospecção. |

## O que é PCA

PCA é o **Plano de Contratações Anual**: o documento em que cada órgão público declara o que pretende comprar (Lei 14.133/2021). Ele indica produto, quantidade, valor estimado, prioridade e data prevista.

PCA **não** é edital aberto, oportunidade, venda, pipeline, receita nem vitória provável.

## PCA, oportunidade, em andamento e histórico

| Situação | Classificação |
| --- | --- |
| PCA sem edital | Sinal de demanda (Leading) |
| Edital publicado e com prazo de propostas aberto | Oportunidade |
| Propostas encerradas, em julgamento, habilitação ou fase recursal | Em andamento — o vencedor ainda pode mudar |
| Resultado homologado | Histórico (Lagging) para preço e vencedor, com acompanhamento pós-homologação |

Veja a ordem das fases e os prazos em [Fases e prazos da licitação](fases-e-prazos.md).

- ✅ "Foram identificados R$ 850 mil em demanda planejada no PCA. Não existe edital aberto verificado."
- ❌ "Encontramos R$ 850 mil em oportunidades."

## PCA → edital

Encontrar um PCA e depois um edital parecido não prova que um originou o outro. As evidências são: mesmo órgão (CNPJ), mesmo produto (CATMAT), descrição, quantidade, valor, datas próximas e especificações.

A associação é classificada como **forte**, **moderada**, **fraca** ou **não verificada** — nunca em porcentagem.

> "Provável associação PCA → edital baseada nas evidências observadas; o vínculo não é determinístico."

## Produto: SKU, CATMAT, PDM e classe

```
SEU SKU → CATMAT → PDM → CLASSE
```

O SKU identifica o produto na sua empresa. O **CATMAT** é a ponte para as compras do governo. Por isso, o primeiro passo é mapear o seu catálogo para CATMAT.

O **PDM** (Padrão Descritivo de Material) agrupa itens parecidos. Ele pode vir de duas formas:

- **PDM informado na origem:** o próprio órgão informou;
- **PDM inferido pelo LicitaGym:** classificamos pela descrição. Nunca é chamado de "oficial".

# Casamento preço praticado × licitação PNCP

Medido em produção em 12/10/2026 10:54 UTC, só leitura. Universo: `licitacoes_externas` com `fonte = 'pncp'` e `data_fim < now()`, usando a coluna `data_fim` gravada. Preço: `precos_praticados_itens` (25.465 linhas; 1 fora do padrão de 17 dígitos em `id_compra`).

Esse corte não é o prazo efetivo. A migration `20261012010000_prioridade_prazo_encerrado.sql` define o instante em Brasília nesta ordem: `normalizacoes.data_fim.normalizado`, senão `raw.data_fim_vigencia`, e só sem os dois o `data_fim` gravado. Valores antigos dessa coluna ficam três horas à frente do texto do PNCP. Edital que vence nessa janela fica de fora desta medição. Os números abaixo valem para o corte da coluna gravada, não para todo edital PNCP com prazo de proposta vencido.

| | |
|---|---|
| Editais PNCP com prazo vencido | 1.313 |
| Desses, `prioridade = leads` | 116 |
| Desses, `prioridade = monitorar` | 397 |

Não há chave direta entre as tabelas. Três candidatos foram medidos. Nenhum número abaixo foi presumido.

## Chave estrita: UASG de 6 dígitos + número + ano

`raw.unidade_codigo` com exatamente 6 dígitos, `raw.numero` e `raw.ano`, contra os campos do `id_compra` de 17 dígitos (UASG, número, ano).

| | |
|---|---|
| Pares | 106 |
| Editais | 106 |
| Compras (`id_compra`) | 106 |
| Edital com mais de uma compra | 0 |
| Compra com mais de um edital | 0 |
| Já em `historico` | 106 |
| Ainda em `leads` ou `monitorar` | 0 |
| CNPJ do órgão bate com o catálogo da UASG | 100 |
| CNPJ não corrobora | 6 |
| O `compra=` de 17 dígitos no link é o mesmo `id_compra` | 80 |
| O link existe e diverge do `id_compra` | 0 |

A tripla é um para um neste universo. Não alcança os 116 leads nem os 397 em monitorar. Os 80 confirmados pelo link são subconjunto desses 106.

## Chave frouxa: CNPJ do órgão + número + ano

Sem exigir a UASG da unidade. O CNPJ do edital é ligado às UASGs do catálogo e daí ao `id_compra`.

| | |
|---|---|
| Pares | 151 |
| Editais | 118 |
| Compras | 142 |
| Edital com mais de uma compra | 19 |
| Ainda em `leads` ou `monitorar` | 4 |

Dezenove editais casam com mais de uma compra. Essa chave não identifica a compra.

## Regra

Preço praticado não rebaixa `leads` nem `monitorar`. Neste corte da coluna `data_fim`, a chave estrita só encontra edital que já está em `historico`, e a chave frouxa mistura compras. A conclusão não se estende, por si, ao universo do prazo efetivo em Brasília.

O rebaixamento para `historico` com prova de preço praticado fica bloqueado até existir chave única que cubra edital ainda aberto. Sem essa prova, o edital vencido continua visível como desfecho não confirmado. O resultado do PNCP é a prova que a issue #319 pede antes desta.

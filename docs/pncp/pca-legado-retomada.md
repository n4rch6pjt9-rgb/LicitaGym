# PCA: carga legada, retomada e inativação (etapa 4)

## Conclusão e checkpoint

O caminho sem rotina mantém a importação por classe e max_paginas por chamada. Se houver página pendente,
a execução e a resposta ficam incompleta. O checkpoint persiste pending (reconhecido pela RPC de lock),
pending_codigos_classificacao (compatibilidade), página por classe, tamanho de página, classes e chain_id.
A persistência acontece antes do primeiro HTTP e é aguardada após cada página. Falha no checkpoint interrompe
a execução; falha na gravação de itens mantém a mesma página para retry.

Chamadas seguintes do mesmo ano/classes retomam o checkpoint, inclusive quando forcar está ativo.
O checkpoint prevalece sobre pagina_inicial e tamanho_pagina novos. A chave legado agora é sempre
pca-sync:{ano}:{classes ordenadas}; forcar, pagina_inicial explícita e ano histórico continuam registrados
como modo manual na execução, sem a chave :manual: que impedia herança de continuation.
O formato legado anterior, com pending_codigos_classificacao, pode ser lido quando já estiver em execução
incompleta na mesma chave; sem prova do início na página 1, ele não promove o lastro anual.

Só uma cadeia iniciada na página 1, terminada em todas as classes e sem erro promove ultima_carga_completa.
Uma importação iniciada depois da página 1 pode concluir o intervalo pedido, mas responde
carga_anual_completa:false e não promove o lastro anual.

## Lastro e probes

metadata.carga_completa guarda o snapshot dos totais por classe, total Search e data Search da carga
comprovadamente completa. Novos probes preservam esse snapshot. A decisão de ignorar compara os probes
atuais com o snapshot, não com o último probe gravado. Uma cadeia pendente impede o skip.

Anchors antigos sem esse snapshot não permitem skip: exigem uma carga completa nova para criar o lastro.
Search indisponível, datas sem comprovação ou escopo diferente também impedem skip. O resumo e os totais
da primeira chamada da cadeia são mantidos até o fim; alterações posteriores podem exigir outra carga.

## Inativação e contrato

modo:completo sem rotina retorna HTTP 400 antes de iniciar carga. O legado não inativa planos nem itens.
Para reconciliação/inativação, usar rotina:reconciliacao da fila, com validação de completude e escopo por plano.
somente_verificacao continua sendo probe, sem carga de dados.

HTTP 200 com envelope/paginação inválidos é falha. HTTP 204 continua sendo fim válido.
pagina_inicial e max_paginas do legado precisam ser inteiros positivos; o default de max_paginas continua 100.
A resposta acrescenta continuation e carga_anual_completa. Campos de contagens e por_codigo permanecem.
As contagens do lote já gravado são conservadas também quando a chamada seguinte termina por orçamento.
Com async e waitUntil, mantém-se 202/accepted; sem waitUntil, aguarda-se o resultado real.

## Consumidores

- invoke-sync-licitagym-scope.ps1 mantém o escopo original; não envia páginas calculadas localmente nem reduz
  classes entre chamadas. A continuação fica com o servidor. Uma resposta parcial antiga sem checkpoint falha.
- reimport-pca.ps1 só confirma a página realmente retornada e sem erro; falhas geram saída 1.
  LimparAntes fica bloqueado, removendo as instruções de apagar o ano e liberar locks indiscriminadamente.
- invoke-validate-pca-anti-churn.ps1 retorna saída 2 para carga incompleta e não compara páginas diferentes como
  se fossem duas cargas completas. Resultados não comprovados deixam de retornar sucesso.
- invoke-sync-pca.ps1 continua exibindo a resposta; repetir a chamada do mesmo escopo retoma no servidor.
- api-pncp-pca continua encaminhando o body. Replay da mesma Idempotency-Key mantém a resposta anterior;
  uma nova chamada de retomada deve ter outra chave. A idempotência desse consumidor não foi redesenhada.
- api-syncs já usa a fila; não migra para o legado.

## Validação e limites

O handler existente foi exportado para testes com clientes injetáveis, mantendo a entrada Deno.serve.
Os testes exercitam o handler real com respostas PNCP sintéticas e persistência simulada sem rede.
Há também check da RPC real sob service_role no PostgreSQL isolado e testes dos scripts com HTTP simulado.
O workflow PR Quality inclui o harness PowerShell; a execução remota do CI ainda não foi realizada.

Não há migration nova nesta etapa. Depende das etapas 2 e 3 ainda locais e da ordem de implantação documentada
na etapa 3. Não houve commit, merge, deploy ou chamada de produção.
A Consulta PCA continua tendo limitações de paginação já documentadas; percorrer as páginas não transforma
o legado em prova de ausência. Histórico/projeções ainda não formam transação única com o plano.

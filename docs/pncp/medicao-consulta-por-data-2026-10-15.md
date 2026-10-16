# Medição da consulta do PNCP por data: 15/10/2026 (spec 0029, CA-1)

Rodada em 16/10/2026 com `python -m coletor.medir_consulta_pncp --data 20261015` (só leitura, nada gravado).
- **Configuração:** `tamanhoPagina` 50, que é o teto destes endpoints; 1 s entre chamadas.
- **Cobertura:** as 13 modalidades × `/api/consulta/v1/contratacoes/publicacao` e `/atualizacao`.
- **Filtro de escopo:** `escopo.classificar(objetoCompra)`, só pelo texto do objeto, sem itens nem CATMAT.

## Resultado do dia inteiro

| | publicação | atualização | total |
|---|---|---|---|
| páginas (respostas 200/204) | 135 | 252 | **387** |
| registros (`totalRegistros` = recebidos em todas as 26 combinações) | 6.310 | 12.134 | **18.444** |
| no escopo (pelo objeto) | 55 | 139 | **194** |
| tempo | ~10 min | ~15 min | **25 min** |

- **429:** 100 respostas 429, além das 387 páginas (~487 requisições, ~1 em 5), todas resolvidas pela espera do
  Retry-After. Nenhuma consulta ficou incompleta, e em todas as combinações os registros recebidos bateram com o
  `totalRegistros` da API.
- **Onde está o volume:** pregão eletrônico (6) e dispensa (8) somam 79% dos registros (14.570 de 18.444). As modalidades 2, 3,
  10, 11 e 13 cabem numa página.
- **Dentro do escopo, por modalidade:** pregão eletrônico 91, dispensa 77, concorrência eletrônica (4) 17,
  inexigibilidade (9) 6 e credenciamento (12) 3.
- **Dentro do escopo, por categoria:** `fraco` 117, `forte` 58, `piso` 10 e `obra_piso` 9. Mais da metade é `fraco`
  (objeto esportivo genérico), que hoje só vira lead depois da análise dos itens.

## O que isso diz para a trilha do dia

- **Cabe na Edge Function com fatias e continuação.** Uma janela de 2 h em horário comercial traz cerca de 1/8 do dia,
  algo como 50 chamadas e 3 a 4 min com 1 s de espera. A janela das 06:00 cobre a noite, com menos volume.
- **A cadência de 2 h decidida em 16/10 se sustenta.** Não há motivo de volume para mudar.
- **O 429 é frequente** (~1 em 5 requisições). A trilha do dia precisa do limitador por host que a Edge já tem
  (`acquire_http_slot`) e não pode tratar 429 como falha.
- **O escopo só pelo objeto é estreito.** Deram 194 compras no dia; o coletor atual grava mais, porque também classifica
  pelos itens e pelo CATMAT (`pncp.avaliar`). Para não perder lead, a trilha do dia precisa abrir os itens das compras
  ambíguas (objeto genérico de material esportivo ou de consumo) antes de descartar. Isso entra no CA-10 da spec.

## Pendências medidas aqui, a resolver na implementação

1. **Sobreposição entre publicação e atualização:** não medida (o script não guarda os identificadores). Se a
   atualização já trouxer as compras novas, a trilha do dia consulta só um endpoint e cai para cerca de 2/3 das
   chamadas.
2. **Feriado:** o dia útil é calculado só por fim de semana.
3. **Domínio de modalidades:** foram medidas as 13 (1 a 13) do manual de integração do PNCP usadas no repositório;
   se o manual tiver acrescentado um código, ele ficou de fora desta medição.

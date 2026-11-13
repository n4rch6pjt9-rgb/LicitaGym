# Medição da consulta do PNCP por data: 15/10/2026 (spec 0029, CA-1)

Rodada em 16/10/2026, de `services/coletor-externo`, com
`python -m coletor.medir_consulta_pncp --data 20261015 --saida medicao-pncp-20261015.json` (só leitura, nada gravado
no banco; o JSON ficou fora do repositório, e a tabela por modalidade abaixo foi tirada dele).
Essa rodada é anterior à contagem de requisições (`requisicoes`, acrescentada na revisão); por isso a coluna não aparece.
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

- **429:** 100 respostas 429, além das 387 páginas: pelo menos 487 requisições (~1 em 5; 5xx e falhas de rede não eram contados nessa rodada), todas resolvidas pela espera do
  Retry-After. Nenhuma consulta ficou incompleta, e em todas as combinações os registros recebidos bateram com o
  `totalRegistros` da API.
- **Onde está o volume:** pregão eletrônico (6) e dispensa (8) somam 79% dos registros (14.570 de 18.444). As modalidades 2, 3,
  10, 11 e 13 cabem numa página.
- **Dentro do escopo, por modalidade:** pregão eletrônico 91, dispensa 77, concorrência eletrônica (4) 17,
  inexigibilidade (9) 6 e credenciamento (12) 3.
- **Dentro do escopo, por categoria:** `fraco` 117, `forte` 58, `piso` 10 e `obra_piso` 9. Mais da metade é `fraco`
  (objeto esportivo genérico), que hoje só vira lead depois da análise dos itens.

## Por endpoint e modalidade

| endpoint | modalidade | páginas | registros | no escopo | 429 | tempo (s) |
|---|---|---|---|---|---|---|
| publicacao | 1 | 1 | 7 | 0 | 0 | 1.4 |
| publicacao | 2 | 1 | 0 | 0 | 0 | 1.0 |
| publicacao | 3 | 1 | 1 | 0 | 0 | 1.0 |
| publicacao | 4 | 5 | 232 | 4 | 0 | 5.5 |
| publicacao | 5 | 1 | 10 | 0 | 3 | 27.7 |
| publicacao | 6 | 35 | 1.715 | 21 | 12 | 148.2 |
| publicacao | 7 | 1 | 32 | 0 | 3 | 27.4 |
| publicacao | 8 | 64 | 3.173 | 27 | 24 | 281.6 |
| publicacao | 9 | 21 | 1.040 | 2 | 6 | 76.6 |
| publicacao | 10 | 1 | 2 | 0 | 3 | 32.2 |
| publicacao | 11 | 1 | 1 | 0 | 0 | 1.0 |
| publicacao | 12 | 2 | 93 | 1 | 0 | 2.2 |
| publicacao | 13 | 1 | 4 | 0 | 0 | 3.3 |
| atualizacao | 1 | 1 | 13 | 0 | 0 | 5.9 |
| atualizacao | 2 | 1 | 0 | 0 | 0 | 4.5 |
| atualizacao | 3 | 1 | 2 | 0 | 0 | 5.7 |
| atualizacao | 4 | 15 | 708 | 13 | 1 | 53.4 |
| atualizacao | 5 | 1 | 35 | 0 | 0 | 6.7 |
| atualizacao | 6 | 92 | 4.572 | 70 | 25 | 367.5 |
| atualizacao | 7 | 2 | 81 | 0 | 0 | 3.9 |
| atualizacao | 8 | 103 | 5.110 | 50 | 18 | 335.3 |
| atualizacao | 9 | 27 | 1.341 | 4 | 4 | 96.5 |
| atualizacao | 10 | 1 | 2 | 0 | 0 | 2.7 |
| atualizacao | 11 | 1 | 3 | 0 | 0 | 2.0 |
| atualizacao | 12 | 6 | 262 | 2 | 1 | 18.6 |
| atualizacao | 13 | 1 | 5 | 0 | 0 | 3.0 |

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

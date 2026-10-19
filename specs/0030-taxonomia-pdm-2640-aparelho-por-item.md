# 0030: Ler o aparelho por item no PDM 2640 e tratar a posição do supino como característica

- **Status:** em implementação
- **Issue:** nenhuma (relacionada: #272, versionamento da taxonomia)
- **Área:** coletor (taxonomia / dicionário de aparelhos)
- **Depende do ok do Marcelo:** sim (regra de classificação). Regras combinadas com o Marcelo em 19/10.

## Problema

O PDM 2640 (APARELHO / EQUIPAMENTO PARA CONDICIONAMENTO FÍSICO) junta dezenas de aparelhos. No CATMAT (106 itens em
`catmat_itens`, consulta de 19/10) ele aparece em dois formatos:

- **A:** o TIPO é o aparelho (`479577 TIPO: CADEIRA FLEXORA`).
- **B:** o TIPO é o mecanismo, e o aparelho vem em CARACTERÍSTICAS ADICIONAIS ou MODELO. Exemplos:
  - `442720 TIPO: ARTICULADO … CARACTERISTICAS ADICIONAIS: SUPINO RETO`;
  - `442719 … HACK DE AGACHAMENTO`.

`classificar_aparelho.py` consulta o TIPO antes do texto. No dicionário, `ARTICULADO` e `CONJUGADO` apontam para
`aparelho_musculacao_indefinido` com confiança "alta", e a classificação para ali: supino reto, supino sentado, hack e
flexo-extensor saem como "indefinido".

Do mesmo jeito, `BANCO REGULÁVEL` + "SUPINO DECLINADO" saía `banco_livre`.

Reto, inclinado e declinado eram valores do eixo "ângulo", misturados com 90°, 45° e "regulável". "3x1" e "3 em 1" não
eram reconhecidos.

## Regras (decisão do Marcelo, 19/10)

1. **TIPO de mecanismo:** ARTICULADO, CONJUGADO, ELÉTRICA/ELÉTRICO e MECÂNICA/MECÂNICO não dizem o aparelho. Viram
   característica (articulado → `cinematica: articulada`, conjugado → `dupla_funcao`, elétrica →
   `fonte_carga: motor`).
2. **Onde ler o aparelho:** nesse caso, nos campos CARACTERÍSTICAS ADICIONAIS, MODELO e IDENTIFICAÇÃO. O mapeamento do
   TIPO (`catmat_tipo`) só vale se esses campos não disserem o aparelho:
   - se o mapeamento cair num nó genérico, a confiança é "baixa";
   - se for um mapeamento curado só para o PDM (ex.: `2640:ELÉTRICA` = esteira), a confiança continua "alta".
3. **TIPO genérico refinado pelo texto:** `BANCO REGULÁVEL` + "supino" = `banco_supino`. No caminho do TIPO só valem
   os refinos marcados com `aplica_no_tipo` no dicionário (hoje só este); sem mapeamento do TIPO, o texto inteiro decide,
   como antes.
4. **Posição:** reto, inclinado e declinado são a **característica `posicao`**, com um ou mais valores.
   - "3x1", "3 em 1" e "três posições" = os três, só perto de "supino" ou "banco" ("kit 3x1" não conta).
   - "Regulável" vira a característica `ajuste` e não informa a posição.
   - 90°/45° continuam em `angulo`.
5. **Comparação com o produto (de-para, fora desta entrega):** o produto atende quando as posições dele incluem as que o
   edital pede.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um item do PDM 2640 com TIPO de mecanismo e o aparelho nas características adicionais (442720, 442719, 480254, 251309), **quando** classificado, **então** o nó é o aparelho e `cinematica` = articulada. Sem aparelho nos campos (251307), **então** é indefinido com confiança "baixa". ELÉTRICA sem aparelho nos campos continua esteira; com "simulador de escada" nos campos, **então** é simulador de escada. | pytest `services/coletor-externo/tests/test_classificar_aparelho_pdm2640.py::test_ca1_*` |
| CA-2 | **Dado** TIPO `BANCO REGULÁVEL` com "SUPINO DECLINADO/INCLINADO" (473406, 480139), **quando** classificado, **então** o nó é `banco_supino` com a `posicao` correspondente. | `test_ca2_*` |
| CA-3 | **Dado** "banco supino 3x1" ou "3 em 1", **quando** classificado, **então** `posicao` = [reto, inclinado, declinado]. **Dado** "banco regulável", **então** não há `posicao`, e `ajuste` = regulavel. | `test_ca3_*` |
| CA-4 | **Dado** o formato A (TIPO = aparelho), **quando** classificado, **então** nada muda: nó e confiança "alta". | `test_ca4_*` e `tests/test_taxonomia.py` |
| CA-5 | Regressões da revisão: TIPO mecanismo sem PDM usa o texto inteiro; refino por modalidade não entra no caminho do TIPO; peça continua peça no texto; "3x1" sem supino/banco não vira posição. | `test_tipo_mecanismo_sem_pdm_*`, `test_refino_por_modalidade_*`, `test_peca_continua_*`, `test_3_em_1_sem_*` |

## Fora de escopo

- Aplicar a taxonomia em `licitacao_itens` (está NULL em 100% das linhas, #272 item 4).
- Comparação de posição no de-para (`ontologia_atributos` / `catalogo_de_para`): próxima spec.
- Pista `cinematica: polia` casando "POLIAMIDA" (achado no dry-run; vira issue).
- Nó para "cadeira-remo" (251310, 472025): ficam indefinidos com confiança baixa até o Marcelo dizer qual é o aparelho.

## Impacto em dados

- **Migration:** não. Os pares nó × PDM e a versão do dicionário (0.3) não mudam; `tests/supabase/taxonomia_no_pdm_test.ts` passa.
- **Tabelas tocadas:** nenhuma. Muda o resultado do classificador do coletor (`calcular_taxonomia`, `perfil_item`).
- **Backfill:** não. Dry-run nos 106 itens CATMAT do PDM 2640, antes × depois:
  - 9 itens mudam de nó ou de confiança;
  - 17 mudam algum atributo, a maioria só `angulo: [regulavel]` → `ajuste: regulavel`.
- **Contrato com o Dashboard:** o atributo `angulo` com reto/inclinado/declinado passa a ser `posicao`. Nenhuma tela lê
  esse atributo hoje.
- **Dado oficial x derivado:** o TIPO e as características do CATMAT ficam como estão. Só o nó derivado muda.

## Perguntas em aberto

- "Cadeira-remo" (251310, 472025: articulado, para bíceps e peitoral) é qual aparelho?
- A fonte editável citada no `classificar_aparelho.py` (`docs/agente-editais/dicionario-aparelhos/dados.py`) não está no
  repositório. Esta mudança editou o JSON operacional; a próxima geração do dicionário precisa trazê-la.

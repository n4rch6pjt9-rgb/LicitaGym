# 0031: Revisar a /precos: estimado × homologado, links da compra, filtros, KPIs e marca pela ata

- **Status:** rascunho (revisada em 21/10 com o feedback do Marcelo, as respostas às perguntas e medições novas)
- **Alimenta:** spec-mãe 0032, fase 3 (agente de preço: estimado × homologado e "fora do perfil")
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma (feedback do Marcelo de 19/10 e de 21/10 sobre a página /precos)
- **Área:** coletor | migrations | edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration nova, decisão de produto, dado de produção)

## Leitura obrigatória antes de implementar

Os itens 1 a 4 e 10 do `_template.md` valem como estão. Específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` (fase 3) e `specs/0009-precos-historicos-pesquisa-preco.md` | objetivo maior e contrato atual da `api-precos` |
| 7 | `.claude/rules/` de coletor, migrations, edge-functions e, no Dashboard, de telas | convenções de cada área |
| 8 | README da `api-precos`; no Dashboard, `PriceResearchView.tsx` e `src/test/precos-tela.test.tsx` | contrato e tela atuais |
| 9 | `docs/compras-gov/schemas-consultas.md`, `docs/pncp/schemas-consultas-pncp.md` | as APIs 2.1 de contratações, a consulta de compra e `/atas` do PNCP |

## Problema

A /precos (spec 0009) mostra o preço homologado de cada compra, mas não mostra quanto o órgão estimou nem de onde veio
o número. Sem isso, não dá para auditar um preço estranho, e o agente de preço (0032, fase 3) não tem o desconto
estimado → homologado.

**Caso de referência 1** (consultado em 19/10): `id_compra` 93099205000052026, item 11, CATMAT 373980 (esteira
ergométrica), PDM 7115, UASG 930992. Objeto: "máquinas, implementos e tratores para equipar as Centrais Municipais de
Resíduos". 18 unidades a R$ 52.000, marca TCMAQ. A API 2.1 do Compras.gov devolve estimado R$ 80.800, situação
Homologado e PNCP `44678797000156-1-000004/2026`. É uma esteira de triagem de resíduos catalogada como esteira
ergométrica: o link e o objeto resolvem o caso em segundos. Sem eles, o número entra na mediana.

**Caso de referência 2** (consultado em 21/10): `id_compra` 16021805900022026, item 66, CATMAT 602701, PDM 9634, UASG
160218 (Colégio Militar de Belém). A API 2.1 devolve duas linhas do item: "Em andamento" (sem resultado) e "Homologado"
com estimado R$ 3.156,67 e resultado R$ 2.229,00 (diferença −29,39%), PNCP `00394452000103-1-010524/2026`, SRP. O
resultado do PNCP (`/itens/66/resultados`) traz `marcaFornecedor`, `modeloFornecedor` e `fabricante` **nulos**; a
Pesquisa de Preço traz marca "PROCOPIO". O PNCP tem a ata de registro de preço 00102/2026 publicada (assinada em 13/08)
e, na consulta da compra, o `linkSistemaOrigem` do portal oficial.

**Medido no banco** (`precos_praticados_itens`):
- 19/10: 25.465 linhas, 5.283 compras, 33 PDMs; `data_resultado` de 2021-12-01 a 2026-10-01; uma só carga
  (`last_synced_at` = 2026-10-03 02:09 UTC); nenhuma linha com `detalhe_sincronizado_em`.
- 21/10: a tabela grava os 41 campos da `1_consultarMaterial` mais o `raw`. As colunas `fabricante` e `modelo` estão
  vazias em 100% das linhas (a API não tem esses campos). A tela mostra uns 10 campos: o corte é da `api-precos` e da
  tela, não da coleta.
- 21/10: PDM 9634 tem 730 linhas no banco e 741 na API (as 11 a mais são resultados depois de 03/10). Nenhum item com
  preço está faltando; o que falta é a coleta voltar a rodar.
- 21/10: o dropdown do PDM 9634 lista 14 itens; só 2 têm preço nos últimos 24 meses (602701: 234; 471988: 146). O
  67288 tem 27 preços, o último de 13/12/2022. Os outros 11 têm 0 na API.
- **PDM 7115:** 40 de 206 preços ficam fora de 0,4× a 2,5× a mediana do próprio item.

**Cobertura do enriquecimento** (amostra de 180 compras, 30 por ano, consultada em 21/10 na API
`1.1_consultarContratacoes_PNCP_14133_Id` e no PNCP):

| Ano da compra | Acha no PNCP | Estimado do item | Ata publicada no PNCP |
|---|---|---|---|
| 2021 | 2/30 | 1/30 | 0 |
| 2022 | 0/30 | 0/30 | 0 |
| 2023 | 10/30 | 10/30 | 3 |
| 2024 | 24/30 | 24/30 | 9 |
| 2025 | 30/30 | 30/30 | 6 |
| 2026 | 30/30 | 30/30 | 11 |

O dígito "9" na posição da modalidade do `id_compra` não serve de filtro: 37 compras sem ele estavam no PNCP.

**Feedback de tela** (19/10 e 21/10):
- Órgão e UASG repetem a mesma informação; fica só a UASG (código · nome).
- A coluna "Objeto da compra" ocupa a tabela; sai, e no lugar entram os links do PNCP e do portal oficial.
- Falta o trio Estimado | Homologado | Diferença (%) por linha.
- Faltam filtros por objeto, cidade, UASG e busca livre.
- O dropdown de itens mostra itens sem preço; deve mostrar só os que têm amostra, com o N.
- Os KPIs não dizem qual item tem mais amostras nem o desconto típico.
- O quadro descritivo repete a "Fonte" duas vezes e o texto de método não ajuda a decidir.
- A marca da Pesquisa de Preço é digitada pelo fornecedor ("Mesa", "propria", "conforme o TR", "1084"); a marca
  homologada está na ata.

## Operação (antes da implementação, sem código)

A coleta de preços não roda desde 03/10 (18 dias em 21/10). A conferir pelo Marcelo no GCP:

1. `gcloud run jobs executions list --job coletor-sestsenat --region $REGION --limit 5`: há execução depois de 03/10?
2. `gcloud scheduler jobs list --location $REGION`: existe agendamento com `--args="--coleta,precos"`?
3. A imagem do Job foi reconstruída depois de 09/10 (#291)? Sem isso, o Job não conhece `--coleta`.
4. A issue `alerta-operacional` com `precos_dias_sem_coleta` crítico deveria estar aberta. Se não estiver, o `saude.yml`
   também precisa de olhar.

## Proposta

### Fase A: estimado, links e tela (sem modelo de IA)

1. **Recorte de 24 meses** (decisão de 21/10): o enriquecimento só busca compras com `data_resultado` nos últimos 24
   meses. Fora desse recorte, estimado e links aparecem como "—" com o motivo "fora do recorte de enriquecimento".
2. **Coleta nova (`coletor/compras_itens_contratacao.py`):**
   - para cada `id_compra` distinto do recorte, ainda sem linha na tabela nova (ou com `data_hora_atualizacao_compra`
     mais nova), chama `GET /modulo-contratacoes/2.1_consultarItensContratacoes_PNCP_14133_Id?tipo=idCompra&codigo=<id>`
     (uma chamada por compra devolve todos os itens; testada em 21/10 no caso 2);
   - grava `valorUnitarioEstimado`, `valorUnitarioResultado`, `situacaoCompraItemNome`, `numeroControlePNCPCompra`,
     `orgaoEntidadeCnpj`, `dataAtualizacaoPncp` e o `raw`;
   - para o link do portal oficial, uma segunda chamada por compra ao PNCP:
     `GET /api/consulta/v1/orgaos/<cnpj>/compras/<ano>/<sequencial>`, gravando `linkSistemaOrigem` (no caso 2:
     `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=16021805900022026`);
   - roda no mesmo Job, depois de `--coleta precos`, com delay de no mínimo 1 s;
   - a primeira carga é o número de compras distintas do recorte (medir no PR com dry-run); depois, só as novas.
3. **Regra de duplicata:** fica a linha com `temResultado = true`; havendo empate, a de `dataAtualizacaoPncp` mais nova.
   Estimado igual a 0 é ausente, nunca zero.
4. **Migration aditiva** `supabase/migrations/<ts>_precos_itens_contratacao.sql`: tabela
   `public.precos_itens_contratacao`, chave `(id_compra, numero_item_compra)`, colunas da coleta mais
   `link_sistema_origem`, `payload_hash` e `last_synced_at`. RLS ligada, sem policy, `revoke all`, leitura só pela Edge
   Function.
5. **`api-precos`, ação `amostras`** (aditiva): por linha,
   - `valor_estimado` (oficial ou `null`), `valor_homologado` (o `preco_unitario`), `diferenca_valor` e
     `diferenca_percentual` = (homologado − estimado) / estimado × 100, 2 casas, meio para longe do zero, só com estimado;
   - `link_pncp` = `https://pncp.gov.br/app/editais/<cnpj>/<ano>/<sequencial>`, a partir do nº de controle;
   - `link_portal_oficial` = o `linkSistemaOrigem` que o PNCP mostra (decisão de 21/10). Sem ele, montado a partir do
     `id_compra` no padrão do Compras.gov (`...landing?destino=acompanhamento-compra&compra=<id_compra>`), com
     `link_portal_oficial_origem = "montado"`; com ele, `"pncp"`;
   - os campos já gravados e hoje descartados: município, modalidade, forma (SISPP/SISRP), critério de julgamento e
     `percentual_maior_desconto`.
6. **Filtros** (decisão de 21/10), os mesmos na `amostras`, no `resumo` e na `itens`, num objeto só (`filtro`), como
   na referência do HAR (ver item 10):
   - `objeto`: texto no objeto da contratação;
   - `pdm` e `item` (código CATMAT);
   - `meses`: 12 ou 24;
   - `uf` e `municipio` (o município depende da UF; lista vinda dos dados do recorte);
   - `uasg`: código exato ou texto no nome da UASG ou do órgão;
   - `q`: busca livre por palavras em objeto, descrição do item, marca, fornecedor e nome da UASG;
   - texto sempre sem acento e sem diferenciar maiúsculas; várias palavras = todas presentes.
7. **Itens do PDM com N:** ação nova `itens` na `api-precos`: para o PDM e o período, devolve
   `codigo_item_catalogo`, descrição e `n`, só com `n > 0`, ordenados por `n` desc.
8. **"Fora do perfil" não entra na /precos** (decisão de 21/10): a tela não exclui nem marca linha sozinha; quem limpa
   o recorte é o operador, pelos filtros. A regra (fora de [0,4×, 2,5×] a mediana do mesmo item e unidade, com ao
   menos 5 preços) vale como regra de produto e fica para a referência praticada do agente de preço (0032, fase 3).
9. **KPIs** (`resumo`, aditivo): além de n, média, mediana, p25–p75 e mín–máx,
   - `item_mais_amostras`: código, descrição curta e n (no recorte sem filtro de item);
   - `diferenca_mediana_percentual`: mediana da diferença estimado → homologado das linhas com estimado, com o `n_com_estimado`.
10. **Front** (Dashboard, PR depois do backend no ar):
    - **Tabela:** Data | UASG (código · nome) | UF | Cidade | Qtd. | Estimado | Homologado | Diferença (%) | Unidade |
      Marca | Fornecedor | Links (ícones PNCP e Portal oficial). Sai "Órgão" e "Objeto da compra"; o objeto aparece
      no `title` dos links.
    - **Filtros**, no formato da referência (HAR da pesquisa do Licitar Digital, 21/10; referência, não regra):
      - no topo, uma caixa de busca livre (`q`) com placeholder "Pesquise por objeto, item, marca, fornecedor ou UASG";
      - "Filtros rápidos" em chips: 12 | 24 meses;
      - "Filtros avançados" num painel: Objeto da contratação, PDM, Item (dropdown "código · descrição curta · N
        amostras", só N > 0, ordenado por N), UF, Cidade (depende da UF), UASG (código ou nome);
      - faixa de filtros aplicados, cada um com "x", mais "Limpar filtros"; sem filtro, "Nenhum filtro aplicado";
      - contagem "N preços encontrados" ao lado dos filtros;
      - estado vazio: "Nenhum preço encontrado. Tente alterar algum filtro.";
      - todos os filtros na URL, para compartilhar o recorte.
    - **KPIs:** Amostras (N) | Mediana | Faixa central p25–p75 | Mín–Máx | Desconto mediano estimado → homologado |
      Item com mais amostras (código e N). A média sai do destaque e vai para o detalhe, porque é puxada por outlier.
    - **Quadro descritivo:** uma linha só: "UN (UNIDADE) em 145 de 146 preços · Fonte: Compras.gov (Pesquisa de Preço +
      Contratações 14.133) e PNCP · período 22/10/2024 a 21/10/2026 · última coleta: <data>". O aviso de unidades
      mistas fica, com o filtro de item sugerido. A regra de cálculo vai para um ícone de ajuda.
    - **Selo** no link do portal oficial quando ele foi montado e não veio do PNCP.

### Fase B: marca homologada pela ata (com modelo de IA)

1. **Coleta das atas:** para as compras da fase A com SRP, `GET /api/pncp/v1/orgaos/<cnpj>/compras/<ano>/<seq>/atas` e
   os arquivos de cada ata. Na amostra de 21/10, 29 de 96 compras achadas tinham ata publicada.
2. **Leitura:** o PDF da ata vira texto; um extrator acha, por item, marca, modelo e fabricante. Saída com o trecho da
   ata que prova cada campo; sem trecho, o campo fica `null`.
3. **Tela:** coluna Marca mostra a marca da ata, com selo "ata"; sem ata, mostra a da Pesquisa de Preço com selo
   "informada pelo fornecedor". As duas ficam visíveis no detalhe da linha.
4. A marca da ata é **derivada** (leitura de documento), rotulada como tal; a da Pesquisa de Preço segue intacta.

## Plano de uso de modelos

| Etapa | Modelo | Por quê |
|---|---|---|
| Coleta, parser, migration, `api-precos`, testes (fase A) | nenhum em execução; implementação com Sonnet | regra determinística |
| Tela e revisão de UX (fase A) | Sonnet; agente `ux-ui-licitagym` | trabalho de front com testes |
| Revisão de segurança e da migration | Opus só nos revisores `revisor-seguranca` e `revisor-migration` | erro aqui expõe dado |
| Extração da marca na ata (fase B, em produção) | Haiku por padrão; sobe para Sonnet só quando o Haiku não acha trecho ou o item tem mais de uma marca | volume alto, tarefa curta, custo por documento |
| Amostra de conferência da fase B (30 atas) | Opus, uma vez, para medir acerto do Haiku | define se o Haiku basta |

## Fases no Cowork

1. **Operação:** o Marcelo confere o Job e o agendamento (seção "Operação"). Sem coleta rodando, o resto mostra dado velho.
2. **Backend fase A:** `/implement` com CA-1 a CA-10 (com os 6b, 7b e 7c): coleta, migration, `api-precos`. PR draft no LicitaGym.
3. **Front fase A:** agente `frontend-dashboard` com CA-11 a CA-14 (com o 11b), depois do backend no ar. PR draft no Dashboard.
4. **Fase B:** só depois da A em produção e com a pergunta 2 respondida; CA-15 a CA-17.

## Critérios de aceite

| ID | Fase | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | A | **Dado** a resposta gravada da API 2.1 para 93099205000052026 (fixture), **quando** o parser roda, **então** o item 11 sai com estimado 80800, resultado 52000 e PNCP `44678797000156-1-000004/2026`, e a linha "Em andamento" com estimado 0 é descartada. | pytest `services/coletor-externo/tests/test_compras_itens_contratacao.py` |
| CA-2 | A | **Dado** a fixture de 16021805900022026, **quando** o parser roda, **então** o item 66 sai com estimado 3156.67 e resultado 2229.0, e a linha "Em andamento" é descartada. | pytest (mesmo arquivo) |
| CA-3 | A | **Dado** um item cujo estimado é 0 ou ausente, **quando** grava, **então** `valor_unitario_estimado` fica NULL. | pytest (mesmo arquivo) |
| CA-4 | A | **Dado** compras com `data_resultado` dentro e fora dos 24 meses, **quando** a coleta roda, **então** só as de dentro são consultadas. | pytest (mesmo arquivo) |
| CA-5 | A | **Dado** erro HTTP ou JSON ilegível em uma compra, **quando** a coleta roda, **então** a compra conta em `falhas`, nada é gravado para ela e o Job sai com código 1. | pytest (mesmo arquivo) |
| CA-6 | A | **Dado** uma linha com estimado 80800 e homologado 52000, **quando** a amostra é pedida, **então** vêm `diferenca_valor` −28800, `diferenca_percentual` −35,64, `link_pncp` e `link_portal_oficial`. | Deno `tests/supabase/api-precos/amostra_estimado_test.ts` |
| CA-6b | A | **Dado** a compra 16021805900022026 com `linkSistemaOrigem` no PNCP, **quando** a amostra é pedida, **então** `link_portal_oficial` é esse link e a origem é `"pncp"`; **dado** uma compra sem ele, o link é montado do `id_compra` e a origem é `"montado"`. | Deno (mesmo arquivo) |
| CA-7 | A | **Dado** `uasg=160218`, **quando** a amostra e o resumo são pedidos, **então** só entram linhas dessa UASG; com `uasg=belem`, entram as de nome com "Belém". | Deno `tests/supabase/api-precos/filtros_test.ts` |
| CA-7b | A | **Dado** `uf=PA` e `municipio=BELÉM`, **quando** a amostra é pedida, **então** só entram linhas de Belém/PA; `municipio` sem `uf` dá 400. | Deno (mesmo arquivo) |
| CA-7c | A | **Dado** `q=klopf mesa`, **quando** a amostra é pedida, **então** só entram linhas com as duas palavras em algum dos campos da busca livre, sem diferenciar acento e maiúsculas; com `objeto=esportivo`, só as de objeto com "esportivo". | Deno (mesmo arquivo) |
| CA-8 | A | **Dado** o PDM 9634 em 24 meses, **quando** a ação `itens` é pedida, **então** volta só itens com `n > 0`, ordenados por `n` desc, sem nenhum com `n = 0`. | Deno `tests/supabase/api-precos/itens_test.ts` |
| CA-9 | A | **Dado** um item com 5 ou mais preços e um acima de 2,5× a mediana, **quando** o resumo da /precos é pedido sem filtro, **então** esse preço entra em n, mediana e quartis (nada é excluído sozinho). | Deno `tests/supabase/api-precos/resumo_sem_exclusao_test.ts` |
| CA-10 | A | **Dado** `anon` ou `authenticated` sem empresa, **quando** lê `precos_itens_contratacao` direto, **então** recebe erro de permissão. | SQL `supabase/tests/precos_itens_contratacao_check.sql` |
| CA-11 | A | **Dado** a amostra com estimado, **quando** a tabela renderiza, **então** há as colunas UASG, Estimado, Homologado, Diferença (%) e Links, e não há "Órgão" nem "Objeto da compra"; sem estimado, as três colunas mostram "—". | vitest `src/test/precos-tela.test.tsx` |
| CA-11b | A | **Dado** filtros aplicados, **quando** a tela renderiza, **então** cada filtro aparece na faixa de aplicados com "x", "Limpar filtros" zera todos, a contagem de preços aparece, e sem resultado aparece o estado vazio. | vitest (mesmo arquivo) |
| CA-12 | A | **Dado** a ação `itens`, **quando** o dropdown abre, **então** cada opção mostra código, descrição curta e N, e nenhuma tem N = 0. | vitest (mesmo arquivo) |
| CA-13 | A | **Dado** o resumo, **quando** os KPIs renderizam, **então** aparecem o item com mais amostras (código e N) e o desconto mediano com o `n_com_estimado`; o quadro descritivo tem uma só linha de fonte. | vitest (mesmo arquivo) |
| CA-14 | A | **Dado** filtros escolhidos, **quando** a URL é aberta em outra aba, **então** o mesmo recorte aparece. | vitest (mesmo arquivo) |
| CA-15 | B | **Dado** a ata 00102/2026 da compra 16021805900022026 (fixture), **quando** o extrator roda, **então** o item 66 sai com a marca da ata e o trecho que a prova. | pytest `.../test_atas_marca.py` |
| CA-16 | B | **Dado** uma ata sem o item, **quando** o extrator roda, **então** a marca fica `null` e a tela mostra a da Pesquisa de Preço com o selo "informada pelo fornecedor". | pytest + vitest |
| CA-17 | B | **Dado** a amostra de conferência de 30 atas, **quando** o Haiku e o Opus extraem, **então** o PR registra a taxa de concordância. | relatório no PR |

## Skills e agentes por contrato

| Contrato | Implementação | Revisão antes do PR | Depois do merge |
|---|---|---|---|
| Coleta (fases A e B) | `/implement` | `revisor-codigo` | `verificar-producao` |
| Migration | skill `nova-migration` | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| `api-precos` | `/implement` | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| Tela /precos | agente `frontend-dashboard` | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |

## Fora de escopo

- Compras fora do recorte de 24 meses (62% do acervo acha no PNCP, mas 2021–2022 quase não): sem enriquecimento.
- "Fora do perfil" na /precos (vai para o agente de preço, 0032 fase 3).
- Recatalogar ou excluir de vez as compras mal catalogadas: nada é apagado.
- Religar ou agendar o Job no GCP: é operação do Marcelo.
- Chat da sessão e propostas perdedoras (o portal exige captcha).
- Registro da execução de preços em `private.coleta_externa_run`: issue própria se valer.

## Impacto em dados

- **Migration:** sim, aditiva e idempotente (tabela nova; função do resumo com parâmetros novos com default; fase B: tabela `precos_atas_marca`).
- **Tabelas, views e funções tocadas:** `precos_itens_contratacao` (nova, escrita pelo coletor, lida pela `api-precos`; inclui `link_sistema_origem`); `precos_praticados_resumo` (parâmetros novos com default: `p_objeto`, `p_uf`, `p_municipio`, `p_uasg`, `p_q`).
- **ACL e RLS:** RLS ligada sem policy, `revoke all` de `anon` e `authenticated`, grant só a `service_role`.
- **Backfill:** primeira carga das compras do recorte de 24 meses (contagem no PR, com dry-run). Não altera `precos_praticados_itens`.
- **Edge Functions republicadas no merge:** todas (regra do repositório). Muda a `api-precos`.
- **Contrato com o Dashboard:** aditivo. O backend vai ao ar antes do front.
- **Dado oficial × derivado:** oficiais: estimado, homologado, situação, nº PNCP, link do sistema de origem (PNCP), marca da Pesquisa de Preço. Derivados: diferença, link do PNCP e link do portal montado (a partir de identificadores oficiais) e marca da ata (leitura de documento, com trecho).

## Decisões do Marcelo

- 21/10: o enriquecimento (estimado, links e ata) cobre só o recorte de 24 meses.
- 21/10: a tabela fica só com a coluna UASG; "Objeto da compra" sai e no lugar entram os links do PNCP e do portal oficial.
- 21/10: o dropdown de itens mostra só itens com amostra, com o N.
- 21/10: a faixa de 0,4× a 2,5× a mediana com mínimo de 5 preços vale como regra de produto (para o agente de preço).
- 21/10: não existe orçamento sigiloso depois de homologado: a /precos não mostra campo nem selo de sigilo.
- 21/10: o link do portal oficial é o que o PNCP mostra (`linkSistemaOrigem`); sem ele, montado a partir do portal oficial do edital.
- 21/10: "fora do perfil" não entra na /precos; o operador limpa o recorte pelos filtros.
- 21/10: filtros: objeto da contratação, PDM, item, 12 e 24 meses, UF, cidade, UASG e busca livre por palavras. O HAR da pesquisa do Licitar Digital é referência de formato, não regra.

## Perguntas em aberto

1. "Navegação": além dos filtros na URL, há outro fluxo esperado (por exemplo, ir da linha para a oportunidade ou para o BI)?
2. Fase B: a marca da ata substitui a da Pesquisa de Preço nas estatísticas por marca do BI, ou só na tela?
3. Link montado: a Pesquisa de Preço é do Compras.gov, então toda compra dela deveria ter portal oficial Compras.gov. Se
   aparecer compra sem `linkSistemaOrigem` de outro portal (não medido), vale só o link do PNCP?

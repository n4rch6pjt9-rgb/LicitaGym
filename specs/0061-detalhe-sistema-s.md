# 0061: Mostrar o detalhe da oportunidade do Sistema S a partir do banco

- **Status:** em implementação (aprovada pelo Marcelo em 13/11/2026; parte 1: K-11 e K-12; parte 2: K-13 e K-14; K-1 no #546). **Adendo de 13/11/2026 (K-15 a K-17, processo julgado por lote): aprovado pelo Marcelo em 13/11/2026.**
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar: coleta e detalhe da oportunidade do Sistema S)
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** edge-functions, coletor, migrations (tabela `licitacao_lances`), dashboard-contrato, dashboard-tela
- **Depende do ok do Marcelo:** sim (migration nova em produção e secrets novos do visitante). Perguntas em aberto: nenhuma.

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` do repositório | como roda, testa e entrega; o que não fazer | sim |
| 2 | `AGENTS.md` (backend) | zero alucinação, fontes, identificadores oficiais | sim no backend |
| 3 | `.claude/rules/regras-negocio.md` (backend) | contrato de serviço nunca vira lead; TR antes do CATMAT | sim no backend |
| 4 | `docs/produto/ESCOPO.md` | módulos 1 e 3 | não: ler |
| 6 | `specs/0029-coleta-do-dia-e-acervo.md` (revisão em `lg-spec-0029-rev`, K-4 e R-1) | o detalhe lido do banco, com `origem` e `gravado_em` por seção; esta spec reaproveita o formato | não: ler |
| 7 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 8 | `.claude/rules/edge-functions.md`, `.claude/rules/coletor.md`, `.claude/rules/document-pipeline.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | convenções das áreas tocadas | ler antes de abrir a pasta |
| 9 | `supabase/functions/api-dashboard-oportunidades/README.md` (seção 4, `acompanhamento`), `acompanhamento.ts`, `copiaLocal.ts`, `index.ts` | contrato atual do detalhe; `copiaLocal.ts` só lê documentos `pncp-N` | não: ler |
| 10 | `supabase/functions/_shared/edital-url.ts` (`buildPortalUrl`, `PARADIGMA_MURAL`) | `url_portal` hoje é só o mural da fonte | não: ler |
| 11 | `services/coletor-externo/coletor/documentos_paradigma.py` (`sincronizar`, `_sincronizar_resumo`, `ARQUIVO_RESUMO`) e `coletor/paradigma.py` (`quer_resumo_do_processo`, `status_normalizado`, `linhas_itens`) | o que o coletor grava para o Sistema S (#536) | não: ler |
| 13 | `services/coletor-externo/coletor/escopo.py` (`servico_sem_material`, regras de serviço) e `supabase/migrations/20261109160000_fieb_servico_fora_do_escopo.sql` | regra de serviço do Paradigma (#509) e o padrão do backfill anterior | não: ler |
| 14 | Dashboard: `src/components/opportunities/OpportunityDetailRealView.tsx` (abas Itens, Documentos e Histórico; botão Acompanhamento), `src/components/opportunities/OpportunityAcompanhamentoView.tsx` (tela `/oportunidades/:id/acompanhamento`), `src/App.tsx` (rota), `src/components/opportunities/OpportunityListView.tsx` (filtros), `src/data/fontes.ts` (`FONTES_CATALOGO`) | a tela que muda | não: ler |
| 15 | `docs/pncp/schemas-consultas-pncp.md` (domínio de modalidades) | os 19 códigos oficiais do PNCP para o catálogo canônico (K-7) | não: ler |
| 16 | `.claude/agents/revisor-codigo.md`, `revisor-seguranca.md`, `revisor-migration.md`; `.claude/skills/nova-migration/SKILL.md`, `validar-migrations/SKILL.md`, `dry-run-classificacao/SKILL.md`, `verificar-producao/SKILL.md`; Dashboard: `.claude/agents/frontend-dashboard.md`, `ux-ui-licitagym.md`, `.claude/skills/run-dashboard/SKILL.md`, `deploy-dashboard/SKILL.md` | procedimento de cada etapa | quando invocados |

## Problema

Medido em 12/11/2026 (MCP somente leitura, logs do Actions e código da `main` em `bd75050`):

- **O detalhe do Sistema S fica vazio.** Exemplo: SDE 2026016793 (FIEB, `id_externo` 18868), tela do Marcelo de 12/11.
  - **Abas Itens, Documentos e Histórico:** "Sem dados disponíveis. Esta oportunidade não é de origem PNCP ou não possui chave de identificação PNCP".
  - **Botão "Acompanhamento":** leva a `/oportunidades/:id/acompanhamento` (`OpportunityAcompanhamentoView.tsx`), que só procura no PNCP ou no Compras.gov e diz que não achou registro.
  - **A causa é a mesma nos dois:** as abas e a tela usam a ação `acompanhamento`, que só monta chave para o PNCP (`acompanhamento.ts:110`).
  - **O que o banco tem desse edital:** 1 item em `licitacao_itens`, 0 linhas em `licitacao_resultados` e 10 documentos.
- **De onde vêm Itens e Histórico no portal** (HAR V2 do mural da FIEB, processo 38191, 12/11; o Marcelo apontou as duas chamadas):
  - **Itens:** `PesquisarProcessoDetalheItemProduto` (corpo `{dtoProcesso:{nCdProcesso, nCdModulo, sNrProcesso, nCdLote:0, nCdSituacao, tmpTipoMuralProcesso:0, dtoIdioma:{nCdIdioma:1}}}`). Devolveu 1 item com descrição, quantidade, unidade, situação do item, melhor lance, marca e modelo do vencedor.
  - **Histórico:** `PesquisarProcessoDetalheItemProdutoLance` (mesmo corpo com `nCdItem`). Devolveu **33 lances** do item, cada um com data e hora (`tDtLance`), valor, empresa com CNPJ, marca e modelo. **7** têm ranking final e **1** é o vencedor; os outros 26 são os lances da disputa.
- **O que o coletor já guarda disso** (banco, 38191):
  - **Itens:** `licitacao_itens` tem o item com o `raw` inteiro da chamada (unidade, melhor lance, marca, modelo, situação). A aba Itens pode ser montada só com o banco.
  - **Histórico:** `licitacao_resultados` tem só as **7** linhas com ranking (1 a 7, 1 vencedor), com `data_resultado` nula nas 7. O `tDtLance` fica só no `raw`. Os **26 lances sem posição são descartados de propósito** (`paradigma.py:749`, "Lance sem posição é histórico da disputa"). Não há eventos gravados, e o portal da FIEB não publica o histórico do processo (`bFlHistoricoPublico: 0`).
- **O coletor já guarda os documentos do Sistema S, mas o Dashboard não os mostra.**
  - O run 43335769439 (20 editais de piso da FIEB, com documentos) baixou 71 de 71 anexos e 15 resumos do processo em 15 min, com 0 erros.
  - No banco, esses 20 editais têm 86 documentos `baixado`:
    - 55 `application/pdf` e 2 `application/PDF`;
    - 10 `application/doc` e 2 `application/docx`;
    - 2 `application/xlsx`;
    - 15 `text/html`, que são os resumos.
  - Fora do PNCP, há 468 documentos, sendo 346 `baixado` em 72 licitações.
  - O detalhe só lista documentos do PNCP: `copiaLocal.ts` lê `licitacao_documentos` com `arquivo_origem` `pncp-N`, e `acompanhamento.ts:110` não monta chave para fonte que não é PNCP.
- **Serviço do Paradigma ainda aparece no escopo.** Na FIEB:
  - **3078** (`fraco`): "Prestação de serviço de pintura do piso da quadra poliesportiva com material incluso";
  - **18263** (`fraco`): "SERVIÇO PARA EXECUÇÃO DE PINTURA COM TINTAS POLIURETANA, NO PISO DA QUADRA".

  Os dois estão em `historico`. Não são serviço, mas compra de material com instalação: 14814 (`forte`, "aquisição de material emborrachado eva para instalação nas paredes da quadra") e 18868 (`piso`, "Fornecimento e Instalação grama sintética"). Quantos casos existem nas outras fontes: não medido.
- **O link do portal não leva ao processo.**
  - `buildPortalUrl` devolve só o `Mural.aspx` da fonte.
  - O HAR do mural da FIEB (12/11) mostra que o processo abre por POST ao webservice, sem URL própria.
  - Se existe parâmetro de link direto: não medido.
- **Os filtros da lista estão fixos no front.**
  - **Modalidade:** 3 opções (`OpportunityListView.tsx:291-294`: Pregão, Dispensa, Concorrência), enquanto o Sistema S tem 9 valores em 570 licitações:
    - Pregão eletrônico: 221;
    - Compra direta: 157;
    - Processo de seleção sem disputa: 135;
    - Processo de seleção com disputa: 40;
    - Pregão: 9;
    - Cotação: 4;
    - Dispensa de Licitação: 2;
    - "Pregão Eletrônico (proposta comercial, …)": 1;
    - Convite: 1.
  - **Fonte:** `FONTES_CATALOGO` tem 17 entradas fixas, e `fontes_externas` tem 20. Faltam `cn_sesi`, `sesc_dn`, `sesi_pa` e `sesi_pe`.
  - **UF:** 12 licitações do Sistema S têm UF nula (`sestsenat`: 11, `sescdn`: 1) e não aparecem em nenhum filtro de UF.

- **Cadastro de visitante incompleto e relatórios públicos ignorados** (HARs da Firjan de 12/11, processo 3800,
  módulo 59, SS 03204/2026, "Homologado"; lidos só na estrutura, sem os valores digitados):
  - **Como o portal libera o download quando exige cadastro:** `ValidarSalvarVisitante` > 0, depois as listas de região
    em cadeia (`PesquisarRegiao` tipo 0, países: 243; tipo 1 com o país: 27 estados; tipo 2 com a UF e o país: 302
    cidades, com código de 4 dígitos), depois `SalvarVisitante` (devolve `nCdCodigo` > 0, o visitante, e
    `oComplemento`, o endereço), depois `SetCookie CK_VISITANTE_TEMP`, `AnexoExiste` e o `Download.aspx`, com o cookie.
    O segundo download reaproveita o visitante e o endereço.
  - **O formulário pede:** documento (CPF ou CNPJ), RG (no CPF), nome, e-mail, telefone (só dígitos), endereço, número,
    bairro, CEP **com máscara** `99.999-999`, país, UF, **código da cidade** da lista do portal e contato.
    `bFlInteresseCertame` não é enviado.
  - **O coletor hoje (`VisitanteInstitucional.dto`):** manda RG, endereço, número, bairro e CEP vazios e `nCdCidade` "0".
    É a recusa medida na FIEB em 12/11 (runs 43329749688 e 43331006111: "RG, Telefone, Endereço, Número, Bairro, CEP,
    Selecione a cidade").
  - **Quem exige cadastro, anexo por anexo** (`ValidarSalvarVisitante` = 1 no anexo testado em 12/11): fiesc, findes,
    firjan e sfiec. Nos outros portais medidos, o portal liberou sem cadastro (HAR do Sesc DN: 0 nos 16 anexos).
  - **Relatórios públicos do processo, num backend diferente do `Servicos.asmx`:**
    - `PesquisarProcessoDetalheRelatorio` lista os relatórios com `bExibePublico` 1 (aqui, 1: "Pedidos de
      Reconsiderações", `nCdItem` 59008, arquivo "Recursos", com o `uidLicitacao` do processo);
    - o PDF vem de `GET /licitacao-backend/wbc/GetRelatorioAreaExterna?uidLicitacao&nCdItem&nCdIdioma&sDsTitulo&reportType=1`,
      só com os cookies de sessão do mural, sem token (`reportType=2` devolveu HTML);
    - o coletor não chama nenhuma das duas rotas. Se o relatório exige `CK_VISITANTE_TEMP`: não medido.
    - No Sesc DN 4387 (aberto) a lista veio vazia.

- **Processo julgado por lote fica sem disputa e sem resultado (adendo de 13/11/2026).** Exemplo: SDE 2026017738 (FIEB,
  `id_externo` 19914, licitação 30034), "Processo de seleção sem disputa", 10 itens em 2 lotes ("1 - CAMISAS" e
  "2 - CALÇA"), homologado. Tela do mural e HAR do Marcelo de 13/11; conferido no webservice público no mesmo dia:
  - **O mural mostra a disputa por lote, não por item.** As chamadas são `PesquisarProcessoDetalheItemLote` (os lotes)
    e `PesquisarProcessoDetalheItemLoteLance` (os lances do lote, corpo `dtoProcesso` com `nCdLote`).
    - Lotes: `nCdLote` 12576 e 12577, `nCdLoteSequencial` 1 e 2, `sDsLote`, `sStLote` "Homologado",
      `dVlMelhorLanceMoedaVencedor` 7527 e 3115.
    - Lances, 2 por lote, com nomes de campo diferentes dos do item: `nCdLoteLance`, `tDtLoteLance`,
      `dVlLoteLanceMoedaProcesso` (o valor que o mural mostra; `dVlLoteLanceMoeda` veio 0), `nNrRanking`,
      `bFlVencedor`, `sDsSituacaoProposta` ("Classificada"/"Desclassificada"), `sNmEmpresa` com CNPJ e `sNrCnpj`.
    - Camisas: LAN SUPRIMENTOS, 1º e vencedor, R$ 7.527,00 às 15:05:19 de 20/07/2026 (Brasília); UNIFORMES MENDONÇA,
      sem posição, R$ 4.457,70, desclassificada. Calça: R$ 3.115,00 (vencedor) e R$ 780,15 (desclassificada).
    - O valor é **do lote inteiro**, não unitário de item. O menor valor foi desclassificado.
  - **O coletor não chama nenhuma das duas rotas.** Só `PesquisarProcessoDetalheItemProduto` com `nCdLote: 0` e
    `PesquisarProcessoDetalheItemProdutoLance` por item (`paradigma.py`, `itens` e `lances`). Os itens vêm com
    `nCdLote` nulo (`-2147483648`), e o banco ficou com 0 lances e 0 resultados para a 30034.
  - **O item sabe o lote se a consulta for por lote:** `PesquisarProcessoDetalheItemProduto` com `nCdLote` = 12576
    devolveu os itens 1 a 5; com 12577, os itens 6 a 10.
  - **Datas `/Date(ms)/` conferidas:** `tDtLoteLance` 1784570719247 = 18:05:19 UTC = 15:05:19 em Brasília, igual ao
    mural. O `/Date(ms)/` do Paradigma já é UTC: o horário gravado do Sistema S não tem o atraso da #332.
  - **Quantos processos são por lote:** não medido (o MCP do Supabase não respondeu em 13/11). Medir antes de
    implementar, com a consulta de "Impacto em dados".
  - **Link direto:** o resumo traz `default.aspx?cr=XXXXX&c=19914&cm=59`. Sem o `cr` (mascarado), a página abre a home
    do portal, não o processo (navegador, 13/11). Continua sem evidência de link direto: o K-9 não muda.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `api-dashboard-oportunidades` `action=acompanhamento` para fonte do Paradigma | `id` da licitação | as mesmas seções de hoje (`itens`, `resultados`, `arquivos`, `historico`), lidas do banco: itens de `licitacao_itens`, resultados de `licitacao_resultados`, arquivos de `licitacao_documentos` (`secao = processo`, não removidos do portal), histórico dos lances de `licitacao_lances` (K-11), em ordem de data e hora, com o vencedor e as posições finais marcados; as datas e a fase do processo vêm junto, do `raw`, com `origem: "banco"` e `gravado_em` por seção (formato do K-4 da 0029). O "Resumo do processo" (`arquivo_origem = resumo_processo.html`) vem primeiro e marcado `tipo: "resumo"`. Nenhuma chamada ao portal. | seção sem dado gravado volta como `erro` explícito, nunca vazia; licitação inexistente 404 | usuário autenticado com vínculo ativo (como hoje) |
| K-2 | `api-dashboard-oportunidades` `action=documento_url` | `documento_id` | URL assinada do Storage, válida por 10 minutos (gerada a cada clique; PDF abre em nova aba, outro formato baixa com o nome original), e `nome_original`, `mime_type` | 401 sem login; 403 vínculo desativado; 404 documento inexistente, removido do portal ou sem `storage_uri`; nunca devolve o `storage_uri` cru | usuário autenticado com vínculo ativo |
| K-3 | Dashboard, abas **Itens**, **Documentos** e **Histórico** do detalhe | resposta do K-1 | **Itens:** os de `licitacao_itens`, com resultado e vencedor quando houver. **Documentos:** "Resumo do processo" em destaque no topo, depois os anexos com data e tipo; abrir chama o K-2. **Histórico:** a disputa de cada item como o portal mostra (todos os lances com data e hora, valor, empresa, marca e modelo; posição final e vencedor marcados), mais as datas e a fase do processo, com a data em que o LicitaGym gravou. Cada aba tem estado explícito de carregando, vazio ("o portal não publicou X") e erro (com "tentar de novo"), nunca a mensagem de "não é de origem PNCP" para fonte do Paradigma. | erro do K-2 vira aviso no item, sem derrubar a lista | tela |
| K-10 | Dashboard, tela **Acompanhamento** (`/oportunidades/:id/acompanhamento`) para fonte do Paradigma | resposta do K-1 | os mesmos blocos da tela do PNCP que o Sistema S tem dado (situação e fase, datas, itens com resultado, vencedor e participantes, documentos), vindos do banco, com a data de gravação; o link do portal é o do K-9. Bloco sem dado na fonte aparece como ausente, nunca com valor inventado | fonte sem dado gravado: aviso "ainda não coletado", não "não achado no PNCP" | tela |
| K-11 | Coletor Paradigma: gravar todos os lances do item | lances de `PesquisarProcessoDetalheItemProdutoLance` (o coletor já chama em `resultado_item`) | uma linha por lance em `licitacao_lances` (chave: licitação, item, `nCdLance`), com data e hora do lance, valor, moeda, empresa e CNPJ como vieram, marca, modelo, posição (quando houver), vencedor e `raw`. `licitacao_resultados` continua só com as posições finais, como hoje. Idempotente: a mesma coleta não duplica | erro da chamada de lances conta erro, nunca "sem lances" | coletor (`service_role`) |
| K-12 | Migration: tabela `public.licitacao_lances` | — | tabela com RLS ligada, sem policy (lida só pela Edge Function), `revoke all` de `anon` e `authenticated`, escrita só `service_role`; índice por licitação e item | migration idempotente | migration |
| K-5 | Escopo do Paradigma (`coletor/escopo.py` e `paradigma.py`) | objeto e itens do processo | objeto de **prestação de serviço sem compra de material** (pintura de piso, execução de serviço) fica fora do escopo (`categoria_escopo` nula, `OUT_OF_SCOPE`); **fornecimento e instalação** continua avaliado como compra | — | coletor |
| K-13 | Cadastro de visitante completo (`VisitanteInstitucional`, `DocumentosParadigma._identificar`) | os dados do Marcelo, que são o visitante do coletor global (decisão de 13/11): secrets `VISITANTE_*` mais o endereço: `VISITANTE_ENDERECO`, `VISITANTE_NUMERO`, `VISITANTE_BAIRRO`, `VISITANTE_CEP`, `VISITANTE_CIDADE` (nome) e `VISITANTE_RG` (só com CPF) | o `dtoVisitante` igual ao do mural: CEP com máscara `99.999-999`, telefone só dígitos, país e UF, `nCdCidade` com o código da cidade achado pelo nome nas listas `PesquisarRegiao` (tipo 1 com o país, tipo 2 com a UF), sem `bFlInteresseCertame`; o cadastro só acontece quando o portal pede (`ValidarSalvarVisitante` = 1 com a configuração ligada) | cidade não achada na lista: o documento fica `pendente` com o motivo, nunca "0"; o motivo de recusa do portal vai mascarado (como hoje) | coletor (`service_role`) |
| K-14 | Relatórios públicos do processo (coletor) | detalhe do processo | `PesquisarProcessoDetalheRelatorio`; para cada item com `bExibePublico` = 1, o PDF de `GetRelatorioAreaExterna` (`reportType=1`) vira documento do processo (ex.: "Pedidos de Reconsiderações"), versionado no Storage como os anexos | resposta que não é PDF (HTML) conta erro e não grava | coletor (`service_role`) |
| K-15 | Fórum do processo (coletor) | detalhe do processo | `PesquisarProcessoDetalheForum` (esclarecimentos e impugnações com as respostas, como o mural mostra) grava em `licitacoes_externas.esclarecimentos`, no mesmo formato da coleta da Sest Senat (`coletor/portal.py`, `_msg_forum`: id, id_pai, tipo, título, mensagem, data, autor comprador, anexo); lista vazia grava `[]` | falha da chamada conta erro e não grava a coluna (o fórum já coletado continua); resposta que não é lista é erro, nunca "sem mensagens" | coletor (`service_role`) |
| K-6 | ~~Migration de backfill do escopo~~ **Retirado (13/11/2026):** a correção das linhas antigas vem pela camada 3 do Paradigma, que reconcilia o processo (0029, K-10 e K-11). Esta spec não tem migration de limpeza. | — | — | — | — |
| K-7 | `api-dashboard-oportunidades` `action=opcoes_filtro` | `fonte` (opcional: `pncp`, `sistema_s` ou um slug) | `fontes` de `fontes_externas` (`ativo = true`), com rótulo e grupo; `modalidades` **conforme a fonte**: para o PNCP, os 19 códigos do domínio oficial (`_shared/modalidades.ts`, de `docs/pncp/schemas-consultas-pncp.md`); para o Sistema S (todas ou um portal), as modalidades que esse portal publica, lidas do banco (`licitacoes_externas.modalidade` da fonte, como vieram); sem fonte, os dois grupos separados (PNCP e Sistema S); `ufs` mais "Nacional" para UF nula | falha de leitura vira 500 com motivo, nunca lista vazia | usuário autenticado com vínculo ativo |
| K-8 | `action=list` aceita o filtro de modalidade da fonte | `modalidade` = código do PNCP ou valor do Sistema S devolvido pelo K-7; `uf = nacional` | casa exatamente a modalidade escolhida dentro da fonte selecionada; `uf = nacional` devolve as linhas com UF nula | modalidade que não existe para a fonte escolhida: 400 | usuário autenticado |
| K-9 | `url_portal` do Paradigma (`buildPortalUrl`) e tela | linha da licitação | `portal: { url_mural, numero_para_busca }`: o mural da fonte e o número do processo (`numero_edital`) para colar na busca; na tela, "Abrir mural" e "Copiar número" | fonte sem mural conhecido: `null` | backend e tela |
| K-15 | Coletor Paradigma: processo julgado por lote (adendo) | detalhe do processo | `PesquisarProcessoDetalheItemLote`; se vier lote (`nCdLote` > 0), para cada lote: `PesquisarProcessoDetalheItemProduto` com o `nCdLote` (grava `numero_lote` = `nCdLoteSequencial` no item) e `PesquisarProcessoDetalheItemLoteLance` (grava os lances do lote em `licitacao_lances` com `numero_lote`, `numero_item = 0`, `id_lance_externo = nCdLoteLance`, valor de `dVlLoteLanceMoedaProcesso`, data de `tDtLoteLance`, posição, vencedor e `raw`); o lote vai para `licitacao_lotes` (descrição, situação, melhor lance do vencedor, `raw`). Processo sem lote: como hoje. Idempotente. **Resultado do lote não entra em `licitacao_resultados`** (preço de lote não é preço unitário de item; ver pergunta 11) | erro de qualquer das chamadas conta erro, nunca "sem lote" ou "sem lances" | coletor (`service_role`) |
| K-16 | Migration: lote (adendo) | — | `licitacao_itens.numero_lote int` (nulo = sem lote); `licitacao_lances.numero_lote int` (nulo = lance de item); tabela `public.licitacao_lotes` (licitação, `id_lote_externo`, `numero_lote`, descrição, situação, valor do melhor lance do vencedor, `raw`; chave licitação + `id_lote_externo`), RLS ligada sem policy, `revoke all` de `anon`/`authenticated`, escrita só `service_role` | aditiva e idempotente; nenhum dado existente muda | migration |
| K-17 | `action=acompanhamento` do Paradigma com lote (adendo do K-1) | `id` | seção nova `lotes` (de `licitacao_lotes`, com os números dos itens de cada lote e o vencedor), `itens[].numeroLote` e `historico` com `numeroLote` e `situacaoProposta` (lance de lote: `numeroItem` 0); mesmo formato `origem`/`gravado_em`; processo sem lote: `lotes` em erro explícito ("processo julgado por item") | como o K-1 | usuário autenticado com vínculo ativo |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** uma licitação `fieb` com 2 itens, 3 resultados e 4 anexos `baixado` mais o resumo, **quando** se chama `acompanhamento`, **então** `arquivos` traz 5 documentos com o resumo primeiro (`tipo: "resumo"`), as seções vêm com `origem: "banco"` e `gravado_em`, e nenhum `fetch` é feito. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-2 | K-2 | **Dado** um usuário sem login, outro com vínculo desativado, e um documento removido do portal, **quando** pedem `documento_url`, **então** recebem 401, 403 e 404, e nenhuma resposta contém `storage_uri`. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-3 | K-3 | **Regressão da tela de 12/11.** **Dado** o detalhe do processo 38191 da FIEB com 1 item, 7 posições finais, 33 lances, o resumo e 4 anexos, **quando** as abas abrem, **então**: **Itens** mostra o item com unidade, melhor lance, marca e modelo do vencedor; **Documentos** mostra "Resumo do processo" primeiro e os 4 anexos, e com o K-2 falhando o item mostra o aviso sem esconder os outros; **Histórico** mostra os 33 lances em ordem de hora, com o vencedor marcado; e nenhuma aba mostra "não é de origem PNCP". | vitest `src/test/detalhe-abas-sistema-s.test.tsx` (Dashboard) |
| CA-12 | K-11, K-12 | **Dado** a resposta de lances do 38191 (fixture reduzida do HAR V2, sem dado além do que o portal publica), **quando** o coletor grava duas vezes, **então** `licitacao_lances` tem 33 linhas (não 66), 7 com posição e 1 vencedor, e `licitacao_resultados` continua com as mesmas 7 linhas; **e** `anon` e `authenticated` não leem `licitacao_lances`. | pytest `services/coletor-externo/tests/test_paradigma_lances.py` (4 testes `test_ca12_*`) + SQL `supabase/tests/licitacao_lances_check.sql` — **implementado na parte 1** |
| CA-11 | K-10 | **Dado** o SDE 2026016793 (FIEB 18868: 1 item, 0 resultados, 10 documentos), **quando** o botão "Acompanhamento" abre `/oportunidades/:id/acompanhamento`, **então** a tela mostra situação, datas, o item e os documentos do banco, com "Abrir mural" e "Copiar número"; o bloco de resultados aparece como "sem resultado publicado" e não como erro do PNCP. | vitest `src/test/acompanhamento-sistema-s.test.tsx` (Dashboard) |
| CA-5 | K-5 | **Regressão.** **Dado** os objetos de 3078 e 18263 (pintura de piso), **quando** o escopo avalia, **então** os dois ficam fora; **e** 14814 (material emborrachado para instalação) e 18868 (fornecimento e instalação) continuam avaliados como compra. | pytest `services/coletor-externo/tests/test_escopo_servicos.py` |
| CA-6 | K-13, K-14 | **Dado** o processo 3800 da Firjan (fixture reduzida dos HARs de 12/11, sem dado pessoal: documento, nomes e endereço trocados por valores de teste), **quando** o coletor sincroniza os documentos com o portal pedindo cadastro, **então**: chama `PesquisarRegiao` tipo 1 e tipo 2 e manda `nCdCidade` com o código da cidade de teste, o CEP com máscara e o endereço preenchido; grava os anexos; e grava "Pedidos de Reconsiderações" como documento, a partir do PDF de `GetRelatorioAreaExterna`. **E**, com a cidade fora da lista, o anexo fica `pendente` com o motivo e nenhum `SalvarVisitante` é chamado. | pytest `services/coletor-externo/tests/test_documentos.py` (17 testes `test_ca6_*`) — **implementado na parte 2** |
| CA-13 | K-15 | **Dado** o fórum de um processo Paradigma com uma pergunta e a resposta do comprador (fixture sintética), **quando** o coletor grava o processo, **então** `licitacoes_externas.esclarecimentos` tem as 2 mensagens no formato da Sest Senat; **e**, com a chamada do fórum falhando, o processo é gravado sem a coluna `esclarecimentos` e o erro é contado; **e** a resposta vazia grava `[]`. | pytest `services/coletor-externo/tests/test_paradigma_forum.py` (8 testes `test_ca13_*`) — **implementado** |
| CA-7 | K-7, K-8 | **Dado** `fontes_externas` com 20 fontes (19 ativas na fixture), licitações do PNCP e da FIEB e linhas com UF nula, **quando** se chama `opcoes_filtro` com `fonte = fieb`, com `fonte = pncp` e sem fonte, **então** a FIEB traz só as modalidades que ela publica (por exemplo "Processo de seleção sem disputa", "Compra direta", "Pregão eletrônico"), o PNCP traz os 19 códigos oficiais, e sem fonte vêm os dois grupos separados; o `list` com a modalidade da FIEB e `uf = nacional` devolve exatamente as linhas certas; **e** uma modalidade do PNCP pedida com `fonte = fieb` dá 400 com o motivo, não lista vazia. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-9 | K-7, K-9 | **Dado** a lista de oportunidades, **quando** a tela carrega, **então** os filtros de fonte, modalidade e UF vêm do `opcoes_filtro`; ao trocar a fonte de PNCP para FIEB, a lista de modalidades troca junto ("Processo de seleção sem disputa" aparece, os códigos do PNCP somem) e "Nacional" aparece em UF e, no detalhe do Sistema S, "Abrir mural" e "Copiar número" levam o mural e o número do processo. | vitest `src/test/filtros-e-portal-sistema-s.test.tsx` (Dashboard) |
| CA-13 | K-15, K-16 | **Regressão da 30034.** **Dado** o processo 19914 da FIEB (fixture reduzida das respostas de 13/11 de `PesquisarProcessoDetalheItemLote`, `PesquisarProcessoDetalheItemProduto` por lote e `PesquisarProcessoDetalheItemLoteLance`, só com o que o portal publica), **quando** o coletor grava duas vezes, **então** `licitacao_lotes` tem 2 lotes; os itens 1 a 5 têm `numero_lote` 1 e os 6 a 10, `numero_lote` 2; `licitacao_lances` tem 4 lances de lote (não 8), com 7527, 4457,70, 3115 e 780,15, 1 vencedor por lote e a data de 20/07/2026 15:05:19 em Brasília; `licitacao_resultados` não ganha linha; **e** o 38191 (por item) continua com 33 lances e 7 resultados. **E**, com `PesquisarProcessoDetalheItemLoteLance` em erro, a execução conta erro e nada é apagado. | pytest `services/coletor-externo/tests/test_paradigma_lotes.py` + SQL `supabase/tests/licitacao_lotes_check.sql` |
| CA-14 | K-17 | **Dado** a 30034 com 2 lotes, 10 itens e 4 lances de lote gravados, **quando** se chama `acompanhamento`, **então** `lotes` traz os 2 lotes com os itens e o vencedor, `itens[].numeroLote` vem preenchido, `historico` traz os 4 lances com `numeroLote` e `situacaoProposta`, e nenhum `fetch` é feito; **e** para o 38191 `lotes` vem com `erro` "processo julgado por item" e o resto igual ao CA-1. | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-7, K-8, K-9 (backend) | `/spec` | `/implement` (TDD) | `deno test tests/supabase ...` | `revisor-codigo` + `revisor-seguranca` (auth, `service_role`, URL assinada) + `revisor-tenant` | `verificar-producao` |
| K-5, K-11 | `/spec` | `/implement` (TDD) | `pytest` do coletor | `revisor-codigo` | `verificar-producao` + coleta da FIEB com os 20 editais |
| K-12 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL) | `verificar-producao` + `get_advisors` |
| K-15, K-17 | `/spec` | `/implement` (TDD) | `pytest` do coletor e `deno test tests/supabase ...` | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` + disparo da FIEB 19914 e conferência com o mural |
| K-16 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL) | `verificar-producao` + `get_advisors` |
| K-13, K-14 | `/spec` | `/implement` (TDD) | `pytest` do coletor | `revisor-codigo` + `revisor-seguranca` (dado da empresa e do visitante, log e erro) | disparo da Firjan 3800 com documentos e conferência dos anexos e do relatório |
| K-15 | `/spec` | `/implement` (TDD) | `pytest` do coletor | `revisor-codigo` + `revisor-seguranca` (texto livre do portal, log) | disparo de um processo com fórum e conferência da coluna |
| K-3, K-9, K-10 (tela) | agente `ux-ui-licitagym` | agente `frontend-dashboard` | `npx vitest run`, `npx tsc --noEmit`, `npm run build`, skill `run-dashboard` (claro, escuro, celular) | `revisor-codigo` + `revisor-seguranca` (do LicitaGym, pela sessão orquestradora) + `ux-ui-licitagym` | `deploy-dashboard` |
| Contrato entre os repositórios | sessão orquestradora | backend mergeado e publicado antes do front | os dois conjuntos | os dois conjuntos | `verificar-producao` e `deploy-dashboard` |

## Fora de escopo

- Abas **Agentes** e **Preços** do detalhe: uma spec para cada (decisão de 12/11/2026).
- Indexação dos documentos para o agente de edital (`coletor.indexador`, `licitacao_chunks`), inclusive o resumo HTML e
  o `.doc` antigo: decisão de 12/11/2026, primeiro a coleta. Hoje os 20 editais da FIEB têm 0 trechos indexados, e o
  resumo não seria indexado como está (o nome não tem extensão).
- Classificação de produto do Sistema S (grama sintética, varredeira, EVA, piso): fica com o de-para dos catálogos
  (0052 e 0053). Esta spec não muda `categoria_escopo` de compra de material.
- Parse dos campos do resumo (critério de julgamento, frete, validade, prazo de entrega, pagamento, habilitação) em
  colunas: spec própria, com regra e teste por campo.
- A fila e o frescor por seção do PNCP (`compra_fila`, K-1 a K-3 da 0029): continuam na 0029.
- Coleta de documentos no cron diário (hoje `--sem-documentos`); entra na camada 3 do Paradigma (R-8b da 0029).
- Link direto para o processo no portal Paradigma, enquanto não houver evidência de parâmetro que abra o processo.
- Cadastro de visitante em outros portais Paradigma: depende de ler a configuração de cada `Mural.aspx`, como foi
  feito na FIEB.
- **Visitante por tenant:** cada tenant novo cadastra os próprios dados de visitante, pela tela de configuração do
  tenant (0060). Esta spec usa só o visitante do coletor global. Fica para a spec da configuração do tenant.

## Impacto em dados

- **Migration:** sim, uma: **K-12**, tabela nova `licitacao_lances`, aditiva e idempotente. (O backfill do K-6 saiu: a camada 3 da 0029 reconcilia.)
- **Adendo do lote (K-15 a K-17):** mais uma migration aditiva (K-16): `licitacao_lotes` nova e `numero_lote` em
  `licitacao_itens` e `licitacao_lances`. Os processos por lote já gravados ganham lotes e lances na próxima
  coleta, sem backfill por migration. Antes de implementar, medir (somente leitura) quantos processos do Paradigma
  são por lote. Aproximação: itens com `nCdLote` nulo na consulta por item,
  `select e.fonte, count(distinct e.id) from licitacoes_externas e join licitacao_itens i on i.licitacao_id = e.id
  where i.raw->>'nCdLote' = '-2147483648' and e.fonte = any(<FONTES_PARADIGMA>) group by 1`; confirmar numa
  amostra com `PesquisarProcessoDetalheItemLote`.
- **Tabelas/views/funções tocadas:**
  - leitura (Edge Function, `service_role` depois de checar o usuário): `licitacao_documentos`, `licitacao_itens`, `licitacao_resultados`, `fontes_externas`, `licitacoes_externas`; Storage do bucket dos documentos (URL assinada);
  - escrita: `licitacao_lances` (coletor, K-11) e `licitacao_documentos` com os relatórios públicos (K-14).
- **ACL/RLS:** `licitacao_lances` com RLS ligada e sem policy; escrita só `service_role`. A URL assinada sai da Edge Function, nunca do cliente.
- **Backfill/reprocessamento:**
  - lances: a próxima coleta de cada edital grava a disputa inteira. Não há backfill (o lance sem posição nunca foi guardado); para os 20 editais da FIEB, um disparo manual depois do merge.
- **Secrets novos (Marcelo, só com o K-13):** `VISITANTE_ENDERECO`, `VISITANTE_NUMERO`, `VISITANTE_BAIRRO`,
  `VISITANTE_CEP`, `VISITANTE_CIDADE` e, se o cadastro for por CPF, `VISITANTE_RG`. São os dados do Marcelo (decisão de
  13/11), como no cadastro que ele fez à mão na Firjan. CPF, RG, endereço, e-mail e telefone de pessoa são dado pessoal:
  máscara no log e no erro, nunca no banco (o cadastro em `portal_visitante` guarda só o HMAC do CPF, #533).
- **Edge Functions republicadas no merge:** todas (o merge na `main` republica todas); muda `api-dashboard-oportunidades`.
- **Contrato com o Dashboard:** muda.
  - `acompanhamento` passa a responder para o Sistema S;
  - ações novas `documento_url` e `opcoes_filtro`;
  - `list` aceita modalidade canônica e `uf = nacional`;
  - `portal` no lugar de `url_portal` solto.

  O PR do backend vai ao ar antes do front.
- **Dado oficial x derivado:**
  - **Oficial:** documentos, itens, resultados, lances (empresa e CNPJ como o portal publica; regra de 01/10/2026: CPF e CNPJ em edital são dado público) e o HTML do resumo, como o portal entregou (no resumo, só a data de geração da página foi zerada, #536).
  - **Derivado:** só o rótulo "Nacional" para UF nula. As modalidades são as da fonte, sem reagrupar.

## Decisões do Marcelo

- 13/11/2026 (adendo do lote, perguntas 10 a 12): aprovadas as três recomendações.
  - O lance do lote vai para `licitacao_lances`, com `numero_lote` e `numero_item = 0`, mais a tabela `licitacao_lotes`.
  - O resultado do lote não vira preço de item: não entra em `licitacao_resultados` nem no agente de preço. O vencedor e o valor do lote ficam em `licitacao_lotes` e aparecem no detalhe.
  - O lance desclassificado é gravado como o portal mostra, e `situacaoProposta` aparece no histórico.
- 13/11/2026: spec aprovada, com a migration `licitacao_lances` (K-12) e os secrets novos do visitante (K-13).
- 12/11/2026: resumo do processo só para editais homologados ou finalizados (#536).
- 12/11/2026: o detalhe lê do banco com atualização por frescor (R-1 da 0029); esta spec estende ao Sistema S.
- 12/11/2026 (perguntas 1 e 2): a classificação de grama sintética, varredeira e EVA na parede não se avalia agora. Ela
  vai depender dos catálogos do Sistema S já mapeados, no de-para com o CATMAT (specs 0052 e 0053). A prioridade
  agora é a coleta funcionar. O K-5 e o K-6 desta spec ficam só com o serviço sem compra de material (pintura de piso,
  3078 e 18263), que a regra de negócio já tira do escopo ("contrato de serviço nunca vira lead").
- 12/11/2026: o indexador do agente de edital sai desta spec; o foco é a coleta e o detalhe (K-4 retirado; os IDs dos
  outros contratos não mudam).
- 12/11/2026: o escopo desta spec é o detalhe inteiro do Sistema S, menos as abas Agentes e Preços (uma spec para
  cada): abas Itens, Documentos e Histórico, botão e tela Acompanhamento, filtros da lista, link do portal e a regra de
  serviço do Paradigma.
- 12/11/2026 (pergunta 9): a aba Itens vem de `PesquisarProcessoDetalheItemProduto` e a aba Histórico de
  `PesquisarProcessoDetalheItemProdutoLance`, como no mural (HAR V2). O coletor passa a gravar todos os lances (K-11,
  K-12), não só as posições finais.
- 12/11/2026 (pergunta 4): o filtro de modalidade muda conforme a fonte escolhida. PNCP mostra as modalidades do
  PNCP; Sistema S mostra as do Sistema S (o portal tem as suas: "Processo de seleção sem disputa", "Compra direta",
  "Pregão eletrônico"...). Hoje o filtro é fixo no código, com 3 opções (`OpportunityListView.tsx:291-294`), e com a
  FIEB escolhida mostra "Todas as modalidades" sem nenhuma do Sistema S (tela do Marcelo, 12/11).
- 12/11/2026 (perguntas 6, 7 e 8, respondidas pelo Claude a pedido do Marcelo):
  - **Frescor (6):** o detalhe do Sistema S não busca nada no portal ao abrir. Ele mostra o que o banco tem e a data
    em que foi gravado. Edital ativo (`leads` ou `monitorar`) com dado de mais de 24 h ganha o aviso "dado de
    <data>"; edital em `historico` não tem aviso, porque não muda mais. A atualização automática (fila por frescor)
    fica com a camada 3 do Paradigma (R-8b da 0029), que esta spec não faz.
  - **URL assinada (7):** vale 10 minutos e é gerada a cada clique. PDF abre em nova aba; os outros formatos baixam
    com o nome original. O caminho no Storage nunca vai para o navegador.
  - **Ordem (8):** esta spec vai primeiro. Os dados do Sistema S já estão no banco e não dependem da fila do PNCP
    (`compra_fila`) da 0029. O K-1 daqui usa o formato de resposta do K-4 da 0029 (`origem` e `gravado_em` por
    seção), e a 0029 depois leva o PNCP para o mesmo formato.
- 13/11/2026: entram na 0061 o cadastro de visitante completo (K-13) e os relatórios públicos do processo (K-14), a
  partir dos HARs da Firjan; o K-6 (backfill por migration) sai, porque a correção das linhas antigas vem pelas camadas
  da 0029.
- 13/11/2026: o coletor global usa os dados de contato do Marcelo como visitante nos portais Paradigma que pedem
  cadastro. Cada tenant novo faz o próprio cadastro de visitante (pela configuração do tenant, fora desta spec).
- 12/11/2026 (pergunta 5): o detalhe mostra os documentos como o portal mostra, sem filtrar pela situação do edital.
  - **Evidência:** HAR do mural da FIEB de 12/11.
    - A listagem do mural traz processos em "Recebimento de lances", "Em andamento" e "Encerrada" (50 na primeira página).
    - O processo 38191, "Finalizado com contrato", tem 4 anexos em `PesquisarAnexos`, todos `bFlPublico = 1`, e o navegador baixou os 4 sem cadastro.
  - **Consequência no K-1:** a seção `arquivos` não filtra por situação nem por escopo. Ela lista todo documento do processo gravado e não removido do portal.
- 13/11/2026: entra na 0061 o fórum do processo (K-15, esclarecimentos e impugnações): o coletor global do Paradigma não chamava `PesquisarProcessoDetalheForum`, que só a coleta da Sest Senat usava. Grava na coluna que já existe (`licitacoes_externas.esclarecimentos`), sem migration. Mostrar o fórum no Dashboard fica para o K-3/K-10.

## Perguntas em aberto

1. ~~Grama sintética e varredeira de grama sintética no escopo de piso~~ **Adiada (12/11/2026), ver "Decisões do
   Marcelo"**: depende do de-para dos catálogos do Sistema S (0052 e 0053). Esta spec não muda a classificação desses
   editais.
2. ~~Material para instalação na parede (14814)~~ **Adiada pelo mesmo motivo** (é classificação de produto, do de-para).
3. ~~`.doc` antigo~~ **Retirada (12/11/2026)**: era sobre o indexador do agente, que saiu desta spec.
4. ~~Família de modalidades do Sistema S~~ **Respondida (12/11/2026), ver "Decisões do Marcelo"**: a lista de
   modalidades muda conforme a fonte (PNCP ou Sistema S), sem misturar as duas.
5. ~~Documentos de edital fora do escopo ou cancelado~~ **Respondida (12/11/2026), ver "Decisões do Marcelo".**
   Resta só um ponto: o HAR não mostra processo cancelado. Se o portal esconder os anexos de cancelado, o detalhe
   mostra o que o coletor tiver gravado antes, com a data de gravação.
9. ~~Histórico do Sistema S~~ **Respondida (12/11/2026), ver "Decisões do Marcelo"**: o histórico é a disputa
   (lances por item), não eventos do LicitaGym.
6. ~~Frescor do detalhe do Sistema S~~ **Respondida (12/11/2026), ver "Decisões do Marcelo".**
7. ~~URL assinada~~ **Respondida (12/11/2026), ver "Decisões do Marcelo".**
8. ~~Ordem com a 0029~~ **Respondida (12/11/2026), ver "Decisões do Marcelo".**
10. ~~**(Adendo do lote) Onde guardar o lance do lote.**~~ **Respondida (13/11/2026): a recomendação foi aprovada.** Recomendação: `licitacao_lances` com `numero_lote` e
    `numero_item = 0` (a chave única atual continua valendo, sem mexer nas 33 linhas do 38191), mais a tabela
    `licitacao_lotes`. Alternativa: tabela `licitacao_lotes_lances` separada (o K-1 passa a ter duas fontes de
    histórico).
11. ~~**(Adendo do lote) Resultado do lote vira preço?**~~ **Respondida (13/11/2026): não, como recomendado.** Recomendação: **não**. O valor é do lote inteiro (R$ 7.527,00
    para 5 tamanhos de camisa), não unitário de item; dividir pela quantidade inventaria preço (zero alucinação; preço
    só de compra homologada, por item). O vencedor e o valor do lote ficam em `licitacao_lotes` e aparecem no
    detalhe; `licitacao_resultados` e o agente de preço continuam só com resultado por item.
12. ~~**(Adendo do lote) Lance desclassificado.**~~ **Respondida (13/11/2026): a recomendação foi aprovada.** O mural mostra o lance desclassificado (R$ 4.457,70, menor que o do
    vencedor) sem posição. Recomendação: gravar como o portal mostra e expor `situacaoProposta` no histórico, para a
    tela não sugerir que o menor valor venceu.

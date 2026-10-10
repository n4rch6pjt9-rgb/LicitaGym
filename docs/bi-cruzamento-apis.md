# BI: Cruzamento de APIs Oficiais e Inteligência de Mercado

Este documento estabelece o contrato das views de BI para o time de frontend do Dashboard (`n4rch6pjt9-rgb/Dashboard---LicitaGym`), a arquitetura do cruzamento de dados oficiais, a ordem de ingestão dos coletores e o mapeamento de campos de fornecedores e marcas homologadas.

---

## 1. Visão Geral das Fontes Oficiais

| Fonte / Módulo | Endpoint Base | Finalidade no LicitaGym | Frequência |
|---|---|---|---|
| **Compras.gov PGC** | `/modulo-pgc/2_consultarPgcDetalheCatalogo` | Demanda planejada por classe CATMAT (7830 / 7220) de órgãos do SISG | Semanal |
| **PNCP PCA** | `/v1/pca/?anoPca&codigoClassificacaoSuperior` | Demanda planejada de entes federados (estados, municípios, órgãos autônomos) | Diário |
| **Compras.gov Pesquisa de Preço** | `/modulo-pesquisa-preco/1_consultarMaterial` | Preços efetivamente praticados (homologados), marcas e fornecedores por item/PDM | Semanal |
| **Compras.gov ARP** | `/modulo-arp/2_consultarARPItem` | Atas de registro de preço vigentes, saldo, adesão máxima e vencimento | Semanal |
| **Compras.gov 14.133** | `/modulo-contratacoes/3_consultarResultadoItensContratacoes_PNCP_14133` | Resultados por item homologado da Nova Lei de Licitações | Semanal |
| **PNCP / Sistema S Homologados** | `licitacao_resultados` x `licitacoes_externas` | Resultados e lances de certames encerrados já existentes no banco | Contínuo |

---

## 2. Mapeamento de Campos: Fornecedor, Marca, Fabricante e Modelo

Amostras reais das APIs oficiais (medidas em 02/10/2026; marca/fabricante/modelo/lote reconferidos ao vivo e no OpenAPI em 02/10/2026 à noite):

| Campo de Negócio | Compras.gov Pesquisa de Preço (`1_consultarMaterial`) | Compras.gov ARP (`2_consultarARPItem`) | Compras.gov 14.133 (`3_consultarResultado...`) | LicitaGym `licitacao_resultados` (PNCP/Paradigma) |
|---|---|---|---|---|
| **CNPJ / NI Fornecedor** | `niFornecedor` (ex.: `"04372852000160"`) | `niFornecedor` (ex.: `"40962266000130"`) | `niFornecedor` (ex.: `"03521758000163"`) | `fornecedor_cnpj` (14 dígitos) |
| **Nome Fornecedor** | `nomeFornecedor` (ex.: `"W.E.V COMERCIAL LTDA"`) | `nomeRazaoSocialFornecedor` (ex.: `"PANTHERA LEO EQUIPAMENTOS"`) | `nomeRazaoSocialFornecedor` (ex.: `"LUBRITECH DO BRASIL"`) | `fornecedor_nome` |
| **Marca** | `marca` (ex.: `"FORTIX"`, `"SIGMETAL"`) — única fonte de marca do Compras.gov | **não existe** (`atas_rp_itens.marca` fica NULL) | **não existe** | `marca` / `marca_normalizada` (ex.: `"MOVEMENT"`) |
| **Fabricante** | **não existe** (deriva de marca/CNAE) | **não existe** | **não existe** | `f.fabricante` (CNAE 10–33) |
| **Modelo** | **não existe** | **não existe** | **não existe** | `modelo` (capturado no Paradigma) |
| **Lote / grupo** | não existe | não existe (chave aceita `numero_grupo`, hoje NULL) | não existe no resultado; `numeroGrupo` só nos itens de contratação (`2_`/`2.1_consultarItensContratacoes`), observado sempre `0` | lote do edital (Paradigma) |
| **Vários vencedores / cota** | um registro por item homologado | `classificacaoFornecedor` (`"001"`…) + `niFornecedor` na chave | `sequencialResultado`, `ordemClassificacaoSrp`, `aplicacaoBeneficioMeepp`; nos itens, `tipoBeneficio`/`tipoBeneficioNome` | — |
| **Preço Unitário** | `precoUnitario` (ex.: `9000.00`) | `valorUnitario` (ex.: `8500.00`) | `valorUnitarioHomologado` (ex.: `4685.00`) | `valor_unitario_homologado` |
| **Órgão / UASG** | `codigoUasg`, `nomeUasg`, `estado` | `codigoUnidadeGerenciadora`, `nomeUnidadeGerenciadora` | `unidadeOrgaoCodigoUnidade`, `orgaoEntidadeCnpj` | `orgao_cnpj`, `orgao_nome`, `uf` |

---

## 3. Classificação Revenda x Fabricante

A classificação do fornecedor na view `v_bi_fornecedor_historico` segue regras determinísticas auditáveis sem suposições ou inferências não fundamentadas:

1. **CNAE Principal (Divisões 10 a 33)**: Indústria / Fabricação (ex.: CNAE `3230-2/00` Fabricação de artefatos para esporte). Classificado como `'fabricante'`, `tipo_fornecedor_motivo = 'cnae_industria'` e confiança `'alta_cnae_industria'`.
2. **CNAE Principal (Divisões 45 a 47)**: Comércio Atacadista / Varejista (ex.: CNAE `4763-6/02` Comércio de artigos esportivos). Classificado como `'revenda'`, `tipo_fornecedor_motivo = 'cnae_comercio'` e confiança `'alta_cnae_comercio'`.
3. **Sinal de Coincidência de Marca**: Quando o CNAE não está nas faixas acima ou não é conhecido, mas a marca que o fornecedor entrega coincide com tokens da sua própria Razão Social / Nome Fantasia (ex.: Fornecedor "Movement Artigos Esportivos" entregando marca "MOVEMENT"). Classificado como `'fabricante'`, `tipo_fornecedor_motivo = 'marca_propria'` e confiança `'media_coincidencia_marca'`.
4. **Sem dados / Desconhecido**: Quando não há CNAE cadastrado ou o CNAE está fora dessas faixas e não há marca própria coincidente, o campo permanece estritamente `'nao_classificado'`, `tipo_fornecedor_motivo = 'sem_fonte'` e confiança `'sem_dados'`. Não há inferência arbitrária de revenda apenas pela presença do CNPJ.
5. **Integração Externa**: O enriquecimento cadastral público é realizado via BrasilAPI/Minha Receita (grátis) em `coletor/fornecedores.py`. Consultas pagas à Econodata pertencem exclusivamente à esteira CRM (`/crm/organizacoes`) e não são invocadas no pipeline de BI.

---

## 4. Contratos das Views de BI (Schema, Colunas e Tipos)

Todas as views foram criadas com `security_invoker = true`. **Não possuem grant para `anon` nem `authenticated`**, sendo acessadas com segurança exclusivamente pela role `service_role` através de Edge Functions no backend.

### 4.1 `public.v_bi_pca_radar`
Demanda planejada consolidada (PNCP + PGC Compras.gov), filtrada estritamente pelo escopo CATMAT de produtos (`catalogo_catmat_pdms_efetivos()`).

| Coluna | Tipo | Descrição |
|---|---|---|
| `fonte` | `text` | Origem do registro: `'pgc'` ou `'pncp'` |
| `orgao_cnpj` | `text` | CNPJ do órgão comprador |
| `codigo_uasg` | `text` | Código da UASG ou unidade compradora |
| `orgao_nome` | `text` | Nome ou razão social do órgão |
| `ano_pca` | `integer` | Ano de exercício do PCA (ex.: `2026`, `2027`) |
| `codigo_pdm` | `integer` | Código PDM oficial do CATMAT |
| `codigo_item` | `bigint` | Código do item CATMAT (quando disponível) |
| `descricao_item` | `text` | Descrição do item planejado |
| `quantidade` | `numeric` | Quantidade estimada |
| `valor_unitario` | `numeric(18,4)` | Valor unitário estimado |
| `valor_total` | `numeric(18,4)` | Valor total estimado |
| `data_prevista` | `date` | Data prevista de formalização / início |
| `mes_previsto` | `text` | Mês previsto no formato `YYYY-MM` |
| `prioridade` | `text` | Prioridade atribuída pelo órgão |
| `status` | `text` | Status de contratação / execução |
| `numero_item_pncp` | `integer` | Número sequencial do item no plano |
| `casamento_confirmado`| `boolean` | `true` se PDM é oficial/confirmado, `false` se incerto |
| `metodo_identificacao`| `text` | `'pgc_catmat'`, `'pncp_pdm_confirmado'`, etc. |

**Regra de Deduplicação**: Quando um item existe em ambas as fontes para o mesmo órgão, ano e `numero_item_pncp`, prioriza-se a linha do PGC (que traz o código CATMAT completo) e descarta-se a duplicata do PNCP.

---

### 4.2 `public.v_bi_precos_praticados`
Estatísticas de preços efetivamente pagos por PDM e item CATMAT.

| Coluna | Tipo | Descrição |
|---|---|---|
| `codigo_pdm` | `integer` | Código PDM do CATMAT |
| `codigo_item` | `integer` | Código do item CATMAT |
| `nome_pdm` | `text` | Nome oficial do PDM |
| `descricao_item` | `text` | Descrição do item |
| `n_cotacoes` | `integer` | Número total de cotações/preços homologados |
| `n_compras` | `integer` | Quantidade de compras públicas distintas |
| `n_fornecedores` | `integer` | Quantidade de fornecedores distintos vencedores |
| `n_uasgs` | `integer` | Quantidade de unidades compradoras distintas |
| `preco_min` | `numeric(18,4)` | Menor preço unitário homologado |
| `preco_p25` | `numeric(18,4)` | 1º quartil (25%) da distribuição de preços |
| `preco_mediana` | `numeric(18,4)` | Mediana (p50) dos preços homologados |
| `preco_p75` | `numeric(18,4)` | 3º quartil (75%) da distribuição de preços |
| `preco_max` | `numeric(18,4)` | Maior preço unitário homologado |
| `primeira_data` | `date` | Data do resultado homologado mais antigo |
| `ultima_data` | `date` | Data do resultado homologado mais recente |
| `outlier_detectado` | `boolean` | Flag de presença de distorção de preço (IQR) |
| `outlier_tipo` | `text` | `'minimo_abaixo_iqr'`, `'maximo_acima_iqr'` ou `'normal'` |

#### Consumo pelo Agente de Preço

`v_bi_precos_praticados` é a referência histórica de preços efetivamente
homologados/registrados para o Agente de Preço. O agente deve manter essa
referência separada dos valores planejados do PCA e dos valores estimados do
edital:

- **Histórico praticado:** mínimo, mediana, máximo, quantidade de amostras e
  datas desta view; usado somente quando o item e a unidade forem comparáveis.
- **PCA:** sinal de demanda planejada e valor estimado pelo órgão; nunca entra
  na mediana ou nos quartis de preços praticados.
- **Edital:** estimativa e quantidade da oportunidade em análise; base para as
  regras determinísticas de exequibilidade da proposta.
- **Proposta e piso do tenant:** dados privados do cliente; não compõem a view
  e o piso não pode ser exposto em achados, logs ou respostas públicas.

Quando houver vínculo PCA–edital com evidência auditável, o agente pode
apresentar a comparação `PCA × edital × proposta` como contexto separado. A
comparação exige item, unidade e escopo técnico compatíveis; sem essa prova, o
resultado deve ser `nao_verificada`, sem variação financeira calculada. O PCA
não transforma uma demanda planejada em oportunidade nem em preço praticado.

---

### 4.3 `public.v_bi_atas_vencendo`
Atas de Registro de Preço no escopo do catálogo expirando nos próximos 180 dias.

| Coluna | Tipo | Descrição |
|---|---|---|
| `ata_item_id` | `bigint` | ID interno do item de ata |
| `numero_ata_registro_preco` | `text` | Identificador oficial da ata |
| `codigo_unidade_gerenciadora` | `integer` | UASG gerenciadora da ata |
| `nome_unidade_gerenciadora` | `text` | Nome do órgão/unidade gerenciadora |
| `codigo_pdm` | `integer` | Código PDM do produto |
| `nome_pdm` | `text` | Descrição do PDM |
| `codigo_item` | `integer` | Código do item CATMAT |
| `descricao_item` | `text` | Descrição do item registrado |
| `ni_fornecedor` | `text` | CNPJ do fornecedor detentor da ata |
| `nome_fornecedor` | `text` | Razão social do fornecedor |
| `marca` | `text` | Sempre NULL: o item de ARP do Compras.gov não traz marca (vem da Pesquisa de Preço ou do Paradigma/edital) |
| `quantidade` | `numeric` | Quantidade homologada na ata |
| `valor_unitario` | `numeric(18,4)` | Preço unitário registrado |
| `valor_total` | `numeric(18,4)` | Valor total registrado para o item |
| `data_vigencia_inicial` | `date` | Data de início de vigência |
| `data_vigencia_final` | `date` | Data de término de vigência |
| `dias_para_vencer` | `integer` | Dias restantes até o fim de vigência |
| `maximo_adesao` | `numeric` | Quantidade máxima para carona/adesão |
| `quantidade_empenhada` | `numeric` | Quantidade já consumida por empenho |
| `saldo_remanescente_estimado` | `numeric` | Saldo disponível da ata para adesão |

---

### 4.4 `public.v_bi_orgaos_match`
Ranking de órgãos por volume planejado (PCA) e volume homologado no escopo fitness.

| Coluna | Tipo | Descrição |
|---|---|---|
| `orgao_cnpj` | `text` | CNPJ do órgão |
| `orgao_nome` | `text` | Nome em `public.orgaos` (nome_orgao/razão social); senão o nome de origem (licitação/PCA); senão `null` — nunca o CNPJ |
| `esfera` | `text` | Esfera administrativa (`Federal`, `Estadual`, `Municipal` ou `null`) |
| `uf` | `text` | UF em `public.orgaos`; senão a UF de origem (licitação ou unidade 14.133) |
| `qtd_itens_planejados` | `integer` | Itens planejados no PCA (PCA + PGC) |
| `valor_planejado_pca` | `numeric(18,2)` | Valor total planejado para compras no escopo (`null` se nenhum item tem valor) |
| `qtd_itens_homologados` | `integer` | Resultados homologados (vários vencedores/cotas do mesmo item contam separado) |
| `valor_homologado` | `numeric(18,2)` | Valor total já adquirido pelo órgão (`null` se nenhum resultado tem valor) |
| `ultima_data_prevista` | `date` | Data mais recente de demanda prevista no PCA |
| `ultima_data_homologada` | `date` | Data da homologação mais recente |

---

### 4.5 `public.v_bi_fornecedor_historico`
Visão de 360° por fornecedor, construída exclusivamente sobre certames **encerrados/homologados** no escopo fitness.

| Coluna | Tipo | Descrição |
|---|---|---|
| `cnpj` | `text` | CNPJ normalizado (14 dígitos) |
| `razao_social` | `text` | Razão social oficial da Receita ou resultado |
| `nome_fantasia` | `text` | Nome fantasia cadastral |
| `cnae_principal` | `integer` | Código do CNAE principal |
| `cnae_principal_descricao` | `text` | Descrição da atividade econômica principal |
| `cnae_divisao` | `integer` | Divisão do CNAE (2 primeiros dígitos) |
| `tipo_fornecedor` | `text` | `'fabricante'`, `'revenda'` ou `'nao_classificado'` |
| `tipo_fornecedor_motivo` | `text` | `'cnae_industria'`, `'cnae_comercio'`, `'marca_propria'` ou `'sem_fonte'` |
| `tipo_fornecedor_confianca`| `text` | Nível de evidência da classificação |
| `uf_sede` | `text` | UF da sede do fornecedor |
| `municipio_sede` | `text` | Município da sede |
| `porte` | `text` | Porte da empresa (`ME`, `EPP`, `Demais`) |
| `total_vendas_homologadas`| `integer` | Total de itens vencidos/homologados |
| `total_certames` | `integer` | Total de licitações/compras distintas vencidas (só as com identificador externo) |
| `total_orgaos` | `integer` | Total de órgãos compradores distintos atendidos (órgão sem identificação não conta) |
| `valor_registrado_ata` | `numeric(18,2)` | Total financeiro apurado exclusivamente em Atas de Registro de Preço (valor registrado) |
| `valor_homologado_contratacao` | `numeric(18,2)` | Total financeiro apurado em contratações diretas / compras homologadas efetivas |
| `valor_total_vendido` | `numeric(18,2)` | Faturamento total geral apurado em homologações (preserva NULL se não informado) |
| `cobertura_predominante` | `text` | Grau de cobertura do catálogo (`'catmat_oficial'`, `'pdm_oficial'`, `'pdm_palavra'`, `'sem_pdm'`) |
| `qtd_itens_catmat_oficial` | `integer` | Total de itens com código CATMAT oficial no cadastro `catmat_itens` |
| `qtd_itens_pdm_oficial` | `integer` | Total de itens com código PDM oficial |
| `qtd_itens_pdm_palavra` | `integer` | Total de itens classificados por palavra-chave (`catmat_pdm_palavras`) |
| `qtd_itens_sem_pdm` | `integer` | Total de itens sem vínculo com PDM |
| `marcas_entregues` | `text[]` | Lista de marcas efetivamente entregues |
| `fabricantes_entregues` | `text[]` | Lista de fabricantes entregues |
| `itens_praticados` | `jsonb` | Array de itens CATMAT/PDM com preços mín, mediana e máx |
| `orgaos_clientes` | `jsonb` | Array de órgãos atendidos com frequência e valor |
| `primeira_venda` | `date` | Data da homologação mais antiga registrada |
| `ultima_venda` | `date` | Data da homologação mais recente registrada |

**Estrutura de `itens_praticados` (JSONB)**:
```json
[
  {
    "codigo_pdm": 2640,
    "codigo_item": 480144,
    "cobertura": "catmat_oficial",
    "n_vendas": 12,
    "preco_min": 8500.0,
    "preco_mediana": 9200.0,
    "preco_max": 10500.0,
    "quantidade_total": 35.0,
    "valor_total": 322000.0,
    "ultima_venda": "2026-09-25"
  }
]
```

**Estrutura de `orgaos_clientes` (JSONB)**:
```json
[
  {
    "orgao_identificador": "158517",
    "orgao_nome": "UNIVERSIDADE FEDERAL DA INTEGRACAO LATINO-AMERICANA",
    "frequencia_vendas": 5,
    "valor_total": 145000.0,
    "ultima_venda": "2026-09-18"
  }
]
```

### 4.6 Regra de Deduplicação Canônica de Vendas Homologadas
Para garantir que a mesma contratação homologada não seja contabilizada mais de uma vez ao ser ingerida por diferentes trilhos oficiais (ex.: PNCP `licitacao_resultados`, Compras.gov `precos_praticados_itens`, Compras.gov `atas_rp_itens` e `resultados_itens_14133`), a view `v_bi_fornecedor_historico` utiliza uma **chave canônica de venda**:

$$\text{chave} = \text{cnpj} \parallel \text{compra\_id\_canonico} \parallel \text{coalesce}(\text{numero\_item}, \text{'cod:'} \parallel \text{coalesce}(\text{codigo\_item}, \text{'pdm:'} \parallel \text{coalesce}(\text{codigo\_pdm}, \text{'0'})))$$

1. **Ponte Compras.gov $\leftrightarrow$ PNCP (`compras_pncp_bridge`)**:
   - As tabelas `resultados_itens_14133` e `atas_rp_itens` contêm simultaneamente `id_compra` e `numero_controle_pncp_compra`.
   - Nas compras do PNCP em `licitacoes_externas`, o `id_compra` de 17 dígitos é extraído de `link_sistema_origem` via regex `[?&]compra=(\d{17})`.
   - Essa ponte mapeia o `id_compra` de `precos_praticados_itens` diretamente para o `numero_controle_pncp_compra` do PNCP.
2. **Escolha da fonte e Identificação de SRP** (migration `20261002160000`):
   - `eh_ata_rp`: determinado prioritariamente pelo booleano oficial `raw->>'srp'` do PNCP; na ausência, pelo regex seguro de fronteira `\y(arp|registro de pre[cç]os?)\y` sobre objeto ou modalidade.
   - Atas de Registro de Preço (`atas_rp_itens`) têm `eh_ata_rp = true` e `valor_origem = 'ata_rp'`.
   - Para cada chave escolhe-se **uma fonte**: ata RP primeiro; depois completude (código do item, preço, marca, quantidade), data mais recente, nome da fonte e id da linha de origem (desempate determinístico). **Todos os resultados da fonte escolhida entram**: vários resultados do mesmo item (vencedores, cotas, `sequencial_resultado`) não colapsam.
   - Valor de venda é sempre o homologado/registrado (`valor_unitario_homologado`/`valor_total_homologado`, valor da ata, preço praticado), nunca o estimado.
3. **Identidade do certame**:
   - PNCP: número de controle (`codigo_externo`), o mesmo das fontes Compras.gov via ponte.
   - Paradigma, SEST SENAT e demais portais: `'ext:' || fonte || ':' || modulo || '/' || id_externo` (ex.: `'ext:sestsenat:59/42'`), a chave única da origem; sem modulo/id_externo, `'ext:' || fonte || ':cod:' || codigo_externo`.
   - Sem nenhum identificador externo: `null` (não conta em `total_certames` e não é deduplicada contra outra linha). A PK interna (`licitacoes_externas.id`) nunca é usada como identidade.
4. **Órgão comprador (`orgao_identificador`)**:
   - CNPJ (licitações), código UASG (Pesquisa de Preço, ARP) ou código da unidade / CNPJ (14.133).
   - Sem esses, `'sem-cnpj:' || fonte || ':' || md5(nome normalizado)`, a mesma fórmula da `orgaos_compradores` (20260929181500); sem nome, `null` (não conta em `total_orgaos` nem aparece em `orgaos_clientes`). Nada de `org:<id>`, `uasg:desconhecida` ou `org:14133`.
   - Na 14.133, `orgao_nome` é o nome oficial de `public.orgaos` pelo CNPJ ou `null`, nunca o CNPJ.

---

## 5. Ordem de Ingestão e Carga dos Coletores

Para manter a consistência relacional e alimentar o BI sem inconsistências, a ordem recomendada de execução dos coletores é:

1. **`compras_pgc`** (`python -m coletor.compras_pgc`):
   - Ingestão do plano de compras por classes 7830 e 7220.
   - Popula `pca_pgc_itens`.
2. **`compras_precos`** (`python -m coletor.compras_precos`):
   - Ingestão dos preços praticados por PDM efetivo (2640, 2638, etc.).
   - Popula `precos_praticados_itens`.
3. **`compras_arp`** (`python -m coletor.compras_arp`):
   - Ingestão de atas de registro de preço vigentes no catálogo.
   - Popula `atas_rp_itens`, chave `(numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)` (`uq_atas_rp_itens_lote_fornecedor`, migration `20261003020000`).
   - A API responde **404** quando falta parâmetro obrigatório (`dataVigenciaInicialMin`/`Max`; na Pesquisa de Preço, `tipo`/`codigo`); consulta válida sem resultado volta 200 com `resultado: []`. Os coletores validam antes e tratam 404 como erro, nunca como vazio.
4. **`fornecedores --de-resultados`** (`python -m coletor.fornecedores --de-resultados`):
   - Consulta pública de CNPJ (BrasilAPI/Minha Receita) para preenchimento de Razão Social e CNAE dos novos fornecedores descobertos.
   - Popula `public.fornecedores`.
5. **Views de BI**:
   - As views refletem automaticamente os dados consolidados sem necessidade de triggers pesadas.

---

## 6. Diagnóstico de Governança e Permissões Pré-existentes

Conforme identificado na auditoria do schema:
- **Tabelas e views novas deste PR (`pca_pgc_itens`, `precos_praticados_itens`, `atas_rp_itens`, `resultados_itens_14133` e `v_bi_*`)**:
  - RLS ativado.
  - **SEM grant para `anon` e SEM grant para `authenticated`**.
  - Acesso estrito e exclusivo por `service_role`.
- **Tabelas e views legadas/históricas**:
  - `v_bi_resultados_itens`, `v_fornecedor_participacoes` e `contratacoes_*` possuem privilégio `SELECT` atribuído à role `authenticated` por migrations históricas.
  - Conforme os limites rígidos do PR (não revogar permissões históricas em produção sem aprovação prévia), essas políticas foram mantidas inalteradas e registradas como pendência para futura sanitização.
- **Ação `historico` na Edge Function `api-fornecedores-homologados`**:
  - Endpoint seguro que recebe `{ action: 'historico', cnpj: '...' }`.
  - Valida JWT de usuário logado (fail-closed) sem chaves em código.
  - Acessa `public.v_bi_fornecedor_historico` via `service_role` e retorna o raio-x completo do fornecedor para o Dashboard.

---

## 7. Itens de Escopo Limítrofes (Grama Sintética / Obras de Campo)

Conforme conferência em produção e levantamento do catálogo CATMAT/PNCP, determinados itens com grande volume financeiro situam-se na fronteira entre fornecimento de produto (escopo da Playfit / LicitaGym) e obras de engenharia civil/construção de campos esportivos:

| Código PDM | Nome PDM / CATMAT | Casos Típicos / Exemplo de Fornecedor | Volume / Observação |
|---|---|---|---|
| **18481** | `GRAMA SINTÉTICA` (Classe 7220) | Fornecimento e instalação de grama sintética para campo society (ex.: Construtora Possamai, R$ 4,78 mi) | PDM de produto, mas frequentemente licitado em certames mistos com base e drenagem |
| **10779** | `PISO SINTÉTICO` (Classe 7220) | Piso modular em polipropileno (PP/TPE) x piso emborrachado EPDM/SBR moldado | Condicional: regulado pelas exclusões de `catmat_pdm_exclusoes` (ex.: piso modular de concorrente fica fora) |
| **9461** / item **150846** | `BORRACHA GRANULADA` (Classe 9320) | Infill / raspa de borracha reciclada para gramados sintéticos e pistas | Núcleo do produto industrial da Playfit, fornecido aos construtores/instaladores |

*Nota de Produto: Conforme diretriz do projeto, a decisão de inclusão/exclusão definitiva de certames do tipo "obra de campo com grama" cabe exclusivamente ao Dono do Produto via Dashboard & Pipeline (`catmat_pdm_exclusoes` / regras de escopo). O BI reflete com precisão o que for delimitado pelas regras ativas do catálogo.*

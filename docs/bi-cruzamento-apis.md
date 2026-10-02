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

Amostras reais das APIs oficiais (medidas em 02/10/2026):

| Campo de Negócio | Compras.gov Pesquisa de Preço (`1_consultarMaterial`) | Compras.gov ARP (`2_consultarARPItem`) | Compras.gov 14.133 (`3_consultarResultado...`) | LicitaGym `licitacao_resultados` (PNCP/Paradigma) |
|---|---|---|---|---|
| **CNPJ / NI Fornecedor** | `niFornecedor` (ex.: `"04372852000160"`) | `niFornecedor` (ex.: `"40962266000130"`) | `niFornecedor` (ex.: `"03521758000163"`) | `fornecedor_cnpj` (14 dígitos) |
| **Nome Fornecedor** | `nomeFornecedor` (ex.: `"W.E.V COMERCIAL LTDA"`) | `nomeRazaoSocialFornecedor` (ex.: `"PANTHERA LEO EQUIPAMENTOS"`) | `nomeRazaoSocialFornecedor` (ex.: `"LUBRITECH DO BRASIL"`) | `fornecedor_nome` |
| **Marca** | `marca` (ex.: `"FORTIX"`, `"SIGMETAL"`) | `marca` (presente em atas detalhadas) | `marca` (quando preenchido pelo órgão) | `marca` / `marca_normalizada` (ex.: `"MOVEMENT"`) |
| **Fabricante** | Não enviado diretamente (deriva de marca/CNAE) | `fabricante` (opcional no DTO) | `fabricante` (opcional no DTO) | `f.fabricante` (CNAE 10–33) |
| **Modelo** | `modelo` (quando informado) | `modelo` (quando informado) | `modelo` (quando informado) | `modelo` (capturado no Paradigma) |
| **Preço Unitário** | `precoUnitario` (ex.: `9000.00`) | `valorUnitario` (ex.: `8500.00`) | `valorUnitarioHomologado` (ex.: `4685.00`) | `valor_unitario_homologado` |
| **Órgão / UASG** | `codigoUasg`, `nomeUasg`, `estado` | `codigoUnidadeGerenciadora`, `nomeUnidadeGerenciadora` | `unidadeOrgaoCodigoUnidade`, `orgaoEntidadeCnpj` | `orgao_cnpj`, `orgao_nome`, `uf` |

---

## 3. Classificação Revenda x Fabricante

A classificação do fornecedor na view `v_bi_fornecedor_historico` segue regras determinísticas auditáveis:

1. **CNAE Principal (Divisões 10 a 33)**: Indústria / Fabricação (ex.: CNAE `3230-2/00` Fabricação de artefatos para esporte). Classificado como `'fabricante'` com confiança `'alta_cnae_industria'`.
2. **CNAE Principal (Divisões 45 a 47)**: Comércio Atacadista / Varejista (ex.: CNAE `4763-6/02` Comércio de artigos esportivos). Classificado como `'revenda'` com confiança `'alta_cnae_comercio'`.
3. **Sinal de Coincidência de Marca**: Quando o CNAE não está categorizado, mas a marca que o fornecedor entrega coincide com tokens da sua própria Razão Social / Nome Fantasia (ex.: Fornecedor "Movement Artigos Esportivos" entregando marca "MOVEMENT"). Classificado como `'fabricante'` com confiança `'media_coincidencia_marca'`.
4. **Sem dados / Desconhecido**: Quando não há CNAE cadastrado (ex.: fornecedor sem consulta pública prévia no `fornecedores`), a coluna permanece `'nao_classificado'` ou `'baixa_sem_cnae_especifico'`, sem qualquer valor inventado.
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
| `marca` | `text` | Marca registrada do produto na ata |
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
| `orgao_nome` | `text` | Razão social ou nome institucional |
| `esfera` | `text` | Esfera administrativa (`Federal`, `Estadual`, `Municipal`) |
| `uf` | `text` | Estado da sede do órgão |
| `qtd_itens_planejados` | `integer` | Itens planejados no PCA (PCA + PGC) |
| `valor_total_planejado` | `numeric(18,2)` | Valor total planejado para compras no escopo |
| `qtd_itens_homologados` | `integer` | Itens já homologados/comprados |
| `valor_total_homologado` | `numeric(18,2)` | Valor total já adquirido pelo órgão |
| `score_demanda_total` | `numeric(18,2)` | Soma do valor planejado + homologado |
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
| `tipo_fornecedor_confianca`| `text` | Nível de evidência da classificação |
| `uf_sede` | `text` | UF da sede do fornecedor |
| `municipio_sede` | `text` | Município da sede |
| `porte` | `text` | Porte da empresa (`ME`, `EPP`, `Demais`) |
| `total_vendas_homologadas`| `integer` | Total de itens vencidos/homologados |
| `total_certames` | `integer` | Total de licitações/compras distintas vencidas |
| `total_orgaos` | `integer` | Total de órgãos compradores distintos atendidos |
| `valor_total_vendido` | `numeric(18,2)` | Faturamento total apurado em homologações |
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
   - Popula `atas_rp_itens`.
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

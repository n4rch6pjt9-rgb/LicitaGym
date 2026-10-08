# LicitaGym — Instruções do Projeto

## Projeto

O LicitaGym é um SaaS para monitoramento e análise de oportunidades de licitações públicas, com foco principal no mercado de equipamentos fitness.

O sistema deve priorizar:

- precisão;
- rastreabilidade;
- dados oficiais;
- auditabilidade;
- segurança.

## Regra de Ouro: Zero Alucinação

Precisão é um requisito do produto.

Nunca invente ou complete dados de licitações quando eles puderem ser obtidos ou verificados em uma fonte oficial.

Isso é especialmente importante para:

- valores de editais;
- preços de itens;
- quantidades;
- códigos CATMAT;
- códigos PDM;
- UASG;
- número da compra;
- datas;

## Regra de Ouro: Consultar Schemas Antes de Requisições

**Antes de fazer qualquer requisição HTTP a APIs (PNCP, Compras.gov)**:

1. Ler `/docs/pncp/schemas-consultas-pncp.md` (PNCP)
2. Ler `/docs/compras-gov/schemas-consultas.md` (Compras.gov)
3. Validar:
   - Parâmetros obrigatórios vs opcionais
   - Limites de `tamanhoPagina` (variam: 50 máx pra contratações, 500 pra outros)
   - Nomes de parâmetros (`dataInical` vs `dataInicio`, etc.)
   - Valores enumerados (ex: `codigoModalidadeContratacao`)

**Razão:** Evita 400/404 errors e trial-and-error desnecessário.
- BDI;
- impostos;
- cálculos de propostas;
- cálculos de exequibilidade;
- margens.

Quando uma informação não estiver disponível, represente-a como ausente, desconhecida ou não verificada.

Nunca fabrique um valor para preencher a interface.

## Identificadores CATMAT

Respeite a semântica dos identificadores oficiais.

Em particular:

- `codigoItem` e `codigoPdm` não são equivalentes;
- diferentes itens CATMAT podem compartilhar um PDM;
- características podem diferenciar itens pertencentes ao mesmo PDM;
- preserve os identificadores originais da fonte durante a ingestão.

## Identificação da licitação

Sempre que disponíveis, preserve:

- UASG;
- número da compra;
- modalidade;
- órgão;
- unidade compradora;
- identificadores oficiais da fonte.

Não substitua identificadores oficiais por identificadores internos.

## Fontes de dados

Priorize fontes oficiais.

Fontes atualmente relevantes:

- Compras.gov.br / Dados Abertos;
- PNCP;
- Compras RJ, quando aplicável.

Dados mockados ou hardcoded não devem substituir dados oficiais nos fluxos de produção.

Mocks podem ser utilizados apenas quando explicitamente destinados a desenvolvimento ou testes.

## Escopo do catálogo

O foco principal atual é equipamentos fitness.

Classificação principal:

- Musculação
- Cárdio
- Acessórios

Exemplos de acessórios:

- Halter
- Dumbbells
- Puxadores
- Anilhas
- Cordas
- Piso
- Colchonete
- Outros

A classificação deve ser determinística e idempotente sempre que possível.

Deve existir possibilidade de edição manual da classificação.

## Arquitetura

Antes de implementar uma funcionalidade:

1. Analise a implementação existente.
2. Analise o schema e as migrations relevantes.
3. Analise os serviços e clientes de API existentes.
4. Reutilize abstrações existentes quando apropriado.
5. Evite criar duas implementações para o mesmo conceito.

## Supabase

Supabase é a plataforma principal de backend do projeto.

Utilize a arquitetura existente do Supabase para recursos aplicáveis, incluindo:

- PostgreSQL;
- autenticação;
- autorização;
- Row Level Security;
- funções e recursos de backend já implementados no projeto.

Não introduza:

- AWS Cognito;
- AWS RDS;
- AWS S3;
- Asaas;

a menos que isso seja solicitado explicitamente.

## Integridade dos dados

Identificadores provenientes de fontes governamentais devem ser preservados separadamente das chaves internas do sistema.

Não sobrescreva silenciosamente dados provenientes das fontes oficiais.

Ao normalizar dados, preserve informações suficientes para:

- rastrear a origem;
- reproduzir a importação;
- auditar o dado;
- identificar o registro original.

Alterações de schema devem utilizar migrations.

## Schema & Migrations — Padrão CATMAT (E1-E7)

**Staging tables** (`icatmat_*`) ingerem dados brutos de Compras.gov antes de reconciliação com `catmat_*`.

### Estrutura obrigatória

- **Identidade:** `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (moderno, não BIGSERIAL)
- **Integridade:** FKs cascata conectam hierarquicamente (E1 ← E2 ← E3 ← E4 ← E5/E6/E7)
- **Rastreabilidade:** `payload_hash TEXT NOT NULL UNIQUE` (MD5 para dedup)
- **Timestamp:** `data_hora_atualizacao` + `sync_timestamp` ambos `NOT NULL DEFAULT NOW()`
- **Validação:** CHECKs replicam golden rule (apenas G72/7220, G78/7830)
- **Índices:** apenas `sync_timestamp` (golden rule limita a 2 grupos = outros índices inúteis)
- **Segurança:** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` obrigatório

### Tabelas existentes

Só duas estão no schema: `icatmat_grupo_material` (E1) e `icatmat_pdm_completa`. As E2–E7
(`icatmat_classe_material`, `icatmat_pdm_material`, `icatmat_item_material`, `icatmat_natureza_despesa`,
`icatmat_unidade_fornecimento`, `icatmat_caracteristica_material`) nunca foram aplicadas e estão em
`supabase/migrations_archive/`. O catálogo em uso é `catmat_*`. Recriar uma E2–E7 exige migration nova.

Ver `supabase/migrations/SCHEMA_STANDARDS.md` para template e checklist.

## Cálculos financeiros

Cálculos financeiros, fiscais, BDI, margem e exequibilidade devem ser determinísticos.

Nunca dependa de cálculos aproximados realizados pelo modelo de linguagem para valores críticos.

Utilize código ou funções com entradas e saídas explícitas.

Os cálculos devem ser:

- reproduzíveis;
- testáveis;
- auditáveis.

Quando houver arredondamento, a regra utilizada deve estar explicitamente definida.

## Interface

A interface deve apresentar informações de licitações de forma clara e profissional.

Prefira:

- hierarquia visual clara;
- densidade de informação adequada;
- componentes consistentes;
- estados de carregamento explícitos;
- estados vazios explícitos;
- estados de erro explícitos.

Nunca esconda ausência de dados utilizando valores inventados.

## Critério de conclusão

Uma tarefa não está concluída apenas porque o código foi escrito.

Quando aplicável:

1. Type checking deve passar.
2. Lint deve passar.
3. Testes relevantes devem passar.
4. Build deve funcionar.
5. Alterações de banco devem possuir migration.
6. Nenhum secret deve ter sido introduzido.
7. Não devem existir regressões óbvias.
8. Dados reais devem ser utilizados em vez de dados hardcoded desnecessários.

Se alguma validação não puder ser executada, informe isso explicitamente.
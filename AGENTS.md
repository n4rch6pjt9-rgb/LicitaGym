# LicitaGym: regras de dados (todos os agentes)

 chore/higiene-contexto-e-pipeline
## Projeto
O LicitaGym é um SaaS para monitoramento e análise de oportunidades de licitações públicas, com foco principal no mercado de equipamentos fitness e pisos esportivos/borracha.

Este repositório (`n4rch6pjt9-rgb/LicitaGym`) compreende o backend: banco de dados PostgreSQL, Supabase Edge Functions, coletores de ingestão em Python e harness de administração desktop. O frontend reside no repositório separado `n4rch6pjt9-rgb/Dashboard---LicitaGym`.

O sistema deve priorizar:
- precisão;
- rastreabilidade;
- dados oficiais;
- auditabilidade;
- segurança.

---
## Regra de Ouro: Zero Alucinação
Precisão é um requisito inegociável do produto.
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
- BDI, impostos, cálculos de propostas, exequibilidade e margens.

Quando uma informação não estiver disponível, represente-a explicitamente como ausente (`null`), desconhecida ou não verificada. Nunca fabrique um valor para preencher a interface.

Em chamadas a Modelos de Linguagem (LLMs):
- É mandatório o uso de saída estruturada com JSON Schema (`response_mime_type="application/json"`).
- O texto extraído de editais de terceiros deve ser envelopado em blocos de confiança com isolamento anti-prompt injection.
- A classificação de escopo de certames deve ser determinística via catálogo ancorado (`catmat_ancoras.py`), nunca baseada puramente na intuição estatística do modelo.

---
## Regra de Ouro: Consultar Schemas Antes de Requisições
**Antes de fazer qualquer requisição HTTP a APIs externas**:
1. PNCP: Ler `/docs/pncp/schemas-consultas-pncp.md` e OpenAPI em `/docs/pncp/openapi/`
2. Compras.gov: Ler `/docs/compras-gov/schemas-consultas.md`
3. Validar:
   - Parâmetros obrigatórios vs opcionais
   - Limites de `tamanhoPagina` (50 máx para contratações, 500 para outros)
   - Nomes exatos de parâmetros (`dataInicial` vs `dataInicio`, etc.)
   - Valores enumerados e códigos de modalidade

---
## Infraestrutura Cloud: Supabase & Google Cloud Platform (GCP)
A arquitetura do LicitaGym é estritamente híbrida entre **Supabase** e **Google Cloud Platform (GCP)**.

### 1. Supabase (Backend Primário & Dados)
- Plataforma de banco relacional PostgreSQL, Autenticação, Row Level Security (RLS) e Edge Functions (Deno).
- Ambiente único de produção.
- Não introduza AWS (Cognito, RDS, S3), Asaas ou outras nuvens não autorizadas.
- O PostgREST público não deve expor tabelas brutas: leituras do frontend passam pelas Edge Functions com projeção estrita de colunas seguras.

### 2. Google Cloud Platform (Processamento Pesado & IA)
- **Cloud Run Jobs:** Ambiente canônico para execução dos coletores longos em lote. Contêineres devem rodar com usuário não-root e `PYTHONUNBUFFERED=1`.
- **Google Cloud Storage (GCS):** Armazenamento de arquivo bruto e imutável de banco e storage de anexos.
- **Vertex AI:**
  - **Embeddings:** Modelo canônico obrigatório `text-multilingual-embedding-002` (768 dimensões).
  - **Modelos Generativos:** `gemini-2.5-flash` (ou versão vigente) para OCR e extração estruturada de editais.
  - **Cotas e Latência:** Respeitar o teto de 5 RPM para embeddings em novos projetos. Retries devem obrigatoriamente incluir **backoff exponencial com jitter**.
  - **Anti-padrão de Download:** Ao processar documentos já hospedados no Cloud Storage, use a URI direta (`Part.from_uri(file_uri="gs://...", mime_type="application/pdf")`) em vez de baixar bytes intermediários na RAM do contêiner.
- **Autenticação GCP:** Apenas via **Application Default Credentials (ADC)** ou Workload Identity. É terminantemente proibido hardcodar ou commitar chaves de conta de serviço (`*.json`) ou API keys.

---
## Identificadores Oficiais e Fontes de Dados
### Identificadores CATMAT
- `codigoItem` e `codigoPdm` não são equivalentes.
- Diferentes itens CATMAT podem compartilhar o mesmo PDM.
- Preserve sempre os identificadores originais da fonte durante a ingestão.

### Identificação da Licitação
Preserve sempre:
- Código de controle PNCP;
- Para compras fora do PNCP: CNPJ do órgão + número do Processo Administrativo;
- UASG, modalidade, órgão e unidade compradora.

### Fontes Autorizadas em Produção
1. **PNCP (Portal Nacional de Contratações Públicas)**
2. **Compras.gov.br (Dados Abertos / SIASG)**
3. **Sistema S (Sesc, Senac, Sesi, Senai, Sest Senat / Plataforma Paradigma)**
4. **Portal de Compras Públicas / Compras RJ** (quando aplicável)

Dados mockados são estritamente proibidos em fluxos de produção.

---
## Escopo do Catálogo e Classificação
Foco: **Equipamentos Fitness e Pisos Esportivos/Borracha**.
- Classificação: Musculação, Cárdio, Acessórios, Pisos, Borracha e Manutenção.
- A classificação deve ser **determinística, ancorada no catálogo oficial CATMAT** e idempotente.
- Deve existir possibilidade de edição manual com precedência sobre a regra automática.

---
## Schema, Migrations e Integridade
- Alterações estruturais no banco de dados exigem **migrations numeradas** com timestamp.
- Nunca execute `supabase db push` ou `supabase db reset` diretamente em produção.
- Toda tabela exposta ao PostgREST deve ter **Row Level Security (RLS)** habilitado.

---
## Governança de Contexto de IA no Repositório
- **Fonte Única:** Este arquivo (`AGENTS.md`) é a única fonte de regras gerais de negócio e arquitetura.
- **Ferramental:** Arquivos como `.cursor/rules/licitagym.mdc` devem apenas referenciar este documento.
- **Higiene:** Não comite logs de sessão de plugins de IA (`CLAUDE.md` de subdiretórios gerados por plugins de memória).
=======
Este arquivo é lido pelo Claude (importado no `CLAUDE.md`), Codex, Cursor e Copilot. Regras de produto e escopo:
`.claude/rules/regras-negocio.md`. Regras por área: `.github/instructions/`.

## Prioridades
Precisão, rastreabilidade, dado oficial, auditabilidade e segurança, nessa ordem.

## Zero alucinação
Nunca invente nem complete dado que possa ser obtido ou conferido numa fonte oficial. Vale principalmente para:
valores de edital, preços de item, quantidades, códigos CATMAT e PDM, UASG, número da compra, datas,
BDI, impostos, cálculos de proposta, exequibilidade e margens.

Dado indisponível aparece como ausente, desconhecido ou não verificado. Nunca fabrique valor para preencher a tela.

## Consultar schemas antes de chamar API
Antes de qualquer requisição HTTP ao PNCP ou ao Compras.gov, leia:
1. `docs/pncp/schemas-consultas-pncp.md`
2. `docs/compras-gov/schemas-consultas.md`

e confira parâmetros obrigatórios, limite de `tamanhoPagina` por família de endpoint (contratações ≤ 50, outros ≤ 500),
nomes exatos (`dataInical` × `dataInicio`) e enums (`codigoModalidadeContratacao`).

## Fontes
- **Portal oficial da disputa (o indicado no edital) é a fonte primária** para acompanhar o certame.
  O PNCP é meio, não fim: usado como alternativa quando o portal não pode ser lido (há atraso entre PNCP e portal).
- Só dado aberto/público. Nenhum agente faz login em portal.
- Fontes em uso: Compras.gov.br (Dados Abertos), PNCP, Portal de Compras Públicas, Sistema S (Paradigma).
- Mock e dado fixo só em desenvolvimento e teste, nunca em fluxo de produção.

## Identificadores oficiais
- `codigoItem` ≠ `codigoPdm`. Vários itens CATMAT podem ter o mesmo PDM; características diferenciam itens do mesmo PDM.
- Preserve UASG, número da compra, modalidade, órgão, unidade compradora e IDs da fonte, separados da chave interna.
- Não sobrescreva em silêncio dado de fonte oficial. Ao normalizar, guarde o original e a proveniência
  (origem, como reproduzir a importação, registro original).

## Cálculos
Financeiro, fiscal, BDI, margem e exequibilidade são calculados em código determinístico, com entradas e saídas
explícitas, testável e com regra de arredondamento escrita. Nunca por estimativa do modelo de linguagem.

## Arquitetura
Antes de implementar: leia a implementação existente, o schema e as migrations, os clientes de API em `_shared/`.
Reutilize; não crie duas implementações do mesmo conceito. Backend é Supabase (Postgres, Auth, RLS, Edge Functions).
Não introduza AWS Cognito, RDS, S3 nem Asaas sem pedido explícito.

## Staging CATMAT (`icatmat_*`)
Só `icatmat_grupo_material` e `icatmat_pdm_completa` existem; o catálogo em uso é `catmat_*`. Padrão e checklist
para recriar uma staging: `supabase/migrations/SCHEMA_STANDARDS.md`.

## Interface
Estados explícitos de carregando, vazio e erro. Nunca esconder ausência de dado com valor inventado.

## Critério de pronto
Código escrito não é tarefa pronta. Quando se aplica: typecheck, lint, testes relevantes e build passam; mudança de
banco tem migration; nenhum segredo entrou; sem regressão óbvia; dado real no lugar de dado fixo.
Se alguma verificação não puder rodar, diga isso explicitamente.
 main

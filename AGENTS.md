# LicitaGym — Instruções do Projeto

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

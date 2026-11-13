# LicitaGym: regras de dados (todos os agentes)

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

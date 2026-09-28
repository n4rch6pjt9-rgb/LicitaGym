# Contrato: Edge Function `api-dashboard-oportunidades`

Documentação da Edge Function de leitura de oportunidades para o Dashboard LicitaGym.

O contrato completo de requisições, respostas, parâmetros e tratamento de erros está disponível em:
[`supabase/functions/api-dashboard-oportunidades/README.md`](../supabase/functions/api-dashboard-oportunidades/README.md).

## Resumo Rápido

- **Caminho**: `/functions/v1/api-dashboard-oportunidades`
- **Tabela Fonte**: `public.licitacoes_externas`
- **Ações**:
  - `readiness`: Retorna prontidão da tabela e data do último sync sem vazar segredos.
  - `get`:
    - Lookup por `id` único (retorna `{ item }` ou 404).
    - Lookup por `codigo_externo` único (+ `fonte` opcional, retorna `{ item }` ou 404).
    - Lookup por `orgao_cnpj` + `processo_norm` (retorna coleção `{ items: [...] }` com todas as compras do processo, ou 404).
  - `list`: Lista com paginação (`page`, `limit`), ordenação (`order_by`, `order_direction`) e múltiplos filtros (UF, órgão, prioridade, escopo, borracha, datas com limites inclusivos de dia inteiro `< dia seguinte`, valores e busca textual).
- **Segurança & RLS**:
  - `licitacoes_externas` possui `anon` explicitamente revogado (`revoke all on public.licitacoes_externas from anon`).
  - A Edge Function executa server-side via `SUPABASE_SERVICE_ROLE_KEY` projetando exclusivamente colunas públicas seguras (`PUBLIC_LICITACAO_COLUMNS`), sem expor payload bruto nem colunas de controle interno.
  - O navegador invoca a função com a chave `anon` padrão; o `service_role` nunca é entregue ao cliente.
  - Mensagens de erro de banco não expõem detalhes crus do PostgREST.

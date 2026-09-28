# Contrato: Edge Function `api-dashboard-oportunidades`

Documentação da Edge Function de leitura de oportunidades para o Dashboard LicitaGym.

O contrato completo de requisições, respostas, parâmetros e tratamento de erros está disponível em:
[`supabase/functions/api-dashboard-oportunidades/README.md`](../supabase/functions/api-dashboard-oportunidades/README.md).

## Resumo Rápido

- **Caminho**: `/functions/v1/api-dashboard-oportunidades`
- **Tabela Fonte**: `public.licitacoes_externas`
- **Ações**:
  - `readiness`: Retorna prontidão da tabela e data do último sync.
  - `get`: Busca por `id` ou `orgao_cnpj` + `processo_norm` (404 claro se não existir).
  - `list`: Lista com paginação (`page`, `limit`), ordenação (`order_by`, `order_direction`) e múltiplos filtros (UF, órgão, prioridade, escopo, borracha, datas, valores e busca textual).
- **Segurança**: Usa chave pública `anon` e RLS aditivo; sem exposição de `service_role`.

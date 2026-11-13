# Segurança MVP — Usuários PNCP (CLA-40)

## Decisão

**Não ingerir** dados do endpoint `/api/pncp/v1/usuarios` no MVP do Monitor licitagym.

## Motivos

1. Endpoint expõe PII (CPF/CNPJ, login) — incompatível com rotas públicas e logs abertos.
2. Usuário PNCP ≠ conta autenticada do Monitor (tenant Supabase Auth).
3. CLA-40 exige finalidade comprovada antes de qualquer ingestão.

## Implementação

- Nenhuma tabela `pncp_usuario` ou equivalente.
- Cliente de integração não chama `/v1/usuarios` por padrão.
- Edge Functions de sync usam apenas API Consulta (pública) ou credenciais de serviço sem escopo usuário.
- RLS em `public.*`: leitura autenticada; escrita apenas via `service_role` nas funções de sync.
- Migration `202609180009_rls_tenant_review.sql`: `REVOKE ALL` de `anon`; `GRANT SELECT` para `authenticated`.
- Storage `pncp-legislation`: bucket privado, sem leitor desde a spec 0043 (a `api-pncp-legislacao`, que assinava a URL, foi removida). A remoção do bucket é a K-4 da 0043.
- Logs: nunca registrar CPF, tokens ou payloads completos de usuário.
- Tenant futuro: adicionar coluna `tenant_id` e policies quando multi-tenant for necessário; MVP é single-tenant com auth Supabase.

## Revisão futura

Reabrir ingestão somente se:

- Finalidade de produto documentada e aprovada.
- Política de retenção e anonimização definida.
- RLS e auditoria de acesso implementados.

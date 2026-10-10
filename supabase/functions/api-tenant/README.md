# api-tenant

Cadastro da empresa (tenant) e dos usuários ligados a ela. Spec `specs/0017-tenant-cadastro-empresa-usuarios.md`,
Dashboard #29 (mãe) e #68 (tela).

- `POST`, JWT do Supabase Auth no `Authorization` (validado no código; `verify_jwt = false` no `config.toml`).
- Banco com `service_role` (`tenants`, `tenant_membros`, `tenant_dados_restritos`); a função confere o papel antes.
- Papel: **desenvolvedor** = `app_metadata.licitagym_role = 'admin'` (admin em qualquer empresa); **admin** e
  **operação** = `tenant_membros.papel`. `user_metadata` nunca decide papel.
- CNPJ: BrasilAPI `GET /api/cnpj/v1/{cnpj}`, timeout de 10 s, até 3 tentativas (429/5xx/timeout/conexão, respeita
  `Retry-After` até 10 s), 404 sem nova tentativa. DV inválido (mod-11) não chama a fonte. Nada é guardado em cache.

| action | quem | corpo | resposta |
|---|---|---|---|
| `minha_empresa` | autenticado | — | `desenvolvedor`, `empresas[]` (`id`, `slug`, `nome`, `cnpj`, `tipo`, `ativo`, `papel`); sem vínculo, `[]` |
| `cnpj_consultar` | desenvolvedor ou admin | `cnpj` | `consulta` (razão social, nome fantasia, situação, CNAEs, endereço, `fonte`, `url`, `consultado_em`); não grava |
| `empresa_criar` | desenvolvedor | `cnpj`, `admin_email`, `nome?`, `slug?`, `tipo?` | 201 `empresa` **inativa** + `consulta`; situação ≠ ATIVA → 400; CNPJ repetido → 409; e-mail sem conta → 404; se o vínculo do admin falhar, a empresa é apagada |
| `empresa_atualizar` | admin (`ativo`: só desenvolvedor) | `tenant_id`, `nome?`, `cnpj?`, `ativo?` | `empresa`; ativar com outra empresa ativa sem membro → 409 |
| `membros_listar` | membro | `tenant_id` | `membros[]` (`user_id`, `email`, `papel`, `ativo`) |
| `membro_adicionar` | admin | `tenant_id`, `email`, `papel` | 201 `membro`; só conta existente (sem convite); e-mail sem conta → 404 |
| `membro_atualizar` | admin | `tenant_id`, `user_id`, `papel?`, `ativo?` | `membro`; tirar o último admin ativo → 400 |
| `dados_restritos_obter` | admin | `tenant_id` | `dados` (`banco`, `agencia`, `conta`, `updated_at`) ou `null` |
| `dados_restritos_salvar` | admin | `tenant_id`, `banco?`, `agencia?`, `conta?` | `dados` |

Membro de outra empresa → 403. Empresa inexistente → 404. Logs sem dado bancário nem token.

**Por que a empresa nasce inativa:** a `api-pipeline` resolve o usuário sem vínculo pelo "único tenant ativo". Uma
segunda empresa ativa antes de os usuários da Konnen estarem ligados faria todo o pipeline responder 409.

Testes: `tests/supabase/functions/api_tenant_test.ts` (CA-1 a CA-17 da spec; CA-12 está em `api_pipeline_test.ts`,
`resolverTenant`; CA-13 em `supabase/tests/tenant_membros_check.sql`).

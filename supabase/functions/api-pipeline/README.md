# api-pipeline

Pipeline comercial da equipe (Dashboard #29). Uma etapa por licitação, compartilhada pelo tenant, com histórico de
cada entrada, mudança e saída. Etapas configuráveis por admin; as 13 do Kanban são o padrão (migration
`20261006020000_pipeline_oportunidades`).

- `POST`, JWT do Supabase Auth no `Authorization` (validado no código; `verify_jwt = false` no `config.toml`).
- Banco com `service_role`; tabelas e funções fechadas para `anon`/`authenticated`.
- Tenant (`_shared/tenant.ts`): vínculo ativo em `tenant_membros` com empresa ativa. Vínculo só com empresa desativada, vínculo desligado ou conta sem vínculo → 403 (#263), sem cair em outra empresa. Só o desenvolvedor sem vínculo cai na única empresa ativa (papel nulo); com duas empresas ativas, 409.
- Papel: `etapa_*` exige admin da empresa (`tenant_membros.papel = 'admin'`) ou o desenvolvedor (`app_metadata.licitagym_role = 'admin'`). Operação lê e movimenta o pipeline, mas não configuram etapas (403).

| action | quem | corpo | resposta |
|---|---|---|---|
| `etapas_listar` | autenticado | — | `etapas[]` (`id`, `nome`, `fase`, `ordem`, `desfecho`, `exige_motivo`, `padrao`, `total`) |
| `pipeline_listar` | autenticado | `etapa_id?` | `itens[]` com `licitacao` (campos do card), até 1000, mais recentes primeiro; `truncado` avisa se havia mais |
| `pipeline_estado` | autenticado | `licitacao_ids[]` (até 200) | `estado[]` (`licitacao_id`, `etapa_id`) só das que estão no pipeline |
| `pipeline_adicionar` | autenticado | `licitacao_ids[]` | entra na primeira etapa sem desfecho; quem já está não muda, de forma atômica (`adicionadas`, `ja_no_pipeline`, `etapa`) |
| `pipeline_mover` | autenticado | `licitacao_ids[]`, `etapa_id`, `motivo?` | `movidas`; etapa com `exige_motivo` sem motivo → 400 |
| `pipeline_remover` | autenticado | `licitacao_ids[]` | `removidas` |
| `pipeline_historico` | autenticado | `licitacao_id` | `eventos[]`, mais recente primeiro |
| `etapa_criar` | admin da empresa ou desenvolvedor | `nome`, `fase`, `ordem?`, `desfecho?`, `exige_motivo?` | 201 `etapa`; nome repetido → 409 |
| `etapa_atualizar` | admin da empresa ou desenvolvedor | `id` + campos | `etapa` |
| `etapa_excluir` | admin da empresa ou desenvolvedor | `id`, `mover_para?` | `movidas`; com oportunidades e sem `mover_para` → 400; última etapa → 400 |

Fases: `prospeccao`, `proposta`, `disputa`, `conclusao`. Desfechos: `vencida`, `perdida`, `descartada`.

Concorrência: `pipeline_mover` e `pipeline_etapa_excluir` são serializadas por tenant (advisory lock da transação),
então chamadas simultâneas não travam entre si nem gravam histórico a partir de uma etapa desatualizada. Tenant novo
ganha as 13 etapas padrão pelo gatilho `tenants_pipeline_semear_etapas`.

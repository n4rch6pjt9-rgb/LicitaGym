# api-pipeline

Pipeline comercial da equipe (Dashboard #29). Uma etapa por licitação, compartilhada pelo tenant, com histórico de
cada entrada, mudança e saída. Etapas configuráveis por admin; as 13 do Kanban são o padrão (migration
`20261006020000_pipeline_oportunidades`).

- `POST`, JWT do Supabase Auth no `Authorization` (validado no código; `verify_jwt = false` no `config.toml`).
- Banco com `service_role`; tabelas e funções fechadas para `anon`/`authenticated`.
- Tenant: `tenant_membros` (papel `admin` ou `operacao`). Sem vínculo, só resolve se houver uma empresa ativa. Com duas empresas ativas e sem vínculo, responde 409.

| action | quem | corpo | resposta |
|---|---|---|---|
| `etapas_listar` | autenticado | — | `etapas[]` (`id`, `nome`, `fase`, `ordem`, `desfecho`, `exige_motivo`, `padrao`, `total`) |
| `pipeline_listar` | autenticado | `etapa_id?` | `itens[]` com `licitacao` (campos do card), até 1000, mais recentes primeiro; `truncado` avisa se havia mais |
| `pipeline_estado` | autenticado | `licitacao_ids[]` (até 200) | `estado[]` (`licitacao_id`, `etapa_id`) só das que estão no pipeline |
| `pipeline_adicionar` | autenticado | `licitacao_ids[]` | entra na primeira etapa sem desfecho; quem já está não muda, de forma atômica (`adicionadas`, `ja_no_pipeline`, `etapa`) |
| `pipeline_mover` | autenticado | `licitacao_ids[]`, `etapa_id`, `motivo?` | `movidas`; etapa com `exige_motivo` sem motivo → 400 |
| `pipeline_remover` | autenticado | `licitacao_ids[]` | `removidas` |
| `pipeline_historico` | autenticado | `licitacao_id` | `eventos[]`, mais recente primeiro |
| `etapa_criar` | admin | `nome`, `fase`, `ordem?`, `desfecho?`, `exige_motivo?` | 201 `etapa`; nome repetido → 409 |
| `etapa_atualizar` | admin | `id` + campos | `etapa` |
| `etapa_excluir` | admin | `id`, `mover_para?` | `movidas`; com oportunidades e sem `mover_para` → 400; última etapa → 400 |

Fases: `prospeccao`, `proposta`, `disputa`, `conclusao`. Desfechos: `vencida`, `perdida`, `descartada`.

Concorrência: `pipeline_mover` e `pipeline_etapa_excluir` são serializadas por tenant (advisory lock da transação),
então chamadas simultâneas não travam entre si nem gravam histórico a partir de uma etapa desatualizada. Tenant novo
ganha as 13 etapas padrão pelo gatilho `tenants_pipeline_semear_etapas`.

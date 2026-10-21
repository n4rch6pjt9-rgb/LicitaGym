# api-pipeline

Pipeline comercial da equipe (Dashboard #29). Uma etapa por licitação, compartilhada pelo tenant, com histórico de
cada entrada, mudança e saída. Etapas configuráveis por admin; as 13 do Kanban são o padrão (migration
`20261006020000_pipeline_oportunidades`).

- `POST`, JWT do Supabase Auth no `Authorization` (validado no código; `verify_jwt = false` no `config.toml`).
- Banco com `service_role`; tabelas e funções fechadas para `anon`/`authenticated`.
- Tenant (`_shared/tenant.ts`): vínculo ativo em `tenant_membros` com empresa ativa. Vínculo só com empresa desativada, vínculo desligado ou conta sem vínculo → 403 (#263), sem cair em outra empresa. Só o desenvolvedor sem vínculo cai na única empresa ativa (papel nulo); com duas empresas ativas, 409.
- Papel: `etapa_*` e `etapas_reordenar` exigem admin da empresa (`tenant_membros.papel = 'admin'`) ou o desenvolvedor (`app_metadata.licitagym_role = 'admin'`). Operação lê e movimenta o pipeline, mas não configuram etapas (403).

| action | quem | corpo | resposta |
|---|---|---|---|
| `etapas_listar` | autenticado | — | `etapas[]` (`id`, `nome`, `fase`, `ordem`, `desfecho`, `exige_motivo`, `padrao`, `total`) e `versao` (texto; repassar como veio em `etapas_reordenar`), lidos no mesmo comando (`pipeline_etapas_listar`) |
| `pipeline_listar` | autenticado | `etapa_id?` | `itens[]` com `licitacao` (campos do card, inclusive `regulamento`) `tarefas_pendencia` (`{motivo, erro, em}` quando as tarefas da lei não puderam ser criadas, senão null) `tarefas_abertas` (número de tarefas da empresa em aberta/em_andamento; a lista fica na `api-tarefas`) e `preparacao` (último pedido da fila de Triagem: `status` pending/processing = "análise em preparação", completed com `resultado` ok/sem_documento/regulamento_nao_informado_pela_fonte, failed com `erro` curto (categoria, sem URL nem corpo HTTP); `erro` só vem fora de completed; null = sem pedido de preparação, por exemplo etapa "Triagem" renomeada), até 1000, mais recentes primeiro; `truncado` avisa se havia mais; `avisos[]` (`preparacao_indisponivel`, `tarefas_abertas_indisponivel`) lista o complemento que não pôde ser lido: o campo some dos itens, não vira null |
| `pipeline_estado` | autenticado | `licitacao_ids[]` (até 200) | `estado[]` (`licitacao_id`, `etapa_id`) só das que estão no pipeline |
| `pipeline_adicionar` | autenticado | `licitacao_ids[]` | entra na primeira etapa sem desfecho; quem já está não muda, de forma atômica (`adicionadas`, `ja_no_pipeline`, `etapa`) |
| `pipeline_mover` | autenticado | `licitacao_ids[]`, `etapa_id`, `motivo?` | `movidas`; etapa com `exige_motivo` sem motivo → 400 |
| `pipeline_remover` | autenticado | `licitacao_ids[]` | `removidas`. Apaga as tarefas da empresa naquela licitação. O histórico de etapas fica. Mudar de etapa não apaga tarefa. |
| `pipeline_historico` | autenticado | `licitacao_id` | `eventos[]`, mais recente primeiro |
| `etapa_criar` | admin da empresa ou desenvolvedor | `nome`, `fase`, `desfecho?`, `exige_motivo?` | 201 `etapa`, no fim da lista (maior `ordem` + 10, dentro do lock: `pipeline_etapa_criar`); nome repetido → 409; com `ordem` → 400 "Use etapas_reordenar para mudar a ordem." |
| `etapa_atualizar` | admin da empresa ou desenvolvedor | `id` + `nome?`, `fase?`, `desfecho?`, `exige_motivo?` | `etapa`; com `ordem` → 400 (mesma mensagem) |
| `etapas_reordenar` | admin da empresa ou desenvolvedor | `ids[]` (todas as etapas da empresa, na ordem nova; até 200), `versao` (a de `etapas_listar`) | `etapas[]` na ordem nova (`ordem` = posição × 10) e a `versao` nova. Lista mudou desde a leitura (reordenada, editada, etapa criada ou excluída) → 409 `codigo: "versao_desatualizada"`; só com a versão certa, id repetido, faltando ou de outra empresa → 400 `codigo: "lista_invalida"`. Nada é gravado em erro |
| `etapa_excluir` | admin da empresa ou desenvolvedor | `id`, `mover_para?` | `movidas`; com oportunidades e sem `mover_para` → 400; última etapa → 400 |
| `catalogo_listar` | autenticado | — | `tarefas[]` ativas do catálogo (`norma = LEI_14133_2021`; `codigo`, `fase_codigo`, `fase_nome`, `fase_ordem`, `parent_codigo`, `ordem`, `titulo`, `natureza`, `ator`, `prazo_unidade`, `base_legal` "art. N (dispositivo)" ou null), para escolher no modelo da etapa |
| `etapa_tarefas_listar` | autenticado | `etapa_id` | `tarefas[]` do modelo da etapa, ativas e desligadas (`origem`, `tarefa_codigo` ou `chave`/`titulo`/`descricao`/`prazo_horas`, `ordem`, `ativo`, `catalogo` com `ativo` do catálogo); etapa de outra empresa → 404 |
| `etapa_tarefas_salvar` | admin da empresa ou desenvolvedor | `etapa_id`, `tarefas[]` (lista completa: `{origem:"catalogo", tarefa_codigo}` ou `{origem:"empresa", chave?, titulo, descricao?, prazo_horas?}`) | `salvas` e o modelo atualizado. Upsert por código ou chave; o que sai da lista é desligado (nunca apagado); tarefa da empresa sem `chave` ganha `emp-` + 8 hex. Código inexistente ou inativo (que não estava no modelo), chave de outra etapa ou item inválido → 400, nada gravado; código que já estava no modelo e o catálogo desativou fica, desligado |
| `tarefas_reaplicar` | autenticado | `licitacao_id` | `criadas`, `existentes`, `bloqueio` (`regulamento_nao_informado` / `regulamento_sem_catalogo`); fora do pipeline → 404 |

Tarefas por etapa (spec 0018): entrar numa etapa cria as tarefas do modelo dela em `tarefas_equipe` (gatilho no banco),
na fila do admin; a lista e a atribuição ficam na `api-tarefas`. O card traz `licitacao.regulamento` (nulo: "tarefas da lei
pendentes" se o modelo da etapa, via `etapa_tarefas_listar`, tem tarefa do catálogo) e `tarefas_pendencia` (falha registrada
ao reaplicar).

Fases: `prospeccao`, `proposta`, `disputa`, `conclusao`. Desfechos: `vencida`, `perdida`, `descartada`.

Concorrência: `pipeline_mover`, `pipeline_etapa_excluir`, `pipeline_etapa_criar` e `pipeline_etapas_reordenar` são
serializadas por tenant (advisory lock da transação), então chamadas simultâneas não travam entre si nem gravam histórico
a partir de uma etapa desatualizada. A ordem das etapas só muda por `etapas_reordenar`, com controle otimista: a `versao`
(`pipeline_etapas_versao`, md5 de id, ordem e `updated_at` de todas as etapas) tem que ser a lida, senão 409 (spec 0034).
`etapa_atualizar` grava sem o lock, mas não mexe em `ordem`, e a edição muda a versão. Tenant novo
ganha as 13 etapas padrão pelo gatilho `tenants_pipeline_semear_etapas`.

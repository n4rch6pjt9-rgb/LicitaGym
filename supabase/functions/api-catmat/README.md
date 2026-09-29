# api-catmat

Árvore CATMAT (Compras.gov ao vivo, com cache) e catálogo CATMAT da empresa, usados pela tela `/catmat` do dashboard e pelo filtro Grupo → Classe → PDM → Item de `/oportunidades`.

Tabelas e funções: `supabase/migrations/20260930100000_catalogo_empresa_catmat.sql`.

## Autenticação e permissão

- Toda ação exige `Authorization: Bearer <JWT do usuário>`. Sem sessão, a resposta é `401`.
- Escrita (`catalogo_salvar`, `catalogo_remover`, `palavras_salvar`, `palavras_remover`) e `arvore` com `refresh: true` exigem `app_metadata.licitagym_role = 'admin'`. Sem o papel, a resposta é `403`. O `user_metadata` nunca é considerado.
- O banco é acessado com `service_role`. O JWT só identifica o usuário, e o `user.id` é gravado em `created_by`/`updated_by`.

## Ações (`POST` com JSON `{ "action": ... }`)

| action | Corpo | Retorno |
|---|---|---|
| `arvore` | `nivel` (`grupos`\|`classes`\|`pdms`\|`itens`), `codigo` (do pai; em `grupos`, o próprio grupo), `incluir_inativos?`, `refresh?` (admin) | `nos[]` com `estado` (`incluido`\|`excluido`\|`herdado`\|`excluido_herdado`\|`nenhum`), `regra_id`, `origem_nivel`; `fonte` (`memoria`\|`banco`\|`compras.gov`), `stale`, `inativos_ocultos` |
| `catalogo_listar` | — | `regras`, `resumo`, `opcoes` (`grupos`, `classes`, `pdms` com `palavras`, `itens`) para o filtro em cascata |
| `catalogo_salvar` | `nivel` (`grupo`\|`classe`\|`pdm`\|`item`), `codigo_grupo`, `codigo_classe`, `codigo_pdm`, `codigo_item` (conforme o nível), `incluido`, `observacao?` | `201` ao criar, `200` ao atualizar; `pdms_materializados`, `itens_hidratados` |
| `catalogo_remover` | `id` | a regra removida |
| `palavras_listar` | `codigo_pdm` | padrões do PDM |
| `palavras_salvar` | `codigo_pdm`, `padrao`, `ativo?`, `id?` (para editar) | o padrão |
| `palavras_remover` | `id` | — |

`nivel` em `arvore` pede os **filhos** do código informado: `classes` + `78` devolve 7810, 7820 e 7830; `pdms` + `7830`; `itens` + `7115`.

## Regras do catálogo

- **Herança:** registrar grupo, classe ou PDM inclui tudo abaixo. A regra do próprio nó vence a do ancestral.
- **Exclusão** (`incluido: false`) só é aceita num nó que herda de um ancestral incluído. Senão, a resposta é `409`. Para desfazer um registro, use `catalogo_remover`.
- **`catalogo_salvar`:**
  - valida o nó no Compras.gov (`404` se não existir);
  - grava grupo, classe e PDM em `catmat_grupos`, `catmat_classes` e `catmat_pdms` (sem `last_seen_sync_id`);
  - ao incluir grupo ou classe, materializa os PDMs descendentes;
  - em PDM ou item, hidrata `catmat_item_pdm`.
- **Padrões (`catmat_pdm_palavras`):**
  - regex do Postgres aplicada ao texto em minúsculas e sem acento (`lg_normalizar`), com até 300 caracteres;
  - validada com `catmat_regex_valido` (`400` se for inválida);
  - o PDM precisa estar em `catmat_pdms` (`409`).

## Compras.gov e cache

- Endpoints `modulo-material/1_` a `4_consultar*Material`, com `tamanhoPagina=500`, no máximo 20 páginas e 350 ms entre páginas.
- Limite de 8 s por chamada, 1 nova tentativa em 429 ou 5xx, e orçamento de 25 s por árvore.
- Cache em memória por isolate (10 min) e em `compras_catmat_cache` (24 h). Pedidos iguais simultâneos compartilham a mesma busca.
- Se o Compras.gov falhar: devolve o cache vencido com `stale: true`. Sem cache nenhum, responde `504`.
- O cache guarda ativos e inativos; `incluir_inativos` só filtra a resposta.

## Testes

`tests/supabase/functions/api_catmat_test.ts`, com repositório em memória e Compras.gov falso.

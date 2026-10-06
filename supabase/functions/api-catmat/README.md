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
| `catalogo_listar` | — | `regras`, `resumo` (inclui `pdms_sem_texto`: sem padrão e sem nó do dicionário), `opcoes` (`grupos`, `classes`, `pdms` com `palavras` e `nos_taxonomia`, `itens`) para o filtro em cascata |
| `catalogo_salvar` | `nivel` (`grupo`\|`classe`\|`pdm`\|`item`), `codigo_grupo`, `codigo_classe`, `codigo_pdm`, `codigo_item` (conforme o nível), `incluido`, `observacao?`, `a_partir_do_pdm?` | `201` ao criar, `200` ao atualizar; `pdms_materializados`, `itens_hidratados`, `proximo_codigo_pdm` (null quando o lote acabou) |
| `catalogo_remover` | `id` | a regra removida |
| `palavras_listar` | `codigo_pdm` | `palavras` (padrões do PDM com `tipo`: primeiro as inclusões, depois as exclusões) e `nos_taxonomia` (nós do dicionário de aparelhos e da taxonomia de pisos que apontam para o PDM, só leitura) |
| `palavras_salvar` | `codigo_pdm`, `padrao`, `ativo?`, `tipo` (`inclui`\|`exclui`; `exclui` = texto que casar não conta para o PDM; **obrigatório com `id`**, ao criar ausente = `inclui`), `id?` (para editar) | o padrão |
| `palavras_remover` | `id`, `tipo` (obrigatório) | — |
| `catalogo_itens` | `codigo_pdm` | `hidratado`, `itens[]` do banco (`catmat_item_pdm` + `catmat_item_atributo`): `descricao` completa, `nome_item` (cabeça), `atributos[]` (`ordem`, `atributo`, `valor`), `estado`/`regra_id`/`origem_nivel` |
| `catalogo_hidratar_itens` (admin) | `apos_pdm?` (cursor), `limite_pdms?` (1–20, padrão 8) | hidrata `catmat_item_pdm` e `catmat_item_atributo` dos PDMs do catálogo (efetivos + PDMs dos itens avulsos) em lotes: `total_pdms`, `processados[]` (`codigo_pdm`, `itens`, `atributos`), `proximo_pdm` (null = fim) |

Inclusões ficam em `catmat_pdm_palavras` e exclusões em `catmat_pdm_exclusoes` (migration `20260930120000_taxonomia_pisos.sql`). O `id` só é único dentro do tipo, por isso editar/remover sem `tipo` responde `400` (evita mexer na inclusão de mesmo id quando a intenção era a exclusão); para trocar o tipo de um padrão, remova e crie de novo. Exclusão não conta como cobertura de texto (`palavras` em `opcoes.pdms`, `pdms_sem_palavras`).

Em `arvore` com `nivel: itens`, cada nó traz também `nome_item` e `atributos` (quebra da descrição, `_shared/compras-gov/descricao-parser.ts`, igual a `catmat_atributos_da_descricao` da migration `20261004005000`). O `nome` do item é a descrição completa do Compras.gov, sem corte.

`nivel` em `arvore` pede os **filhos** do código informado: `classes` + `78` devolve 7810, 7820 e 7830; `pdms` + `7830`; `itens` + `7115`.

## Regras do catálogo

- **Herança:** registrar grupo, classe ou PDM inclui tudo abaixo. A regra do próprio nó vence a do ancestral.
- **Exclusão** (`incluido: false`) só é aceita num nó que herda de um ancestral incluído. Senão, a resposta é `409`. Para desfazer um registro, use `catalogo_remover`.
- **`catalogo_salvar`:**
  - valida o nó no Compras.gov (`404` se não existir);
  - grava grupo, classe e PDM em `catmat_grupos`, `catmat_classes` e `catmat_pdms` (sem `last_seen_sync_id`);
be-forte-ancorado-nucleo
  - ao incluir grupo ou classe, materializa os PDMs descendentes;
  - em PDM ou item, hidrata `catmat_item_pdm` e `catmat_item_atributo` (rpc `catmat_item_atributo_sincronizar`);
  - grupo/classe não hidratam itens (seriam dezenas de PDMs numa chamada): use `catalogo_hidratar_itens`.

  - grava a regra antes de hidratar. Grupo ou classe materializa no máximo 8 PDMs por chamada (`proximo_codigo_pdm` pede a continuação com `a_partir_do_pdm`); a árvore devolve ativos e inativos, com `status_item`;
  - em PDM ou item (e em cada PDM do lote de grupo/classe), hidrata `catmat_item_pdm` e `catmat_item_atributo` (rpc `catmat_item_atributo_sincronizar`);
  - para hidratar os itens de todos os PDMs do catálogo, use `catalogo_hidratar_itens`.
main
- **Padrões (`catmat_pdm_palavras`):**
  - regex do Postgres aplicada ao texto em minúsculas e sem acento (`lg_normalizar`), com até 300 caracteres;
  - validada com `catmat_regex_valido` (`400` se for inválida);
  - o PDM precisa estar em `catmat_pdms` (`409`).

## Compras.gov e cache

- Endpoints `modulo-material/1_` a `4_consultar*Material`, com `tamanhoPagina=100`, no máximo 20 páginas e 350 ms entre páginas.
- Limite de 8 s por chamada, 1 nova tentativa em 429 ou 5xx, e orçamento de 25 s por árvore.
- Cache em memória por isolate (10 min) e em `compras_catmat_cache` (24 h). Pedidos iguais simultâneos compartilham a mesma busca.
- Se o Compras.gov falhar: devolve o cache vencido com `stale: true`. Sem cache nenhum, responde `504`.
- `catalogo_salvar` não aceita a cópia vencida: se o Compras.gov estiver fora e só houver cache vencido, responde `503` sem gravar nada.
- Lista vazia (código sem filhos ou inexistente) não vai para o cache.
- A hierarquia gravada em `catmat_grupos/classes/pdms` não mexe em `data_atualizacao_origem` (é do `sync-compras-catmat`).
- Deploy: listada em `supabase/config.toml` com `verify_jwt = false` (a função valida o JWT e o papel no código) e no workflow `deploy-supabase-functions.yml`.
- O cache guarda ativos e inativos; `incluir_inativos` só filtra a resposta.

## Testes

`tests/supabase/functions/api_catmat_test.ts`, com repositório em memória e Compras.gov falso.

## Casamento por taxonomia

`taxonomia_no_pdm` (migration `20260930110000_taxonomia_no_pdm.sql`) liga o nó do dicionário de aparelhos (slug que os coletores gravam em `licitacao_itens.no_taxonomia`) ao PDM CATMAT. Com isso, `licitacoes_ids_por_catmat` casa também por `taxonomia` (item) e `taxonomia_objeto` (licitação). É o caminho do Sistema S, cujos portais não usam CATMAT, e reforça o PNCP. A carga acompanha o `dicionario-aparelhos-v0.3.json`, e o teste `tests/supabase/taxonomia_no_pdm_test.ts` garante isso.

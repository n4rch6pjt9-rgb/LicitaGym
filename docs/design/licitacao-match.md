# licitacao_match: casamento CATMAT por texto materializado

Migration: `supabase/migrations/20261002170000_licitacao_match_rpc_unica.sql`.
Verificação: `supabase/tests/licitacao_match_check.sql`.

## Por que

Depois da `20261002140000` (índices trgm + `lg_regex_ramos`), `licitacoes_ids_por_catmat(null,null,null,null,true)`
ainda levava em prod 7,0 s com cache quente, 11 s com cache frio e 8,3 s no `EXPLAIN (ANALYZE, BUFFERS)` de
02/10/2026. O plano era o mesmo do PG17 local, onde a chamada leva ~2 s: as mesmas linhas (3.098 casamentos,
1.103 licitações), os 36 ramos e ~575 candidatos do GIN por ramo, e todos os buffers em cache. A diferença
é CPU: a instância de prod roda o recheck da regex ~4-5x mais devagar (217 ms contra ~50 ms por ramo).
Mais de 90% do tempo vai para `por_texto_item`.

A Edge Function `api-dashboard-oportunidades` chamava a RPC uma vez por página de 1.000 linhas (`max_rows` do
PostgREST), 4 vezes no catálogo. O `statement_timeout` de 8 s é do role `authenticator` e vale por chamada, então
cada página ficava perto do limite.

Só juntar as chamadas não dá folga: uma chamada continua levando 7 a 8,3 s. A regex precisa sair do caminho da leitura.

## Desenho

| Objeto | Papel |
|---|---|
| `public.licitacao_match` | Uma linha por (item, PDM), com origem `texto_item`, e por (licitação, PDM), com origem `texto_objeto`. Regra igual à da RPC: um padrão ativo do PDM (`catmat_pdm_palavras`) casa `lg_normalizar(texto)` e nenhuma exclusão ativa do PDM (`catmat_pdm_exclusoes`) casa. FKs com `on delete cascade` para a licitação, o item e o PDM. |
| `public.licitacao_match_estado` | Uma linha. `carregado_em` fica null até o backfill. Enquanto for null, tudo fica **inerte**: os triggers não marcam, a drenagem não grava e a RPC usa o caminho ao vivo da `20261002140000` (fallback). O resultado e o tempo são os de hoje, só que numa chamada. |
| `public.licitacao_match_pendente` | Texto alterado que ainda não foi recalculado. `(origem, ref_id)`, onde `ref_id` é o id do item ou da licitação. |
| `licitacao_match_recalcular_pdms(int[])` | Recalcula PDMs inteiros (`null` recalcula todos) pelo caminho GIN, com um ramo por lateral. |
| `licitacao_match_atualizar(p_limite)` | Drena até `p_limite` pendências, as mais antigas primeiro, com `for update skip locked`. Põe o padrão no laço externo, o que mantém a regex compilada no cache de 32 regexes do backend. Devolve quantas pendências restam. |
| `licitacao_match_carregar()` | Backfill: trava as escritas de texto e de padrões, recalcula tudo, limpa as pendências e marca o estado. Só o owner executa. |
| `licitacoes_ids_por_catmat` | Mesma assinatura, `STABLE` e `SECURITY INVOKER`. Depois da carga, os ramos de texto leem `licitacao_match`; antes dela, usam o caminho ao vivo. O estado é um InitPlan, então o ramo que não vale não executa. O texto pendente fica fora do materializado e é casado ao vivo, então **o resultado não depende de a drenagem estar em dia**: só o tempo depende. |
| `licitacoes_ids_por_catmat_unica` | A mesma resolução numa linha só: `ids bigint[]` (distintos, em ordem crescente) e `matches jsonb`. A Edge Function chama esta função uma vez, sem paginação. |

Tudo fica restrito a `service_role`. O recálculo completo e a carga ficam só com o owner: tabelas com RLS e sem grant para `anon`/`authenticated`, e EXECUTE só para `service_role`.

## Quem atualiza (depois do backfill)

1. **Escrita de texto (coletores):** triggers de statement em `licitacao_itens` e `licitacoes_externas` só marcam
   a pendência quando a escrita é uma inserção ou muda `descricao`/`licitacao_id` ou `objeto`. Não rodam regex na escrita:
   uma licitação chega a 5.357 itens (p99 473), e a regex síncrona poderia estourar os 8 s do upsert.
2. **Drenagem (coletores):** `destino.Supabase` conta as linhas de texto gravadas (upsert em `licitacao_itens` ou
   `licitacoes_externas`, ou `atualizar` com `descricao`/`objeto`). A cada `LICITACAO_MATCH_LOTE` linhas (300 por padrão),
   chama `licitacao_match_atualizar` em lotes até zerar. Os coletores `pncp`, `paradigma` e `main` (SEST SENAT)
   chamam `drenar_licitacao_match(sb)` também no fim da execução. Uma falha na drenagem só gera um aviso no log e não
   interrompe a coleta.
3. **Padrões e exclusões (api-catmat, migrations):** um trigger recalcula na hora os PDMs tocados (antes e depois
   da alteração). Um PDM leva ~0,4 s no PG17 local, ~2 s estimados em prod.
4. **Mudança de `lg_normalizar`, `lg_regex_ramos` ou da regra de casamento:** a migration que fizer a mudança deve rodar
   `select public.licitacao_match_recalcular_pdms(null);`. Leva ~8 s no PG17 local, estimados em 30-40 s em prod.
5. **Nenhum cron nem job novo.** Se algum dia houver escrita de texto fora de `destino.Supabase`, quem escreve chama
   `select public.licitacao_match_atualizar(300)` até devolver 0. Até lá, a RPC continua correta, só fica mais lenta.

A marcação usa `on conflict ... do update`. Se uma drenagem estiver segurando a pendência, a escrita espera e remarca
depois; com `do nothing`, a drenagem poderia apagar a pendência tendo lido o texto antigo.

## Custos medidos (PG17 local, volume de prod copiado em 02/10/2026)

| | Antes (main 002110c) | Com licitacao_match |
|---|---|---|
| `licitacoes_ids_por_catmat(…, true)` | ~2,0 s | 14-37 ms |
| `licitacoes_ids_por_catmat_unica(…, true)` (uma chamada, tudo) | não existia (eram 4 páginas) | 22-48 ms |
| drenagem de 300 pendências | | 60-80 ms (1.000 pendências: ~190 ms) |
| fallback sem carga (`carregado_em` null) | ~2,0 s | 1,84-1,92 s (o mesmo caminho) |
| `licitacao_match_carregar()` (backfill) | | 7,9 s |
| RPC com 3.300 pendências não drenadas (pior caso) | | ~3,2 s |

Em prod, a parte da RPC que não lê `licitacao_match` (mapa CATMAT, itens alvo, código e taxonomia) levou 465 ms. Foi
um `select` read-only com a tabela de match trocada por um conjunto vazio. Com a leitura de ~13 mil linhas de
`licitacao_match` e o `jsonb_agg` de 3.098 casamentos, a estimativa é de **~0,6 s quente e 1-2 s frio**, numa chamada só.
Hoje são 4 chamadas de ~7 s.

Pendência acumulada custa ~1 s por 1.000 itens no PG17 local (~4-5 s em prod). Por isso a drenagem roda a cada 300 linhas,
e não só no fim da execução.

## Deploy

1. Aplicar a migration `20261002170000`. Ela só tem DDL e funções, sem carga, e levou 67 ms no local. O timestamp é
   posterior ao da `20261002160000` do #132, de que ela não depende: a ordem fica certa qualquer que seja a ordem de merge.
   O estado começa sem carga, então o dashboard segue no fallback.
2. Publicar a Edge Function `api-dashboard-oportunidades`. Ela passa a fazer uma chamada `licitacoes_ids_por_catmat_unica`
   no lugar de 4 páginas. Publicar também o coletor com a drenagem; antes da carga, a drenagem devolve 0 e não grava.
3. **Backfill, passo separado e com ok do Marcelo**, fora da janela dos coletores, no SQL editor:
   ```sql
   begin;
   set local statement_timeout = '10min';
   set local lock_timeout = '10s';
   select public.licitacao_match_carregar();
   commit;
   ```
   No local levou 7,9 s com o volume de prod; em prod a estimativa é 30-40 s. Durante a carga, as escritas nas
   4 tabelas esperam e as leituras seguem.
4. Voltar ao fallback, se preciso: `update public.licitacao_match_estado set carregado_em = null;`.
5. Conferir depois: `select count(*) from licitacao_match_pendente` deve ficar perto de 0 depois de cada execução de coletor.

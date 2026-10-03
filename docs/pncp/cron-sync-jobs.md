# Jobs pg_cron dos syncs (Edge Functions)

Migration: `supabase/migrations/20260930180000_cron_sync_jobs.sql`. Os jobs de CATMAT por classe foram substituídos em `supabase/migrations/20261004004000_cron_sync_catmat_catalogo.sql`. Horários em BRT (UTC-3); o `cron.timezone` do projeto é GMT, então as expressões do pg_cron estão em UTC.

## 2. Edge Functions que são jobs

Todas as `sync-*` e a `link-catmat-pca` autenticam com `validateCronAuth`: **`Authorization: Bearer <SYNC_CRON_SECRET>`**, comparado em tempo constante e com suporte a lista separada por vírgula. Estão com `verify_jwt = false` no `config.toml`. Não aceitam service_role nem JWT de usuário.

| Função | Parâmetros (body JSON) | Duração | API externa | Decisão |
|---|---|---|---|---|
| `sync-compras-catmat` | `modo: "catalogo"` (PDMs de `catalogo_catmat_pdms_efetivos()`), `incluir_inativos` (padrão false), `async`, `somente_retomada`. Par `codigo_grupo`+`codigo_classe` ainda existe e continua preso à lista fixa 78/7830 e 72/7220. `tamanhoPagina` 100 | por PDM; 41 PDMs no catálogo de 03/10/2026 | dadosabertos.compras.gov.br | **agendar** o modo catálogo, com job de retomada |
| `sync-pncp-pca` | `ano` (ano UTC corrente), `codigos_classificacao` (7830), `max_paginas` (100), `verificar_periodo`, `somente_verificacao`, `forcar`, `async` | p50 134 s; orçamento interno de 110 s, depois retoma | pncp.gov.br (consulta + search) | **agendar** com gate e `async` |
| `link-catmat-pca` | `limite` (500, máx. 1000), `offset`, `classe_catmat`, `limiar_similaridade` | até 27 s por lote de 500 | nenhuma (só banco) | **agendar** em lotes |
| `sync-pncp-orgaos` | nenhum | 21–27 s (191 CNPJs) | pncp.gov.br (integração) | **agendar** |
| `sync-pncp-legislation` | nenhum | 2 s | www.gov.br | **agendar** (semanal) |
| `sync-pncp-catalogo` | nenhum | não medido (nunca rodou) | pncp.gov.br (integração) | **agendar** (mensal) |
| `sync-pncp-contratacoes-editais/atas/contratos` | `data_inicial`, `data_final` (janela padrão de 2 dias), `modalidade`, `modo`, `usar_atualizacao`, `async` | 1–183 s | pncp.gov.br | **não agendar**: bloqueadas por `PNCP_NATIONAL_SYNC_ENABLED` (responde 423) e fora do escopo. As oportunidades vêm do coletor-externo. |
| `sync-pncp-irp` | `orgaos` | | | **não agendar**: gate `IRP_SYNC_ENABLED` (CLA-34) |
| `sync-comprasgov-consulta` | | | | **não agendar**: placeholder, os 77 endpoints não estão ligados |
| `import-catmat-curadoria` | JSON de curadoria | | | manual |
| `sync-pncp-contratacoes-itens`, `link-pca-edital` | `limite`, `edital_id` / `janela_dias`, `limite`, `dry_run` | até 127 s | | **não agendar**: publicadas, mas **não versionadas no repo**, e dependem de editais |

## 3. Plano de agendamento

Janela fora de pico: 02:00–06:00 BRT. Os minutos quebrados espalham a carga. O Brasil não tem horário de verão desde 2019, então BRT = UTC-3 o ano todo.

| # | Job | Chama | Quando (BRT) | pg_cron (UTC) | Body | Timeout pg_net | Por quê |
|---|---|---|---|---|---|---|---|
| 1 | `licitagym-sync-compras-catmat-catalogo` | `sync-compras-catmat` | dom 02:07 | `7 5 * * 0` | `{"modo":"catalogo","incluir_inativos":false,"async":true}` | 150 s | Espelho segue os PDMs efetivos, não a classe inteira. `async` devolve 202. `incluir_inativos: false` é explícito: só ativos. |
| 2 | `licitagym-sync-compras-catmat-catalogo-continuacao` | `sync-compras-catmat` | dom 02:27 | `27 5 * * 0` | `{"modo":"catalogo","incluir_inativos":false,"async":true,"somente_retomada":true}` | 150 s | Só continua um run `incompleta` do mesmo lock. Se a carga das 02:07 terminou, responde ignorado. |
| 3 | `licitagym-sync-pncp-pca` | `sync-pncp-pca` | diário 03:13 | `13 6 * * *` | `{"verificar_periodo":true,"async":true}` | 150 s | O PCA é a fonte da demanda. O gate de período pula a carga quando nada mudou. `async` devolve 202 e a carga roda em background. |
| 4 | `licitagym-sync-pncp-pca-continuacao` | `sync-pncp-pca` | diário 03:43 | `43 6 * * *` | igual ao 3 | 150 s | Retoma as páginas pendentes do lock `pca-sync:<ano>:7830` quando a 1ª execução esgota o orçamento de 110 s. Se estiver tudo em dia, devolve `ignorado`. |
| 5 | `licitagym-link-catmat-pca` | `link-catmat-pca` | diário 04:23 | `23 7 * * *` | `{"limite":500,"offset":N}`, N = 0, 500, … até o total de `pca_itens` (7 lotes para 3.331, calculado na hora) | 120 s | Liga PCA a CATMAT depois do PCA. Não chama API externa. Lote de 500 levou no máximo 27 s. |
| 6 | `licitagym-sync-pncp-orgaos` | `sync-pncp-orgaos` | diário 04:43 | `43 7 * * *` | `{}` | 150 s | Entidades e órgãos dos CNPJs dos planos PCA. Depende do PCA. Leva 21–27 s. |
| 7 | `licitagym-orgaos-classificar` | SQL: `fn_orgaos_uasgs_classificar()` | diário 05:03 | `3 8 * * *` | — | `statement_timeout` de 10 min | Classifica órgãos e UASGs na transação própria. Não espera o refresh da MV. |
| 7b | `licitagym-escopo-match` | SQL: `fn_escopo_match_atualizar()` | diário 05:18 | `18 8 * * *` | — | `statement_timeout` de 10 min | Sincroniza `escopo_item_calc` (só texto novo ou alterado), atualiza `mv_escopo_demanda` e grava `match_nivel`. Faixa livre 05:12–05:26, depois do pior caso da classificação. |
| 8 | `licitagym-sync-pncp-legislation` | `sync-pncp-legislation` | seg 05:27 | `27 8 * * 1` | `{}` | 60 s | Página de legislação, muda raramente. Leva 2 s. |
| 9 | `licitagym-sync-pncp-catalogo` | `sync-pncp-catalogo` | dia 1, 05:37 | `37 8 1 * *` | `{}` | 150 s | Categorias de item do PCA (tabela de referência, nunca carregada). |
| 10 | `licitagym-cron-respostas` | SQL: `private.cron_coletar_respostas()` | a cada hora, no minuto 11 | `11 * * * *` | — | — | Copia o status HTTP de `net._http_response`, que dura 6 h, para `private.cron_edge_chamadas`. |
| 11 | `licitagym-cron-limpeza` | SQL | dom 05:51 | `51 8 * * 0` | — | — | Apaga `cron.job_run_details` com mais de 30 dias e `private.cron_edge_chamadas` com mais de 90. |

Sobre o job 5: o `pg_net` dispara os 7 lotes do `link-catmat-pca` quase ao mesmo tempo. Não há risco de sobreposição, porque a função lê `pca_itens` ordenado por `id` com `range(offset, offset+499)` e cada lote cobre uma faixa diferente. Ela só usa o banco, sem API externa, e o total de lotes é recalculado a cada execução.

### Ordem de dependência

```
dom: compras-catmat catálogo (02:07) → retomada do catálogo (02:27)
diário: pca (03:13) → pca-continuacao (03:43) → link-catmat-pca (04:23) → orgaos (04:43) → classificar (05:03) → escopo (05:18)
independentes: legislation (seg 05:27), catalogo (dia 1 05:37), respostas (:11), limpeza (dom 05:51)
```

- `link-catmat-pca` precisa do catálogo CATMAT (domingo) e do PCA do dia. O vínculo e o sync de órgãos continuam na lista fixa de classes (7830 e 7220); o job de domingo não amplia esse escopo.
- `sync-pncp-orgaos` lê os CNPJs de `pca_planos`.
- As rotinas SQL usam órgãos, UASGs, PCA e licitações.
- Entre um passo e o seguinte há pelo menos 20 min, exceto classificação (05:03) e escopo (05:18): 15 min, mais que os 10 min de timeout da classificação. Cada job é idempotente; os syncs de Edge usam lock no `private.pncp_sync_run`.

## 4. Como cada job chama a função

A migration cria `private.cron_chamar_edge(job, funcao, corpo, timeout_ms)`. Só o dono (`postgres`, que é quem roda os jobs) tem EXECUTE. anon, authenticated, service_role e PUBLIC não têm. A cada execução do job, a função:

1. lê o token **no Vault, pelo nome**, dentro do próprio job:
   `select btrim(decrypted_secret) from vault.decrypted_secrets where name = 'sync_cron_secret'`;
2. se o segredo não existe ou está vazio, faz **`raise exception`** antes de qualquer `net.http_post`. O job fica `failed` em `cron.job_run_details` com a mensagem `Vault sem o segredo "sync_cron_secret"…` e **nenhuma requisição sai com token vazio**;
3. chama `net.http_post(url := 'https://ifaiagegyicjzlpskafh.supabase.co/functions/v1/<funcao>', body := <corpo>, headers := {"Authorization": "Bearer <token>", "Content-Type": "application/json"}, timeout_milliseconds := <timeout>)`;
4. grava `request_id`, job, função e corpo em `private.cron_edge_chamadas`, **sem o token**.

O valor do segredo não aparece na migration, no `cron.job.command` nem no log. Num branch de preview do Supabase não há segredo no Vault, então os jobs falham sem chamar produção.

## 5. Segredo no Vault

- **Nome:** `sync_cron_secret`. É o nome que a migration antiga e o `docs/design/acompanhamento-tarefas.md` já usavam.
- **Valor:** exatamente o mesmo do secret `SYNC_CRON_SECRET` das Edge Functions.

## 6. Timeouts

- **pg_net:**
  - 150 s nas funções síncronas: é o limite de parede da Edge, e passar disso vira 546/504 de qualquer jeito;
  - 120 s no `link-catmat-pca`;
  - 60 s na `legislation`;
  - o PCA usa `async`, responde 202 em segundos e segue em background com orçamento interno de 110 s.
- **pg_cron:** o job só enfileira a requisição (milissegundos). Os jobs SQL de classificação (05:03) e de escopo (05:18) rodam cada um com `set local statement_timeout = '10min'`, em transações separadas.
- **Concorrência:** `max_running_jobs = 32` sobra. Os locks do `pncp_sync_run` impedem duas execuções do mesmo sync: a segunda responde `already_running`.

## 7. Monitoramento de falhas

1. **O job rodou?** Aqui aparece, por exemplo, o segredo ausente:

   ```sql
   select j.jobname, d.status, d.start_time, left(d.return_message, 200) msg
     from cron.job_run_details d join cron.job j using (jobid)
    where j.jobname like 'licitagym-%' and d.start_time > now() - interval '2 days'
    order by d.start_time desc;
   ```

2. **Qual foi a resposta HTTP?** `status_code` ≠ 2xx, `timed_out` ou `erro`:

   ```sql
   -- últimas 6 h, direto do pg_net
   select c.job, r.status_code, r.timed_out, r.error_msg, left(r.content, 200), r.created
     from net._http_response r join private.cron_edge_chamadas c on c.request_id = r.id
    order by r.created desc;
   -- histórico (copiado de hora em hora pelo licitagym-cron-respostas)
   select job, funcao, chamado_em, status_code, timed_out, erro, left(resposta, 200)
     from private.cron_edge_chamadas
    where chamado_em > now() - interval '7 days'
      and (status_code is null or status_code not between 200 and 299 or timed_out or erro is not null)
    order by chamado_em desc;
   ```

3. **O sync terminou bem?** Olhar `status in ('falhou','concluida_com_erros')`, que é o que conta no caso das chamadas `async` (o HTTP devolve 202 antes do fim):

   ```sql
   select resource_type, status, iniciada_em, finalizada_em, total_erros, left(erro_principal, 200)
     from private.pncp_sync_run where iniciada_em > now() - interval '2 days' order by iniciada_em desc;
   ```

4. **Os dados estão frescos?** `max(last_synced_at)` de `pca_itens`, `entidades` e `catalogo_itens`, e `pg_matviews.ispopulated` de `mv_escopo_demanda`.

## 8. O que o Marcelo faz à mão (nesta ordem)

1. **Gerar um segredo forte** no próprio computador, por exemplo com `openssl rand -hex 32`. Não colar em chat, PR ou log.
2. **Gravar esse valor no secret das Edge Functions:** Dashboard → Edge Functions → Secrets → `SYNC_CRON_SECRET` → salvar. Ou, no terminal: `supabase secrets set SYNC_CRON_SECRET=<valor> --project-ref ifaiagegyicjzlpskafh`. As funções passam a usar o valor sem redeploy.
3. **Criar o segredo no Vault com o MESMO valor**, no SQL Editor:
   ```sql
   select vault.create_secret('<valor>', 'sync_cron_secret', 'Bearer dos jobs pg_cron das Edge Functions sync-*');
   ```
   Para trocar o valor depois: `select vault.update_secret(id, '<novo>') from vault.secrets where name = 'sync_cron_secret';`.
4. **Testar uma chamada** sem expor o valor, também no SQL Editor:
   ```sql
   select private.cron_chamar_edge('teste-manual', 'sync-pncp-legislation', '{}'::jsonb, 60000);
   ```
   Depois de uns segundos, `select status_code, left(content,200) from net._http_response order by id desc limit 1;` deve mostrar **200**. Se der 401, os valores dos passos 2 e 3 são diferentes.
5. **Atualizar o script local do PowerShell** com o novo valor, porque o antigo deixa de valer.
6. **Extensões:** não há nada a habilitar. `pg_cron`, `pg_net` e `supabase_vault` já estão instaladas.
7. **Ordem com o merge:** os passos 1–3 podem ser feitos antes ou depois do merge. Enquanto o segredo não existir, os jobs falham de forma visível e não chamam nada. O primeiro job útil depois do merge é o `licitagym-sync-pncp-pca`, às 03:13.


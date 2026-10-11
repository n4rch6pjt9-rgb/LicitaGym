# 0021: Sondar a disponibilidade das APIs do PNCP e não travar sync quando a fonte cai

- **Status:** rascunho
- **Issue:** #328 (relacionadas: #321, #289, #245)
- **Área:** edge-functions (nova `sonda-pncp`; `sync-pncp-orgaos`, `sync-pncp-pca`), migrations (tabela, saúde, cron),
  pncp (`_shared/http-client/unified-client.ts`)
- **Depende do ok do Marcelo:** sim. Há migration, cron novo, verificação nova na saúde e mudança de comportamento
  em dois syncs de produção.

## Problema

Quando o PNCP cai, a saúde (`private.saude_operacional_resumo`) acusa "sync falhou" ou "heartbeat parado", mas não diz
que a causa é a fonte. Os syncs também não percebem a queda: ficam presos em `executando` até alguém encerrar à mão.

**Evidência de 11/10/2026 (consultas somente leitura e `curl` desta máquina):**

- **A integração do PNCP não respondeu o dia todo:**
  - `GET pncp.gov.br/api/pncp/v1/orgaos/{cnpj}` e `/orgaos/{cnpj}/pca/{ano}/{seq}/itens` conectam em cerca de
    0,07 s e não respondem (timeout de 25 a 60 s), de 18:20 a 19:35 UTC;
  - `pncp.gov.br/pncp-api/v1/modalidades` devolve 503 "No server is available to handle this request.";
  - a consulta `/api/consulta/v1/pca/` respondeu 200, em 5,9 a 23 s;
  - o `treina.pncp.gov.br` respondeu 200 em 0,2 s.
- **O monitor externo statuslicitacoes.com.br** (`status.json` gerado às 19:38 UTC):
  - Portal PNCP `DOWN` desde 18:56 UTC;
  - API de consulta `DOWN` desde 19:33 UTC (`consulta_proposta` DOWN; `consulta_pca` entre SLOW e OK);
  - ele não monitora a integração (`/api/pncp/v1`), que é a que os nossos syncs usam.
- **`sync-pncp-orgaos` (#328):**
  - a run do cron das 07:43 UTC ficou `executando` sem heartbeat até ser encerrada à mão às 14:30 UTC;
  - a run do teste manual das 18:16 UTC fez 2 requisições, as 2 deram `The operation was aborted due to timeout` e a
    run ficou presa em `executando`.
- **`private.pncp_sync_request` em 11/10 até 19:00 UTC:** 175 linhas, 4 com timeout e 15 com 5xx. O volume normal
  nos dias anteriores era de 2 a 12 por dia (de 01/10 a 09/10); em 10/10 foram 225, todas do `sync-pncp-orgaos`.
- **`sync-pncp-pca`, de 27/09 a 11/10:**
  - 7 runs `falhou` por lock vencido ou sem heartbeat;
  - 1 `falhou` com `HTTP 429 on pncp.gov.br` (11/10, 06:13 UTC);
  - 1 `incompleta` por `BUDGET_EXHAUSTED` (fluxo da fila, 11/10, 18:51 UTC: a descoberta parou na página 9 com a
    consulta lenta).

Hoje não existe sonda das APIs do PNCP gravada no banco. O `sync-pncp-pca` tem um probe de período
(`pca-probe:<ano>`) que usa só a `api/search` e não alimenta a saúde. O `private.http_host_lease` registra
`cooldown_until` quando recebe 429, mas não registra timeout nem 5xx.

## Abordagem proposta

1. **Sonda: Edge Function `sonda-pncp`, chamada pelo pg_cron a cada 15 min.**
   - Autenticação pelo cron secret, como os `sync-*`.
   - Faz um GET leve por componente, em sequência, cada um com timeout próprio. Proposta: 15 s.

   | Componente | Requisição (proposta) |
   |---|---|
   | `pncp_consulta_pca` | `/api/consulta/v1/pca/?anoPca=<ano>&codigoClassificacaoSuperior=7830&pagina=1&tamanhoPagina=10` |
   | `pncp_integracao` | `/api/pncp/v1/orgaos/<cnpj fixo de órgão público>` |
   | `pncp_integracao_pca_itens` | `/api/pncp/v1/orgaos/<cnpj>/pca/<ano>/<seq>/itens?pagina=1&tamanhoPagina=1` |
   | `pncp_api_v1` | `/pncp-api/v1/modalidades` |
   | `treina` | ver pergunta 2 |

   - Cada requisição pede a vaga no `private.acquire_http_slot('pncp.gov.br')` antes de sair. Se o host estiver em
     cooldown, grava `nao_sondado`, que não conta como DOWN, e não faz a requisição.
   - Um 429 chama `private.report_http_rate_limit`, como já faz o `UnifiedHttpClient`.
2. **Classificação**, no padrão OK / SLOW / DOWN do statuslicitacoes:
   - `DOWN`: timeout, erro de conexão ou HTTP 5xx;
   - `SLOW`: HTTP 2xx com latência acima do limiar do componente (proposta: 5 s para a integração, 10 s para a
     consulta);
   - `OK`: HTTP 2xx abaixo do limiar. **Um `204 No Content` também é `OK`:** a API respondeu "sem resultado" e não
     está fora;
   - `LIMITADO`: 429;
   - `ERRO_SONDA`: HTTP 400 ou 422. É um erro permanente de parâmetro (data fora do formato `yyyyMMdd`, `pagina`
     ausente, `tamanhoPagina` acima do limite). Indica defeito da sonda, não queda do PNCP, e **não conta como DOWN**.
     Só entra na saúde como atenção ("sonda mal configurada");
   - `nao_sondado`: o lease negou a vaga.

   **Referência de classificação:** o monitor statuslicitacoes.com.br/api-pncp, consultado em 11/10/2026:
   - ele trata a API e o Portal como infraestruturas separadas, que caem de forma independente;
   - ele usa a classificação OK / SLOW / DOWN por latência;
   - ele recomenda que 204 não seja tratado como erro e que 400 e 422 sejam permanentes, sem nova tentativa.

   Esse monitor não cobre a integração (`/api/pncp/v1`) e não é fonte de dado deste projeto.

   Os limiares ficam numa tabela de configuração, editável sem deploy, como a `saude_limiares`.
3. **Gravação:** tabela nova `private.fonte_disponibilidade_sonda`, com uma linha por componente por sonda. Colunas:
   `componente`, `status`, `http_status`, `latencia_ms`, `erro` (texto curto, sem corpo da resposta) e `sondado_em`.
   Retenção: ver pergunta 4.
4. **Leitura:** função `private.fonte_disponibilidade(p_componente text)`, que devolve:
   - o status atual (o da última sonda);
   - desde quando está nesse status;
   - quantas sondas seguidas estão em `DOWN`.

   Uma sonda com mais de 45 min conta como "sem dado", não como OK.
5. **Saúde:** duas verificações novas em `private.saude_limiares` e no `saude_operacional_resumo`:
   - `pncp_integracao_indisponivel_min`: minutos seguidos em DOWN da integração. Proposta: atenção 30, crítico 120,
     `sem_dado = atencao`;
   - `pncp_consulta_indisponivel_min`: o mesmo para a consulta.

   A `api-saude` e o workflow `saude.yml` passam a mostrar a causa quando a fonte está fora.
6. **Syncs consultam a sonda antes de começar.** Quando o componente de que dependem está `DOWN` em 2 sondas
   seguidas:
   - **`sync-pncp-orgaos`** (integração): não faz requisição. Encerra a run com o status da pergunta 1 e
     `erro_principal = 'fonte_indisponivel: pncp_integracao DOWN desde <ts>'`, com `finalizada_em` preenchido e o lock
     liberado.
   - **`sync-pncp-pca`, fluxo da fila (#294):**
     - consulta fora: não roda a descoberta;
     - integração fora: não reserva planos na fase B, e eles ficam `pendente` sem gastar tentativa;
     - o resto do trabalho segue.
   - Durante a run, 3 timeouts ou 5xx seguidos no mesmo host interrompem o laço (disjuntor da #328) e encerram a run
     da mesma forma.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um `fetch` falso que devolve 200 em 1 s, 200 em 8 s, 204 em 1 s, 503, timeout, 429 e 422, **quando** a `sonda-pncp` classifica cada resposta, **então** grava, respectivamente, `OK`, `SLOW`, `OK`, `DOWN`, `DOWN`, `LIMITADO` e `ERRO_SONDA`, com `http_status` e `latencia_ms`. O 429 também chama `report_http_rate_limit`. O 422 não chama, não tenta de novo e não conta para `pncp_*_indisponivel_min`. | Deno `tests/supabase/functions/sonda_pncp_test.ts` |
| CA-2 | **Dado** um lease que nega a vaga (`allowed: false, reason: 'cooldown'`), **quando** a sonda roda, **então** nenhuma requisição sai e o componente fica gravado como `nao_sondado`, não como `DOWN`. | idem |
| CA-3 | **Dado** uma chamada à `sonda-pncp` sem o cron secret, ou com JWT de `authenticated`, **então** responde 401 e não grava nada. | idem |
| CA-4 | **Dado** sondas de `pncp_integracao` em `DOWN` há 130 min seguidos, **quando** se lê `saude_operacional_resumo()`, **então** `pncp_integracao_indisponivel_min` sai `critico` com valor ≥ 120. **Dado** a última sonda `OK`, **então** sai `ok`. **Dado** nenhuma sonda há mais de 45 min, **então** sai `atencao` (sem dado). | SQL `supabase/tests/fonte_disponibilidade_check.sql` |
| CA-5 | **Regressão #328.** **Dado** a integração em `DOWN` em 2 sondas seguidas, **quando** o `sync-pncp-orgaos` é chamado, **então** não faz nenhuma requisição ao PNCP, e a run termina com `finalizada_em` não nulo, `erro_principal` começando com `fonte_indisponivel:` e o lock `orgaos-sync` liberado. Nunca termina em `executando`. | Deno `tests/supabase/functions/sync_pncp_orgaos_fonte_test.ts` |
| CA-6 | **Regressão #328 (disjuntor).** **Dado** uma sonda `OK`, mas um cliente falso que dá timeout em toda chamada, **quando** o `sync-pncp-orgaos` roda, **então** para depois de 3 falhas seguidas, com no máximo 3 requisições, e encerra a run como no CA-5. | idem |
| CA-7 | **Dado** a consulta `OK` e a integração `DOWN`, **quando** o `sync-pncp-pca` roda com `rotina: incremental`, **então** a descoberta roda, nenhum plano é reservado, os planos da fila continuam `pendente` com `tentativas` igual e nenhum item é inativado. | Deno `tests/supabase/functions/sync_pncp_pca_fonte_test.ts` |
| CA-8 | **Dado** os papéis `anon` e `authenticated`, **então** não leem nem escrevem `private.fonte_disponibilidade_sonda`, nem executam `private.fonte_disponibilidade`. Só `service_role` tem acesso. | SQL `supabase/tests/fonte_disponibilidade_check.sql` |

## Fora de escopo

- **Painel no Dashboard ou página de status pública.** A saúde já aparece pela `api-saude` e pela issue
  `alerta-operacional`.
- **Sondar o Compras.gov e o Paradigma.** O desenho aceita outros componentes, mas esta spec cobre só o PNCP.
- **Consumir o statuslicitacoes.com.br.** É terceiro, sem contrato de API e sem cobertura da integração; fica só como
  referência de classificação.
- **Reprocessar automaticamente quando a fonte volta.** Os crons e o cron de continuação já fazem isso.
- **Mostrar a última resposta válida durante a queda**, com o dado do banco marcado com a data da coleta, em vez de
  "(0)". Está na #334. Ela pode ler a `fonte_disponibilidade()` desta spec para explicar o motivo ao usuário.
- **Outros `sync-*`** (contratações, editais): a mesma checagem pode entrar depois, com issue própria.

## Impacto em dados

- **Migration:** sim, aditiva e idempotente.
  - `<ts>_fonte_disponibilidade.sql`: tabela, índice por `(componente, sondado_em desc)`, a função de leitura, a
    tabela de limiares de latência e o seed dos componentes;
  - `<ts>_saude_fonte_disponibilidade.sql`: os 2 limiares e a recriação de `saude_operacional_resumo`, igual à de
    produção mais os blocos novos;
  - `<ts>_cron_sonda_pncp.sql`: cron a cada 15 min via `private.cron_chamar_edge`;
  - pergunta 1: se o status `adiada` entrar, o `pncp_sync_run_status_check` é recriado. É uma mudança de constraint,
    feita com drop e add na mesma transação.
- **Tabelas, views e funções tocadas:**
  - `private.fonte_disponibilidade_sonda`: nova; a `sonda-pncp` escreve e os syncs e a saúde leem;
  - `private.fonte_disponibilidade()`: nova;
  - `private.saude_limiares` e `private.saude_operacional_resumo()`: alteradas;
  - `private.pncp_sync_run`: só pela pergunta 1;
  - `private.http_host_lease`: só uso, sem mudança de schema.
- **ACL/RLS:** tabela nova em `private`, com RLS ligada, `revoke all` de `anon`, `authenticated` e `PUBLIC`, e acesso
  só para `service_role`. A função nova é `security definer`, com `search_path` fixo e `execute` só para
  `service_role`.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas, como sempre.
  - nova: `sonda-pncp`;
  - mudam: `sync-pncp-orgaos`, `sync-pncp-pca` e `api-saude` (verificações novas).
- **Requisições ao PNCP:** 4 ou 5 a cada 15 min, cerca de 400 a 500 por dia, dentro do 1 req/s do lease. Ver
  pergunta 3.
- **Contrato com o Dashboard:** inalterado. A `api-saude` ganha 2 verificações no mesmo formato.
- **Dado oficial x derivado:** a sonda grava só o que mediu (código HTTP, latência, erro). OK, SLOW e DOWN são
  classificações calculadas por limiar configurável. Nenhum dado de licitação é gravado.

## Perguntas em aberto

1. **Status da run adiada:** criar `adiada` no `pncp_sync_run_status_check`, o que muda a constraint, ou usar
   `cancelada` com `erro_principal = 'fonte_indisponivel: ...'`? Isso afeta `pncp_sync_falhas_24h` e
   `pncp_sync_dias_sem_sucesso`, que hoje contam `falhou`.
2. **Treina:** sondar o `treina.pncp.gov.br`? Em 11/10 ele respondia enquanto a produção estava fora. Serve para
   separar "PNCP fora" de "nossa rede fora", mas são mais requisições a um ambiente que você decidiu usar só para
   contrato.
3. **Frequência e orçamento:** 15 min (cerca de 480 requisições por dia) está bom? Ou 30 min, com a sonda chamada
   também sob demanda pelo sync antes de começar?
4. **Retenção** da `fonte_disponibilidade_sonda`: 30 dias, com limpeza no próprio cron, ou guardar para medir o SLA do
   PNCP por mês?
5. **Quem identifica o plano de referência** da sonda de itens: um plano fixo (por exemplo o do Galeão,
   `00394429000100`, sequencial 4 de 2026) ou o plano mais recente da `pca_plano_fila`? Um plano fixo pode sair da
   fonte no ano seguinte.
6. **A `pncp_sync_dias_sem_sucesso` deve ficar em silêncio** enquanto a fonte estiver DOWN, para não abrir dois
   alertas pela mesma causa?

# 0064: Coletar o Sistema S por portal e em camadas (descoberta → fila → carga)

- **Status:** em implementação (13/11/2026; aprovada em 13/11/2026)
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades: licitações do Sistema S). Regra de foco
  suspensa desde 11/11/2026. Substitui o K-6 retirado da spec 0063 (disparo do `sesc_senac_rs` por `pg_cron`).
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** coletor | migrations | workflow GitHub Actions | observabilidade
- **Depende do ok do Marcelo:** sim (migration com tabela e RPCs novas, mudança no agendamento da coleta de produção)

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template. Específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `docs/produto/ESCOPO.md` (módulo 1) | o que a spec alimenta |
| 5 | `specs/0063-coleta-externa-run-orfao.md` | fechamento de run órfão, saúde da coleta e o K-6 que esta spec substitui |
| 7 | `.claude/rules/pncp.md` (seção "Discovery ≠ Hydration", checkpoint, reconciliação), `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | padrão de camadas e de migration |
| 8 | `services/coletor-externo/coletor/paradigma.py` (`coletar`, `processar_processo`, `paginar_intervalo`, `RegistroColeta`, `main`) | hoje a descoberta (listar por termo) e a carga (detalhe, itens, ranking, lances, fórum) rodam no mesmo laço, sem checkpoint |
| 8 | `services/coletor-externo/README.md` (Sistema S / Paradigma) | como o coletor roda hoje |
| 8 | `.github/workflows/coletor-sistema-s.yml` | lote agendado, matriz de 3 vagas, `timeout 70m` + SIGTERM, fontes fora do lote |
| 8 | `supabase/migrations/20261011100000_pca_plano_fila.sql` e `supabase/functions/_shared/pncp/pca-fila.ts` | padrão de fila com `status`, `tentativas`, `erro`, reserva e devolução usado no PCA |
| 8 | `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql`, `supabase/migrations/20261108170000_coleta_externa_run_rpc.sql` | `coleta_externa_run` (CHECK de `modo`) e RPCs de registro |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-codigo.md`, `.claude/agents/revisor-seguranca.md` | procedimento de cada etapa |

## Problema

Medido em 13/11/2026 pelos jobs do GitHub Actions da coleta agendada de 12/11 (run 43271946803, `--paginas 3`):

| Faixa | Portais (duração do job) |
|---|---|
| até 7 min | `sescdn` 1 · `findes` 1,6 · `sescrj` 4 · `fiems` 4 · `sfiec` 6,5 · `sescsp` 7 |
| 10 a 40 min | `sestsenat` 10 · `sescba` 17,5 · `fiesc` 19 · `firjan` 39 |
| acima de 50 min | `fieb` 54,5 · `sesc_senac_rs` cancelado aos 60 min |

- O `sesc_senac_rs` nunca concluiu no runner: 14 jobs cancelados por tempo em 15 dias (comentário do
  `coletor-sistema-s.yml`, 12/11) e o disparo manual de 12/11 (run 43292439869) foi cancelado aos 63 min, gravando
  licitações até o fim. O `fieb` está a menos de 16 min do limite interno de 70 min.
- `coletar` lista todos os termos e depois processa todos os processos no mesmo processo Python, sem checkpoint:
  interrompido, o próximo job recomeça do zero e refaz os processos já hidratados.
- A matriz do workflow tem 3 vagas; um portal longo segura uma vaga por quase 1 h.
- Medido em `private.coleta_externa_run`, últimos 15 dias, 4 execuções por fonte (consulta do Marcelo em 13/11/2026):

  | Fonte | Min. médio | Listados (máx.) | Processos hidratados (média) | No escopo (média) | Seg. por processo* |
  |---|---|---|---|---|---|
  | `fieb` | 55,0 | 367 | 334 | 133 | 9,9 |
  | `firjan` | 39,4 | 267 | 151 | 80 | 15,7 |
  | `fiesc` | 20,7 | 171 | 143 | 56 | 8,7 |
  | `sescba` | 17,5 | 100 | 93 | 55 | 11,3 |
  | `sestsenat` | 10,3 | 28 | 25 | 9 | 24,7 |
  | `sescsp` | 6,7 | 38 | 37 | 22 | 10,9 |
  | `sfiec` | 6,5 | 8 | 7 | 3 | 55,7 |
  | `fiems` | 4,3 | 13 | 12 | 6 | 21,5 |
  | `sescrj` | 3,7 | 15 | 3 | 3 | 74,0 |
  | `findes` | 1,5 | 10 | 10 | 5 | 9,0 |
  | `sescdn` | 0,6 | 3 | 1 | 1 | 36,0 |
  | `sesc_senac_rs` | 1393,6** | 0 | 0 | 0 | — |

  \* minutos × 60 ÷ processos hidratados; inclui o tempo da listagem por termo, por isso fica alto nos portais
  pequenos. \** as 4 linhas são execuções órfãs fechadas pela regra de 6 h, com contadores zerados: a duração e o
  volume reais do RS não estão medidos.
- O tempo cresce com os processos hidratados, e **toda execução hidrata de novo tudo o que listou** (`fieb`: 334 de
  367), mesmo o que não mudou desde a véspera. Quantos processos mudam de um dia para o outro: não medido.
- Pacote externo analisado em 13/11 (`nexor-portal-paradigma.zip`, Sesc BA): o mural comum (`PesquisarProcessos`,
  sem termo) lista 30.865 processos de 2000 a 2026 em cerca de 90 s; o detalhe leva cerca de 0,3 s por processo
  (números do LEIAME do pacote, não reproduzidos aqui). O coletor atual busca por termo e pode não ver processo cujo
  objeto não tenha o termo.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `private.coleta_externa_fila`: `fonte` (FK `fontes_externas.slug`), `n_cd_origem`, `modulo`, `listagem jsonb` (linha da listagem como veio), `hash_listagem`, `status` (`pendente`, `processando`, `feito`, `erro`), `tentativas`, `erro`, `descoberto_em`, `atualizado_em`, `processado_em`; único por (`fonte`, `n_cd_origem`, `modulo`); RLS ligada, sem policy | — | — | — | só via RPC |
| K-2 | RPC `public.coleta_externa_fila_enfileirar(p_fonte, p_itens jsonb)`: insere novos como `pendente`; existente volta a `pendente` (zerando `tentativas`) se o `hash_listagem` mudou ou se está em `leads`/`monitorar` sem processamento há mais de 24 h; devolve contagem (novos, reabertos, inalterados) | fonte, lista de {nCdOrigem, módulo, listagem} | jsonb de contagens | `22004` fonte nula | `service_role` |
| K-3 | RPC `public.coleta_externa_fila_reservar(p_fonte, p_limite)` (marca `processando`, `for update skip locked`, devolve os itens; `processando` há mais de 2 h volta a `pendente`) e `public.coleta_externa_fila_marcar(p_id, p_ok, p_erro)` (`feito`, ou `erro` com `tentativas + 1`; volta a `pendente` enquanto `tentativas < 5`) | fonte, limite / id, ok, erro | itens / boolean | `22023` id inexistente | `service_role` |
| K-4 | Coletor: `--etapa descoberta` lista o mural comum inteiro (`PesquisarProcessos` sem termo) filtrado pelas situações "Em proposta", "Em andamento" e "Finalizado" e por início nos últimos 24 meses, calcula o `hash_listagem` (objeto, situação, datas inicial/final/encerramento, valores estimado/negociado) e chama K-2, sem hidratar; usa o `PortalParadigma` atual (`DELAY_SEGUNDOS`, `Retry-After`, recusa em 401/403) | fonte, termos ou situações, `--paginas` | contagens no log e em `coleta_externa_run` | erro de página = execução `falhou`/`incompleta`, nunca lista vazia | coletor |
| K-5 | Coletor: `--etapa carga --orcamento-minutos N` reserva lotes (K-3), roda `processar_processo` em cada item e para limpo quando o orçamento acaba, devolvendo o que não processou; termina `incompleta` se sobrou fila, `concluida`/`concluida_com_erros` se esvaziou | fonte, orçamento | contagens e log de progresso por processo | erro de um processo marca só aquele item | coletor |
| K-6 | `--etapa completa` (padrão): descoberta + carga no mesmo job; comportamento atual preservado para os portais rápidos | igual ao atual | igual ao atual | — | coletor |
| K-7 | `coleta_externa_run.modo` aceita `descoberta` e `carga` (CHECK da tabela e `modo_registro`) | — | — | — | migration |
| K-8 | Workflow: todos os portais passam a descoberta + carga (a carga só hidrata o que a fila marcou); grupos pela medição acima: **pequenos** (`sescdn`, `findes`, `sescrj`, `fiems`, `sfiec`, `sescsp`, `sestsenat`: até 40 processos) em sequência num job; **médios** (`sescba`, `fiesc`, `firjan`) um job cada; **grandes** (`fieb`, `sesc_senac_rs`) descoberta num job e carga a cada 2 h (orçamento de 60 min), cada um dentro dos 70 min | — | — | — | workflow (sem `uses:`) |
| K-9 | Saúde: `coleta_externa_fila_pendente_horas` (idade do `pendente` mais antigo entre fontes ativas do Paradigma) e entrada em `SAUDE_VERIFICACOES_ESPERADAS` | — | linha na `saude_operacional_resumo()` | — | quem já lê a saúde |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-2 | **Dado** a fila vazia, **quando** enfileiro 3 processos e depois os mesmos 3 com um `listagem` alterado, **então** a primeira chamada devolve 3 novos e a segunda 1 reaberto e 2 inalterados; nenhuma linha duplicada (idempotência). | SQL `supabase/tests/coleta_externa_fila_check.sql` |
| CA-2 | K-3 | **Dado** 5 pendentes, **quando** duas sessões reservam com limite 3 ao mesmo tempo, **então** nenhum item sai nas duas (`skip locked`) e o total reservado é 5. | SQL `supabase/tests/coleta_externa_fila_check.sql` |
| CA-3 | K-3 | **Dado** um item que falhou 5 vezes, **quando** é marcado com erro de novo, **então** fica `erro` e não volta a `pendente`; com 4 falhas, volta a `pendente`. | SQL `supabase/tests/coleta_externa_fila_check.sql` |
| CA-4 | K-1, K-2, K-3 | **Dado** os papéis `anon` e `authenticated`, **quando** se consulta `has_function_privilege` nas três RPCs e `has_table_privilege` na tabela, **então** é `false` (negativo de acesso); `service_role` só tem EXECUTE nas RPCs. | SQL `supabase/tests/coleta_externa_fila_check.sql` |
| CA-5 | K-4 | **Dado** um mural falso com 6 processos (4 nas situações aceitas e nos últimos 24 meses, 1 de 2019, 1 "Cancelado"), **quando** roda `--etapa descoberta`, **então** chama `coleta_externa_fila_enfileirar` só com os 4 e não chama `detalhes`; com a página 2 do mural falhando, a execução não termina `concluida`. | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-6 | K-5 | **Dado** 10 itens reservados e um relógio falso que esgota o orçamento após 4, **quando** roda `--etapa carga`, **então** marca 4 `feito`, devolve 6 a `pendente` e registra `incompleta`; sem chamada a API real. | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-7 | K-5, K-6 | **Dado** a coleta interrompida por SIGTERM no meio da carga, **quando** o próximo job roda, **então** não reprocessa os itens já `feito` (regressão: hoje recomeça do zero). | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-8 | K-7 | **Dado** a migration aplicada, **quando** `coleta_externa_iniciar` abre execução com modo `carga`, **então** aceita; com modo inventado, a CHECK recusa. | SQL `supabase/tests/coleta_externa_run_rpc_check.sql` |
| CA-9 | K-9 | **Dado** um `pendente` de fonte ativa do Paradigma com 30 h, **quando** se lê a saúde, **então** `coleta_externa_fila_pendente_horas` ≥ 30 com status pelos limiares; fila vazia = 0 e `ok`; a `api-saude` lista a verificação. | SQL `supabase/tests/saude_coleta_externa_fila_check.sql` + Deno `tests/supabase/functions/api_saude_test.ts` |

### Cobertura (implementação, 13/11/2026)

| CA | Teste |
|---|---|
| CA-1 | `supabase/tests/coleta_externa_fila_check.sql` (bloco CA-1: 3 novos; 0/1/2; sem duplicar; feito com hash novo reabre zerando tentativas; revisita de `leads` após 24 h; `historico` não reabre) |
| CA-2 | `supabase/tests/coleta_externa_fila_check.sql` (bloco CA-2: reservas 3 + 2 disjuntas; `for update skip locked` na definição; `processando` > 2 h volta). Duas sessões simultâneas não cabem num check de transação única: a concorrência real é garantida pelo `skip locked`, não exercitada |
| CA-3 | `supabase/tests/coleta_externa_fila_check.sql` (bloco CA-3: 4 falhas → pendente; 5 → erro; ok → feito; id inexistente → 22023) |
| CA-4 | `supabase/tests/coleta_externa_fila_check.sql` (bloco CA-4: `anon`/`authenticated` sem tabela nem RPC; `service_role` só EXECUTE; RLS sem policy; definer com `search_path`) |
| CA-5 | `services/coletor-externo/tests/test_paradigma.py::test_ca5_*` (4 testes) |
| CA-6 | `services/coletor-externo/tests/test_paradigma.py::test_ca6_*` (2 testes) |
| CA-7 | `services/coletor-externo/tests/test_paradigma.py::test_ca7_sigterm_na_carga_nao_reprocessa_o_que_ficou_feito` |
| CA-8 | `supabase/tests/coleta_externa_run_rpc_check.sql` (bloco "Spec 0064, CA-8") |
| CA-9 | `supabase/tests/saude_coleta_externa_fila_check.sql` + `tests/supabase/functions/api_saude_test.ts` ("CA-9: …") |
| K-8 | `services/coletor-externo/tests/test_ci_coletor_sistema_s.py::test_k8_grupos_por_tamanho_e_grandes_em_camadas` (execução real fica para depois do merge: o PR não dispara o workflow em produção) |

Achado na fonte viva (13/11/2026, `sescdn` e `sescba`, 1 consulta cada): a linha do `PesquisarProcessos` vem com
`sDsSituacao` nulo e `nCdSituacao` = 1 em todas; as visões do mural (`PesquisarSituacoesModulo`: 0 todos, 999 em
andamento, 997 encerrados) não filtram essa listagem. O filtro de situação do K-4 só descarta quando a linha traz a
situação; sem ela, o processo entra e a carga aplica o escopo de hoje.

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-3, K-7 | `/spec` | skill `nova-migration` | skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL, `SECURITY DEFINER`) | skill `verificar-producao` + `get_advisors` |
| K-4, K-5, K-6 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | skill `verificar-producao` (próximas execuções) |
| K-8 | `/spec` | `/implement` | execução real registrada no PR | `revisor-codigo` + `revisor-seguranca` (secrets do workflow) | skill `verificar-producao` |
| K-9 | `/spec` | skill `nova-migration` + `/implement` | SQL + Deno | `revisor-migration` + `revisor-codigo` | skill `verificar-producao` |

## Fora de escopo

- Coleta de documentos (`--sem-documentos` continua no runner).
- `fiergs`, `fiemt` e `fiemg`: bloqueio do host, não se contorna.
- `detalhe_erros` vazio em `concluida_com_erros`: issue própria.
- Paralelizar processos dentro de um portal (o `DELAY_SEGUNDOS` e o `Retry-After` do host continuam valendo).
- Do pacote `nexor-portal-paradigma.zip`, não entram: tabelas `paradigma_*` em `public` com leitura para
  `authenticated` (duplicam `licitacoes_externas`, `licitacao_itens`, `coleta_externa_run` e a saúde, e expõem tabela
  bruta); `paradigma_disparar_sync()` `SECURITY DEFINER` sem `revoke` (executável por `anon`); `ThreadPoolExecutor(6)`
  sem pausa nem `Retry-After`; retry em qualquer exceção; `uses:` no workflow; cliente só da Sesc BA; arquivos `data/`.
- Formulário de interesses do tenant (`02_interesses_tenant.sql`, `03_seed_form_interesses.sql`): produto, sobrepõe o
  catálogo do tenant existente; spec própria se o Marcelo quiser.
- Achados do pacote para a 0061 (`nCdProduto` por item para o catálogo, `tDtPublicacao` e `sDsFase` no detalhe):
  levar à 0061.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_coleta_externa_fila.sql`: tabela nova, três RPCs, CHECK de
  `modo` ampliada, métrica e limiares da saúde (recriando a função a partir da definição de produção). Aditiva e
  idempotente.
- **Tabelas/views/funções tocadas:** `private.coleta_externa_fila` (escrita e leitura só pelo coletor via RPC; leitura
  pela saúde); `private.coleta_externa_run` (CHECK de `modo`); função de métricas da saúde.
- **ACL/RLS:** tabela com RLS ligada e sem policy, sem grant a `anon`/`authenticated`; RPCs `SECURITY DEFINER` com
  `search_path` fixo e EXECUTE só para `service_role`.
- **Backfill/reprocessamento:** não. A primeira descoberta de cada portal enche a fila; a primeira carga reprocessa
  tudo uma vez (as gravações em `licitacoes_externas`, `licitacao_itens` e afins já são upsert pela chave da fonte).
- **Edge Functions republicadas no merge:** todas (regra do merge); só `api-saude` muda (verificação nova).
- **Contrato com o Dashboard:** o bloco de saúde (só admin da plataforma) ganha uma linha.
- **Dado oficial x derivado:** a fila guarda a linha da listagem como veio do portal; nada é derivado além de hash e
  contadores.
- **Ordem com a 0062 e a 0063:** as três recriam a função de métricas da saúde; a que entrar depois parte da
  definição de produção.
- **K-6 da 0063:** descartado. O patch `0063-k6-disparo-rs.patch` não é usado; o secret `GITHUB_DISPATCH_TOKEN`
  sai do painel e o token é revogado no GitHub (ação do Marcelo).

## Decisões do Marcelo

- 13/11/2026: o disparo do `sesc_senac_rs` sai da 0063 e vira esta spec de coleta por portal e em camadas.
- 13/11/2026: grupos de portais definidos pela medição do que está no banco (tabela do "Problema").
- 13/11/2026: o pacote `nexor-portal-paradigma.zip` serve de referência de desenho (mural + hash + só o que mudou);
  o código dele não entra (ver "Fora de escopo").

- 13/11/2026: grupos do K-8 aprovados (pequenos num job, médios um job cada, `fieb` e `sesc_senac_rs` em camadas).
- 13/11/2026: grandes com descoberta 1 vez ao dia e carga a cada 2 h, orçamento de 60 min por job.
- 13/11/2026: revisita (K-2): processo `feito` volta a `pendente` se o `hash_listagem` mudar ou se estiver em
  `leads`/`monitorar` sem processamento há mais de 24 h.
- 13/11/2026: disparo por `pg_cron` descartado. O patch do K-6 da 0063 não é usado; o secret `GITHUB_DISPATCH_TOKEN`
  das Edge Functions e o token no GitHub ficam sem uso e o Marcelo os apaga/revoga (nenhum código lê o secret).
- 13/11/2026: limiares do K-9: atenção ≥ 26 h, crítico ≥ 48 h.
- 13/11/2026: descoberta pelo mural comum inteiro (K-4), filtrado pelas situações "Em proposta", "Em andamento" e
  "Finalizado" e por início nos últimos 24 meses; a carga aplica a regra de escopo de hoje.

## Perguntas em aberto

- nenhuma

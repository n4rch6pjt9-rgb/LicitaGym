# 0008: Verificar na BrasilAPI os CNPJs que a base não consegue confirmar

- **Status:** aprovada (09/10). Escopo desta entrega: só a verificação local; a BrasilAPI entra quando o PGC for carregado
- **Issue:** nenhuma. Pedido do Marcelo em 09/10: "para os casos de não verificados, rodar Brasil API para verificar se o
  CNPJ realmente existe". Relacionadas: #262 (mod-11), #282 e spec 0007 (PGC × PNCP).
- **Área:** migrations, edge-functions ou coletor (ver Perguntas), pncp
- **Depende do ok do Marcelo:** sim (migration nova, fonte externa nova, decisão de produto)

## Problema

Alvos escolhidos pelo Marcelo em 09/10: (a) órgãos sem nome no radar, (b) CNPJs com dígito verificador inválido e (c)
itens "não verificado" do casamento PGC × PNCP. Medição em produção (só leitura, 09/10), com o mod-11 calculado na
consulta e conferido em Python:

| Alvo | Hoje |
|---|---|
| (a) CNPJs de órgão do PCA sem nome (`pca_planos` × `orgaos`) | 0 de 682 |
| (b) CNPJs com DV inválido | **9 em `orgaos.cnpj`**, de 11.736. 0 em `fornecedores`, `licitacao_resultados`, `precos_praticados_itens` e `licitacoes_externas.orgao_cnpj` |
| (c) itens do PGC × PNCP sem par | não medível: `pca_pgc_itens` tem 0 linhas |

Os 9 CNPJs inválidos (todos em `orgaos`, que é gravada por `sync-pncp-orgaos`):
- 00177780000108, FUNDO PENITENCIARIO DE SANTA CATARINA;
- 00407324000115, COMPANHIA DE SANEAMENTO DA CAPITAL CUIABA-MT;
- 01612656000148, MTO-PREFEITURA MUNICIPAL DE LAJEADO;
- 06554481000330, EPI-SECRETARIA DE ADMINISTRAÇÃO GERAL;
- 08148553000105, PREFEITURA MUNICIPAL DE ITAU - RN;
- 18113852000110, MMG-PREFEITURA MUNICIPAL DE SIMONÉSIA;
- 18668558000101, MMG-PREFEITURA MUNICIPAL DE FORMIGA;
- 33014040000108, MRJ-PREFEITURA MUNICIPAL DE PARATY;
- 52746236000144, FUNDAÇÃO EDUCACIONAL GUAÇUANA-MOGI GUAÇU - SP.

**Origem não verificada:** não se sabe se esses números vieram assim da API oficial ou se o normalizer os alterou
(zeros à esquerda, por exemplo). A spec 0007 cobre essa origem.

**O que a BrasilAPI resolve e o que não resolve:**
- **Resolve:** dado um CNPJ **com DV válido**, ela diz se ele existe na Receita e traz razão social, situação
  cadastral, município, UF e natureza jurídica. Serve para (a) e (c).
- **Não resolve:** para DV inválido, a BrasilAPI recusa antes de consultar, como a própria Receita no print do Marcelo
  ("Dígitos verificadores inválidos"). Ela não descobre qual é o CNPJ correto, e nós também não podemos chutar o
  número (`AGENTS.md`). Para (b), a verificação é local (mod-11) e a correção vem da fonte oficial.
- **Não é fonte oficial:** a BrasilAPI agrega dados da Receita. O dado dela fica numa tabela à parte, com proveniência,
  e nunca sobrescreve o dado da fonte oficial.

## Abordagem

Decisões do Marcelo (09/10): a coleta roda numa **Edge Function**. **Agora** entra só a verificação local; a
**BrasilAPI** entra quando o PGC for carregado, numa entrega 2 desta spec.

### Entrega 1 (este PR)

1. **Migration `<timestamp>_cnpj_verificacao.sql`:**
   - **Tabela `private.cnpj_verificacao`:** RLS ligada, sem policy, `revoke all` de PUBLIC, anon e authenticated, e
     DML só para `service_role`.
     - `cnpj` (14 dígitos, PK) e `dv_valido`;
     - `status`: `dv_invalido` | `aguardando_consulta`, mais os da entrega 2: `ok` | `nao_encontrado` |
       `erro_consulta`;
     - `motivos` text[]: `dv_invalido`, `orgao_sem_nome`, `pgc_pncp_sem_par`;
     - `ocorrencias` jsonb: `tabela.coluna` → quantidade de linhas;
     - `primeira_vez_em`, `ultima_vez_no_alvo`;
     - as colunas da BrasilAPI, todas nulas nesta entrega: `fonte`, `http_status`, `situacao_cadastral`,
       `razao_social`, `nome_fantasia`, `municipio`, `uf`, `natureza_juridica`, `resposta`, `consultado_em` e `erro`.
   - **Função `private.cnpj_verificacao_atualizar()`:** `security definer`, `search_path` vazio, EXECUTE só para
     `service_role`. Ela:
     - lê as colunas de CNPJ das tabelas de dado oficial;
     - aplica `private.cnpj_valido` (#262), aceitando só valores com 14 dígitos (CPF fica de fora);
     - junta os três alvos;
     - faz upsert em `cnpj_verificacao` e devolve as contagens.
     - **Não altera nenhuma tabela de dado oficial.**
   - **Cron semanal** com `private.cron_chamar_edge(...)`. Sem pg_cron, a migration avisa e segue, como a
     `20261004004000`.
2. **Edge Function `sync-cnpj-verificacao`:**
   - `requireCronAuth`; aceita só POST;
   - chama a RPC com `service_role` e devolve as contagens;
   - erro dá 500;
   - nesta entrega não faz nenhuma chamada HTTP externa.
3. **Correção na origem:** para cada `dv_invalido` em `orgaos`, uma issue apontando a linha e a API de origem. O dado
   não é corrigido à mão.

### Entrega 2 (quando o PGC entrar)

1. **Consulta à BrasilAPI**, dentro da mesma Edge Function, só para quem está em `aguardando_consulta`:
   - timeout, retry com backoff e `Retry-After`, 1 consulta por segundo;
   - 404 vira `nao_encontrado`; 5xx ou timeout vira `erro_consulta`.
2. **Saúde e telas:** a saúde ganha a contagem por `status`; as telas mostram a razão social marcada como "Receita via
   BrasilAPI, consultado em ...".

## Critérios de aceite

### Entrega 1

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | Só `service_role` lê e grava `private.cnpj_verificacao` e executa `cnpj_verificacao_atualizar()`. anon e authenticated não têm grant, inclusive via PUBLIC. | SQL `supabase/tests/cnpj_verificacao_check.sql`, mais `funcoes_acl_check`/`tabelas_acl_check` |
| CA-2 | **Dado** um CNPJ de 14 dígitos com DV inválido numa coluna de dado oficial (ex.: `orgaos.cnpj`), **quando** a função roda, **então** existe a linha `status='dv_invalido'`, `dv_valido=false`, com `dv_invalido` em `motivos` e a contagem em `ocorrencias`. | SQL check com fixture |
| CA-3 | **Dado** um órgão do PCA sem nome (sem `titulo` e sem nome em `orgaos`) com DV válido, **então** `status='aguardando_consulta'` e `orgao_sem_nome` em `motivos`. | idem |
| CA-4 | **Dado** um CNPJ de órgão do PGC sem plano no PNCP no mesmo ano, com DV válido, **então** `aguardando_consulta` com `pgc_pncp_sem_par`. | idem |
| CA-5 | CPF (11 dígitos), valor vazio e CNPJ válido sem nenhum outro motivo não entram. Rodar duas vezes não duplica linha nem motivo; `ultima_vez_no_alvo` avança. | idem |
| CA-6 | A função não altera nenhuma linha das tabelas de dado oficial lidas: o hash de cada tabela é igual antes e depois. | idem |
| CA-7 | **Edge:** sem o segredo do cron, 401 e nenhuma RPC; GET dá 405; com o segredo, chama a RPC `cnpj_verificacao_atualizar` e devolve 200 com as contagens; erro da RPC dá 500. Nenhum `fetch` externo. | Deno `tests/supabase/functions/sync_cnpj_verificacao_test.ts` |

### Entrega 2 (BrasilAPI, depois)

Os CA de consulta continuam como estavam: 200 vira `ok` com a resposta bruta; 404 vira `nao_encontrado`; 429, 5xx ou
timeout vira `erro_consulta`, com retry; os testes nunca chamam a API real. Eles serão detalhados quando a entrega 2
começar.

## Fora de escopo

- Corrigir os 9 CNPJs de `orgaos`. Vira issue apontando a origem; a spec 0007 investiga o normalizer.
- Usar a BrasilAPI como fonte primária de órgão ou fornecedor.
- Consultar CPF (`ni_fornecedor` pessoa física). Só CNPJ de 14 dígitos entra.
- A tela que mostra a razão social da BrasilAPI. Vai num PR de front depois deste.

## Impacto em dados

- **Migration:** sim, `<timestamp>_cnpj_verificacao.sql`. É aditiva e idempotente: tabela e função em `private`, com
  `revoke all` + grant a `service_role`.
- **Tabelas tocadas:** só `private.cnpj_verificacao` recebe escrita. `orgaos`, `pca_planos` e `pca_pgc_itens` são
  só lidas.
- **ACL/RLS:** tabela nova com RLS e sem policy. EXECUTE da função só para `service_role`.
- **Backfill:** a 1ª rodada consulta os pendentes. Hoje são 9 com DV inválido (sem chamada) e 0 com DV válido. O PR
  registra a contagem antes e depois.
- **Edge Functions republicadas no merge:** todas. Se a coleta for Edge, cria `sync-cnpj-verificacao`.
- **Contrato com o Dashboard:** inalterado neste PR.
- **Dado oficial × derivado:** a BrasilAPI é fonte externa não oficial, sempre separada e marcada; nunca sobrescreve
  o dado oficial.

## Perguntas em aberto

Nenhuma para a entrega 1.

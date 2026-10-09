# 0008: Verificar na BrasilAPI os CNPJs que a base não consegue confirmar

- **Status:** rascunho
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

1. **Migration** com `private.cnpj_verificacao`. Só `service_role` tem acesso; RLS ligada, sem policy.
   - **Colunas:**
     - `cnpj` (14 dígitos, PK);
     - `dv_valido`;
     - `status`: `ok` | `nao_encontrado` | `dv_invalido` | `erro_consulta`;
     - `http_status`, `situacao_cadastral`, `razao_social`, `nome_fantasia`, `municipio`, `uf`, `natureza_juridica`;
     - `resposta` (jsonb bruto);
     - `fonte` = `'brasilapi'`;
     - `motivos` text[]: `orgao_sem_nome`, `dv_invalido`, `pgc_pncp_sem_par`;
     - `consultado_em`, `erro`.
   - Mais `private.cnpj_verificacao_pendentes()`, que devolve os CNPJs dos três alvos ainda não verificados ou
     vencidos.
2. **Coleta:**
   - consulta a BrasilAPI só para os CNPJs com DV válido;
   - DV inválido é gravado direto como `dv_invalido`, sem chamada;
   - timeout explícito, retry com backoff e `Retry-After`, `DELAY_SEGUNDOS >= 1`;
   - 404 vira `nao_encontrado`; 5xx ou timeout vira `erro_consulta`, nunca `nao_encontrado`.
3. **Exposição:** a saúde operacional ganha a contagem por `status`. As telas (radar e órgãos) passam a mostrar, quando
   o nome oficial faltar, a razão social da BrasilAPI marcada como "Receita via BrasilAPI, consultado em ...". Isso
   fica num PR de front separado.
4. **Correção na origem:** para cada `dv_invalido` em `orgaos`, uma issue apontando a linha e a API de origem. O dado
   não é corrigido à mão.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | A tabela existe, só `service_role` lê e grava, e anon e authenticated não têm nenhum grant. | SQL `supabase/tests/cnpj_verificacao_check.sql` |
| CA-2 | **Dado** um CNPJ com DV inválido, **quando** a coleta roda, **então** grava `status='dv_invalido'` e **não** chama a BrasilAPI. | teste unitário com mock HTTP (conta as chamadas) |
| CA-3 | **Dado** a BrasilAPI responder 200, **então** grava `status='ok'`, os campos e a `resposta` bruta, com `fonte='brasilapi'` e `consultado_em`. | idem |
| CA-4 | **Dado** 404, **então** `nao_encontrado`. **Dado** 429/5xx/timeout, **então** retry com backoff (respeitando `Retry-After`) e, esgotado, `erro_consulta`. Nunca `nao_encontrado`. | idem |
| CA-5 | `cnpj_verificacao_pendentes()` devolve os três alvos, sem repetir CNPJ e juntando os motivos, e não devolve o que foi verificado com `ok` há menos de N dias. | SQL check com fixtures |
| CA-6 | Nenhuma coluna de tabela de dado oficial (`orgaos`, `pca_planos` etc.) é alterada pela coleta. | check SQL compara o hash das linhas antes e depois, no banco descartável |
| CA-7 | Os testes unitários nunca chamam a BrasilAPI real. | o mock é obrigatório; o teste falha se houver fetch não mockado |

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

1. **Onde roda a coleta:**
   - **Edge Function `sync-cnpj-verificacao` com cron:** mesmo padrão dos `sync-*`, lock e saúde.
   - **Python no `coletor-externo`:** Cloud Run Job, que já tem o cliente HTTP com retry.
   - A sessão cloud não alcança `brasilapi.com.br` (proxy 403). Isso só afeta o teste manual, porque os testes usam
     mock.
2. **Validade:** depois de quantos dias um `ok` é verificado de novo? A proposta é 90 dias.
3. **Limite da BrasilAPI:** não há SLA documentado; a proposta é 1 consulta por segundo. Hoje o volume é 0 com DV
   válido, então o limite só pesa quando o PGC for carregado ou aparecerem órgãos sem nome.
4. **Vale a pena agora?** Com os números de hoje (0 / 9 / 0), a parte da BrasilAPI não teria nada para consultar.
   Alternativa: entregar já só a verificação local de DV (CA-1, CA-2, CA-5, CA-6) e ligar a BrasilAPI quando o PGC
   entrar.

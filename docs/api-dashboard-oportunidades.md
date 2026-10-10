# Contrato: Edge Function `api-dashboard-oportunidades`

Documentação da Edge Function de leitura de oportunidades para o Dashboard LicitaGym.

O contrato completo de requisições, respostas, parâmetros e tratamento de erros está disponível em:
[`supabase/functions/api-dashboard-oportunidades/README.md`](../supabase/functions/api-dashboard-oportunidades/README.md).

## Resumo Rápido

- **Caminho**: `/functions/v1/api-dashboard-oportunidades`
- **Tabela Fonte**: `public.licitacoes_externas`; `list` e `get` leem a view `public.licitacoes_externas_prioridade_efetiva` (mesmas colunas públicas, `prioridade` efetiva que só rebaixa; `security_invoker`, SELECT só para `service_role`).
- **Oportunidades sem `historico`** (decisão de produto 30/09/2026): o `list` exclui `historico` por padrão (itens e `total`); `prioridade=historico` responde 200 vazio; `get` de uma compra `historico` responde normalmente com a prioridade efetiva (links do BI).
- **Compra PNCP republicada uma vez** (decisão 02/10/2026, `20261003170000_licitacoes_pncp_canonica`): `list` (itens e `total`) só traz a publicação canônica (`eh_canonica`) de um grupo PNCP com o mesmo `orgao_cnpj` + `processo_norm` + `numero_edital`; `get` devolve qualquer publicação com `canonica_id`/`eh_canonica`. As views BI `v_bi_resultados_itens`, `v_bi_orgaos_match`, `v_bi_fornecedor_historico` e `oportunidades_borracha` também contam só a canônica.
- **Escopo e encaixe**: `catmat_match` no `list` e no `get` é escopo CATMAT (`licitacao_match`: o texto cai em qual PDM). Não é aderência técnica. O encaixe produto × item fica em `catalogo_de_para`, com veredito por atributo (`atende`, `supera`, `nao_atende`, `nao_comprovado`, `ausente`, `ambiguo`). Falha ou lacuna num atributo eliminatório não pode sair como `atende`.
- **Ações**:
  - `readiness`: Retorna prontidão da tabela e data do último sync sem vazar segredos (pública).
  - `get`: Requer autenticação JWT do usuário.
    - Lookup por `id` único (retorna `{ item }` ou 404).
    - Lookup por `codigo_externo` único com `fonte` obrigatório (retorna `{ item }`, 400 se faltar `fonte`, ou 404).
    - Lookup por `orgao_cnpj` + `processo_norm` paginado com `page` e `limit` (retorna coleção `{ orgao_cnpj, processo_norm, page, limit, total, items: [...] }`, ou 404).
  - `list`: Requer autenticação JWT do usuário. Lista com paginação (`page`, `limit`), ordenação com desempate determinístico por `id` e múltiplos filtros (UF, órgão, prioridade, escopo, borracha, datas com limites inclusivos em America/Sao_Paulo UTC-3, valores e busca textual literal com allowlist).
  - `acompanhamento`: Requer autenticação JWT do usuário (`401` se não autenticado). `id` obrigatório, somente dígitos (1 a 18); fora disso retorna `400`. Painel de acompanhamento ao vivo para oportunidade PNCP: consulta metadados da compra, itens paginados, vencedores e valores homologados via `/itens/{n}/resultados` (concorrência ~5), atas de registro de preços, histórico de eventos (timeline normalizada) e arquivos oficiais para download. Deriva `url_edital` e `url_acompanhamento` (Comprasnet cnetmobile com 17 dígitos). Oportunidades não-PNCP retornam HTTP 200 com `disponivel: false`. Inclui cache em memória de ~5 minutos e tolerância a falhas parciais por seção. Somente leitura: `linkSistemaOrigem` não é coluna de `licitacoes_externas` e é lido do PNCP ou de `raw` server-side (`raw` nunca é devolvido).
- **Segurança & RLS**:
  - `licitacoes_externas` possui todo acesso direto via PostgREST revogado para `authenticated`, `anon` e `PUBLIC` (`REVOKE ALL ON TABLE public.licitacoes_externas FROM authenticated, anon, PUBLIC;`), com remoção de qualquer policy de SELECT para authenticated ou anon.
  - Leituras do dashboard/usuários são feitas exclusivamente via Edge Function `api-dashboard-oportunidades` (service_role + `PUBLIC_LICITACAO_COLUMNS`), enquanto leituras/escritas internas operam via `service_role` (Edge Function + coletores).
  - Chamadas à Edge Function para `list`, `get` e `acompanhamento` exigem autenticação de usuário via `requireUserAuth` (JWT de usuário Supabase), mantendo `OPTIONS` e `readiness` públicos.
  - A Edge Function executa server-side via `SUPABASE_SERVICE_ROLE_KEY` projetando exclusivamente colunas públicas seguras (`PUBLIC_LICITACAO_COLUMNS`, incluindo `modulo` e `id_externo` para SEST SENAT), sem expor payload bruto (`raw`), fóruns (`esclarecimentos`, `notas`) nem colunas de controle interno (`anexo_raiz_id`, `edital_id`).
  - O navegador invoca a função com token de usuário autenticado; a chave `service_role` nunca é entregue ao cliente.
  - Mensagens de erro de banco não expõem detalhes crus do PostgREST e retornam HTTP 500 para falhas de banco.
  - Script SQL de verificação de ACL e RLS efetivo disponível em `supabase/tests/licitacoes_externas_acl_check.sql`.

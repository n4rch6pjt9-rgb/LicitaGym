# Backend da área de Configurações: o que existe e o que falta

Base: repositório `n4rch6pjt9-rgb/LicitaGym` (`main`, commit `8436bdd`), banco de produção lido em 20/10/2026
(só leitura) e workspace do Dashboard anexado.

## Decisões de 20/10

1. Colunas do CSV do catálogo aprovadas, inclusive o formato `atr:<nome>` para atributos.
2. Catálogo, escopo CATMAT e ficha de produto saem de "Descoberta" e vão para `/configuracoes`.
3. Usuários & RBAC e Modelo de Dados (hoje só na demo): levantar o backend dentro da estrutura proposta (este documento).
4. Visões salvas de filtro são **da equipe** (compartilhadas no tenant).

## 1. Estado de cada página de `/configuracoes`

Legenda: **Pronto** = a API existe e a tela já usa. **Só falta tela** = a API existe e a tela não usa.
**Parcial** = a tabela existe, mas falta API ou isolamento por tenant. **Novo** = nada no backend.

| Página proposta | Backend hoje | Estado | O que falta no backend |
|---|---|---|---|
| Empresa (perfil, CNPJ, dados bancários) | `api-tenant`: `empresa_atualizar`, `dados_restritos_*` | Pronto | — |
| Usuários e papéis | `api-tenant`: `membros_listar/adicionar/atualizar`; papéis `admin`/`operacao` com CHECK no banco; último admin protegido | Pronto para o básico | Convite por e-mail (hoje só conta já existente); permissões finas (ver 2.1) |
| Etapas do pipeline | `api-pipeline`: `etapa_criar/atualizar/excluir` (admin), com tenant novo semeado com 13 etapas | **Só falta tela** | — (o front só chama `etapas_listar`) |
| Tarefas por etapa | `api-pipeline`: `etapa_tarefas_listar/salvar` | Pronto | — |
| Catálogo de produtos (CSV) | `catalogo_produtos` (com `tenant_id`, 23 linhas), `catalogo_produto_atributos`, `ontologia_atributos`; só a `api-catalogo-ficha` grava, um produto por vez, a partir do HTML | Parcial | Importação em lote, chave por tenant, histórico e desfazer (ver 2.2) |
| Preços do catálogo (CSV só admin) | `catalogo_precos` (com `tenant_id`; o `api-agentes` lê); nenhuma API grava | Parcial | Importação só admin (ver 2.2) |
| Escopo CATMAT | `catalogo_empresa_catmat` + `api-catmat` | **Parcial: sem `tenant_id`** | A tabela é global: hoje "o catálogo da empresa" vale para todos os tenants. Precisa de `tenant_id` e de escrita pelo admin do tenant (ver 2.3) |
| Termos de inclusão e exclusão | `escopo_termos` (232 linhas, "alterar só por migration"), `catmat_pdm_palavras`, `catmat_pdm_exclusoes` | Parcial: globais e editados por migration | Separar taxonomia da plataforma (global) de termos do tenant (por `tenant_id`, editáveis na tela) |
| Ficha de produto | `api-catalogo-ficha` | Pronto, mas preso a um site | Host e perfil de leitura por tenant (`empresa_site`) ou a substituição pelo CSV |
| Regras comerciais | `tenant_regras_comerciais` (margem, regiões, prazo); nenhuma API | Parcial | Ações de ler e salvar (admin) |
| Documentos de habilitação | `documento_tipos` (18) + `tenant_documentos` + bucket `tenant-documentos`; nenhuma API encontrada | Parcial | Upload, listagem com validade e alerta de vencimento |
| Alertas | nada | Novo | Canais e eventos por tenant (decisão anterior: push, e-mail, navegador) |
| Fontes e sincronizações | `api-syncs` (exige admin da plataforma; a API já devolve 403 para os demais) | Pronto | Só a tela: esconder os botões de quem não é admin |
| Modelo de dados (campos customizados do CRM) | nada | Novo | Ver 2.4: proposta de **não** construir agora |
| Visões salvas de filtro (equipe) | nada | Novo | Ver 2.5 |
| Metadados das telas (opções, limites, rótulos) | listas fixas no front | Novo | Ver 2.6 |

**Bloqueio de fundo:** o tenant é **implícito**. A `_shared/tenant.ts` resolve a empresa pelo vínculo do usuário. O
desenvolvedor sem vínculo cai na "única empresa ativa", e **com duas empresas ativas recebe 409**. Antes do segundo
tenant entrar, as APIs precisam receber o tenant explicitamente (ver 2.0).

## 2. O que construir

### 2.0 Tenant explícito (pré-requisito de tudo)
- **Contrato:** toda chamada `api-*` de dado de tenant aceita `tenant_id` (no corpo ou num header `X-Tenant-Id`).
- **Validação:** a `_shared/tenant.ts` confere se quem chama é membro ativo desse tenant, ou se é o desenvolvedor.
  Sem `tenant_id` e com um só vínculo, usa esse vínculo. Com dois ou mais, devolve 400 pedindo a escolha (não "a única ativa").
- **Front:** um seletor de empresa no shell (`minha_empresa` já lista as empresas e o papel), guardado por sessão.
- **Testes:** CA negativo para cada `api-*` (membro do tenant A pedindo o tenant B → 403).

### 2.1 Usuários e papéis (substitui a tela "Usuários & RBAC" da demo)
- **Agora:** a tela real é a de membros da `api-tenant`, que já existe. Funde "Usuários & RBAC" com "Empresa e
  usuários" e mostra os 2 papéis reais, com o que cada um pode fazer escrito na tela.
- **Novo:**
  - **Convite:** `membro_convidar` (admin) → `auth.admin.inviteUserByEmail` + vínculo pendente em `tenant_membros`
    (coluna `convite_em`), com `ativo` só depois do primeiro login.
  - **Permissões finas, só quando houver um terceiro papel de verdade:** tabela `papel_permissoes(papel, recurso,
    acao)` lida pela `_shared`. Até lá, a matriz admin × operação fica documentada no código das funções (como
    está hoje), sem tabela.

### 2.2 Catálogo do tenant via CSV
**Migration (aditiva):**
- `catalogo_produtos`:
  - `tenant_id NOT NULL`, depois de conferir que as 23 linhas têm tenant;
  - `UNIQUE (tenant_id, codigo)`;
  - a `UNIQUE (url)` global passa a `UNIQUE (tenant_id, url)`, porque dois tenants podem revender o mesmo produto;
  - colunas novas `unidade`, `garantia_meses`, `modelo` (a `linha` existente continua).
- `catalogo_importacoes(id, tenant_id, tipo produtos|precos, arquivo_storage, sha256, autor, criado_em, linhas_total,
  novas, atualizadas, com_erro, status rascunho|aplicada|desfeita, desfeita_em)`.
- `catalogo_importacao_linhas(importacao_id, linha, dados jsonb, acao nova|atualiza|erro, erros jsonb, produto_id,
  antes jsonb)`. O `antes` permite desfazer.

**Edge Function nova `api-catalogo`** (só service_role no banco; papel conferido na função):

| action | quem | o que faz |
|---|---|---|
| `modelo_csv` | admin | devolve o cabeçalho: colunas fixas + uma `atr:<nome>` por atributo da ontologia das famílias do tenant |
| `importar_previa` | admin | recebe o CSV (até N linhas), detecta `;` ou `,`, valida linha a linha e grava a importação como `rascunho`, sem tocar no catálogo |
| `importar_aplicar` | admin | aplica as linhas válidas numa transação (upsert por `tenant_id, codigo`, atributos em `catalogo_produto_atributos`) |
| `importar_desfazer` | admin | volta a última importação aplicada usando `antes` |
| `importacoes_listar` | membro | histórico |
| `produtos_listar` | membro | lista paginada com filtros (contrato de filtros da fase 1) |
| `precos_previa/aplicar` | **só admin** | segundo CSV (`codigo; preco_tabela; desconto_max_pct; vigencia_inicio; vigencia_fim`) em `catalogo_precos` |

**Regras de validação:** obrigatórias presentes; `familia` dentro da lista fechada; número com vírgula ou ponto;
`atr:` desconhecido gera aviso, não erro; `catmat_item` conferido em `catmat_item_pdm`, sem bloquear quando ausente.
Nenhuma coluna inventa valor: célula vazia grava nulo.

**Testes:** CA para nova, atualiza, erro por linha, CSV com `;` e com `,`, desfazer, outro tenant (403) e operação
tentando importar preço (403).

### 2.3 Escopo CATMAT por tenant
- **Migration:** `catalogo_empresa_catmat.tenant_id`, com backfill para o tenant atual. A `chave` única passa a
  `(tenant_id, chave)`.
- **Funções que filtram pelo catálogo** (`licitacoes_ids_por_catmat` e afins) recebem o `tenant_id`.
- **Escrita** pela `api-catmat`: admin do tenant, não só o admin da plataforma.
- **`escopo_termos`** se divide em dois:
  - a taxonomia da plataforma (global, curada, continua por migration);
  - `tenant_termos(tenant_id, termo, tipo inclui|exclui, origem, ativo)`, editável na tela. É aqui que entra o
    portão de "ar livre", aplicado ao **texto do TR/edital**.
- **Fica em aberto:** a decisão de 20/10 sobre o CATMAT ser fonte do escopo continua pendente. Este desenho não
  depende dela, porque o catálogo de produtos via CSV passa a ser outra entrada do escopo.

### 2.4 Modelo de Dados (campos customizados do CRM): proposta de não construir agora
A tela da demo desenha objetos e campos customizados do CRM (Pessoas, Organizações). Isso não é alicerce do negócio
e pediria um mecanismo de EAV (entidade-atributo-valor) em várias tabelas, além de mexer em todas as listas e filtros.

**Proposta:**
- remover a tela agora;
- usar o lugar dela para **"Atributos do catálogo"**: a lista de `ontologia_atributos` por família (nome, sentido,
  eliminatório). É o metadado que o CSV (`atr:<nome>`) e o agente de aderência de fato usam.
- **Escrita:** só admin da plataforma no início, porque o atributo precisa ter o mesmo nome no requisito do edital e
  na ficha do produto. O tenant pede atributo novo por um botão "Sugerir atributo".

### 2.5 Visões salvas de filtro (da equipe)
- **Migration:** `filtro_visoes(id, tenant_id, rota, nome, filtros jsonb, criada_por, criada_em, atualizada_em,
  padrao_da_rota boolean)` com `UNIQUE (tenant_id, rota, nome)`.
- **Ações** (na `api-metadados` ou numa função própria):
  - `visoes_listar(rota)`: membro;
  - `visao_salvar` e `visao_excluir`: membro cria; quem criou ou o admin edita e exclui;
  - `visao_definir_padrao`: admin.
- **Validação dos filtros salvos:** o `filtros` é validado contra o esquema da rota no servidor. Chave desconhecida é
  descartada, e a visão com filtro inválido mostra aviso em vez de quebrar.

### 2.6 `api-metadados` (opções, limites e rótulos por tenant)
Função de leitura, por membro, com cache curto:

| action | devolve |
|---|---|
| `filtros` (com `rota`) | as opções de cada filtro: fontes, modalidades (código + rótulo), categorias de objeto, prioridades, ordenações, UFs, famílias, janelas de prazo |
| `limites` | tamanhos de página e tetos |
| `rotulos` | dicionário de enums (situação, severidade, status de tarefa…) |
| `prontidao` | estado de cada alicerce para a página inicial de `/configuracoes` (configurado, atenção, vazio), com as contagens vindas do banco |

## 3. Ordem sugerida (cada linha vira uma spec)

| # | Spec | Depende de | Migration | Tamanho |
|---|---|---|---|---|
| 1 | Tenant explícito nas `api-*` + seletor no shell | — | não | M |
| 2 | Etapas do pipeline editáveis (só front) | — | não | P |
| 3 | `api-metadados` (`filtros`, `limites`, `rotulos`) + visões salvas da equipe | 1 | sim (`filtro_visoes`) | M |
| 4 | `api-catalogo`: importação de produtos por CSV, histórico e desfazer | 1 | sim | G |
| 5 | Preços por CSV (só admin) | 4 | não (tabela existe) | P |
| 6 | Escopo CATMAT e termos por tenant | 1 | sim, com backfill (pede branch Supabase) | G |
| 7 | Usuários: fusão das telas + convite por e-mail | 1 | sim (`convite_em`) | M |
| 8 | Atributos do catálogo no lugar do Modelo de Dados | 4 | não | P |
| 9 | Página inicial `/configuracoes` (`prontidao`) | 3–8 | não | P |
| 10 | Regras comerciais, habilitação e alertas | 1 | sim | G |

Itens 1 e 6 mudam RLS ou consulta de tabela de tenant: pelas regras do repositório, pedem branch Supabase criada pelo
Marcelo antes do merge.

## 4. Correção a um achado da revisão
O code-review do grupo B classificou como Alta que "qualquer usuário dispara sync global". No backend, a `api-syncs`
já devolve 403 para quem não é admin da plataforma (`api-syncs/index.ts`, `isLicitagymAdmin`). O problema é só de
tela: os botões aparecem para quem não pode usá-los. Severidade rebaixada para Média (UX).

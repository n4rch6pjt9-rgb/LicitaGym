# Fase 1: frontend do LicitaGym sem tenant fixo, com configuração por metadados

Base: workspace anexado (`Dashboard---LicitaGym`, commit `190d61a` com 6 arquivos alterados e não commitados em
/oportunidades), 80 arquivos em `src/components` (cerca de 21 mil linhas), 27 rotas fotografadas no modo demo.
Quatro agentes revisaram o código: UX/UI e code-review, cada um dividido em grupo A (rotas operacionais) e grupo B
(plataforma, configuração e análise). Os relatórios completos dos agentes ficaram anexados na conversa de 20/10 (não versionados). Conferi no código os
achados bloqueantes abaixo.

Ressalvas: as telas foram vistas no modo demo. Em /pipeline, /tarefas, /precos e no detalhe da oportunidade, o demo
mostra outro componente, diferente do de produção, por isso essas telas foram avaliadas pelo código. As issues do
GitHub não puderam ser consultadas (403).

## 1. Diagnóstico em uma frase por tema

| Tema | Situação hoje |
|---|---|
| Multi-tenant | O shell mostra "LicitaGym Brasil Esportes" para todos (`AppShell.tsx:107`). A busca ⌘K e os textos de exemplo são de fitness e Joinville. A ficha de produto está presa ao site da Konnen (`lerFichaHtml.ts`, CSP) |
| Metadados × código | 17 itens no grupo A e mais de 20 no grupo B estão fixos no código: categorias de objeto (com regex no navegador), fontes, modalidades, prioridades, as 13 etapas no Kanban e no painel, grupos CATMAT 78/72, limites e rótulos de enums |
| /configuracoes | Só 2 de 5 telas configuram algo de verdade: Empresa e usuários, e Tarefas por etapa. Usuários & RBAC e Modelo de Dados são só demonstração. Não há catálogo por CSV, edição de etapas, regras comerciais, documentos de habilitação nem alertas |
| Permissão | `adminOnly` está declarado e nunca é usado. /saude e todas as /configuracoes abrem para qualquer usuário logado. "Rodar agora" e "Refazer o cron" aparecem para todos |
| Filtros | Cada rota tem um modelo próprio. Só /oportunidades e /pca guardam os filtros na URL. Nenhuma rota tem chips de filtros ativos nem visões salvas. `FilterBar` e `DataTable` existem, mas quase nenhuma tela usa. O `CustomSelect` quebra no tema escuro e não funciona por teclado |
| Zero alucinação | O acompanhamento inventa "Pendente", "UN", homologado calculado com a quantidade estimada e ata "Vigente" vencida. Os KPIs de órgãos e fornecedores mostram zeros quando a chamada falha |
| Datas | Vários pontos formatam em UTC: o histórico PNCP sai com +3 h e o prazo do Kanban cai no dia anterior |

## 2. Corrigir já (bugs confirmados)

| # | Rota | Problema | Onde | Correção |
|---|---|---|---|---|
| 1 | /oportunidades | "Encerramento mais próximo" não pode ser escolhido: a tabela de ordenações tem `valor` e direção invertidos, e 2 testes do vitest falham | `filtrosUrl.ts:42-44` | `data_fim.asc` = mais próximo; padrão = encerramento mais próximo |
| 2 | /oportunidades | "Sessão/disputa" roda no navegador sobre 10 itens, sem limite para o passado e com o dia em UTC | `OpportunityListView.tsx:59-67` | Filtrar no servidor (`data_fim_min/max` em datas de Brasília) |
| 3 | /oportunidades | O selo "amostra: 10 de 181" aparece em toda página que não é a última | `supabaseProvider.ts:445` | `parcial` só quando atinge o teto de 10.000; mostrar "181 resultados · página 1 de 19" |
| 4 | /oportunidades | "Limpar filtros" desliga o filtro de catálogo (`catalogo=0`) sem caminho de volta | `OpportunityListView.tsx:105` | "Limpar" volta ao padrão, e o escopo fica visível como chip |
| 5 | shell | Nome de empresa inventado e seletor de workspace que não faz nada | `AppShell.tsx:107,445-455` | Nome do tenant vindo da `api-tenant`; seletor real ou nenhum |
| 6 | shell/rotas | Configuração e saúde sem controle de papel | `AppShell.tsx:57,195`, `App.tsx:504-536` | Guarda de rota + menu por permissão (a API continua sendo quem decide) |
| 7 | acompanhamento | Valores inventados quando falta dado | `OpportunityAcompanhamentoView.tsx:706,897,903,915,1119` | Mostrar ausente como "—", sem cálculo com quantidade estimada |
| 8 | /pipeline, detalhe | Datas em UTC | `PipelineRealView.tsx:48-52`, `OpportunityDetailRealView.tsx:73-78` | Um formatador único de data de Brasília |

Os itens 1 e 2 estão nas alterações ainda não commitadas do workspace: corrija antes de commitar.

## 3. Alicerce de metadados (a mudança de fundo)

**Princípio:** o código conhece **tipos** (o que é uma etapa, um filtro, um produto). O tenant cadastra **valores**
pela interface. O backend serve as opções e os limites de cada rota (`api-metadados`), e o front nunca tem lista de
negócio fixa.

### 3.1 Área `/configuracoes` como painel de alicerces

```
/configuracoes                 página inicial: lista de verificação dos alicerces do tenant
├─ Empresa                     perfil, CNPJ, dados bancários (existe) · usuários e papéis (fundir as duas telas)
├─ Catálogo e escopo           catálogo de produtos via CSV (NOVO) · escopo CATMAT (mover de /catmat)
│                              · termos de inclusão e exclusão (NOVO) · ficha de produto (mover /catalogo/ficha)
├─ Comercial                   regras comerciais: UFs, modalidades, faixa de valor, margem (NOVO)
│                              · documentos de habilitação com validade (NOVO)
├─ Processo                    etapas do pipeline editáveis (NOVO) + tarefas por etapa (existe) · alertas (NOVO)
├─ Dados e fontes              fontes e sincronizações (existe, só admin da plataforma)
└─ Auditoria                   histórico de importações e alterações (quem, quando, o quê)
```

O tenant novo vê na página inicial o que falta configurar. Hoje esse caminho não existe.

### 3.2 Catálogo do tenant: rota própria com CSV de layout único

Rota `/configuracoes/catalogo`, em 4 passos: **baixar o modelo → enviar → pré-visualizar e validar linha a linha →
confirmar**. Linha com erro não bloqueia as válidas. Cada importação fica registrada (arquivo, contagens, autor) e a
última pode ser desfeita.

Proposta de colunas, alinhadas ao que o banco já tem (`catalogo_produtos`, `catalogo_produto_atributos`,
`ontologia_atributos`). **Precisa da sua validação:**

| Coluna | Obrigatória | Observação |
|---|---|---|
| `codigo` | sim | chave do produto no tenant (SKU); reimportar atualiza |
| `nome` | sim | |
| `marca` | sim | |
| `modelo` / `linha` | não | |
| `familia` | sim | lista fechada, vinda de metadado (ex.: musculação, cárdio, acessório, piso) |
| `catmat_item` | não | sinal auxiliar; o escopo não depende só dele (decisão em revisão) |
| `unidade` | sim | UN, CJ, M²… |
| `comprimento_cm`, `largura_cm`, `altura_cm`, `peso_kg` | não | numéricos |
| `garantia_meses` | não | |
| `ficha_url` | não | |
| `ativo` | sim | sim/não |
| `atr:<nome>` | não | uma coluna por atributo da ontologia (ex.: `atr:carga_maxima_kg`, `atr:contador`); o modelo baixado já traz as colunas do tenant |

Preço e desconto **não entram nesse arquivo**: `catalogo_precos` é sigiloso e fica num segundo CSV, só para admin.

### 3.3 O que mais vira metadado (resumo dos inventários)

| Hoje no código | Passa a vir de |
|---|---|
| Categorias de objeto + regex no navegador | `objeto_categorias` por tenant; classificação só no backend |
| Fontes, modalidades, ordenações, UFs | `api-metadados action=filtros&rota=…` |
| 13 etapas no Kanban e no painel | `pipeline_etapas` do tenant (já existe; apagar as listas locais) |
| Grupos CATMAT padrão 78/72 | escopo do tenant |
| Janelas de prazo, tamanhos de página, tetos | `empresa_config` / `api-metadados action=limites` |
| Rótulos de enums (situação, severidade, status de tarefa) | dicionário `rotulos_enum` |
| Papéis e permissões (5 papéis fictícios na demo) | `papeis` + `papel_permissao` |
| Menu, "Em breve" e badges | registro único de rotas com `requer_papel` e `feature_flag` |
| Marca no shell | `tenant_config.marca` (white-label opcional) |
| Ficha de produto presa ao site da Konnen | `empresa_site` (host e perfil de leitura) ou o CSV acima |

## 4. Filtros: um kit único para todas as rotas

Os agentes propuseram desenhos compatíveis. O consolidado fica assim:

- **`src/filtros/`**, um esquema por rota (`esquemas/oportunidades.ts`, `pca.ts`, `precos.ts`…), com:
  - um só modelo de URL (o padrão não vai para a URL, valor inválido é ignorado, mudar filtro volta à página 1);
  - `useFiltrosUrl(esquema)`;
  - opções vindas do `api-metadados`.
- **`<FilterBar>`**, com um conjunto fixo de peças:
  - busca por texto com debounce (`?q=`; hoje não dá para achar "PE 048/2026");
  - `FilterSelect` (o `CustomSelect` usando os tokens do tema, com seleção múltipla, teclado e contagem por opção);
  - **contagem de resultados vinda do servidor**;
  - **chips removíveis** para cada filtro ativo, inclusive os padrões;
  - **"Limpar tudo" / "Voltar ao padrão"**;
  - **visões salvas** por usuário e por equipe;
  - no celular, um painel de filtros que abre de baixo.
- **Contrato com o backend:**
  - toda lista paginada filtra no servidor;
  - a resposta traz `filtros_aplicados` e `ignorados[]`, e parâmetro ignorado aparece como aviso;
  - `total` é o total do recorte e `truncado` vale só para o teto;
  - datas vão como datas de calendário de Brasília.
- **Escopo em /oportunidades:** troca o bloco Grupo→Classe→PDM→Item + checkbox por um controle
  `(Meu catálogo · n) (Fora · n) (Tudo · n)`, mais um seletor "Produto" com busca e seleção múltipla e um selo de
  aderência por linha. O detalhe CATMAT vira filtro avançado.

Ordem de migração: /oportunidades → /pca → /precos → /pipeline → /tarefas → /catmat → /crm → acompanhamento.

## 5. Plano da fase (proposta)

| Etapa | Entrega | Repo | Tamanho |
|---|---|---|---|
| 1 | Bugs 1–8 da seção 2 + vitest verde | Dashboard | P |
| 2 | Tenant ativo no shell + guarda por papel + menu num registro único de rotas | Dashboard (+ `api-tenant`) | M |
| 3 | Kit `src/filtros/` + `FilterBar` v2 + `DataTable` v2, migrando /oportunidades e /pca | Dashboard | M |
| 4 | `api-metadados` (opções, limites, rótulos) e retirada das listas fixas | LicitaGym → Dashboard | M |
| 5 | `/configuracoes` página inicial + `/configuracoes/catalogo` (CSV) + etapas editáveis | os dois | G |
| 6 | Migrar o kit de filtros para as demais rotas; retirar textos de tenant e segmento | Dashboard | M |
| 7 | Regras comerciais, habilitação, alertas como metadado | os dois | G |

Cada etapa vira uma spec (`/spec`) que **alimenta** um módulo do `ESCOPO.md`. A ordem de publicação continua a
mesma: o backend vai antes do front que depende dele.

## 6. Decisões que preciso de você

1. As colunas do CSV do catálogo (seção 3.2), principalmente a convenção `atr:<nome>` para atributos.
2. O catálogo, o escopo CATMAT e a ficha saem de "Descoberta" e vão para `/configuracoes`?
3. O que fazer com Usuários & RBAC e Modelo de Dados, hoje só na demo: remover agora ou manter atrás de uma
   flag até haver backend?
4. Visões salvas de filtro: só por usuário, ou também compartilhadas pela equipe do tenant?

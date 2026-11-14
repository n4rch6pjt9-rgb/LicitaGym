# 0065: Casar o item do Sistema S pelo catálogo do portal (Grupo → Classe → Produto), como o PNCP casa pelo CATMAT

- **Status:** rascunho
- **Alimenta:** módulo 1 de `docs/produto/ESCOPO.md` (Radar de oportunidades: licitações aderentes ao catálogo de
  produtos, Sistema S). Regra de foco suspensa desde 11/11/2026. Revisa as fases 2 a 4 de
  `specs/0052-catalogo-sistema-s-selecao-por-tenant.md` (seleção única no lugar da seleção por tenant; nível grupo) e
  depende da fila de `specs/0064-sistema-s-coleta-camadas.md`.
- **Repositório:** LicitaGym (a tela de seleção fica fora; ver "Perguntas em aberto")
- **Issue:** nenhuma
- **Área:** migrations | coletor | catmat | workflow GitHub Actions | specs (planilha `specs/nexor_spec_v0.2.xlsx`)
- **Depende do ok do Marcelo:** sim (migration, carga de dado em produção, mudança de classificação com
  reprocessamento, religar a coleta agendada)

## Leitura obrigatória antes de implementar

Itens 1 a 10 do template. Específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 4 | `docs/produto/ESCOPO.md` (módulo 1, "Decisões registradas") | o que a spec alimenta; "TR primeiro" (20/10) |
| 5 | `specs/0052-catalogo-sistema-s-selecao-por-tenant.md` (fase 0, fase 1, decisões de 09 e 10/11) | catálogo por portal, carga total, o que esta spec revisa |
| 5 | `specs/0053-catalogo-sistema-s-de-para-catmat.md` | de-para CATMAT (fica fora daqui) |
| 5 | `specs/0064-sistema-s-coleta-camadas.md` | fila, descoberta e carga em que o match roda |
| 7 | `.claude/rules/catmat.md`, `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/database-migrations.md`, `.claude/rules/tests.md` | hierarquia e regras do match; coleta; migration |
| 8 | `supabase/migrations/20260930100000_catalogo_empresa_catmat.sql` (tabela de regras, `catalogo_catmat_pdms_efetivos`, `catmat_itens_mapa`) | o modelo de seleção que esta spec copia |
| 8 | `services/coletor-externo/coletor/catmat_codigo.py` (`categoria_por_codigo`, `carregar_mapa_catmat`) e `services/coletor-externo/coletor/catmat_ancoras.py` (`gerar_ancoras`) | o match por código e o "forte ancorado" do PNCP |
| 8 | `services/coletor-externo/coletor/pncp.py` (`avaliar`, l. 584-699) | ordem: código, texto ancorado, vetos |
| 8 | `services/coletor-externo/coletor/paradigma.py` (`classificar_item_detalhe`, `CATEGORIAS_POR_FONTE`, `produtos_escopo`, `processar_processo`, `carregar`) e `services/coletor-externo/coletor/escopo.py` (`TERMOS_GENERICOS`, `classificar`) | o match do Sistema S hoje e a origem do falso positivo |
| 8 | `supabase/migrations/20261110100000_sistema_s_catalogo.sql` e `services/coletor-externo/coletor/catalogo_paradigma.py` | tabelas do catálogo (fase 1 da 0052) e a carga `--tudo --gravar` |
| 8 | `services/coletor-externo/coletor/reclassificar_escopo_pncp.py` | padrão de reclassificação com dry-run, a copiar para o Sistema S |
| 8 | `.github/workflows/coletor-sistema-s.yml` | workflow sem `uses:`, desativado em 13/11/2026 |
| 10 | `.claude/skills/nova-migration/SKILL.md`, `.claude/skills/validar-migrations/SKILL.md`, `.claude/skills/verificar-producao/SKILL.md`, `.claude/skills/dry-run-classificacao/SKILL.md`, `.claude/agents/revisor-migration.md`, `.claude/agents/revisor-seguranca.md`, `.claude/agents/revisor-codigo.md` | procedimento de cada etapa |

## Problema

Medido em 13/11/2026:

- **Falsos leads em produção.** A coleta da 0064 passou a hidratar o mural inteiro. A carga da FIEB (run
  43504262950, 60 min) hidratou 847 processos e marcou 7 como no escopo. Os 7 são falsos: talha elétrica,
  materiais elétricos, organizadores de cabos e um serviço de desmontagem. Um deles, 47970/m19, ficou em `leads`.
  A causa é o texto: "CONECTOR RETO … COM ANILHAS" e "MANILHA ÂNCORA" casam `anilhas` em
  `escopo.TERMOS_GENERICOS` e saem `forte`, sem catálogo e sem contexto de academia (`classificar_item_detalhe`
  com `produtos=None`). O workflow "Coletor Sistema S" foi desativado em 13/11/2026 por decisão do Marcelo.
- **O catálogo não está no banco.** `select fonte, count(*) from public.sistema_s_catalogo_produtos group by 1`,
  rodada pelo Marcelo em 13/11/2026, não devolveu nenhuma linha. A fase 1 da 0052 (#516) criou as tabelas, mas a
  carga, feita pelo operador, não foi feita.
- **O match por produto usa uma lista fixa por nome.** `CATEGORIAS_POR_FONTE` e `CATEGORIAS_MAPEADAS` em
  `paradigma.py` nomeiam classes por texto. Com o catálogo vazio no banco, cada execução refaz a busca no portal,
  e uma classe renomeada some sem aviso (FIEMS e FIEMT ficaram meses com 0 produtos, comentário do código).
- **O grupo existe no código do produto.** No Sesc BA (pacote de 13/11, `catalogo_produtos.jsonl`: 19.756
  produtos, 402 classes), o primeiro segmento do código (`20.2.1743`) forma 33 grupos, e nenhuma das 402 classes
  aparece em dois grupos. As classes de academia ficam todas no grupo 23:
  - "EQUIPAMENTOS - MUSCULAÇÃO E FITNESS" (21 produtos);
  - "PEÇAS REPOSIÇÃO E ACESSÓRIOS EQUIPAMENTOS DE ACADEMIA, ESPORTE E LAZER" (26);
  - "ACADEMIA E GINÁSTICA" (1).

  A classe "MATERIAIS ESPORTIVOS" (240) fica no grupo 20. O portal não devolve grupo: a entidade
  `CWCatalogoProduto` só tem classe (consulta pública de 13/11). Nos outros 11 portais, a regra de grupo não foi
  medida.
- **A semente existe e não está no repositório.** `C:\Users\marce\licitagym\Sistema - S\catalogo.txt` traz 52
  produtos de academia do Sesc DN (`codigo` = `nCdProduto`, SKU de 15 dígitos ou `PT…`). Um deles é "CADEIRA GAMER
  PROFISSIONAL".
- **No pacote do Sesc BA, 16% dos itens testados vieram sem `nCdProduto`.** O número é do LEIAME do pacote e não
  foi reproduzido aqui. O match por produto não cobre esses itens: eles precisam de texto ancorado.

## Modelo (equivalência com o CATMAT)

| CATMAT (PNCP) | Sistema S (esta spec) |
|---|---|
| Grupo → Classe → PDM → Item | Grupo (prefixo do código, por regra do portal) → Classe (`nCdClasse`) → Produto (`nCdProduto`); o PDM não tem equivalente |
| `catalogo_empresa_catmat` (seleção única da plataforma, níveis, `incluido`) | `sistema_s_catalogo_selecao` (seleção única da plataforma; serve à Konnen; níveis grupo, classe e produto) |
| `catalogo_catmat_pdms_efetivos()` | `sistema_s_produtos_efetivos()` |
| `categoria_por_codigo`: código no catálogo → `catmat`; PDM fora → None (o texto não reabre) | `nCdProduto` efetivo → `forte` (ou `manutencao`, se for peça) com `escopo_metodo='catalogo'`; produto conhecido e fora da seleção → None |
| "forte ancorado" (`catmat_ancoras`) | âncoras geradas da descrição dos produtos efetivos, para o item sem `nCdProduto` |
| vetos de texto (serviço, ar livre, obra) | os mesmos de hoje no `paradigma.py` (serviço, ar livre, brinquedo, `ITEM_FORA`, piso) |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Migration: `sistema_s_catalogo_classes.codigo_grupo` (text, nulo) e `public.fontes_externas`, ou tabela própria, com a regra de grupo do portal (separador e segmento; nulo = portal sem grupo) | — | — | — | só `service_role` |
| K-2 | Migration: `public.sistema_s_catalogo_selecao` (`nivel` grupo, classe ou produto; `fonte`; `codigo_grupo`; `id_classe_fonte`; `id_produto_fonte`; `incluido`; `observacao`; autoria e datas; `chave` gerada e única; CHECK por nível), sem `tenant_id`. RLS ligada, sem policy | — | — | combinação de nível inválida → `check_violation` | escrita só `service_role` |
| K-3 | Função `public.sistema_s_produtos_efetivos()` → (`fonte`, `id_produto_fonte`, `id_classe_fonte`, `codigo_grupo`, `descricao`). A regra mais específica vence (produto > classe > grupo); só `tipo = 'Produto'` | — | lista | — | `service_role` (coletor) |
| K-4 | Workflow `.github/workflows/catalogo-sistema-s.yml` (só `workflow_dispatch`, sem `uses:`): `python -m coletor.catalogo_paradigma --fonte <slug> --tudo --gravar` e o cálculo de `codigo_grupo` pela regra do portal (K-1). A regra só vale se nenhuma classe cair em dois grupos; se cair, o grupo fica nulo no portal inteiro, com aviso | fonte validada contra a lista fixa | contagem de classes e produtos por fonte no log | aviso de paginação → sai 3 e não grava (regra da 0053); 401/403 → para | operador (disparo manual) |
| K-5 | Migration da semente da seleção (`on conflict do nothing`): Sesc DN, os produtos de `catalogo.txt`; Sesc BA, grupo 23 menos as classes de serviço, e classe 141; FIEB, classe 226; FIEMS, classe 20; FIEMT, classes 9, 91, 172 e 191 (as de hoje no código) | — | linhas em K-2 | — | migration |
| K-6 | Coletor: `classificar_item_detalhe` passa a receber os efetivos de K-3 (carregados uma vez por execução) e decide nesta ordem: (1) serviço → fora; (2) `nCdProduto` efetivo → `forte`/`manutencao`, método `catalogo`, com os vetos de texto mantidos; (3) `nCdProduto` conhecido no catálogo e fora da seleção → None; (4) sem `nCdProduto`, ou produto ausente do catálogo → texto ancorado nos produtos efetivos da fonte. `CATEGORIAS_POR_FONTE` e `produtos_escopo` saem do caminho da coleta. Grava `licitacao_itens.id_produto_externo` (o `nCdProduto`) | item, efetivos da fonte | `categoria_escopo`, `escopo_metodo` | falha ao ler K-3 → a execução falha; nunca segue com catálogo vazio calado | coletor |
| K-7 | Coletor: fonte sem nenhum produto efetivo segue só por texto ancorado (sem `nCdProduto`), com aviso no log e em `coleta_externa_run.detalhe_erros`, e não marca nenhum item pelo catálogo | fonte | aviso | — | coletor |
| K-8 | Reclassificação: `python -m coletor.reclassificar_escopo_sistema_s --dry-run` / `--gravar` recalcula `categoria_escopo` dos itens e das licitações do Sistema S já gravados, a partir de `raw`, sem chamar o portal. Mostra a contagem antes e depois por fonte e por categoria. A prioridade continua vindo do status, como hoje | fonte(s) | contagem; com `--gravar`, linhas atualizadas | — | operador |
| K-9 | `specs/nexor_spec_v0.2.xlsx`: a versão de 12/11/2026 15:33 (Downloads) com a aba `SistemaS_Catalogo` acrescentada. Fica ao lado da `specs/nexor_spec.xlsx`, que o `scripts/import-spec.ts` lê hoje (o cabeçalho de `Pipeline_Etapas` mudou na v0.2). A troca é o CHG-18, no PR-2 da 0066. A aba traz hierarquia, equivalência com o CATMAT, ordem do match, semente, regra de grupo por portal, pendências | — | planilha | — | `/spec` (esta spec) |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-2, K-3 | **Dado** os papéis `anon` e `authenticated`, **quando** se consulta `has_table_privilege` em K-2 e `has_function_privilege` em K-3, **então** dá `false` (negativo de acesso); `service_role` lê e grava K-2 e executa K-3; RLS ligada sem policy. | SQL `supabase/tests/sistema_s_catalogo_selecao_check.sql` |
| CA-2 | K-3 | **Dado** o grupo 23 do Sesc BA incluído, a classe de serviço 729 dele excluída, um produto do grupo excluído e um produto de outra classe incluído avulso, **quando** se lê K-3, **então** vêm os produtos do grupo menos a classe 729 e o produto excluído, mais o avulso; produto do tipo Serviço nunca vem; a mesma regra em outro portal não conta. | mesmo check |
| CA-3 | K-4 | **Dado** um catálogo falso em que uma classe aparece em dois prefixos, **quando** roda a carga com a regra de grupo, **então** `codigo_grupo` fica nulo em todo o portal e o log avisa; com prefixos consistentes, cada classe ganha o grupo do prefixo. | pytest `services/coletor-externo/tests/test_catalogo_paradigma.py` |
| CA-4 | K-6 | **Dado** os efetivos do Sesc BA, **quando** classifica um item com `nCdProduto` efetivo, **então** `forte` e método `catalogo`; com `nCdProduto` conhecido e fora da seleção, mesmo com "esteira" no texto, **então** fora (como o PDM fora no CATMAT); com o mesmo produto "ACADEMIA AO AR LIVRE", **então** fora (veto mantido). | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-5 | K-6 | **Regressão (falsos leads da FIEB, 13/11/2026):** **dado** os itens "CONECTOR RETO MACHO 1/2" NPT X 1/2" OD INOX 304 COM ANILHAS" e "MANILHA ÂNCORA COM PINO ROSCADO" sem `nCdProduto` efetivo, **quando** classifica, **então** nenhum sai no escopo; "ANILHA OLÍMPICA 20 KG" com o objeto de academia continua `forte`. | mesmo pytest |
| CA-6 | K-6, K-7 | **Dado** uma fonte sem produto efetivo, **quando** a carga roda, **então** o aviso sai no log e no `detalhe_erros`, e nenhum item recebe método `catalogo`; **dado** falha ao ler K-3, **então** a execução termina `falhou`, sem classificar nada. | mesmo pytest |
| CA-7 | K-8 | **Dado** os 7 processos da FIEB marcados em 13/11 (47970, 47990 e os outros do run 43504262950) em fixture, **quando** roda `--dry-run`, **então** a contagem mostra os 7 saindo do escopo e nada é gravado; com `--gravar`, `categoria_escopo` fica nula e a prioridade derivada do status não muda. | pytest `services/coletor-externo/tests/test_reclassificar_escopo_sistema_s.py` |
| CA-8 | K-4 | **Dado** o workflow, **então** não usa `uses:`; as entradas chegam só por `env` e a fonte é validada por lista fechada antes de virar argumento; `SUPABASE_SERVICE_ROLE_KEY` só no passo da carga. | pytest `services/coletor-externo/tests/test_ci_catalogo_sistema_s.py` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-3, K-5 | `/spec` | skill `nova-migration` | SQL `_check` + skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL) | skill `verificar-producao` + `get_advisors` |
| K-4 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` + `revisor-seguranca` (secrets do workflow) | carga por fonte, com a contagem registrada no PR; `verificar-producao` |
| K-6, K-7 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | skill `dry-run-classificacao` (o Marcelo roda e anexa a contagem); `verificar-producao` |
| K-8 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | contagem do `--dry-run` no PR, `--gravar` só com o ok do Marcelo; `verificar-producao` |
| K-9 | `/spec` | esta spec | — | — | — |

## Fases (cada uma é um PR; a ordem importa)

1. **Carga do catálogo (K-4, K-1 regra de grupo).** Workflow e regra de grupo; carga por fonte em produção, com a
   contagem no PR. Destrava os pré-requisitos da 0065 e do pacote de preços do Sistema S.
2. **Seleção (K-2, K-3, K-5).** Migration da seleção e dos efetivos e a semente.
3. **Match no coletor (K-6, K-7) e regra "anilha".** Inclui o dry-run de classificação.
4. **Reclassificação (K-8)** dos itens já gravados, primeiro com `--dry-run` e depois com `--gravar`. Só então se
   religa o workflow "Coletor Sistema S" (`gh workflow enable`), com ok do Marcelo.

## Fora de escopo

- Seleção por tenant: a seleção é única e serve à Konnen, como o CATMAT (decisão de 13/11/2026). A seleção por
  tenant, quando houver um segundo cliente, entra junto para o CATMAT e o Sistema S.
- Tela de seleção no Dashboard: a seleção sai por migration até haver tela (ver pergunta 5).
- De-para Sistema S ↔ CATMAT (`specs/0053`). Para preço, o Sistema S usa a rota própria pelo produto do portal
  (pacote `entrega_precos_sistema_s.zip`, a virar spec própria).
- Editais dos módulos 900 a 907 do Sesc DN e processos com `nCdOrigem` nulo. A coleta antiga e a nova não leem
  esses processos; o caminho foi medido em 13/11 (`PesquisarProcessoDetalhes` com `nCdEdital` e
  `tmpTipoMuralProcesso = 2`). Vai para spec própria.
- Achado "CATMAT divergente" (TR × código), que também não existe no PNCP hoje.
- Embedding do catálogo (decisão de 09/11: só sob demanda).

## Impacto em dados

- **Migration:** sim, duas, aditivas e idempotentes:
  - seleção, efetivos e coluna de grupo (fase 2; a coluna de grupo pode entrar já na fase 1);
  - semente (`on conflict do nothing`), que não sobrescreve regra editada.
- **Tabelas/views/funções tocadas:**
  - `sistema_s_catalogo_classes` (`codigo_grupo`): escrita pela carga e lida por K-3;
  - `sistema_s_catalogo_produtos`: escrita pela carga;
  - `sistema_s_catalogo_selecao`: escrita por migration e lida por K-3;
  - `sistema_s_produtos_efetivos()`: lida pelo coletor;
  - `licitacao_itens` (`id_produto_externo`, `categoria_escopo`, `escopo_metodo`) e `licitacoes_externas`
    (`categoria_escopo`): escritas pelo coletor e por K-8.
- **ACL/RLS:** tabela nova com RLS ligada, sem policy e sem grant a `anon`/`authenticated`; a função K-3 executável
  só por `service_role`.
- **Backfill/reprocessamento:** sim.
  - Carga do catálogo nos 12 portais medidos na fase 0: 505.141 produtos (`specs/0052`, 09/11/2026). O tamanho em
    disco não foi medido.
  - Reclassificação dos itens do Sistema S já gravados (K-8), com contagem antes e depois no PR.
- **Edge Functions republicadas no merge:** todas (regra do merge); nenhuma muda nesta spec.
- **Contrato com o Dashboard:** inalterado. Itens do Sistema S passam a ter `escopo_metodo = 'catalogo'` com mais
  frequência; os campos lidos são os de hoje.
- **Dado oficial x derivado:**
  - oficial: classe, produto, código e descrição, como o portal devolve;
  - derivado: `codigo_grupo` (prefixo do código, por regra declarada por portal, nulo quando a regra não se
    sustenta) e a categoria de escopo.

## Decisões do Marcelo

- 13/11/2026: o coletor do Sistema S segue o escopo Grupo → Classe → Produto, com o mesmo processo de match do
  PNCP × CATMAT.
- 13/11/2026: sem tenant novo: o Sistema S complementa a Konnen. A seleção é única da plataforma, como o CATMAT.
- 13/11/2026: a fase 5 da 0052 (de-para CATMAT) não é necessária para o Sesc BA, porque o preço do Sistema S tem
  rota própria pelo produto do portal.
- 13/11/2026: workflow "Coletor Sistema S" desativado até corrigir o classificador e o match pelo catálogo.
- 13/11/2026: complementar a planilha da spec com a versão de 12/11 (Downloads) e uma aba do Sistema S. Em 14/11 ela
  ficou em `specs/nexor_spec_v0.2.xlsx`, porque o import-spec ainda lê o formato antigo.

## Perguntas em aberto

1. **Produto fora da seleção:** quando o item traz `nCdProduto` de um produto do catálogo fora da seleção, ele fica
   fora mesmo com texto de academia (como o PDM fora no CATMAT, `categoria_por_codigo`)? Ou o texto do item reabre,
   pela regra "TR é a fonte da verdade"?
2. **Semente do Sesc DN:** a "CADEIRA GAMER PROFISSIONAL" de `catalogo.txt` entra?
3. **Semente do Sesc BA:**
   - A classe 141 "MATERIAIS ESPORTIVOS" entra inteira (240 produtos, de bola a medalha)?
   - A classe 494 "PEÇAS REPOSIÇÃO… ACADEMIA" entra como `manutencao`?
   - As classes de serviço do grupo 23 (729 manutenção, 639 locação) ficam fora (serviço nunca vira lead)?
4. **Regra de grupo nos outros 11 portais:** aceita grupo nulo (classe como nível mais alto) onde o prefixo não se
   sustentar? A medição só sai depois da carga.
5. **Seleção sem tela:** a seleção muda só por migration até existir tela? Ou a tela (`api` + Dashboard, como
   `/catmat`) entra já?
6. **Reativação da coleta:** religar o workflow depois das fases 3 e 4 em produção, ou antes, só com a regra
   "anilha" corrigida?

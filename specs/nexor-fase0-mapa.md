# Nexor Fase 0: mapa conceito → tabela

Decisão do Marcelo (07/11/2026): **estender as tabelas que já existem**. Criar só o que falta. Este mapa vale para
os PRs da Fase 0. Fonte: `specs/nexor_spec.xlsx` (aba indicada) e schema de produção lido em 07/11/2026.

## Mapa

| Conceito do prompt | Aba da planilha | Tabela no banco | Situação | PR |
|---|---|---|---|---|
| `holidays_national` | Documentacao_Edital M34:O52 | `feriados_nacionais` (nova) | **criada** | 1 |
| `regimes` | Padrao_Lei, seção 3 | `regimes` (nova) | **criada** | 1 |
| `tenants` | Nexor_Dados (`nx_tn_*`, `nx_emp_*`) | `tenants` + `tenant_dados_restritos` + `tenant_regras_comerciais` | existe; faltam marca (`nx_tn_*`) e dados da proposta (`nx_emp_*`) | 3 |
| `pipeline_stages` (catálogo) | Glossario 2a, Pipeline_Etapas | `processo_fases` (`norma = 'NX'`) | **criadas** as 14 etapas A01–R14 | 2 |
| `pipeline_stages` (tenant) | Pipeline_Etapas | `pipeline_etapas` (por tenant) | padrão de tenant novo; Konnen em PR próprio com dry-run | 3 |
| `task_templates` | Tarefas_Default, Glossario §2b e §3 | `tarefas_catalogo` (`norma = 'NX'`) + `tarefas_catalogo_apelidos` | **criados** 23 modelos NX e 45 apelidos | 2 |
| `task_instances` | — | `tarefas_equipe` | existe; muda só o cálculo de prazo (0041 K-4) | 3 |
| `legal_blocks` (22 × 5) | Padrao_Lei, seções 1 e 2 | `norma_dispositivos` guarda artigo; a matriz bloco × procedimento **não existe** | **criada** `blocos_legais` (110 linhas, regime `lei_14133`) | 3b |
| `documents` | RAG_Schema §1 | `licitacao_documentos` + `licitacao_documento_versoes` | existe; conferir campos (`sha256`, `paginas`, `regime`) | Fase A |
| `chunks` | RAG_Schema §2 | `licitacao_chunks` | existe; faltam `clausula`, `caminho`, `temas`, `prazos_detectados` | Fase A |
| `persons` | RAG_Schema §5 | — | nova: `pessoas` (sem CPF, RG nem e-mail pessoal) | Fase A |
| `normalized_items` | RAG_Schema §6 | — | nova: `itens_normalizados` | Fase A |
| `doc_gates` | Documentacao_Edital §1 | — (achados vão para `agente_execucoes`) | nova, se o gate precisar de estado próprio | Fase A |
| `session_events` | Sessao_PE138 | — | nova: `sessao_eventos` | Fase S |
| `proposals`, `proposal_items` | Proposta_Nexor, Nexor_Dados | — | novas: `propostas`, `proposta_itens` | Fase P |

## PR 1 (#465, mergeado em 07/11/2026)
- `feriados_nacionais` (18 linhas, 2026–2027) e `regimes` (5), escrita só por migration e leitura só `service_role`.
- `scripts/import-spec.ts` gera o bloco de seed a partir da planilha. Nada vai direto ao banco.
- Teste Deno compara o bloco da migration com o que o script gera (drift planilha × banco).

## PR 2 (etapas e modelos NX)
Migration `20261107220000_nexor_modelos_nx.sql`, bloco gerado por `scripts/import-spec.ts --bloco=modelos`.

Como cada campo obrigatório foi preenchido sem inventar dado:
- **Etapa** (`processo_fases`): código, grupo e nome do Glossario 2a; ordem da Pipeline_Etapas (conferida com o
  código). `descricao` junta, sem reescrever, grupo, coluna atual, entrada automática, gatilho e guardrail da
  Pipeline_Etapas. `macro`: R12 (Ata e execução) = `contrato`; as demais = `certame` (Perdida e Descartada encerram o
  certame). `artigos` vazio: a base legal entra com os blocos legais (PR 3).
- **Código do modelo**: `NX.GEN.<etapa>.<bloco>.<seq>-<DV>`. Etapa e bloco vêm da Tarefas_Default via Glossario 2a/2b;
  o script recalcula o id e exige que bata com o id que o Glossario 3 calcula por fórmula (as 34 linhas batem).
- **Prazo**: `prazo_horas_apos_etapa` preenchido → `sem_prazo_legal` + coluna nova `prazo_horas_apos_etapa` (SLA
  interno, não é prazo legal); `prazo_evento` preenchido → `definido_no_edital` + `prazo_observacao` com o texto da
  planilha. Os dois ou nenhum → erro. Aqui `definido_no_edital` quer dizer "prazo em texto, ainda não estruturado":
  NX-T29 (antes do limite de impugnação, art. 164) e NX-T23 (recorrente até o fim da ARP) ficam assim até o cálculo
  de prazo da 0041 K-4 estruturá-los.
- **Responsável**: copiado da planilha e validado no formato `papel:<admin|operacao>` ou `agente:<nome>`, combinável
  com ` + `. O nome do agente é o da planilha (`precos`), não o código de `agentes_catalogo` (`preco`): quem for usar
  a coluna para despachar agente precisa mapear antes.
- **Recarga**: o seed faz `on conflict ... do update` só em linha `norma = 'NX'`. Uma migration futura gerada da
  planilha sobrescreve edição manual de admin em modelo NX: a planilha é a fonte. Edição manual que deva ficar vai
  para a planilha.
- **Condição**: `sempre` → `{}`; texto → `{"condicao_nx": "<texto>"}`, que `catalogo_condicao_avaliar` avalia como
  `null` ("não verificada"), nunca `true`.
- **Descrição e saída**: `descricao` e `saida_esperada` = `criterio_conclusao`; `responsavel_padrao` = coluna
  `responsavel` (só sugestão: o tenant decide).
- **Apelidos**: 33 NX-T ativos (NX-T18 → F05-T01 e F05-T02); id NX dos 10 NX-T mapeados para a 14.133; NX-T34 sem
  apelido.

Fica para o PR 3: etapas por tenant (`pipeline_etapas`), blocos legais, marca do tenant e cálculo de prazo (0041 K-4).

## PR 3a (#484, mergeado em 08/11/2026)
Dias úteis com feriados nacionais (`_shared/prazos/dias-uteis.ts`) e prazo de impugnação do agente de edital
(spec 0041 K-2 e K-3). Sem migration.

## PR 3b (blocos legais)
Migration `20261108230000_nexor_blocos_legais.sql`, bloco gerado por `scripts/import-spec.ts --bloco=blocos`.
- **Fonte:** Padrao_Lei seção 1 (matriz 22 blocos × 5 procedimentos, célula `Obrig.|Cond.|N/A [· n unidade
  antes|depois âncora] [confiança]`) e seção 2 (detalhe do pregão).
- **Regime:** `lei_14133`, lido do título da seção 2 ("Lei 14.133 + IN SEGES 73/2022"). Título sem "Lei 14.133" →
  erro; o gerador não adivinha regime.
- **Pregão:** a matriz e o detalhe têm de bater (status, quantidade, unidade, confiança, sentido e âncora). Divergência
  → erro. O detalhe completa sentido e âncora sem quantidade (proposta: "até a abertura da sessão").
- **Outros procedimentos:** só o que a matriz diz; condição, base legal, parte obrigada, temas e variações ficam
  `null` (não pesquisados).
- **Unidade:** `ano(s)` da planilha vira `anos`.
- **Achado na planilha:** os textos da seção 2 param em tetos fixos (condição 230, base legal 130, variações 160
  caracteres): vieram cortados na própria planilha, às vezes com "…", às vezes no meio da frase (ex.: variações das
  linhas 29 e 32). Entram como estão, com aviso no comentário de cada coluna; completar é na planilha. Agente que
  citar esses campos confere a fonte antes.
- **Layout:** coluna a mais ou linha em branco no meio de qualquer das duas seções dá erro (nada some em silêncio).

Fica para depois: etapas por tenant, marca do tenant e prazo de tarefa em dias úteis (0041 K-4).

### Achado na planilha
- A aba PRD (C32) dava o exemplo `NX.GEN.A02.IMP.005-8`, mas 8 é o DV com origem `LG`. Em 07/11 a planilha passou
  inteira para NX: códigos curtos `LG-Txx` → `NX-Txx` (mesmo número e conteúdo), Glossario D5:D12 e fórmula de
  F44:F77 com origem `NX` (`NX.GEN.A02.IMP.005-4`), PRD C19/C31/C32 atualizados. O apelido curto no banco é
  `sistema = 'nx_t'`; `LG-Txx` não é gravado (a tabela ainda não existia em produção, nada a migrar).

## Decisões do Marcelo (07/11/2026)

### Valem para o PR 1 (este)
- **Regime canônico = Padrao_Lei.** Os 5 ids deste PR (`lei_14133`, `lei_13303`, `sistema_s_sesc_senac`,
  `sistema_s_sesi_senai`, `lei_14981`) são os únicos. O vocabulário da RAG_Schema (`sistema_s`, `estatal_13303`,
  `outro`) não entra no banco: documento de regime não identificado fica com regime `null` (desconhecido), nunca
  `outro`. A aba RAG_Schema da planilha deve passar a citar esses ids.
- **`npm:xlsx@0.18.5`: risco aceito.** CVE-2023-30533 e CVE-2024-22363 afetam leitura de arquivo malicioso; a entrada
  é só a planilha versionada (revisada em PR) e o script nunca é importado em `supabase/functions/**`.
- **Nome de vencedor na aba Orgao_SSP_SP ("MANOEL GOMES", I6 e I11): mantido.** Dado público de homologação, sem CPF.
  A regra de LGPD do Nexor (não guardar CPF, RG, e-mail pessoal) continua valendo para qualquer tabela.

### Valem para o PR 2 (modelos de tarefa e etapas)
1. **Modelo NX em `processo_fases` + `tarefas_catalogo`.** As 14 etapas A01–R14 entram em `processo_fases` com
   `norma = 'NX'`; os 23 modelos NX novos (18 novos + 5 dos parciais) entram em `tarefas_catalogo` com `norma = 'NX'`.
   `natureza` e `ator` vêm da planilha: a aba Tarefas_Default ganha as duas colunas, preenchidas pelo Marcelo, e o
   gerador lê de lá (nada de valor inventado). Valores aceitos pelo banco (lidos em 07/11):
   - `natureza` (enum `tarefa_natureza`): `obrigacao`, `faculdade`, `direito`, `acompanhamento`, `preparacao`;
   - `ator` (check): `licitante`, `contratado`, `licitante_ou_contratado`.
   O gerador falha se a coluna estiver vazia ou com valor fora da lista.
2. **Apelidos em tabela própria:** `tarefas_catalogo_apelidos (tarefa_codigo, sistema in ('nx','nx_t'), apelido)`,
   unique `(sistema, apelido, tarefa_codigo)`. Aceita o NX-T18 apontando para F05-T01 e F05-T02.
3. **Etapas Nexor só para tenant novo.** As 14 etapas viram o padrão de tenant novo. A Konnen fica como está; migrá-la
   é PR próprio, com dry-run (contagem por etapa antes/depois) e ok do Marcelo.
4. **Parciais do de-para aprovados:** 3 apelidos (T16, T19, T22) e 5 NX novas (T09, T11, T20, T21, T32). Ver
   `specs/nexor-de-para-tarefas.md`.

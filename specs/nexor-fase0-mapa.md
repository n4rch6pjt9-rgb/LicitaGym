# Nexor Fase 0: mapa conceito → tabela

Decisão do Marcelo (07/11/2026): **estender as tabelas que já existem**. Criar só o que falta. Este mapa vale para
os PRs da Fase 0. Fonte: `specs/nexor_spec.xlsx` (aba indicada) e schema de produção lido em 07/11/2026.

## Mapa

| Conceito do prompt | Aba da planilha | Tabela no banco | Situação | PR |
|---|---|---|---|---|
| `holidays_national` | Documentacao_Edital M34:O52 | `feriados_nacionais` (nova) | **criada** | 1 |
| `regimes` | Padrao_Lei, seção 3 | `regimes` (nova) | **criada** | 1 |
| `tenants` | Nexor_Dados (`nx_tn_*`, `nx_emp_*`) | `tenants` + `tenant_dados_restritos` + `tenant_regras_comerciais` | existe; faltam marca (`nx_tn_*`) e dados da proposta (`nx_emp_*`) | 2 |
| `pipeline_stages` | Pipeline_Etapas | `pipeline_etapas` (por tenant) | existe; faltam `codigo_nx` (A01–R14), `grupo` e regra de entrada automática | 2 |
| `task_templates` | Tarefas_Default, Glossario §3 | `tarefas_catalogo` (plataforma) + `pipeline_etapa_tarefas` (por tenant) | existe; faltam código NX, apelido LG-T e campos da planilha | 2 |
| `task_instances` | — | `tarefas_equipe` | existe; muda só o cálculo de prazo (0041 K-4) | 3 |
| `legal_blocks` (22 × 5) | Padrao_Lei, seções 1 e 2 | `norma_dispositivos` guarda artigo; a matriz bloco × procedimento **não existe** | nova: `blocos_legais` | 2 |
| `documents` | RAG_Schema §1 | `licitacao_documentos` + `licitacao_documento_versoes` | existe; conferir campos (`sha256`, `paginas`, `regime`) | Fase A |
| `chunks` | RAG_Schema §2 | `licitacao_chunks` | existe; faltam `clausula`, `caminho`, `temas`, `prazos_detectados` | Fase A |
| `persons` | RAG_Schema §5 | — | nova: `pessoas` (sem CPF, RG nem e-mail pessoal) | Fase A |
| `normalized_items` | RAG_Schema §6 | — | nova: `itens_normalizados` | Fase A |
| `doc_gates` | Documentacao_Edital §1 | — (achados vão para `agente_execucoes`) | nova, se o gate precisar de estado próprio | Fase A |
| `session_events` | Sessao_PE138 | — | nova: `sessao_eventos` | Fase S |
| `proposals`, `proposal_items` | Proposta_Nexor, Nexor_Dados | — | novas: `propostas`, `proposta_itens` | Fase P |

## PR 1 (este)
- `feriados_nacionais` (18 linhas, 2026–2027) e `regimes` (5), escrita só por migration e leitura só `service_role`.
- `scripts/import-spec.ts` gera o bloco de seed a partir da planilha. Nada vai direto ao banco.
- Teste Deno compara o bloco da migration com o que o script gera (drift planilha × banco).

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
2. **Apelidos em tabela própria:** `tarefas_catalogo_apelidos (tarefa_codigo, sistema in ('nx','lg_t'), apelido)`,
   unique `(sistema, apelido, tarefa_codigo)`. Aceita o LG-T18 apontando para F05-T01 e F05-T02.
3. **Etapas Nexor só para tenant novo.** As 14 etapas viram o padrão de tenant novo. A Konnen fica como está; migrá-la
   é PR próprio, com dry-run (contagem por etapa antes/depois) e ok do Marcelo.
4. **Parciais do de-para aprovados:** 3 apelidos (T16, T19, T22) e 5 NX novas (T09, T11, T20, T21, T32). Ver
   `specs/nexor-de-para-tarefas.md`.

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

## Decisões para o PR 2 (modelos de tarefa e etapas)
1. **Onde mora o modelo NX.** `tarefas_catalogo.fase_codigo` aponta para `processo_fases` (F01–F12 da 14.133), e
   `natureza` e `ator` são obrigatórios. Proposta: as 14 etapas A01–R14 entram em `processo_fases` com
   `norma = 'NX'`, e os modelos NX novos em `tarefas_catalogo` com `norma = 'NX'`. `natureza` e `ator` dos 18 novos não
   estão na planilha: vão como `TODO(spec)` para você preencher, ou a planilha ganha as duas colunas.
2. **Apelidos.** O LG-T18 corresponde a dois modelos (F05-T01 e F05-T02), então o apelido não cabe numa coluna única
   do catálogo. Proposta: tabela `tarefas_catalogo_apelidos (tarefa_codigo, sistema in ('nx','lg_t'), apelido)`.
3. **Etapas por tenant.** `pipeline_etapas` é por tenant e a Konnen já tem as suas. As 14 colunas novas entram como
   padrão de tenant novo; migrar a Konnen exige dry-run (contagem por etapa antes/depois) e o seu ok.
4. **Regime: dois vocabulários na planilha.** RAG_Schema usa `lei_14133 | lei_14981 | sistema_s | estatal_13303 |
   outro`; Padrao_Lei usa os 5 ids carregados neste PR. O PR 1 segue a Padrao_Lei. Qual vale?

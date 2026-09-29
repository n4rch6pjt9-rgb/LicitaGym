---
doc_id: lg-arq-conectividade-v1
titulo: "Conectividade e infraestrutura de IA no LicitaGym: achados reais e melhor cenário de uso"
dominio: arquitetura_ia
subdominio: [latencia, regiao, embeddings, rag, resiliencia, custo, mcp, observabilidade, topologia_agentes]
projeto: LicitaGym
supabase_project_ref: ifaiagegyicjzlpskafh
fonte_conceitual: "UNIPDS - Material de Apoio - Conectividade: A Fundação de Tudo (live Matheus Freitas, 30/07/2026)"
fonte_empirica: "Inspeção do banco (Supabase MCP, só leitura) e do repositório local em 29/09/2026"
nivel_confianca: interno_revisado
versao: 1.0
data: 2026-09-29
idioma: pt-BR
instrucao_de_uso: "Cada seção H2 é autocontida e pode virar um chunk. Nada aqui foi aplicado; as ações são PROPOSTA."
---

# Conectividade e infraestrutura de IA no LicitaGym

> **Como este documento foi feito.** Os conceitos vêm do material da live "Conectividade: A Fundação de Tudo". Os achados vêm de consultas ao banco `ifaiagegyicjzlpskafh` (só leitura) e da leitura do código em 29/09/2026. Nada foi alterado.

---

## 1. Resposta curta: qual o melhor uso deste material no LicitaGym

**Contexto:** síntese para decisão.

O material não traz um "bug" para corrigir como o de prompt injection trouxe. O melhor uso dele é outro: **virar os requisitos não funcionais do Agente de Edital e do assistente RAG antes de construí-los**. Três pontos, em ordem:

1. **Corrigir agora (achado real, seção 3):** as duas bases vetoriais estão em **espaços de embedding diferentes** e nenhuma registra o modelo usado. Um assistente que gere um único vetor para a pergunta e busque nas duas bases vai recuperar lixo em uma delas. A base de legislação, além disso, discrimina mal (pares aleatórios têm similaridade média 0,95).
2. **Decidir antes de construir o assistente:** região do modelo (hoje Vertex em `us-central1`, banco em São Paulo), orçamento de latência por etapa, padrão de comunicação (fila para análise de edital, streaming para chat), topologia simples (pipeline, não mesh) e limites de loop e custo.
3. **Reaproveitar o que já está maduro:** a camada de coleta do PNCP já implementa quase todo o capítulo de resiliência da live (timeout hierárquico, backoff com jitter, Retry-After, lease por host, telemetria). O mesmo padrão deve ser copiado para as chamadas de IA em Python, que ainda não têm jitter nem orçamento.

---

## 2. Mapa: conceito da live → estado real do LicitaGym

**Contexto:** onde o projeto já está, onde falta e o que fazer.

| Conceito (seção da live) | Estado no LicitaGym (29/09/2026) | Lacuna | Ação |
|---|---|---|---|
| Região e latência (2, 4.4) | Supabase em `sa-east-1` (São Paulo). Vertex AI com `GOOGLE_CLOUD_LOCATION` padrão `us-central1` (`services/coletor-externo/coletor/ia.py`) | Hoje só lote, então tolerável. No assistente interativo, cada pergunta faz ida e volta aos EUA 2 vezes (embedding + geração) | Medir p50/p95/jitter por região antes de escolher (seção 4) |
| Hops e topologia (3) | Não há agente em produção. Classificação de itens é determinística (dicionário de aparelhos v0.3) | Risco de desenhar o Agente de Edital como mesh | Pipeline sequencial com etapas determinísticas + LLM só onde precisa (seção 6) |
| RAG × CAG (5) | 2 bases vetoriais (`licitacao_chunks` 403, `legislacao_embeddings` 257) | Modelos de embedding diferentes e não registrados | Seção 3. CAG faz sentido para remissões da Lei 14.133 (seção 7) |
| Padrões de comunicação (6) | Coleta por cron (assíncrona); Dashboard via REST; `private.job_queue` existe | Nenhum padrão definido para análise de edital e chat | Fila para edital, streaming para chat (seção 5) |
| MCP (7) | Dois conectores Supabase: um só leitura, um com escrita | O de escrita pode alterar produção fora do ciclo de PR | Regras de uso (seção 8) |
| Roteamento e fallback (8) | Um provedor (Vertex/Gemini). O Dashboard já estourou cota do Gemini (PRD v2.1) | Sem fallback de geração. **Fallback de embedding é impossível** sem reindexar | Router só para geração; embedding fixo por base (seção 3.4) |
| Guardrails e WAF (9) | Aplicados em 29/09: ACL do RAG, scanner, `v2` por confiança (doc `seguranca-prompt-injection-v1`) | Sem rate limit nas Edge Functions públicas | Rate limit por usuário no endpoint do assistente |
| Custo e loops (10) | `econodata_consultas` guarda `tokens_estimados` e `tokens_cobrados` (estimativa antes de gastar) | Vertex sem orçamento por execução/dia; código da função Econodata não está no repositório | Tabela de uso de IA + limite diário (seção 9) |
| Observabilidade (11) | `pncp_sync_run`, `pncp_sync_request_telemetry`, `consultas_log` com trace (29/09) | `consultas_log` não guarda latência por camada, tokens nem custo | Acrescentar esses campos quando o assistente nascer (seção 10) |
| Resiliência (12) | PNCP: timeout por tentativa limitado pelo orçamento restante, backoff + jitter, Retry-After, lease por host | Python/Vertex: backoff sem jitter, sem orçamento global | Portar o padrão do `retry.ts` (seção 11) |

---

## 3. Achado principal: duas bases vetoriais, dois espaços de embedding, nenhum registro

**Contexto:** medido no banco em 29/09/2026. É o ponto da live sobre RAG (seção 5) somado ao de fallback (seção 8).

### 3.1 Evidência

| Medida | Valor | Leitura |
|---|---|---|
| Norma dos vetores (as duas bases) | 1,000 | Ambos normalizados; a norma não distingue os modelos |
| Similaridade média entre pares aleatórios **dentro** de `licitacao_chunks` | 0,823 | Normal para um mesmo modelo |
| Similaridade média entre pares aleatórios **dentro** de `legislacao_embeddings` | **0,951** | Quase tudo parece igual: baixa capacidade de discriminar |
| Similaridade média **entre** as bases (legislação × chunks) | **0,043** | Vetores praticamente ortogonais: são modelos diferentes |
| Campo com o nome do modelo nos metadados | nenhum, nas 660 linhas | Não há como saber, pelo banco, qual modelo gerou cada vetor |

**Origem provável** (pelo código):
- `licitacao_chunks`: Vertex `text-multilingual-embedding-002`, 768 dimensões (`services/coletor-externo/coletor/ia.py`).
- `legislacao_embeddings`: agente jurídico local, padrão `pierreguillou/bert-base-cased-squad-v1.1-portuguese` (`docs/agente-juridico-ml/embeddings_backend.py`). Esse é um modelo de **pergunta e resposta (SQuAD)**, não de embedding de frases. Isso explica a similaridade 0,95 entre textos sem relação.

### 3.2 Consequências

1. **Assistente com um único vetor de pergunta:** se a Edge Function gerar o embedding da pergunta com o Vertex e consultar as duas bases, a busca na legislação devolve resultados aleatórios.
2. **`match_legislacao_embeddings` com `match_threshold = 0.7` (padrão):** com similaridade média 0,95, praticamente todo artigo passa no limiar. O filtro não filtra.
3. **Fallback impossível:** a live recomenda fallback entre provedores (seção 8). Para geração isso vale. Para embedding, **não**: um vetor de pergunta de outro modelo não é comparável aos vetores da base. Trocar o modelo de embedding exige reindexar a base inteira.
4. **Drift silencioso:** sem registro do modelo, um reindex parcial com outro modelo mistura espaços na mesma tabela, e ninguém percebe.

### 3.3 Ação proposta (PROPOSTA)

1. Reindexar `legislacao_embeddings` com o **mesmo modelo** de `licitacao_chunks` (`text-multilingual-embedding-002`, `task_type = RETRIEVAL_DOCUMENT` nos documentos e `RETRIEVAL_QUERY` na pergunta). São 257 linhas: poucas chamadas, custo baixo.
2. Registrar o modelo em coluna, não em JSON solto:

```sql
-- PROPOSTA (não aplicada)
alter table public.legislacao_embeddings
  add column embedding_model text,
  add column embedding_versao text;
alter table public.licitacao_chunks
  add column embedding_model text,
  add column embedding_versao text;
-- depois do reindex:
-- alter table ... alter column embedding_model set not null;
-- check (embedding_model = 'text-multilingual-embedding-002') enquanto houver um só modelo
```

3. As funções `match_*` passam a receber o modelo da pergunta e recusam se for diferente do da base.
4. Recalibrar o `match_threshold` da legislação depois do reindex, medindo com o golden set (seção 13).

### 3.4 Regra de roteamento derivada

| Chamada | Pode ter fallback para outro provedor? | Motivo |
|---|---|---|
| Geração (resposta, resumo, extração) | Sim | Saída é texto; outro modelo produz texto comparável |
| Embedding de documento | **Não** | Vetor precisa estar no espaço da base |
| Embedding de pergunta | **Não** (só o mesmo modelo em outra região) | Mesmo motivo; fallback de região do mesmo modelo é aceitável |

---

## 4. Região e latência: medir antes de decidir

**Contexto:** caso dos 180 ms da live (seção 2) aplicado ao LicitaGym.

- **Hoje:** o banco está em São Paulo (`sa-east-1`) e as chamadas de IA vão para `us-central1` por padrão. Na coleta em lote isso não importa: o gargalo é a cota do Vertex (5 requisições/min por região nos modelos `text-*-embedding` em projetos novos, conforme o comentário do código), não a rede.
- **Quando importa:** no assistente interativo. Uma pergunta faz pelo menos: Edge Function → Vertex (embedding) → Supabase (busca) → Vertex (geração) → usuário. São duas idas e voltas aos EUA dentro do prazo do usuário.
- **Pergunta de arquitetura da live, aplicada:** antes de escolher a região, medir de onde a Edge Function roda até cada região candidata: número de saltos, latência média, **p95** e jitter.
- **Candidatas:** `us-central1` (atual) e `southamerica-east1` (São Paulo). **Confirmar** se `text-multilingual-embedding-002` e `gemini-2.5-flash` estão disponíveis na região de São Paulo antes de trocar. Se o modelo de embedding não existir lá, a regra da seção 3.4 impede trocar só a região da pergunta.
- **Bônus de LGPD:** processar em São Paulo mantém propostas e dados de fornecedores no Brasil.

**Script de medição sugerido:** 50 chamadas de embedding de uma frase curta por região, a partir de uma Edge Function (não do notebook do desenvolvedor), registrando p50, p95, máximo e desvio padrão.

---

## 5. Padrões de comunicação por fluxo do produto

**Contexto:** seção 6 da live aplicada aos fluxos reais.

| Fluxo | Padrão recomendado | Por quê |
|---|---|---|
| Coleta PNCP, Compras.gov, Sistema S | Assíncrono (cron + lock + telemetria), **já é assim** | Tolerância a falha importa mais que tempo |
| Análise de edital (PDF, OCR, extração de itens, classificação) | **Assíncrono com fila** (`private.job_queue` já existe) | PDF grande, OCR e LLM podem passar de minutos; o usuário recebe aviso quando terminar |
| Dashboard (listas, filtros, BI) | Síncrono REST, como hoje | Leitura rápida de dados já prontos |
| Chat do assistente (lei, edital, recurso) | **Streaming** | Resposta de LLM longa; o usuário vê o texto chegando |
| WebSocket | Não se aplica agora | Nenhum fluxo de voz ou interação contínua |

**Regra da fila (live, 6.1):** fila resolve falha, não prazo. Se um edital tem prazo de impugnação amanhã, a análise precisa de prioridade na fila e de um aviso quando o prazo estiver em risco, e não apenas de "vai processar quando der".

---

## 6. Topologia do Agente de Edital

**Contexto:** seção 3 da live. O agente ainda não existe; decidir agora evita custo e hops desnecessários.

**Recomendação: pipeline sequencial, com LLM só nas etapas que precisam dele.**

```
PDF do edital
  → extração de texto/OCR            (determinístico)
  → segmentação em itens             (regra + LLM se falhar)
  → classificação CATMAT/aparelho    (dicionário v0.3: determinístico; LLM só nos ambíguos)
  → extração de prazos e exigências  (LLM, saída com schema)
  → checagem de compatibilidade      (regra: ex. furo × barra × presilha)
  → relatório
```

- **Por que não mesh:** a live mostra que cada agente e cada ferramenta acrescenta hops e caminhos imprevisíveis. O dicionário de aparelhos já resolve a maior parte da classificação sem nenhuma chamada de modelo (86/86 nomes do arquivo original e 48/48 tipos CATMAT).
- **Por que não single agent:** as etapas têm entradas e saídas diferentes e precisam ser auditadas separadamente.
- **Onde caberia um orquestrador:** só se surgirem vários tipos de documento com tratamentos muito diferentes (edital, ata, recurso). Mesmo assim, com um roteador determinístico por tipo, não com agentes conversando entre si.

**Limites obrigatórios desde o primeiro dia (live, seção 10.2):**

| Controle | Valor inicial sugerido |
|---|---|
| Máximo de chamadas LLM por edital | 20 |
| Orçamento por edital | definir em R$ antes do piloto |
| Timeout global por edital | 10 min (assíncrono) |
| Timeout por etapa LLM | 90 s (já é o `TIMEOUT_MS` do `ia.py`) |
| Condição de sucesso | todos os itens com classificação ou marcados "a revisar" |
| Condição de falha | devolver o que conseguiu + lista do que faltou, nunca repetir indefinidamente |

---

## 7. CAG baseado em grafo: onde faz sentido no LicitaGym

**Contexto:** seção 5 da live. A live mostra o CAG como forma de ler menos contexto seguindo relações, com o risco de o grafo ficar desatualizado.

| Candidato | Faz sentido? | Motivo |
|---|---|---|
| **Remissões da Lei 14.133** (art. 164 → prazos do art. 165 etc.) | **Sim, melhor caso** | Pergunta jurídica quase sempre depende de artigos relacionados. Top-k por similaridade não segue remissões. A lei muda pouco, então o grafo envelhece devagar (o risco da live 5.3 é pequeno) |
| Hierarquia CATMAT (grupo → classe → PDM → item) e taxonomia | Já é um grafo relacional | Não precisa de RAG: a navegação é por chave. O RAG entra só no texto livre do edital |
| Código do repositório para Claude/Cursor | Sim, para desenvolvimento | Repositório grande, várias worktrees e muitas migrations. Um mapa de módulos reduz leitura de contexto nas sessões de código |
| Chunks de edital e recurso | Não agora | Documentos isolados e curtos; o RAG com nível de confiança resolve |

**Proposta para a lei:** tabela `legislacao_remissao (artigo_origem, artigo_destino, tipo)` extraída por regex ("art. 164", "§ 2º do art. 165"). A busca vetorial encontra o artigo principal; a remissão traz os vizinhos. Isso também reduz tokens, que é o ganho que a live relata.

---

## 8. MCP: dois conectores, duas regras

**Contexto:** seção 7 da live: MCP é um componente exposto e auditável, não segurança automática.

- **Conector só leitura (`Supabase_LicitaGym`):** bloqueou DDL em 29/09 ("cannot execute DROP POLICY in a read-only transaction"). Esse é o comportamento desejado para análise e diagnóstico.
- **Conector com escrita (`Supabase`):** foi usado em 29/09 para aplicar as migrations de segurança. O fluxo usado deve virar regra:
  1. dry-run do SQL completo em transação desfeita (falha proposital no fim);
  2. `apply_migration` com nome em snake_case (fica registrado em `schema_migrations`);
  3. teste de ACL em produção;
  4. arquivo da migration versionado no repositório com a mesma versão.
- **Por que isso importa:** o drift de grants de `match_licitacao_chunks` (achado de 29/09) é exatamente o tipo de mudança feita fora do ciclo de PR que a live pede para auditar.
- **Recomendação:** usar o conector de escrita só para migrations já revisadas, nunca para "consertar rápido" pelo chat.

---

## 9. Custo: shadow billing do LicitaGym

**Contexto:** seção 10 da live.

**O que já existe:** `econodata_consultas` com `estimativa`, `tokens_estimados`, `tokens_cobrados` e `usuario_id`. É o "rate limit por custo" da live: estimar antes, registrar depois. O código da Edge Function que grava essa tabela **não foi encontrado** no repositório local; conferir se está versionado.

**O que falta:**
- Vertex/Gemini sem registro de consumo por execução. Criar uma tabela única de uso de IA (`ia_uso`: fluxo, modelo, região, tokens de entrada/saída, custo estimado, latência, `trace_id`) e um limite diário por fluxo.
- Alerta de orçamento no projeto GCP (os créditos do Vertex acabam em silêncio).
- **Shadow billing a somar** na conta de um piloto: Supabase (plano, egress, armazenamento de PDFs), Vertex (embeddings + geração), OCR, Econodata, GPU local do agente jurídico, e as horas de operação.

---

## 10. Observabilidade: os quatro sinais aplicados

**Contexto:** seção 11 da live.

| Sinal | Onde registrar | Estado |
|---|---|---|
| Tokens por endpoint | `ia_uso` (proposta) e `consultas_log` | Falta |
| Latência por camada | `consultas_log.latencias` (jsonb: embedding, busca, modelo, ferramentas) | Falta |
| Custo por dia/execução | `ia_uso` + `econodata_consultas` | Parcial (só Econodata) |
| Falha/alucinação | `consultas_log.guardrail_saida` (criado em 29/09) + golden set | Parcial |

Coleta já tem o melhor exemplo interno: `pncp_sync_request_telemetry` e `pncp_sync_run`. **Responsável pelo alerta (live, 11.3):** definir quem recebe o alerta de cota do Vertex, de sync incompleta e de orçamento, e o que fazer em cada caso.

---

## 11. Resiliência: o PNCP já está no padrão; a IA em Python não

**Contexto:** seção 12 da live, comparando dois pontos do próprio código.

| Prática da live | `supabase/functions/_shared/pncp/retry.ts` | `services/coletor-externo/coletor/ia.py` |
|---|---|---|
| Timeout por hop | Sim (`fetchWithTimeout`, 45 s padrão) | Sim (`TIMEOUT_MS` 90 s) |
| Timeout hierárquico | **Sim**: `attemptTimeoutMs = min(teto, tempo restante − margem)`; se não há tempo, nem começa | Não: 8 tentativas de até 90 s cada, sem orçamento total |
| Backoff | Sim, exponencial | Sim, `min(90, 5·2^i)` |
| Jitter | **Sim**, até 25% (máx. 250 ms) | **Não** |
| Retry-After | Sim | Não |
| Controle de vazão por host | Sim (`private.http_host_lease`, `acquire_http_slot`) | Intervalo fixo entre chamadas (12,5 s) |
| Telemetria | Sim (`pncp_sync_request_telemetry`) | Só log |

**Ação:** portar para o `ia.py` o jitter e um orçamento global por execução. Sem jitter, dois coletores rodando juntos (PNCP + Sistema S) batem no 429 e tentam de novo nos mesmos instantes.

**Cache semântico (live, 12.1):** candidato natural são as perguntas sobre a Lei 14.133, que se repetem entre usuários e não dependem de dados privados. Não cachear perguntas sobre processos específicos nem respostas que usem `parte_interessada`.

**Testar a falha (live, 12.5):** simular 429 do Vertex, PNCP fora do ar e timeout do Supabase em branch, e verificar se o edital volta para a fila em vez de sumir.

---

## 12. Checklist antes de abrir o assistente e o Agente de Edital

**Modelo e região**
- [ ] Legislação reindexada com o mesmo modelo dos chunks; `embedding_model` registrado em coluna.
- [ ] Latência p50/p95/jitter medida por região; região escolhida e justificada.
- [ ] Router de geração com fallback; embedding sem fallback de modelo.

**Fluxo**
- [ ] Análise de edital assíncrona na fila, com prioridade por prazo.
- [ ] Chat em streaming.
- [ ] Pipeline sequencial; limites de chamadas, custo e tempo por edital.

**Operação**
- [ ] Tabela de uso de IA + limite diário + alerta de orçamento GCP.
- [ ] Latência por camada em `consultas_log`.
- [ ] Jitter e orçamento global no `ia.py`.
- [ ] Responsável definido para cada alerta.
- [ ] Testes de falha em branch.
- [ ] Conector MCP de escrita só para migrations revisadas.

---

## 13. Perguntas e respostas de referência (golden set)

**P1. Por que o assistente do LicitaGym não pode usar um único vetor de pergunta para buscar na lei e nos editais hoje?**
R: Porque as duas bases foram indexadas com modelos diferentes. Em 29/09/2026 a similaridade média entre vetores das duas bases era 0,043 (praticamente ortogonais), contra 0,82 dentro dos chunks. Um vetor de pergunta só é comparável à base do mesmo modelo.

**P2. Por que o fallback entre provedores não vale para embeddings?**
R: O vetor da pergunta precisa estar no mesmo espaço dos vetores da base. Trocar o modelo de embedding exige reindexar a base. O fallback vale para geração de texto e, no máximo, para outra região do mesmo modelo de embedding.

**P3. Por que a busca na legislação filtra mal hoje?**
R: Pares aleatórios de artigos têm similaridade média 0,95, provavelmente por usar um modelo de pergunta e resposta (BERT SQuAD) como embedding. Com o limiar padrão de 0,7, quase todo artigo passa.

**P4. Em que região o LicitaGym deve rodar os modelos?**
R: Ainda não decidido. O banco está em São Paulo e o Vertex está em `us-central1` por padrão. Para o assistente interativo, medir p95 e jitter nas duas regiões e confirmar a disponibilidade dos modelos em `southamerica-east1` antes de trocar.

**P5. Qual padrão de comunicação para a análise de edital?**
R: Assíncrono com fila (`private.job_queue`), com prioridade por prazo, porque PDF, OCR e LLM podem demorar minutos. O chat usa streaming.

**P6. Qual topologia para o Agente de Edital?**
R: Pipeline sequencial, com etapas determinísticas (extração, dicionário de aparelhos, regras de compatibilidade) e LLM só onde precisa, com limites de chamadas, custo e tempo por edital.

**P7. Onde o CAG baseado em grafo ajuda no LicitaGym?**
R: Nas remissões entre artigos da Lei 14.133. A busca vetorial encontra o artigo principal e o grafo traz os artigos citados. A lei muda pouco, então o risco de grafo desatualizado é baixo.

**P8. O que do capítulo de resiliência da live o LicitaGym já faz?**
R: A coleta do PNCP já tem timeout por tentativa limitado pelo tempo restante, backoff com jitter, Retry-After, lease por host e telemetria. As chamadas ao Vertex em Python ainda não têm jitter nem orçamento global.

---

*Fim do documento. Mensagem da live aplicada ao LicitaGym: antes de escolher o modelo mais capaz, garantir que ele responde no tempo, no custo e no espaço vetorial certos.*

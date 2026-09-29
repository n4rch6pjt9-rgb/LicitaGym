# Arquitetura e Design: Acompanhamento de Eventos PNCP & Automação de Tarefas da Equipe

**Documento:** `docs/design/acompanhamento-tarefas.md`  
**Data:** 29 de setembro de 2026  
**Status:** Design Técnico e Proposta de SQL (não aplicada)  
**SQL proposto:** [`docs/design/sql/acompanhamento_tarefas.sql`](sql/acompanhamento_tarefas.sql) — proposta fora de `supabase/migrations`, não aplicada em nenhum banco. Quando o design for aprovado, vira `supabase/migrations/<timestamp>_acompanhamento_tarefas.sql` com timestamp novo, gerado na data da aprovação.

---

## 1. Visão Geral e Motivação

O LicitaGym monitora oportunidades públicas e necessita transformar movimentações oficiais em ações operacionais para a equipe comercial e de licitações. No PNCP, cada compra registra um histórico de manutenção (`/historico`) com centenas de eventos (retificações de itens, publicação de editais, termos aditivos, atas, anulações e homologações).

Em certames reais, um único pregão pode gerar centenas de eventos repetitivos em um mesmo dia (exemplo auditado: Pregão 90010/2026 de Santa Fé do Sul gerou **151 retificações de itens** no mesmo minuto ao homologar resultados). Se cada evento gerasse uma tarefa isolada, a equipe seria inundada por notificações inoperantes.

Este documento detalha o modelo de dados e a arquitetura do motor assíncrono de acompanhamento e tarefas:
1. **Separação estrita de responsabilidades:** A ação de leitura da API (`acompanhamento` em `api-dashboard-oportunidades`) **não gera tarefas nem grava no banco**; ela apenas consulta e exibe em tempo real o histórico do PNCP.
2. **Geração assíncrona desacoplada:** A geração e conciliação de tarefas ocorrem em segundo plano via **job agendado** (`pg_cron` + `pg_net` + Edge Function worker), garantindo isolamento transacional, controle de concorrência e idempotência.

---

## 2. Modelo de Dados Relacional

```
[ licitacoes_externas ]
         │ (1:N)
         ▼
[ acompanhamento_eventos ] ──── (regras canônicas) ────► [ tarefa_tipos ]
         │                                                      │
         └─────────────► [ tarefas (agrupadas) ] ◄──────────────┘
                                  │ (N:1)
                                  ▼
                            [ auth.users ]
```

### 2.1 Tabela `public.acompanhamento_eventos`
Armazena a trilha imutável dos eventos do histórico oficial do PNCP por compra.

- **Chave Primária:** `id BIGINT GENERATED ALWAYS AS IDENTITY`
- **Chave de Idempotência Composta (UNIQUE):**
  `(compra_orgao_cnpj, compra_ano, compra_sequencial, log_data_inclusao, categoria, tipo, item_numero, documento_sequencial, item_resultado_sequencial)`
  - Garante que a reingestão do histórico da compra seja estritamente idempotente.
- **Campos Principais:**
  - `licitacao_id`: FK opcional para `licitacoes_externas(id)`
  - `categoria` / `tipo`: Nomes das categorias oficiais (ex: 'Contratação', 'Item de Contratação', 'Documento de Contratação', 'Ata de Registro de Preço')
  - `log_data_inclusao`: Timestamp oficial registrado no PNCP
  - `justificativa`: Justificativa do ato administrativo
  - `processado`: Flag booleana indicando se o evento já foi processado pelo motor de tarefas

### 2.2 Tabela `public.tarefa_tipos`
Tabela canônica de regras determinísticas de negócio. Mapeia a tupla `(categoria_evento, tipo_evento)` nas diretrizes da tarefa a ser aberta.

| Código | Categoria Evento | Tipo Evento | Título Template | Prioridade | Prazo Padrão | Agrupamento |
|---|---|---|---|---|---|---|
| `DOC_INCLUIDO` | Documento de Contratação | Inclusão | Ler novo documento: {documento_titulo} | Alta | 1 dia útil | individual |
| `ITEM_RETIFICADO` | Item de Contratação | Retificação | Revisar itens alterados no certame ({quantidade_itens} itens) | Urgente | 1 dia útil | compra_dia |
| `RESULTADO_INCLUIDO` | Resultado de Contratação | Inclusão | Conferir vencedor/preço homologado do item {item_numero} | Alta | 2 dias úteis | item |
| `ATA_PUBLICADA` | Ata de Registro de Preço | Inclusão | Avaliar adesão à ata de registro de preços | Média | 3 dias úteis | compra_dia |
| `CONTRATACAO_RETIFICADA` | Contratação | Retificação | Revisar/encerrar lead — certame alterado | Urgente | 1 dia útil | compra_dia |
| `CONTRATACAO_REVOGADA` | Contratação | Revogação | Revisar/encerrar lead — certame revogado | Alta | 1 dia útil | compra_dia |
| `CONTRATACAO_ANULADA` | Contratação | Anulação | Revisar/encerrar lead — certame anulado | Alta | 1 dia útil | compra_dia |

### 2.3 Tabela `public.tarefas`
Instâncias operacionais atribuídas a membros da equipe.

- **Campos Principais:**
  - `tarefa_tipo_id`: FK para `tarefa_tipos(id)`
  - `licitacao_id`: FK para `licitacoes_externas(id)`
  - `responsavel_id`: FK para `auth.users(id)`
  - `status`: `'aberta'`, `'em_andamento'`, `'concluida'`, `'cancelada'`
  - `prazo_limite`: Timestamp calculado conforme regra de negócio
  - `chave_agrupamento`: Hash ou string composta estável (ex: `compra_dia:45138070000149:2026:559:ITEM_RETIFICADO:2026-09-18`)
  - `eventos_origem_ids`: Array `BIGINT[]` contendo os IDs de todos os eventos que alimentaram esta tarefa
  - `quantidade_eventos`: Contador atômico de eventos agrupados
- **Deduplicação de Tarefas Abertas:**
  - `CONSTRAINT uq_tarefas_agrupamento_aberta UNIQUE (chave_agrupamento, status)`
  - Se um novo evento do mesmo tipo chegar no mesmo dia enquanto a tarefa estiver com `status = 'aberta'`, a tarefa existente é atualizada (adicionando o evento em `eventos_origem_ids` e incrementando `quantidade_eventos`), evitando a criação de tarefas redundantes.

---

## 3. Segurança e Permissões (RLS & ACL)

1. **Row Level Security Habilitado:**
   - Ativado obrigatoriamente em `acompanhamento_eventos`, `tarefa_tipos` e `tarefas`.
2. **Isolamento Total da Role `anon`:**
   - `REVOKE ALL ON TABLE ... FROM anon` em todas as tabelas.
   - `REVOKE ALL ON SEQUENCE ... FROM anon` em todas as sequências de ID.
   - Nenhuma linha ou metadado é acessível sem autenticação válida.
3. **Acesso Autenticado (`authenticated`):**
   - Usuários logados têm permissão de `SELECT` para visualização das tarefas e do histórico.
   - Usuários logados têm permissão de `UPDATE` nas tarefas para assumir responsabilidade (`responsavel_id`), iniciar (`em_andamento`) e concluir (`concluida`).
4. **Escrita do Coletor (`service_role`):**
   - A criação automática de eventos e tarefas opera via `service_role` na Edge Function de background.

---

## 4. Arquitetura do Job Agendado (Worker de Tarefas)

A geração de tarefas **nunca** é executada dentro do endpoint síncrono `api-dashboard-oportunidades` (ação `acompanhamento`), pois a ação de dashboard deve responder rapidamente ao frontend com isolamento de leitura.

O fluxo de automação é disparado de forma desacoplada:

```
[ pg_cron ] ── (a cada 15 min) ──► net.http_post() ──► [ Edge Function: job-gerar-tarefas ]
                                                              │
                                   ┌──────────────────────────┴──────────────────────────┐
                                   ▼                                                     ▼
                      acquire_sync_lock()                                  UnifiedHttpClient (Rate Limit)
                                   │                                                     │
                                   ▼                                                     ▼
                      Seleciona Oportunidades                                Consulta /historico PNCP
                      (view acompanhamento_escopo)                                       │
                                   │                                                     ▼
                                   │                                         Upsert acompanhamento_eventos
                                   │                                                     │
                                   └─────────────► Agrupamento & Upsert ◄────────────────┘
                                                   public.tarefas
```

### 4.1 Agendamento com `pg_cron` e `pg_net`
Utiliza a infraestrutura de jobs agendados disparando o worker com autenticação padrão via secret do Vault (passado via header seguro, como `x-cron-secret` ou `Authorization: Bearer <secret>`):

```sql
SELECT cron.schedule(
  'gerar-tarefas-acompanhamento',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/job-gerar-tarefas?async=1',
    headers := jsonb_build_object(
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sync_cron_secret'),
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sync_cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) AS request_id;
  $$
);
```

### 4.2 Escopo: Quais Oportunidades são Monitoradas?
**Decisão do owner.** O job monitora as linhas de `licitacoes_externas` que atendem **todas** as condições abaixo, materializadas na view `public.acompanhamento_escopo` do SQL proposto:

1. **Prioridade de funil:** `prioridade IN ('leads', 'monitorar')` — valores gravados pelo coletor PNCP (`--modo leads|monitorar`, coluna criada em `20260924100000_pncp_itens_resultados.sql`) e exibidos no dashboard como "Lead" e "Monitorar". Linhas **sem prioridade** (`prioridade IS NULL`, inclusive as gravadas pelo modo `historico`) ficam fora.
2. **Compra viva:** não revogada, anulada nem cancelada — `status_normalizado <> 'cancelada'` e `situacao` sem "Revogada", "Anulada" ou "Cancelada".
3. **Janela de tempo:** a compra atende a pelo menos um dos critérios:
   - não homologada (`data_homologacao IS NULL` e sem status/situação de homologada);
   - homologada nos últimos 30 dias (`data_homologacao >= now() - interval '30 days'`);
   - tem ata de registro de preço ainda em vigência (`contratacoes_atas.ativo` e `vigencia_fim >= current_date`, ligada à compra por `contratacoes_editais`, via `licitacoes_externas.edital_id` ou `numero_controle_pncp = codigo_externo`).

   Compra homologada sem `data_homologacao` conhecida só entra pelo critério da ata vigente.

> **Atenção (29/09/2026, nova semântica de `prioridade`):** o coletor PNCP passou a derivar `prioridade` do
> estado da compra — `leads` = recebendo proposta, `monitorar` = em julgamento, `historico` = encerrada/homologada/
> com resultado (compra homologada **não** é mais lead; ver `prioridade_da_compra()` em
> `services/coletor-externo/coletor/pncp.py`). Com isso, o filtro 1 (`prioridade IN ('leads','monitorar')`) já
> exclui toda compra homologada, e os ramos "homologada nos últimos 30 dias" e "ata vigente" do filtro 3 deixam
> de alcançar linhas PNCP. Se o acompanhamento pós-homologação continuar desejado, o filtro 1 precisa aceitar
> também `prioridade = 'historico'` quando o filtro 3 casar por homologação recente ou ata vigente
> (decisão pendente do owner; o SQL em `docs/design/sql/acompanhamento_tarefas.sql` ainda não foi ajustado).

**Justificativa:**
- A prioridade é o marcador de funil da equipe: só gera tarefa o que a equipe marcou como Lead ou Monitorar.
- A janela de tempo limita o volume de consultas ao `/historico` do PNCP, mantendo o job dentro do limite de 1 req/s por host (§4.3).

### 4.3 Controle de Concorrência e Rate Limiting
1. **Coordenação de Execução com `acquire_sync_lock`:**
   - O worker adquire lock com chave estável `tarefas:acompanhamento:processamento`.
   - Evita sobreposição de workers se um ciclo demorar mais que 15 minutos.
2. **Cliente HTTP Unificado com Rate Limit:**
   - Requisições ao host `pncp.gov.br` utilizam `UnifiedHttpClient` com leasing centralizado em `private.http_host_lease`.
   - Limite de 1 req/s por host com detecção automática de 429 e cooldown distribuído.
3. **Agrupamento Inteligente no Processamento:**
   - Eventos ingeridos em `acompanhamento_eventos` são processados em lote.
   - Múltiplas retificações da mesma compra no mesmo dia são consolidadas em uma única tarefa aberta com contador de itens alterados.

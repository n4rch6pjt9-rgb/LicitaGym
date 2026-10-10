# 0016: Montar o laboratório local de agentes e os casos congelados que barram regressão antes de produção

- **Status:** rascunho
- **Issue:** nenhuma
- **Área:** coletor (`services/coletor-externo`), documentos (pipeline documental), agentes (`_shared/agentes`),
  CI (`pr-quality.yml`), operação (ambiente de validação)
- **Depende do ok do Marcelo:** sim. Decide onde a saída de modelo pode ser gravada, se o Supabase passa a ter
  branch de preview paga por hora e o que pode ser versionado como caso congelado.
- **Base de evidência:** medições de 09/10/2026 na máquina do Marcelo (abaixo), casos 129 e 135 do Dashboard, código
  da `main` em `c9ff533` e arquivos ainda não versionados do checkout local (citados como tal).

## Problema

- **Só existe produção.** O merge na `main` aplica a migration e republica todas as Edge Functions no projeto
  `ifaiagegyicjzlpskafh` (ver `CLAUDE.md`, "Ambientes e entrega"). Não há lugar para ver o efeito de uma regra nova
  sobre licitações reais antes de o cliente ver.
- **As correções chegam lentas e aparecem como "ajuste de interpretação" na UI.** Dois casos reais:
  - **135 (Baraúna, PE 016/2026):** uma suspensão antiga prevaleceu sobre a republicação, e a fase ficou
    "Suspensa (documento)" quando não devia.
  - **129 (Lagoa Nova):** prazo "2604-04-16", ata de SRP assinada e já expirada, e a compra aparece como `monitorar`.
  - As regras determinísticas desses dois são corrigidas em PR separado (branch `claude/fase-reconciliada`). Esta spec
    não repete essa correção. Ela cria o mecanismo para que o próximo caso desse tipo seja pego antes do merge.
- **As fontes erram e envelhecem:**
  - erros de digitação de data;
  - documento que contradiz o status do PNCP;
  - aviso que torna outro aviso sem efeito;
  - ata expirada que continua aparecendo.

  O produto precisa **normalizar** esses erros, guardando o bruto, a regra aplicada e a origem. Também precisa
  **antecipar** dado desatualizado.
- **O modelo local ainda não é confiável sozinho.** Medição de 09/10/2026 com `qwen2.5:7b` na decisão
  administrativa de 21/09/2026 do PE 016/2026 de Baraúna (detalhe em "Escolha de modelo"): 105 s, 4 de 4 trechos
  literais conferem, mas há 4 erros de interpretação. O arquivo vizinho do mesmo certame não tem texto e exige OCR.

## O que já existe (conferido em 09/10/2026)

| Peça | Onde | Estado |
|---|---|---|
| Fase e prioridade determinísticas | `services/coletor-externo/coletor/pncp.py`: `fase_da_compra()` e `sinal_documental()`. Função pura com precedência P0–P10, constantes `FASE_SUSPENSA_DOC`, `FASE_PRAZO_INVALIDO` etc. Testes em `services/coletor-externo/tests/test_fase_compra.py` e `test_prioridade_pncp.py` | na `main` |
| Prioridade efetiva lida pelo Dashboard | view `licitacoes_externas_prioridade_efetiva` (migration `20260930200000_licitacoes_prioridade_efetiva`), lida por `supabase/functions/api-dashboard-oportunidades/index.ts` | na `main` |
| Documentos | `public.licitacao_documentos` (`supabase/migrations/20260923100000_licitacoes_externas.sql`): `sha256 text`, `extracao jsonb`, `status_processamento in ('pendente','baixado','extraido','indexado','erro','ignorado')`. **Não há estado `OCR_REQUIRED`**, que `.github/instructions/document-pipeline.instructions.md` exige como [BLOQUEANTE] para PDF sem texto | na `main` |
| Chunks | `public.licitacao_chunks` (mesma migration): **uma só coluna `pagina int`**, sem `page_start/page_end`, `content_hash` nem versão do documento, metadados que a instrução do pipeline pede | na `main` |
| Indexação e OCR atuais | `services/coletor-externo/coletor/indexador.py`: PDF escaneado vai para `ia.ocr_pdf()`. `coletor/ia.py` usa Gemini, com `GEN_MODEL` padrão `gemini-2.5-flash`. Texto com menos de 50 caracteres é gravado como `ignorado` | na `main` |
| Agentes do produto | `supabase/functions/_shared/agentes/` (`edital.ts`, `preco.ts`, `juridico.ts`, `aderencia.ts`, `achados.ts`, `decisao.ts`, `tipos.ts`) e `supabase/functions/api-agentes/` (`index.ts`, `repo.ts`, `validation.ts`) | **no checkout local, não versionado na `main`** |
| Contrato de achado | `tipos.ts`: `natureza: "fato" \| "analise" \| "inferencia"`, `metodo: "regra" \| "modelo" \| "cliente"`, `fontes: Fonte[]` (chunk com página e trecho, registro, dispositivo, cálculo, cliente) e `REGRA_VERSAO` | **checkout local** |
| Execuções | `supabase/migrations/20261006220000_agente_execucoes.sql`: `public.agente_execucoes` com `contexto_hash`, `regra_versao`, `modelo`, revisão `aguardando/aprovada/rejeitada`, só `service_role` | **checkout local** |
| Política de IA | `docs/agentes/politica-uso-ia.md`: achado sem fonte não grava, trecho literal, ausência é ausência, rastro do modelo, texto gerado identificado | **checkout local** |
| Compose com GPU (outro serviço) | `docs/agente-juridico-ml/docker-compose.gpu.yml` (`gpus: all`) | na `main` |
| Postgres descartável da CI | job de migrations em `.github/workflows/pr-quality.yml` com `pgvector/pgvector:pg17` | na `main` |

Esta spec depende de os arquivos marcados como "checkout local" entrarem na `main` pelo PR próprio deles. Sem isso, as
etapas 3 e 4 abaixo ficam bloqueadas.

## Duas famílias de agentes (não misturar)

| | **Agentes do produto** (runtime) | **Agentes de desenvolvimento** |
|---|---|---|
| O que fazem | extraem eventos e datas de documento, normalizam valor de fonte, propõem fase | escrevem código, testes e migrations em paralelo |
| Modelo | Ollama local (`qwen2.5:7b`, `llama3.2` 3B), sempre atrás de validador determinístico | Claude (Claude Code). Modelo local de 3 a 7B não substitui o Claude para código, e esta spec não propõe isso |
| Onde rodam | laboratório local (docker compose, abaixo) e, depois de aprovado, o pipeline de produção | git worktrees (já usados: `.claude/worktrees/`) ou Docker Sandboxes |
| Saída | arquivo/tabela sombra, avaliada contra casos congelados | branch + PR draft, revisada pelos agentes `revisor-*` e pela CI |
| Barreira | avaliador (casos congelados) | CI `pr-quality.yml` + avaliador + ok do Marcelo para merge |

**Docker Sandboxes:** o `docker sandbox` antigo foi removido do Docker 29.8.2 instalado. O Docker Sandboxes atual exige
o CLI `sbx`, que **não está instalado**. Até lá, os agentes de desenvolvimento seguem em worktrees, como hoje.

## Abordagem proposta

### 1. Laboratório local (docker compose)

```
                  ┌──────────────────────────── laboratorio/compose.yml ──────────────────────────────┐
 casos congelados │                                                                                   │
 (JSON + SHA-256) │  worker-documentos ──► texto por página ──► extração com schema ──► validadores   │
        │         │   (download/cache       (pypdf; sem texto      (Ollama, format=     (trecho literal, │
        ▼         │    por SHA-256)          => OCR_REQUIRED       JSON schema,          data por regex, │
  avaliador ◄─────┤                          => OCR local)         temperature 0)        cronologia)     │
  (relatório)     │                                                         │                         │
        ▲         │  worker-reconcilia ◄──── eventos validados ◄────────────┘                         │
        │         │   (fase_da_compra + normalização com origem: regras, sem modelo)                  │
        └─────────┤                                   │                                               │
                  │                                   ▼                                               │
                  │                   saída SOMBRA: arquivos JSONL + Postgres local (pg17)            │
                  └───────────────────────────────────────────────────────────────────────────────────┘
                     Ollama: o do host via host.docker.internal:11434 (padrão) ou serviço `ollama` no compose
```

**Serviços:**

- **`ollama`:** por padrão, o compose **não** sobe Ollama. Os workers falam com o Ollama do host em
  `http://host.docker.internal:11434`.
  - O Ollama do host já roda com `OLLAMA_HOST=127.0.0.1:11434` e `OLLAMA_MODELS=D:\ollama\models`, pelo script
    `D:\AI-IDE-Data\Ollama\start-ollama-localhost.ps1`.
  - **Atenção:** ligado só em `127.0.0.1`, o Ollama do host pode não aceitar conexão vinda do container. Isso **não
    foi testado**. A etapa 2 mede e escolhe entre duas opções:
    - (a) mudar o bind do host para a interface que o Docker alcança;
    - (b) perfil `ollama` no compose (`image: ollama/ollama`, `gpus: all`, volume só leitura para `D:\ollama\models`).
  - Em qualquer opção, a porta não é exposta fora da máquina.
- **`worker-documentos`** (Python, reusa `coletor/indexador.py` e `coletor/textos.py` onde servir):
  1. **Download:** baixa da URL oficial (PNCP/portal) ou lê do cache local `laboratorio/.cache/docs/<sha256>`. O cache
     fica fora do git. O SHA-256 do arquivo tem de bater com o do caso. Se não bater, o caso é marcado `documento_mudou`
     e não é avaliado.
  2. **Texto por página:** sempre por página. Página sem texto extraível vira `OCR_REQUIRED` no resultado do
     laboratório, nunca `extraido` vazio. Depois entra o OCR local (seção 5), registrando engine, versão e confiança
     quando a engine der.
  3. **Extração com schema:** chamada ao Ollama com `format` = JSON Schema do evento (seção 2), `temperature 0` e
     `num_ctx 8192`. O resultado guarda modelo, digest do modelo, opções e `REGRA_VERSAO`.
  4. **Validadores determinísticos** (descartam ou rebaixam, nunca completam):
     - **trecho literal:** `trecho` tem de existir no texto da página citada, após normalização só de espaço e hifenização
       de quebra de linha. Se não existir, o evento é descartado;
     - **data por regex:** toda data do evento tem de aparecer no trecho (ou na página) num formato reconhecido. Data que
       não aparece vira `null` com `motivo_ausencia`, e a data do modelo não é usada;
     - **cronologia:** data do ato ≤ data de publicação do documento no PNCP. Se não for, cai na escala de evidência da
       seção 4;
     - **condicional × efetivo:** verbo no futuro ou condição ("será republicado", "após") marca o evento como
       `condicional`, que não muda fase;
     - **dedup:** mesmo `tipo` + mesma `data_ato` + trechos sobrepostos no mesmo documento contam como um só evento.
- **`worker-reconcilia`** (Python, **sem modelo**):
  - recebe os dados do caso (JSON PNCP, resposta do portal e eventos validados);
  - chama `fase_da_compra()` com `documentos` e `retificada_em`, como produção chama;
  - aplica a normalização com origem (seção 4);
  - produz `(fase, prioridade, motivo, datas_normalizadas[])`.
- **`postgres`:** `pgvector/pgvector:pg17`, a mesma imagem da CI. Recebe as migrations do repositório (`supabase/migrations/`)
  e um schema `laboratorio` próprio, que não é migration de produção, para a saída sombra consultável por SQL.
  Volume local, descartável.
- **`avaliador`:** compara a saída com o esperado de cada caso congelado e escreve
  `laboratorio/saida/<execucao>/relatorio.json` e `.md` (seção 3).

**Onde o laboratório escreve (regra):**

1. **Etapas 1 a 5: nada no Supabase.** A saída vai só para arquivos JSONL em `laboratorio/saida/` (fora do git) e para o
   Postgres local. O laboratório não recebe `SUPABASE_SERVICE_ROLE_KEY`.
2. **Leitura de produção, se precisar,** só por export que o Marcelo faz (SQL Editor) ou pelas APIs públicas
   (PNCP/portal), já que o MCP do repositório é só leitura. Caso congelado não depende de leitura viva.
3. **Etapa 6 (opcional, depende do ok):** tabela sombra em produção (proposta: `private.normalizacao_sombra`). Ela nasce
   de migration + PR e é gravada **apenas por coletor existente** (Cloud Run Job do `coletor-externo`), com a camada
   de regras. Nenhuma linha dela altera `licitacoes_externas.fase`, `prioridade` nem a view de prioridade efetiva.
   Promover uma regra da sombra para a fase de produção é um PR à parte, com o avaliador verde e o ok do Marcelo.
4. Saída de modelo nunca chega a produção sem passar pelo validador e sem `metodo = "modelo"` no rastro, conforme a
   política de IA.

### 2. Evento extraído (schema da camada de modelo)

```json
{
  "tipo": "suspensao | retomada | republicacao | retificacao | adiamento | aviso_sem_efeito | revogacao | anulacao | homologacao | ata_assinada | outro",
  "alvo": "certame | aviso | item | lote | ata",
  "efetividade": "efetivo | condicional",
  "data_ato": { "valor": "AAAA-MM-DD | null", "bruto": "texto como está no documento | null", "motivo_ausencia": "texto | null" },
  "documento_sha256": "64 hex",
  "pagina": 1,
  "trecho": "cópia literal do documento"
}
```

O schema separa `aviso_sem_efeito` (tornar sem efeito um **aviso**) de `anulacao` do **certame**, e usa o campo `alvo`.
Essa separação responde ao erro medido em 09/10. `data_ato` é obrigatório como objeto: ou vem com `valor` + `bruto`, ou
com `motivo_ausencia`.

### 3. Avaliador e casos congelados

**Formato do caso** (`laboratorio/casos/<id>/caso.json`; `<id>` = número do caso do Dashboard ou slug):

```json
{
  "id": "135-barauna-pe016-2026",
  "congelado_em": "2026-10-09",
  "descricao": "suspensão antiga vs republicação",
  "camadas": ["regras", "modelo"],
  "bloqueante": true,
  "agora": "2026-10-09T12:00:00-03:00",
  "entradas": {
    "pncp_compra": "pncp_compra.json",
    "pncp_arquivos": "pncp_arquivos.json",
    "pncp_itens": "pncp_itens.json",
    "portal": null,
    "documentos": [
      { "sha256": "b955ec87e18e46d2cc2639b09113d0cba4bd0d9d145f570f0ed549ae0d9936f5", "origem": "pncp", "sequencial_arquivo": 4, "url": "<url oficial>", "paginas": 2 },
      { "sha256": "<64 hex completos do arquivo 3>", "origem": "pncp", "sequencial_arquivo": 3, "url": "<url oficial>", "paginas": 4, "exige_ocr": true }
    ]
  },
  "esperado": {
    "fase": "<constante de pncp.py>",
    "prioridade": "leads | monitorar | historico",
    "eventos": [ { "tipo": "...", "alvo": "...", "efetividade": "...", "data_ato": "AAAA-MM-DD | null", "documento_sha256": "...", "pagina": 1 } ],
    "datas_normalizadas": [ { "campo": "data_encerramento_proposta", "valor": "AAAA-MM-DD | null", "bruto": "...", "regra": "...", "origem": "pncp | portal | edital | inferido" } ]
  }
}
```

- **Quem escreve o esperado:** o Marcelo, ou o agente com revisão do Marcelo, lendo o documento oficial. O esperado de
  `eventos` e `datas_normalizadas` só entra no caso com página e trecho conferidos. Esta spec **não** preenche o
  esperado dos casos 129 e 135: isso é a etapa 1, depois que `claude/fase-reconciliada` for mergeada.
- **SHA-256 do arquivo 3 de Baraúna:** a medição de 09/10 registrou só o prefixo e o sufixo (`8f6429b0…97f2`). O caso
  precisa do hash completo, recalculado no download.
- **Documentos não vão para o git** (`CLAUDE.md`: não versionar dados de coleta). O caso guarda SHA-256 + URL oficial.
  JSON do PNCP é dado público de órgão. Se o Marcelo aprovar (pergunta 2), entra como fixture mínima, só com os campos
  que `fase_da_compra()` lê, como a spec 0012 já fez com fixtures de PCA.

**Métricas por execução** (todas medidas, nenhuma estimada):

- acerto de `fase` e de `prioridade` por caso (igual/diferente);
- por tipo de evento:
  - verdadeiro positivo, falso positivo e falso negativo, contados, não percentuais, enquanto houver poucos casos;
  - `suspensao` com contagem separada de **falso positivo de suspensão**, que é o erro do caso 135;
- `data_ato`: certa, errada ou ausente quando existia;
- trechos: quantos o validador literal descartou;
- `efetividade`: condicional marcado como efetivo (erro medido em 09/10);
- tempo: segundos por documento e por página, com modelo e `num_ctx`;
- páginas `OCR_REQUIRED` e tempo de OCR por página.

**Regra de bloqueio:** nenhum PR que quebre um caso com `bloqueante: true` vai para produção. Na prática:

- **CI (`pr-quality.yml`, sem Ollama):** um teste pytest novo (proposta: `services/coletor-externo/tests/test_casos_congelados.py`)
  roda a **camada `regras`** de todos os casos:
  - entrada: JSON do caso + `esperado.eventos` usados como se fossem eventos validados;
  - execução: `fase_da_compra()` + normalização com origem;
  - verificação: confere `fase`, `prioridade` e `datas_normalizadas`.

  O teste entra no job `python-coletor-externo` que já existe, sem rede, sem Ollama e sem documento binário. Caso
  bloqueante quebrado = job vermelho.
- **Local (com Ollama):** `docker compose run avaliador --camada modelo` roda a camada `modelo` (documento → eventos)
  e compara com `esperado.eventos`. Essa camada **não** barra a CI, porque a CI não tem GPU nem Ollama. Ela barra
  outra coisa: troca de modelo, de prompt ou de schema de extração só é proposta em PR com o relatório do avaliador
  anexado, sem piora em caso bloqueante.
- **Caso novo de bug P0/P1:** todo bug de fase/prioridade reportado da UI vira caso congelado no mesmo PR da correção,
  seguindo a regra de CA de regressão do `_template.md`.

### 4. Normalização com origem

Todo valor normalizado guarda quatro coisas:

```json
{ "campo": "data_encerramento_proposta", "valor": "AAAA-MM-DD | null", "bruto": "2604-04-16", "regra": "data.ano_implausivel.v1", "origem": "pncp | portal | edital | inferido", "evidencia": "outra_fonte_oficial | digitacao_validada_por_cronologia | limite_pelos_fatos" }
```

- **`bruto` nunca é apagado.** O valor da fonte oficial não é sobrescrito, conforme `AGENTS.md`, "Integridade dos dados".
- **Escala de evidência** (a primeira que se aplica vence):
  1. **Outra fonte oficial:** o mesmo campo, em outra fonte oficial do mesmo certame, tem valor plausível. Exemplos:
     edital publicado no PNCP, portal do órgão, ata. Usa esse valor, com `origem` = a fonte e `evidencia = outra_fonte_oficial`.
  2. **Correção de digitação validada pela cronologia:** existe **uma única** correção de digitação candidata, e ela é
     coerente com as outras datas oficiais do certame (publicação ≤ abertura ≤ encerramento ≤ homologação ≤ ata).
     Usa a correção com `origem = inferido` e `evidencia = digitacao_validada_por_cronologia`. Com mais de uma
     candidata, não corrige.
  3. **Limite pelos fatos:** sem 1 nem 2, o valor fica `null` (desconhecido), com `bruto` preservado. A decisão usa só
     os fatos que existem (por exemplo, "ata de SRP assinada e vigência expirada" é fato oficial que não depende da
     data errada) e não inventa a data.
- **Caso 129:** o "2604-04-16" passa pela escala acima. O valor corrigido só aparece se 1 ou 2 se aplicarem, e o caso
  congelado registra qual se aplicou. Esta spec não afirma qual é a data certa.
- **Antecipar dado desatualizado:** o `worker-reconcilia` emite um alerta (não muda fase) quando:
  - um fato oficial já implica mudança de estado e a fonte ainda não a refletiu. Exemplos: vigência de ata terminada,
    prazo vencido com status "recebendo", suspensão com republicação posterior;
  - o documento é mais novo que o `dataAtualizacao` do PNCP.

  O alerta vai para a saída sombra com origem e regra.

### 5. Escolha de modelo e OCR

**Medido em 09/10/2026** (RTX 3050 6 GB, Ollama 0.34.2, `qwen2.5:7b` Q4_K_M de 4,7 GB, saída JSON com schema pelo
`format` do Ollama, `temperature 0`, `num_ctx 8192`). Documento: decisão administrativa de 21/09/2026 do PE 016/2026
de Baraúna, arquivo PNCP 4, 2 páginas com texto, SHA-256 `b955ec87e18e46d2cc2639b09113d0cba4bd0d9d145f570f0ed549ae0d9936f5`.

| Medida | Resultado |
|---|---|
| Tempo | 105 s |
| Eventos extraídos | 4 |
| Trechos literais que conferem com o texto | 4 de 4 |
| Erros | classificou "tornar sem efeito o aviso" como ANULACAO do certame; não extraiu a data do ato; marcou republicação futura (condição) como ato efetivo; duplicou a retirada |

O arquivo 3 do mesmo certame (4 páginas escaneadas) tem 0 caracteres de texto e exige OCR.

**Leitura:**

- o modelo acertou a parte que dá para validar mecanicamente (trecho literal);
- errou a parte de interpretação (tipo, alvo, efetividade, data);
- é uma medição de um documento, não uma taxa.

Daí o desenho:

- o modelo **propõe**, e os validadores e as regras decidem;
- o schema da seção 2 cria campos (`alvo`, `efetividade`, `data_ato.bruto`) para os erros vistos;
- a fase é sempre da camada `regras`.

**Plano de comparação** (etapa 4), sobre os mesmos casos congelados e com as mesmas métricas da seção 3:

| Variante | O que roda |
|---|---|
| A. só regras | `sinal_documental()` pelos títulos + regex de data, sem modelo |
| B. `qwen2.5:7b` | extração com schema + validadores |
| C. `llama3.2` 3B | idem, mesmo prompt e schema |

- **Fora da primeira rodada:**
  - `hermes3:3b`, `phi3` 3.8B e as variantes `chat-3050`/`work-3050`/`code-3050` (3B, `num_ctx 8192`), que podem
    entrar se B e C empatarem;
  - `codellama` 7B, que é modelo de código e não serve para esta tarefa;
  - `mxbai-embed-large`, que é embedding e não extrai. O embedding de produção é `text-multilingual-embedding-002`
    (768 dimensões), e trocá-lo é "Alto" pela instrução do pipeline documental.
- **Critério de escolha** (definido antes de medir, sem número inventado):
  - descartar a variante que tiver qualquer falso positivo de suspensão ou anulação em caso bloqueante;
  - entre as que sobrarem, escolher a de mais eventos certos;
  - em empate, a mais rápida por página;
  - se A empatar com B ou C em eventos certos, fica A (sem modelo).
- **Teto de tempo por página:** pergunta ao Marcelo (pergunta 5). Hoje há um único número: 105 s para 2 páginas, com
  `qwen2.5:7b`.

**OCR local (proposta, a medir):**

- **Engine:** Tesseract com o idioma `por`, via `ocrmypdf` (gera camada de texto por página e não altera o original;
  o original fica pelo SHA-256).
- **Alternativa se a qualidade não bastar:** PaddleOCR com GPU.
- **Não medido:** nada sobre essas engines nesta máquina. A etapa 5 mede, no arquivo 3 de Baraúna e em outros
  escaneados dos casos:
  - tempo por página;
  - caracteres extraídos;
  - se os trechos esperados aparecem no texto do OCR.
- **Comparação com produção:** o mesmo arquivo passa pelo `ia.ocr_pdf()` (Gemini) para comparar, só se o Marcelo
  autorizar o custo dessa chamada.

### 6. Ambiente de validação antes de produção (camadas)

| Camada | O que pega | Custo | Riscos | Estado |
|---|---|---|---|---|
| **1. Casos congelados na CI** (camada `regras`, job `python-coletor-externo`) | regressão de fase/prioridade/normalização em caso conhecido | minutos de CI do GitHub: a medir | só pega o que já virou caso; fixture desatualizada se a fonte mudar (o SHA-256 detecta no documento, não no JSON) | proposto (etapa 1) |
| **2a. Branch de preview do Supabase por PR** | migration e Edge Function rodando antes do merge, com banco isolado | cobrado por hora de branch ativa: valor a medir no plano da conta | sem `seed.sql` (`supabase/config.toml`: `[db.seed] enabled = false`), o banco do preview nasce vazio, e o seed precisa ser escrito sem dado pessoal; segredos das funções precisam existir no preview; cron/coletores não podem apontar para o preview por engano | **não verificado** |
| **2b. Preview do Dashboard (Cloudflare)** | UI do PR apontando para o backend de preview | a medir | o front de preview precisa apontar para o Supabase de preview, não para produção | **não verificado** (repositório `Dashboard---LicitaGym`) |
| **3. Docker Sandboxes** para agentes de desenvolvimento | agente de código isolado do host (rede, disco, credenciais) | tempo de máquina local; licença/plano: a verificar | exige o CLI `sbx`, não instalado; sem ele, seguem os worktrees, que não isolam rede nem credencial | não instalado |

**Sobre a camada 2a:**

- o check "Supabase Preview" já aparece nos PRs. Pelo `CLAUDE.md`, esse check é a integração GitHub, que **aplica em
  produção no merge**;
- **não foi verificado** se a conta tem branching por PR habilitado, nem o custo, nem se a integração atual cria um
  branch por PR ou só reporta;
- a etapa 7 verifica isso (leitura do painel com o Marcelo) antes de propor qualquer mudança.

## Etapas de entrega (PRs pequenos)

| # | PR | Migration | Depende de |
|---|---|---|---|
| 1 | Formato do caso + `test_casos_congelados.py` (camada `regras`) + casos 129 e 135 com esperado revisado pelo Marcelo | não | merge de `claude/fase-reconciliada`; resposta às perguntas 1 e 2 |
| 2 | `laboratorio/compose.yml` + `worker-documentos` sem modelo: download por SHA-256, texto por página, `OCR_REQUIRED`, saída JSONL. Medição host × container do Ollama | não | 1 |
| 3 | Schema de evento + chamada Ollama + validadores (trecho literal, data por regex, cronologia, condicional, dedup) | não | 2; `_shared/agentes` na `main` |
| 4 | Avaliador camada `modelo` + relatório A × B × C nos casos | não | 3 |
| 5 | OCR local (Tesseract/ocrmypdf) medido nos escaneados | não | 2 |
| 6 | Tabela sombra em produção, gravada pelo coletor com a camada `regras` | **sim** (aditiva, `private`, sem grant a `anon`/`authenticated`) | ok do Marcelo; 1 a 4 |
| 7 | Avaliação de preview Supabase + Dashboard (documento, sem mudança de infra) | não | ok do Marcelo para ler custo no painel |

Fora destas etapas, mas recomendado: PR próprio para o estado `OCR_REQUIRED` em `licitacao_documentos.status_processamento`
e para os metadados de chunk que faltam. Ambos são exigidos pela instrução do pipeline documental e são migration de
produção.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o caso congelado 135 com `bloqueante: true`, **quando** `fase_da_compra()` recebe as entradas do caso, **então** `fase` e `prioridade` são iguais ao `esperado` e a fase não é `Suspensa (documento)`. | pytest `services/coletor-externo/tests/test_casos_congelados.py` |
| CA-2 | **Dado** o caso 129, **quando** a camada `regras` roda, **então** a prioridade é a do `esperado` (não `monitorar`) e `datas_normalizadas` traz `bruto = "2604-04-16"` com `evidencia` e `origem` preenchidas. | pytest `test_casos_congelados.py` |
| CA-3 | **Dado** um caso bloqueante cujo `esperado.fase` difere da saída, **quando** a CI roda, **então** o job `python-coletor-externo` falha e nomeia o caso. | pytest `test_casos_congelados.py` (caso sintético com esperado errado, marcado `xfail(strict=True)`) |
| CA-4 | **Dado** um `caso.json` sem `entradas.documentos[].sha256` com 64 hex, ou sem `esperado.fase`, **quando** o carregador lê, **então** recusa com erro de validação. | pytest `test_casos_congelados.py` |
| CA-5 | **Dado** um PDF cujo SHA-256 difere do declarado no caso, **quando** o `worker-documentos` baixa, **então** o caso sai como `documento_mudou` e não é avaliado. | pytest `laboratorio/tests/test_worker_documentos.py` |
| CA-6 | **Dado** uma página sem texto extraível, **quando** o `worker-documentos` extrai, **então** a página sai `OCR_REQUIRED` e nenhum evento é gerado dela. | pytest `laboratorio/tests/test_worker_documentos.py` |
| CA-7 | **Dado** um evento do modelo cujo `trecho` não existe na página citada, **quando** o validador roda, **então** o evento é descartado e contado em `trechos_descartados`. | pytest `laboratorio/tests/test_validadores.py` |
| CA-8 | **Dado** um evento com `data_ato` que não aparece no trecho nem na página, **quando** o validador roda, **então** `data_ato.valor` = `null` com `motivo_ausencia`. | pytest `test_validadores.py` |
| CA-9 | **Dado** o trecho "será republicado" (condição futura), **quando** o validador roda, **então** `efetividade = condicional` e o evento não altera fase. | pytest `test_validadores.py` |
| CA-10 | **Dado** dois eventos de mesmo tipo, data e trecho sobreposto no mesmo documento, **quando** o validador roda, **então** sobra um. | pytest `test_validadores.py` |
| CA-11 | **Dado** uma data bruta com duas correções de digitação candidatas coerentes com a cronologia, **quando** a normalização roda, **então** `valor = null` e `evidencia = limite_pelos_fatos`. | pytest `services/coletor-externo/tests/test_normalizacao_origem.py` |
| CA-12 | **Dado** o compose do laboratório, **quando** `docker compose config` roda, **então** nenhum serviço define `SUPABASE_SERVICE_ROLE_KEY` nem `SUPABASE_URL` de produção. | pytest `laboratorio/tests/test_compose.py` (lê o YAML) |
| CA-13 | **Dado** o relatório do avaliador da camada `modelo`, **quando** é gerado, **então** contém, por variante: modelo, digest, `num_ctx`, eventos certos/errados por tipo, falsos positivos de suspensão e segundos por página. | pytest `laboratorio/tests/test_avaliador.py` (saída do Ollama gravada como fixture) |
| CA-14 | (etapa 6) **Dado** a tabela sombra, **quando** `anon` ou `authenticated` tentam `select`, **então** recebem erro de permissão. | SQL `supabase/tests/normalizacao_sombra_check.sql` |

## Fora de escopo

- Corrigir as regras dos casos 129 e 135 (`claude/fase-reconciliada`).
- Mudar `fase`/`prioridade` de produção a partir de saída de modelo.
- Trocar o embedding ou reindexar `licitacao_chunks`.
- Estado `OCR_REQUIRED` e metadados de chunk em produção (PR próprio, ver acima).
- Ativar branching do Supabase ou preview do Dashboard (a etapa 7 só avalia).
- Instalar o CLI `sbx` ou migrar os agentes de desenvolvimento para Docker Sandboxes.
- Usar modelo local para escrever código do repositório.
- Processar proposta ou documento de habilitação de cliente no laboratório (política de IA, item 2): só documento
  público de edital.

## Impacto em dados

- **Migration:** não nas etapas 1 a 5 e 7. Sim na etapa 6 (proposta `private.normalizacao_sombra`, aditiva,
  idempotente, sem grant a `anon`/`authenticated`), só com ok.
- **Tabelas/views/funções tocadas:**
  - nenhuma em produção nas etapas 1 a 5;
  - o laboratório lê fixtures e documentos públicos e escreve em `laboratorio/saida/` e no Postgres local.
- **ACL/RLS:** nenhum até a etapa 6.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas, como em todo merge na `main`, mas nenhuma muda nas etapas 1 a 5.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:**
  - **oficial:** JSON PNCP, documento por SHA-256, `bruto`;
  - **derivado:** evento validado, `valor` normalizado (com `regra`, `origem`, `evidencia`), alerta de dado
    desatualizado;
  - nenhum valor inventado: sem evidência, `null`.

## Perguntas em aberto

1. **Quem preenche o `esperado` dos casos 129 e 135?** E podemos esperar o merge de `claude/fase-reconciliada` para
   congelá-los já com a regra corrigida?
2. **O que pode ser versionado?** O `CLAUDE.md` proíbe versionar dados de coleta. Os JSONs públicos do PNCP (campos
   mínimos) e trechos curtos de documento público podem entrar como fixture em `laboratorio/casos/`, como na spec 0012?
   Ou o caso guarda só URL + SHA-256 e a CI baixa? Baixar na CI depende do PNCP estar no ar.
3. **Ollama no container ou no host?** Aceita mudar o bind do Ollama do host (hoje `127.0.0.1`) para o Docker
   alcançar, ou prefere o serviço `ollama` no compose lendo `D:\ollama\models` só para leitura?
4. **Tabela sombra em produção (etapa 6):** quer, ou o laboratório fica só local até a regra ser promovida por PR?
5. **Teto de tempo por página para a camada de modelo:** qual é aceitável? A única medição é de 105 s para 2 páginas.
6. **OCR de comparação com Gemini:** autoriza rodar `ia.ocr_pdf()` no arquivo 3 de Baraúna como referência (tem custo)?
7. **Preview do Supabase:** a conta tem branching por PR habilitado? Topa olhar o custo por hora no painel antes da
   etapa 7?
8. **Preview do Dashboard:** o repositório `Dashboard---LicitaGym` já gera URL de preview por PR no Cloudflare? E dá
   para apontá-la para outro backend?
9. **Docker Sandboxes:** quer instalar o CLI `sbx` agora, ou os worktrees bastam até a camada 1 estar de pé?
10. **Arquivos não versionados:** `_shared/agentes/`, `api-agentes/`, a migration `agente_execucoes` e
    `docs/agentes/politica-uso-ia.md` estão só no checkout local. Eles têm PR próprio previsto antes das etapas 3 e 4?

# 0016: Montar o laboratório local de agentes e os casos congelados que barram regressão antes de produção

- **Status:** rascunho (decisões do Marcelo de 09/10/2026 em "Decisões"; abertas só as perguntas de preview)
- **Issue:** nenhuma
- **Área:** coletor (`services/coletor-externo`), documentos (pipeline documental), agentes (`_shared/agentes`),
  CI (`pr-quality.yml`), operação (ambiente de validação)
- **Depende do ok do Marcelo:** sim. As decisões de 09/10 estão em "Decisões". Falta só a verificação do preview
  Supabase/Cloudflare no painel.
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

Esta spec depende de os arquivos marcados como "checkout local" entrarem na `main` pelo PR próprio deles. Eles estão
sendo resgatados em PRs próprios (branches `claude/resgate-*`, decisão 8). Até lá, as etapas 3 e 4 abaixo ficam
bloqueadas.

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

- **`ollama`:** o compose **não** sobe Ollama (decisão 3). Os workers usam o Ollama do host, com os modelos em
  `D:\ollama\models`, pelo endereço `http://host.docker.internal:11434`.
  - O Ollama do host já roda com `OLLAMA_HOST=127.0.0.1:11434` e `OLLAMA_MODELS=D:\ollama\models`, pelo script
    `D:\AI-IDE-Data\Ollama\start-ollama-localhost.ps1`.
  - **Teste de alcance (passo da etapa 2):** ligado só em `127.0.0.1`, o Ollama do host pode não aceitar conexão vinda
    do container. Isso **não foi testado**. A etapa 2 começa com um teste: de dentro de um container do compose,
    `GET http://host.docker.internal:11434/api/tags`, registrando o resultado no PR. Se falhar, a correção do bind do
    host volta ao Marcelo antes de seguir. O compose não sobe um Ollama próprio.
  - A porta não é exposta fora da máquina.
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

1. **Laboratório só local (decisão 4): nada no Supabase.** A saída vai só para arquivos JSONL em
   `laboratorio/saida/` (fora do git) e para o Postgres local. O laboratório não recebe `SUPABASE_SERVICE_ROLE_KEY`.
2. **Leitura de produção, se precisar,** só por export que o Marcelo faz (SQL Editor) ou pelas APIs públicas
   (PNCP/portal), já que o MCP do repositório é só leitura. Caso congelado não depende de leitura viva.
3. **Tabela sombra em produção: decisão futura, depois da medição (decisão 4).** Não faz parte desta spec. Se vier,
   o desenho previsto é:
   - nasce de migration + PR (proposta de nome: `private.normalizacao_sombra`);
   - é gravada **apenas por coletor existente** (Cloud Run Job do `coletor-externo`), com a camada de regras;
   - nenhuma linha dela altera `licitacoes_externas.fase`, `prioridade` nem a view de prioridade efetiva.

   Promover uma regra para a fase de produção é sempre um PR à parte, com o avaliador verde e o ok do Marcelo.
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
      { "sha256": "8f6429b0223e149a034f80f38d3209201257b4495cb5ed9acf0f6143d53b97f2", "origem": "pncp", "sequencial_arquivo": 3, "url": "<url oficial>", "paginas": 4, "exige_ocr": true }
    ]
  },
  "esperado": {
    "fase": "Recebendo propostas",
    "prioridade": "leads",
    "eventos": [ { "tipo": "...", "alvo": "...", "efetividade": "...", "data_ato": "AAAA-MM-DD | null", "documento_sha256": "...", "pagina": 1 } ],
    "datas_normalizadas": [ { "campo": "data_fim", "valor": "AAAA-MM-DD | null", "bruto": "...", "regra": "...", "origem": "pncp | portal | edital | inferido" } ]
  }
}
```

- **Esperado dos casos-semente (decisão 1):**

  | Caso | `fase` | `prioridade` |
  |---|---|---|
  | 135 (Baraúna, PE 016/2026) | `Recebendo propostas` | `leads` |
  | 129 (Lagoa Nova) | `Registro de Preço` | `historico` |

  Os dois só são congelados depois do merge de `claude/fase-reconciliada` (etapa 1).
- **`eventos` e `datas_normalizadas` do esperado:** escritos pelo Marcelo, ou pelo agente com revisão do Marcelo, lendo
  o documento oficial. Só entram no caso com página e trecho conferidos.
- **`data_fim`** = fim do recebimento de propostas. É o campo onde o caso 129 traz "2604-04-16".
- **SHA-256 completo do arquivo 3 de Baraúna:**
  `8f6429b0223e149a034f80f38d3209201257b4495cb5ed9acf0f6143d53b97f2`. É conferido de novo a cada download.
- **O que entra no git (decisão 2):**
  - JSON público do PNCP, só com os campos mínimos que `fase_da_compra()` e a normalização leem, como fixture em
    `laboratorio/casos/<id>/`;
  - PDFs **não** entram. O caso guarda URL oficial + SHA-256, e o `worker-documentos` baixa sob demanda para o cache
    local fora do git.

  Por isso a camada `regras` da CI não precisa de rede nem de documento binário.

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
{ "campo": "data_fim", "valor": "AAAA-MM-DD | null", "bruto": "2604-04-16", "regra": "data.ano_implausivel.v1", "origem": "pncp | portal | edital | inferido", "evidencia": "outra_fonte_oficial | digitacao_validada_por_cronologia | limite_pelos_fatos" }
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
- **Caso 129:** o "2604-04-16" está em `data_fim` (fim do recebimento de propostas) e passa pela escala acima. O valor corrigido só aparece se 1 ou 2 se aplicarem, e o caso
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
  - descartar a variante acima do teto de 60 s por página (decisão 5);
  - entre as que sobrarem, escolher a de mais eventos certos;
  - em empate, a mais rápida por página;
  - se A empatar com B ou C em eventos certos, fica A (sem modelo).
- **Execução e teto (decisão 5):** a camada de modelo roda **só em lote noturno**, nunca no caminho síncrono de uma
  requisição. O teto é de até 60 s por página, por documento, medido e registrado no relatório. Hoje há um único
  número: 105 s para 2 páginas, com `qwen2.5:7b`. Uma única medição não basta para dizer se cabe no teto; a etapa 4
  mede em todos os casos.

**OCR local (proposta, a medir):**

- **Engine:** Tesseract com o idioma `por`, via `ocrmypdf` (gera camada de texto por página e não altera o original;
  o original fica pelo SHA-256).
- **Alternativa se a qualidade não bastar:** PaddleOCR com GPU.
- **Não medido:** nada sobre essas engines nesta máquina. A etapa 5 mede, no arquivo 3 de Baraúna e em outros
  escaneados dos casos:
  - tempo por página;
  - caracteres extraídos;
  - se os trechos esperados aparecem no texto do OCR.
- **Referência do Gemini (decisão 6):** o OCR do Gemini (`ia.ocr_pdf()`) no arquivo 3 de Baraúna está autorizado como
  referência. O Marcelo roda à parte e informa o resultado, e o laboratório não chama o Gemini. O texto de referência
  entra na etapa 5 só para comparar com o OCR local. Até ele chegar, essa comparação fica pendente.

### 6. Ambiente de validação antes de produção (camadas)

| Camada | O que pega | Custo | Riscos | Estado |
|---|---|---|---|---|
| **1. Casos congelados na CI** (camada `regras`, job `python-coletor-externo`) | regressão de fase/prioridade/normalização em caso conhecido | minutos de CI do GitHub: a medir | só pega o que já virou caso; fixture desatualizada se a fonte mudar (o SHA-256 detecta no documento, não no JSON) | proposto (etapa 1) |
| **2a. Branch de preview do Supabase por PR** | migration e Edge Function rodando antes do merge, com banco isolado | cobrado por hora de branch ativa: valor a medir no plano da conta | sem `seed.sql` (`supabase/config.toml`: `[db.seed] enabled = false`), o banco do preview nasce vazio, e o seed precisa ser escrito sem dado pessoal; segredos das funções precisam existir no preview; cron/coletores não podem apontar para o preview por engano | **não verificado** |
| **2b. Preview do Dashboard (Cloudflare)** | UI do PR apontando para o backend de preview | a medir | o front de preview precisa apontar para o Supabase de preview, não para produção | **não verificado** (repositório `Dashboard---LicitaGym`) |
| **3. Docker Sandboxes** para agentes de desenvolvimento | agente de código isolado do host (rede, disco, credenciais) | tempo de máquina local; licença/plano: a verificar | exige o CLI `sbx`, não instalado; sem ele, seguem os worktrees, que não isolam rede nem credencial | **adiado (decisão 7):** não instalar o `sbx` agora; seguir com worktrees |

**Sobre a camada 2a:**

- o check "Supabase Preview" já aparece nos PRs. Pelo `CLAUDE.md`, esse check é a integração GitHub, que **aplica em
  produção no merge**;
- **não foi verificado** se a conta tem branching por PR habilitado, nem o custo, nem se a integração atual cria um
  branch por PR ou só reporta;
- o Marcelo vai verificar no painel (perguntas em aberto 1 e 2). Até lá, 2a e 2b continuam "não verificado", e a etapa 6 só
  documenta o que ele encontrar.

## Etapas de entrega (PRs pequenos)

| # | PR | Migration | Depende de |
|---|---|---|---|
| 1 | Formato do caso + `test_casos_congelados.py` (camada `regras`) + casos 135 (`Recebendo propostas`/`leads`) e 129 (`Registro de Preço`/`historico`), com fixtures JSON mínimas do PNCP | não | merge de `claude/fase-reconciliada` |
| 2 | Teste de alcance do Ollama do host a partir do container (`host.docker.internal:11434`), depois `laboratorio/compose.yml` + `worker-documentos` sem modelo: download sob demanda por URL + SHA-256, texto por página, `OCR_REQUIRED`, saída JSONL | não | 1 |
| 3 | Schema de evento + chamada Ollama + validadores (trecho literal, data por regex, cronologia, condicional, dedup) | não | 2; `_shared/agentes` na `main` (PRs `claude/resgate-*`) |
| 4 | Avaliador camada `modelo` em lote noturno + relatório A × B × C nos casos, com o teto de 60 s por página | não | 3 |
| 5 | OCR local (Tesseract/ocrmypdf) medido nos escaneados, comparado com a referência do Gemini que o Marcelo informar | não | 2 |
| 6 | Registro do que o Marcelo encontrar sobre preview Supabase + Dashboard (documento, sem mudança de infra) | não | verificação do Marcelo no painel |

A tabela sombra em produção não é etapa desta spec (decisão 4). Se vier, é uma spec nova depois das medições das etapas
4 e 5, com migration própria.

Fora destas etapas, mas recomendado: PR próprio para o estado `OCR_REQUIRED` em `licitacao_documentos.status_processamento`
e para os metadados de chunk que faltam. Ambos são exigidos pela instrução do pipeline documental e são migration de
produção.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o caso congelado 135 com `bloqueante: true`, **quando** `fase_da_compra()` recebe as entradas do caso, **então** `fase = "Recebendo propostas"` e `prioridade = "leads"` (não `Suspensa (documento)`). | pytest `services/coletor-externo/tests/test_casos_congelados.py` |
| CA-2 | **Dado** o caso 129, **quando** a camada `regras` roda, **então** `fase = "Registro de Preço"`, `prioridade = "historico"` (não `monitorar`), e `datas_normalizadas` traz `campo = "data_fim"`, `bruto = "2604-04-16"`, com `evidencia` e `origem` preenchidas. | pytest `test_casos_congelados.py` |
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
| CA-14 | **Dado** um caso cujo `entradas.documentos[]` traz PDF ou outro binário dentro de `laboratorio/casos/`, **quando** o carregador lê, **então** recusa: documento só por URL + SHA-256. | pytest `test_casos_congelados.py` |
| CA-15 | **Dado** o relatório da camada `modelo`, **quando** uma variante passa de 60 s por página em algum documento, **então** ela sai marcada como fora do teto e não é escolhida. | pytest `laboratorio/tests/test_avaliador.py` |

## Fora de escopo

- Corrigir as regras dos casos 129 e 135 (`claude/fase-reconciliada`).
- Mudar `fase`/`prioridade` de produção a partir de saída de modelo.
- Trocar o embedding ou reindexar `licitacao_chunks`.
- Estado `OCR_REQUIRED` e metadados de chunk em produção (PR próprio, ver acima).
- Tabela sombra em produção (decisão futura, depois da medição).
- Ativar branching do Supabase ou preview do Dashboard (a etapa 6 só registra).
- Instalar o CLI `sbx` ou migrar os agentes de desenvolvimento para Docker Sandboxes (decisão 7).
- Chamar o Gemini a partir do laboratório (a referência de OCR vem do Marcelo).
- Rodar a camada de modelo fora do lote noturno.
- Usar modelo local para escrever código do repositório.
- Processar proposta ou documento de habilitação de cliente no laboratório (política de IA, item 2): só documento
  público de edital.

## Impacto em dados

- **Migration:** não, em nenhuma etapa.
- **Tabelas/views/funções tocadas:**
  - nenhuma em produção;
  - o laboratório lê fixtures e documentos públicos e escreve em `laboratorio/saida/` e no Postgres local.
- **Arquivos versionados:** código, schema do caso e fixtures JSON mínimas do PNCP. PDFs nunca.
- **ACL/RLS:** nenhum.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas, como em todo merge na `main`, mas nenhuma muda.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:**
  - **oficial:** JSON PNCP, documento por SHA-256, `bruto`;
  - **derivado:** evento validado, `valor` normalizado (com `regra`, `origem`, `evidencia`), alerta de dado
    desatualizado;
  - nenhum valor inventado: sem evidência, `null`.

## Decisões (Marcelo, 09/10/2026)

1. **Esperado dos casos-semente:**
   - 135 = `Recebendo propostas` / `leads`;
   - 129 = `Registro de Preço` / `historico`.

   Os dois só são congelados depois do merge de `claude/fase-reconciliada`.
2. **Fixtures:** JSON público do PNCP, só com os campos mínimos, pode entrar no repositório. PDFs não: o caso guarda
   URL + SHA-256 e o documento é baixado sob demanda.
3. **Ollama:** o do host (modelos em `D:\ollama\models`). O teste de alcance do container em
   `host.docker.internal:11434` é o primeiro passo da etapa 2.
4. **Laboratório só local por enquanto.** Tabela sombra em produção fica como decisão futura, depois da medição.
5. **Camada de modelo:** só em lote noturno, com teto de até 60 s por página.
6. **OCR do Gemini no arquivo 3 de Baraúna:** autorizado como referência. O Marcelo roda à parte e informa o
   resultado.
7. **Docker Sandboxes:** não instalar o `sbx` agora; seguir com worktrees.
8. **Arquivos de agentes do checkout local:** estão sendo resgatados em PRs próprios (branches `claude/resgate-*`).
9. **Dados do caso:**
   - SHA-256 completo do arquivo 3 de Baraúna:
     `8f6429b0223e149a034f80f38d3209201257b4495cb5ed9acf0f6143d53b97f2`;
   - `data_fim` = fim do recebimento de propostas.

## Perguntas em aberto

1. **Preview do Supabase:** a conta tem branching por PR habilitado, e qual o custo por hora? O Marcelo vai verificar
   no painel. Até lá: não verificado.
2. **Preview do Dashboard:** o repositório `Dashboard---LicitaGym` já gera URL de preview por PR no Cloudflare, e dá
   para apontá-la para outro backend? O Marcelo vai verificar. Até lá: não verificado.

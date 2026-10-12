# Acompanhamento pelo Portal de Compras Públicas — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rota `acompanhamento` passa a devolver a seção `portal` (situação, datas, informações, documentos, chat e itens) quando `link_sistema_origem` for do Portal de Compras Públicas, e um job por minuto grava o estado e os eventos que mudam.

**Architecture:** Funções puras em `_shared/portal-compras-leitura.ts` normalizam o JSON do portal, calculam a fase e montam os eventos. A rota lê o retrato em `portal_acompanhamento` (cache de 5 minutos; `atualizar=true` força a rede, com espera de 30 segundos). O job `sync-portal-compras-publicas` é quem mantém o retrato e `portal_eventos`. O alerta diário da issue #266 (`portal_consulta`, `sync-portal-compras`) permanece.

**Tech Stack:** Edge Functions Deno, `UnifiedHttpClient`, Postgres 17 (migration idempotente, RLS, pg_cron), testes `deno test tests/supabase`.

**Base deste plano:** `main` em `84bac56`. Spec enviada em 08/10/2026 (Piraúba/MG, processo `513820`, PNCP `18554147000199-1-000140/2026`; processo encerrado `486428`).

## Global Constraints

- Dado ausente sai `null` ou lista vazia. Nenhum código de situação, página de chat ou prazo é inventado.
- Datas da API saem em UTC (`timestamptz` / ISO com `Z`). Texto de documento no formato `24/09/2026-09:54:08` é horário de Brasília e vira UTC com offset `-03:00` (America/Sao_Paulo não tem horário de verão desde 2019).
- Nomes de fornecedores e frases do chat saem como texto puro. A resposta não traz HTML.
- Timeout de 20 segundos por chamada. Falha de uma parte do portal preenche `erro` nessa parte e a resposta do PNCP continua 200.
- `User-Agent: LicitaGym/acompanhamento`.
- Sem login no portal: não envia proposta, lance, impugnação nem mensagem. Não baixa nem indexa PDF. Guarda nome, tipo e link.
- Fora desta entrega: BLL, BNC, Licitar Digital, Licitanet, e o fuso de `data_fim` do coletor PNCP.
- Migration nova, aditiva, idempotente. Não editar `20261008180000_portal_consulta.sql`. Merge na `main` aplica em produção e republica as Edge Functions: o PR fica em draft até o ok do Marcelo.
- Teste de unidade não chama a API do portal. Fixture com os campos e os valores que a spec já registrou.
- Papel de admin continua `app_metadata.licitagym_role`. Estas tabelas não têm policy para `authenticated`.

## O que já existe (issue #266) e o que esta entrega acrescenta

| Peça | Hoje | Esta entrega |
|---|---|---|
| `parsePortalProcessoUrl` | Extrai UF, comprador, processo e o último grupo de dígitos. Hosts `www` e apex. | Reusar. A seção nova publica `codigo_licitacao` como número. |
| `portal_consulta` + cron `0 11 * * *` | Retrato diário: situação, hash, erro. Alimenta o alerta de list/get. | Permanece. O job novo também atualiza `situacao` e `consultado_em` dessa linha, para o alerta não ficar um dia atrás. |
| `secaoPortal` | Objeto curto (`familia`, `atualizacao`, `desatualizado`, `no_pipeline`). Consulta ao vivo só no pipeline, no máximo uma vez por dia, debounce de 30 s. | A ação `acompanhamento` passa a devolver o objeto da spec. `anexarAlertaPortal` (list/get) continua com o objeto curto. |
| Cliente HTTP | `consultarPortal` faz um GET no detalhe, com `fetch` direto. | Fan-out pelo `UnifiedHttpClient` (lease por host já usado no acompanhamento do PNCP). |

Decisões travadas neste plano:

1. Host que não é o portal: `portal` é `{ "disponivel": false }`. As seções do PNCP não mudam. Comprasnet não dispara chamada ao portal.
2. Cache da rota: retrato com `consultado_em` há menos de 5 minutos volta sem rede. `atualizar=true` ignora esses 5 minutos. Se `consultado_em` tem menos de 30 segundos, a segunda chamada devolve o mesmo retrato e não consulta de novo. A espera mora em `consultado_em`, não num `Map` da instância.
3. A tela em fase `sessao` chama a rota a cada 60 segundos com `atualizar=true`. 60 s é maior que a espera de 30 s, então cada poll consulta. Dois cliques em menos de 30 s compartilham uma consulta.
4. `atualizado_em` do portal muda quando entra evento novo. O campo irmão `atualizado_em` na raiz da resposta é o mais recente entre `compra.datas.atualizacao` (PNCP) e `portal.atualizado_em`.
5. Precedência da fase, da mais urgente para a mais folgada: `encerrado`, `sessao`, `pos_sessao`, `aguardando_sessao`, `vespera_limites`, `propostas`. Janelas se sobrepõem (a última hora antes da abertura ainda é antes do fim das propostas; a véspera dos limites também). Ganha a mais urgente.
6. `encerrado` exige as duas coisas: descrição com homologado, fracassado ou revogado, e `existeResultado` verdadeiro no PNCP. Código numérico de `statusProcesso` não vira fase. A descrição é o texto exibido.
7. Chat: uma página. Se a lista vier com 50 mensagens, `chat.truncado = true`. Não há parâmetro conhecido para a página seguinte.
8. Inscrição da oportunidade: o job, a cada minuto, cria a linha que falta para link do portal com `data_fim` no futuro ou com a licitação no pipeline de empresa ativa. `proxima_consulta_em = now()`. A migration faz o backfill das abertas por `data_fim`. Sem trigger em `licitacoes_externas` (o coletor grava essa coluna dentro da transação de upsert).
9. Falha: esperas de 1, 5, 15 e 60 minutos. `falha_desde` marca o início. Depois de 24 horas, a seção sai com `indisponivel: true` e o job segue tentando a cada 60 minutos.
10. O cron de 1 minuto entra na migration. O PR não pede merge enquanto a pergunta da spec sobre termos de uso / API de parceiro estiver aberta.

## File structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/functions/_shared/portal-compras.ts` | Já existe. Continua dono do parse da URL, do alerta #266 e de `consultarPortal`. |
| `supabase/functions/_shared/portal-compras-leitura.ts` | Criar. Datas, normalização, fase, intervalo, diff de eventos, merge de chave de documento. Sem I/O. |
| `supabase/functions/_shared/portal-compras-cliente.ts` | Criar. Cinco chamadas em paralelo via `UnifiedHttpClient`, mais o POST do relatório em dois passos. |
| `supabase/functions/api-dashboard-oportunidades/portal.ts` | Passa a montar a seção rica na ação `acompanhamento`. O alerta de list/get fica. |
| `supabase/functions/api-dashboard-oportunidades/acompanhamento.ts` | `atualizar=true` ignora o cache em memória do PNCP. Anexa `atualizado_em` na raiz. |
| `supabase/functions/api-dashboard-oportunidades/types.ts` | Tipos `PortalAcompanhamento` e a ação `portal_relatorio`. |
| `supabase/functions/api-dashboard-oportunidades/validation.ts` | Valida `portal_relatorio`. |
| `supabase/functions/sync-portal-compras-publicas/index.ts` | Cron auth, trava, lote. |
| `supabase/functions/sync-portal-compras-publicas/sync.ts` | Inscreve, lê, grava retrato e eventos. |
| `supabase/migrations/20261012120000_portal_acompanhamento.sql` | Tabelas, índice, ACL, cron, backfill. |
| `supabase/tests/portal_acompanhamento_check.sql` | ACL. |
| `supabase/config.toml` | `verify_jwt = false` na função nova. |
| `tests/supabase/fixtures/portal_513820.json` e `portal_486428.json` | Corpos mínimos com os valores da spec. |
| `tests/supabase/functions/portal_leitura_test.ts` | Fase, datas, eventos, normalização. |
| `tests/supabase/functions/portal_cliente_test.ts` | Fan-out com `fetch` falso: uma parte falha, as outras voltam. |
| `tests/supabase/functions/sync_portal_publico_test.ts` | Lote, backoff, evento idempotente. |

O Dashboard (`licitagym-dashboard`) não está neste repositório. O contrato que ele consome está no apêndice. Plano de tela fica no outro repo, depois deste contrato estável num PR em draft.

---

### Task 1: Datas e normalização

**Files:**
- Create: `tests/supabase/fixtures/portal_513820.json`
- Create: `tests/supabase/fixtures/portal_486428.json`
- Create: `tests/supabase/functions/portal_leitura_test.ts`
- Create: `supabase/functions/_shared/portal-compras-leitura.ts`
- Test: `tests/supabase/functions/portal_leitura_test.ts`

**Interfaces:**
- Consumes: `parsePortalProcessoUrl` de `portal-compras.ts` (já devolve `codigoLicitacao` string).
- Produces:
  - `isoUtc(value: unknown): string | null` — aceita ISO com `Z`; rejeita o resto.
  - `textoBrasiliaParaUtc(value: unknown): string | null` — `DD/MM/AAAA-HH:mm:ss` → ISO UTC.
  - `normalizarDetalhe(body: unknown): DetalhePortal | null`
  - `normalizarDocumentos(body: unknown): DocumentoPortal[]`
  - `normalizarChat(body: unknown): ChatPortal`
  - `normalizarItens(body: unknown): ItemPortal[]`
  - `DetalhePortal`, `DocumentoPortal`, `ChatPortal`, `ItemPortal` exportados.

- [ ] **Step 1: Write the failing test**

Fixture `tests/supabase/fixtures/portal_513820.json` (só campos citados na spec; o que a spec não trouxe fica de fora):

```json
{
  "detalhe": {
    "codigoLicitacao": 513820,
    "statusProcesso": { "codigo": 13, "descricao": "Aguardando Início da Sessão Pública" },
    "dataHoraPublicacao": "2026-09-24T12:54:00.000Z",
    "dataHoraInicioRecebimentoPropostas": "2026-09-25T13:00:00.000Z",
    "dataHoraLimiteImpugnacoes": "2026-10-06T02:59:00.000Z",
    "dataHoraLimiteEsclarecimentos": "2026-10-06T02:59:00.000Z",
    "dataHoraFinalRecebimentoPropostas": "2026-10-08T12:59:00.000Z",
    "dataHoraAbertura": "2026-10-08T13:00:00.000Z",
    "dataHoraFechamento": null,
    "tipoLicitacao": "Pregão",
    "tipoJulgamento": "Menor Preço",
    "tratamentoFasesLances": "Aberto",
    "operacao": "Eletrônica",
    "nomeOperador": "Pregoeiro do processo",
    "labelOperador": "Pregoeiro",
    "nomePregoeiro": "",
    "nomeAutoridadeCompetente": "Autoridade",
    "nomeApoio": ["Apoio 1"],
    "origemRecurso": "Próprio",
    "legislacaoAplicavel": "14.133"
  },
  "documentos_processo": [
    { "nome": "Edital", "tipo": "Edital", "dataHora": "24/09/2026-09:54:08", "url": "https://arquivos.portaldecompraspublicas.com.br/v1/download/1", "idArquivo": 1, "tipoDownLoad": 1, "parametros": null, "codigoPncp": "edital-pncp" }
  ],
  "documentos_fornecedores": [],
  "chat": { "codigoUltimaFrase": 0, "mensagens": [] },
  "itens": { "total": 12, "dados": [{ "codigo": 1, "descricao": "Item", "quantidade": 1, "unidade": "UN", "valorReferencia": 10, "melhorLance": null, "situacao": { "descricao": "Aguardando" }, "participacao": { "descricao": "Ampla" } }] }
}
```

Os três documentos de impugnação entram na mesma lista, com `url` vazia e `parametros` preenchido num deles (`"Impugnacao,513820"`), `idArquivo` nulo. Completar a fixture com mais três objetos nesse formato antes do teste de contagem. Valores de nome que a spec não citou: usar `"Impugnação 1"`, `"Impugnação 2"`, `"Pedidos de Impugnação"` — rótulos da própria spec, não dado de produção além dela.

`portal_486428.json`: detalhe com `dataHoraFechamento` preenchido (`"2026-10-01T15:00:00.000Z"`), `statusProcesso.descricao` `"Homologado"`, chat com duas frases (`"Adjudicação"` e `"Homologação"`, `codigoUltimaFrase` 2, cada mensagem com `codigo` 1 e 2) e documentos nomeados `"Ata Final"` e `"Termo de Homologação"`.

Teste:

```ts
import { assertEquals } from "jsr:@std/assert@1";
import ref from "../fixtures/portal_513820.json" with { type: "json" };
import enc from "../fixtures/portal_486428.json" with { type: "json" };
import {
  isoUtc,
  normalizarChat,
  normalizarDetalhe,
  normalizarDocumentos,
  textoBrasiliaParaUtc,
} from "../../../supabase/functions/_shared/portal-compras-leitura.ts";
import { parsePortalProcessoUrl } from "../../../supabase/functions/_shared/portal-compras.ts";

const LINK =
  "https://www.portaldecompraspublicas.com.br/processos/MG/Prefeitura-Municipal-de-Pirauba-4946/RPE-115-2026-2026-513820";

Deno.test("o código 513820 sai do link, com e sem www", () => {
  assertEquals(parsePortalProcessoUrl(LINK)?.codigoLicitacao, "513820");
  assertEquals(
    parsePortalProcessoUrl(LINK.replace("www.", ""))?.codigoLicitacao,
    "513820",
  );
  assertEquals(parsePortalProcessoUrl("https://cnetmobile.estaleiro.serpro.gov.br/x"), null);
});

Deno.test("datas do detalhe permanecem UTC e o texto do documento vira UTC", () => {
  const detalhe = normalizarDetalhe(ref.detalhe);
  assertEquals(detalhe?.datas.fim_propostas, "2026-10-08T12:59:00.000Z");
  assertEquals(detalhe?.datas.abertura, "2026-10-08T13:00:00.000Z");
  assertEquals(detalhe?.datas.fechamento, null);
  assertEquals(textoBrasiliaParaUtc("24/09/2026-09:54:08"), "2026-09-24T12:54:08.000Z");
  assertEquals(isoUtc("24/09/2026-09:54:08"), null);
});

Deno.test("documentos e chat do 513820 e do 486428", () => {
  const docs = normalizarDocumentos([
    ...ref.documentos_processo,
    ...ref.documentos_fornecedores,
  ]);
  assertEquals(docs.length, 4);
  assertEquals(docs.filter((d) => d.parametros === "Impugnacao,513820").length, 1);
  assertEquals(normalizarChat(ref.chat).total, 0);
  const chat = normalizarChat(enc.chat);
  assertEquals(chat.ultima_frase, 2);
  assertEquals(chat.dados.map((m) => m.frase), ["Adjudicação", "Homologação"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/supabase/functions/portal_leitura_test.ts --allow-read --allow-env --no-prompt`

Expected: FAIL, módulo `portal-compras-leitura.ts` não existe.

- [ ] **Step 3: Write minimal implementation**

`portal-compras-leitura.ts`:

```ts
export interface DatasPortal {
  publicacao: string | null;
  inicio_propostas: string | null;
  limite_impugnacoes: string | null;
  limite_esclarecimentos: string | null;
  fim_propostas: string | null;
  abertura: string | null;
  fechamento: string | null;
}

export interface InformacoesPortal {
  tipo: string | null;
  fase_lances: string | null;
  operacao: string | null;
  operador: string | null;
  rotulo_operador: string | null;
  autoridade: string | null;
  apoio: string[];
  origem_recursos: string | null;
  legislacao: string | null;
}

export interface DetalhePortal {
  codigo_licitacao: number | null;
  situacao: { codigo: number | null; descricao: string | null };
  datas: DatasPortal;
  informacoes: InformacoesPortal;
}

export interface DocumentoPortal {
  nome: string | null;
  tipo: string | null;
  data_hora: string | null;
  url: string | null;
  id_arquivo: number | null;
  tipo_download: number | null;
  parametros: string | null;
  codigo_pncp: string | null;
}

export interface MensagemChat {
  codigo: number | null;
  data_hora: string | null;
  apelido: string | null;
  frase: string | null;
}

export interface ChatPortal {
  dados: MensagemChat[];
  total: number;
  ultima_frase: number;
  truncado: boolean;
}

export interface ItemPortal {
  codigo: number | null;
  descricao: string | null;
  quantidade: number | null;
  unidade: string | null;
  valor_referencia: number | null;
  melhor_lance: number | null;
  situacao: string | null;
  participacao: string | null;
}

function obj(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function texto(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const limpo = value.replace(/<[^>]*>/g, "").trim();
  return limpo === "" ? null : limpo;
}

function inteiro(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function numero(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function isoUtc(value: unknown): string | null {
  if (typeof value !== "string" || !value.endsWith("Z")) return null;
  const data = new Date(value);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString();
}

export function textoBrasiliaParaUtc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})-(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00`;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString();
}

function dataPortal(value: unknown): string | null {
  return isoUtc(value) ?? textoBrasiliaParaUtc(value);
}

export function normalizarDetalhe(body: unknown): DetalhePortal | null {
  const o = obj(body);
  if (!o) return null;
  const status = obj(o.statusProcesso);
  const apoio = Array.isArray(o.nomeApoio) ? o.nomeApoio.map(texto).filter((s): s is string => s !== null) : [];
  const tipo = [texto(o.tipoLicitacao), texto(o.tipoJulgamento)].filter((s) => s !== null).join(" / ");
  return {
    codigo_licitacao: inteiro(o.codigoLicitacao),
    situacao: {
      codigo: inteiro(status?.codigo),
      descricao: texto(status?.descricao),
    },
    datas: {
      publicacao: dataPortal(o.dataHoraPublicacao),
      inicio_propostas: dataPortal(o.dataHoraInicioRecebimentoPropostas),
      limite_impugnacoes: dataPortal(o.dataHoraLimiteImpugnacoes),
      limite_esclarecimentos: dataPortal(o.dataHoraLimiteEsclarecimentos),
      fim_propostas: dataPortal(o.dataHoraFinalRecebimentoPropostas),
      abertura: dataPortal(o.dataHoraAbertura),
      fechamento: dataPortal(o.dataHoraFechamento),
    },
    informacoes: {
      tipo: tipo === "" ? null : tipo,
      fase_lances: texto(o.tratamentoFasesLances),
      operacao: texto(o.operacao),
      operador: texto(o.nomeOperador) ?? texto(o.nomePregoeiro),
      rotulo_operador: texto(o.labelOperador),
      autoridade: texto(o.nomeAutoridadeCompetente),
      apoio,
      origem_recursos: texto(o.origemRecurso),
      legislacao: texto(o.legislacaoAplicavel),
    },
  };
}

function umDocumento(value: unknown): DocumentoPortal | null {
  const o = obj(value);
  if (!o) return null;
  return {
    nome: texto(o.nome),
    tipo: texto(o.tipo),
    data_hora: dataPortal(o.dataHora),
    url: texto(o.url),
    id_arquivo: inteiro(o.idArquivo),
    tipo_download: inteiro(o.tipoDownLoad),
    parametros: texto(o.parametros),
    codigo_pncp: texto(o.codigoPncp),
  };
}

export function normalizarDocumentos(body: unknown): DocumentoPortal[] {
  const lista = Array.isArray(body) ? body : obj(body)?.dados;
  if (!Array.isArray(lista)) return [];
  return lista.map(umDocumento).filter((d): d is DocumentoPortal => d !== null);
}

export function normalizarChat(body: unknown): ChatPortal {
  const o = obj(body);
  const bruta = Array.isArray(body) ? body : (o?.mensagens ?? o?.dados);
  const dados: MensagemChat[] = Array.isArray(bruta)
    ? bruta.map((item) => {
      const m = obj(item);
      return {
        codigo: inteiro(m?.codigo),
        data_hora: dataPortal(m?.dataHoraFrase),
        apelido: texto(m?.apelido),
        frase: texto(m?.frase),
      };
    })
    : [];
  return {
    dados,
    total: dados.length,
    ultima_frase: inteiro(o?.codigoUltimaFrase) ?? 0,
    truncado: dados.length === 50,
  };
}

export function normalizarItens(body: unknown): { dados: ItemPortal[]; total: number } {
  const o = obj(body);
  const bruta = Array.isArray(body) ? body : (o?.dados ?? o?.itens);
  const dados: ItemPortal[] = Array.isArray(bruta)
    ? bruta.map((item) => {
      const m = obj(item);
      return {
        codigo: inteiro(m?.codigo),
        descricao: texto(m?.descricao),
        quantidade: numero(m?.quantidade),
        unidade: texto(m?.unidade),
        valor_referencia: numero(m?.valorReferencia),
        melhor_lance: numero(m?.melhorLance),
        situacao: texto(obj(m?.situacao)?.descricao),
        participacao: texto(obj(m?.participacao)?.descricao),
      };
    })
    : [];
  const total = inteiro(o?.total) ?? dados.length;
  return { dados, total };
}
```

O teste de documentos espera 4 itens. A fixture precisa ter 4 documentos de processo (edital + 3). Ajustar a fixture, não o teste, se a contagem falhar.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/supabase/functions/portal_leitura_test.ts --allow-read --allow-env --no-prompt`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/portal-compras-leitura.ts tests/supabase/functions/portal_leitura_test.ts tests/supabase/fixtures/portal_513820.json tests/supabase/fixtures/portal_486428.json
git commit -m "feat(portal): normaliza detalhe, datas, documentos e chat"
```

---

### Task 2: Fase e eventos

**Files:**
- Modify: `supabase/functions/_shared/portal-compras-leitura.ts`
- Modify: `tests/supabase/functions/portal_leitura_test.ts`

**Interfaces:**
- Consumes: `DatasPortal`, `DocumentoPortal`, `ChatPortal` da Task 1.
- Produces:
  - `type FasePortal = "propostas" | "vespera_limites" | "aguardando_sessao" | "sessao" | "pos_sessao" | "encerrado"`
  - `calcularFase(relogio: RelogioFase): FasePortal`
  - `intervaloMs(fase: FasePortal): number | null` — `null` em `encerrado`
  - `esperaFalhaMs(tentativas: number): number` — 1, 5, 15, 60 minutos
  - `diffEventos(antes: RetratoEvento, depois: RetratoEvento): EventoPortal[]`
  - `chaveDocumento(doc: DocumentoPortal): string | null`
  - `mesmoEdital(doc: DocumentoPortal, arquivoPncp: { titulo: string | null }): boolean`

- [ ] **Step 1: Write the failing test**

Acrescentar em `portal_leitura_test.ts`:

```ts
import {
  calcularFase,
  diffEventos,
  esperaFalhaMs,
  intervaloMs,
  mesmoEdital,
} from "../../../supabase/functions/_shared/portal-compras-leitura.ts";

const H = 60 * 60 * 1000;
function relogio(parcial: Partial<Parameters<typeof calcularFase>[0]>) {
  return {
    agora: new Date("2026-10-08T12:00:00.000Z"),
    fimPropostas: new Date("2026-10-08T12:59:00.000Z"),
    limiteImpugnacoes: new Date("2026-10-06T02:59:00.000Z"),
    limiteEsclarecimentos: new Date("2026-10-06T02:59:00.000Z"),
    abertura: new Date("2026-10-08T13:00:00.000Z"),
    fechamento: null,
    chatTemMensagem: false,
    ultimaMensagemEm: null,
    situacaoDescricao: "Aguardando Início da Sessão Pública",
    existeResultadoPncp: false,
    ...parcial,
  };
}

Deno.test("as seis fases", () => {
  assertEquals(calcularFase(relogio({ agora: new Date("2026-09-26T13:00:00.000Z") })), "propostas");
  assertEquals(calcularFase(relogio({ agora: new Date("2026-10-06T00:00:00.000Z") })), "vespera_limites");
  assertEquals(calcularFase(relogio({ agora: new Date("2026-10-08T12:30:00.000Z") })), "aguardando_sessao");
  assertEquals(
    calcularFase(relogio({
      agora: new Date("2026-10-08T14:00:00.000Z"),
      chatTemMensagem: true,
      ultimaMensagemEm: new Date("2026-10-08T13:50:00.000Z"),
    })),
    "sessao",
  );
  assertEquals(
    calcularFase(relogio({
      agora: new Date("2026-10-08T16:00:00.000Z"),
      chatTemMensagem: true,
      ultimaMensagemEm: new Date("2026-10-08T13:00:00.000Z"),
    })),
    "pos_sessao",
  );
  assertEquals(
    calcularFase(relogio({
      situacaoDescricao: "Homologado",
      existeResultadoPncp: true,
      fechamento: new Date("2026-10-08T18:00:00.000Z"),
    })),
    "encerrado",
  );
  assertEquals(intervaloMs("sessao"), 2 * 60 * 1000);
  assertEquals(intervaloMs("propostas"), 6 * H);
  assertEquals(intervaloMs("encerrado"), null);
  assertEquals(esperaFalhaMs(1), 60 * 1000);
  assertEquals(esperaFalhaMs(2), 5 * 60 * 1000);
  assertEquals(esperaFalhaMs(3), 15 * 60 * 1000);
  assertEquals(esperaFalhaMs(4), 60 * 60 * 1000);
});

Deno.test("documento novo gera um evento e a segunda comparação não gera outro", () => {
  const doc = {
    nome: "Impugnação 1",
    tipo: "Impugnação",
    data_hora: "2026-10-07T15:00:00.000Z",
    url: null,
    id_arquivo: 9,
    tipo_download: null,
    parametros: null,
    codigo_pncp: null,
  };
  const base = {
    situacaoCodigo: 13,
    datas: {
      publicacao: null,
      inicio_propostas: null,
      limite_impugnacoes: null,
      limite_esclarecimentos: null,
      fim_propostas: "2026-10-08T12:59:00.000Z",
      abertura: "2026-10-08T13:00:00.000Z",
      fechamento: null,
    },
    documentos: [] as DocumentoPortal[],
    ultimaFrase: 0,
    mensagens: [],
  };
  const primeiro = diffEventos(base, { ...base, documentos: [doc] });
  assertEquals(primeiro.map((e) => e.chave), ["documento:9"]);
  const segundo = diffEventos({ ...base, documentos: [doc] }, { ...base, documentos: [doc] });
  assertEquals(segundo, []);
});

Deno.test("edital com codigo_pncp e o mesmo título no PNCP é o mesmo documento", () => {
  const doc = {
    nome: "Edital",
    tipo: "Edital",
    data_hora: null,
    url: "https://arquivos.portaldecompraspublicas.com.br/v1/download/1",
    id_arquivo: 1,
    tipo_download: 1,
    parametros: null,
    codigo_pncp: "edital-pncp",
  };
  assertEquals(mesmoEdital(doc, { titulo: "Edital Pregão", sequencialDocumento: 1 }), true);
  assertEquals(mesmoEdital({ ...doc, codigo_pncp: null, nome: "Ata Final" }, { titulo: "Edital" }), false);
});
```

Importar `DocumentoPortal` no teste. O objeto `datas` acima já é o `DatasPortal` completo.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/supabase/functions/portal_leitura_test.ts --allow-read --allow-env --no-prompt`

Expected: FAIL, `calcularFase` não exportado.

- [ ] **Step 3: Write minimal implementation**

Acrescentar no mesmo módulo:

```ts
export type FasePortal =
  | "propostas"
  | "vespera_limites"
  | "aguardando_sessao"
  | "sessao"
  | "pos_sessao"
  | "encerrado";

export interface RelogioFase {
  agora: Date;
  fimPropostas: Date | null;
  limiteImpugnacoes: Date | null;
  limiteEsclarecimentos: Date | null;
  abertura: Date | null;
  fechamento: Date | null;
  chatTemMensagem: boolean;
  ultimaMensagemEm: Date | null;
  situacaoDescricao: string | null;
  existeResultadoPncp: boolean;
}

const HORA = 60 * 60 * 1000;

function naJanela(agora: Date, marco: Date | null, antes: number, depois: number): boolean {
  if (!marco) return false;
  const t = agora.getTime();
  const m = marco.getTime();
  return t >= m - antes && t <= m + depois;
}

export function calcularFase(r: RelogioFase): FasePortal {
  const desc = (r.situacaoDescricao ?? "").toLocaleLowerCase("pt-BR");
  if (/homolog|fracass|revog/.test(desc) && r.existeResultadoPncp) return "encerrado";
  const quieta = r.ultimaMensagemEm != null && r.agora.getTime() - r.ultimaMensagemEm.getTime() >= 2 * HORA;
  if (r.chatTemMensagem && r.fechamento == null && !quieta) return "sessao";
  if (r.fechamento != null || (r.chatTemMensagem && quieta)) return "pos_sessao";
  if (r.abertura && r.agora.getTime() >= r.abertura.getTime() - HORA && !r.chatTemMensagem) {
    return "aguardando_sessao";
  }
  if (
    naJanela(r.agora, r.limiteImpugnacoes, 24 * HORA, 24 * HORA) ||
    naJanela(r.agora, r.limiteEsclarecimentos, 24 * HORA, 24 * HORA)
  ) {
    return "vespera_limites";
  }
  if (r.fimPropostas == null || r.agora.getTime() < r.fimPropostas.getTime()) return "propostas";
  return "pos_sessao";
}

export function intervaloMs(fase: FasePortal): number | null {
  switch (fase) {
    case "propostas":
      return 6 * HORA;
    case "vespera_limites":
      return HORA;
    case "aguardando_sessao":
      return 5 * 60 * 1000;
    case "sessao":
      return 2 * 60 * 1000;
    case "pos_sessao":
      return HORA;
    case "encerrado":
      return null;
    default: {
      const nunca: never = fase;
      return nunca;
    }
  }
}

export function esperaFalhaMs(tentativas: number): number {
  if (tentativas <= 1) return 60 * 1000;
  if (tentativas === 2) return 5 * 60 * 1000;
  if (tentativas === 3) return 15 * 60 * 1000;
  return 60 * 60 * 1000;
}

export interface RetratoEvento {
  situacaoCodigo: number | null;
  datas: DatasPortal;
  documentos: DocumentoPortal[];
  ultimaFrase: number;
  mensagens: MensagemChat[];
}

export interface EventoPortal {
  tipo: "situacao" | "data" | "documento" | "chat";
  ocorrido_em: string | null;
  titulo: string;
  detalhe: Record<string, unknown>;
  chave: string;
}

export function chaveDocumento(doc: DocumentoPortal): string | null {
  if (doc.id_arquivo != null) return `documento:${doc.id_arquivo}`;
  if (doc.parametros) return `documento:${doc.parametros}`;
  return null;
}

function normNome(value: string | null): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").trim();
}

export function mesmoEdital(
  doc: DocumentoPortal,
  arquivoPncp: { titulo: string | null },
): boolean {
  if (doc.codigo_pncp) return normNome(doc.nome).length > 0 && normNome(arquivoPncp.titulo).includes(normNome(doc.nome));
  return false;
}

const CAMPOS_DATA: Array<keyof DatasPortal> = [
  "publicacao",
  "inicio_propostas",
  "limite_impugnacoes",
  "limite_esclarecimentos",
  "fim_propostas",
  "abertura",
  "fechamento",
];

export function diffEventos(antes: RetratoEvento, depois: RetratoEvento): EventoPortal[] {
  const eventos: EventoPortal[] = [];
  if (depois.situacaoCodigo != null && depois.situacaoCodigo !== antes.situacaoCodigo) {
    eventos.push({
      tipo: "situacao",
      ocorrido_em: null,
      titulo: "Situação atualizada",
      detalhe: { codigo: depois.situacaoCodigo },
      chave: `situacao:${depois.situacaoCodigo}`,
    });
  }
  for (const campo of CAMPOS_DATA) {
    const novo = depois.datas[campo];
    if (novo && novo !== antes.datas[campo]) {
      eventos.push({
        tipo: "data",
        ocorrido_em: novo,
        titulo: campo,
        detalhe: { campo, valor: novo },
        chave: `data:${campo}:${novo}`,
      });
    }
  }
  const chavesAntes = new Set(antes.documentos.map(chaveDocumento).filter((c): c is string => c !== null));
  for (const doc of depois.documentos) {
    const chave = chaveDocumento(doc);
    if (chave && !chavesAntes.has(chave)) {
      eventos.push({
        tipo: "documento",
        ocorrido_em: doc.data_hora,
        titulo: doc.nome ?? "Documento",
        detalhe: { nome: doc.nome, tipo: doc.tipo, parametros: doc.parametros },
        chave,
      });
    }
  }
  const novas = depois.mensagens.filter((m) => m.codigo != null && m.codigo > antes.ultimaFrase);
  for (const msg of novas) {
    eventos.push({
      tipo: "chat",
      ocorrido_em: msg.data_hora,
      titulo: msg.apelido ?? "Chat",
      detalhe: { frase: msg.frase, apelido: msg.apelido },
      chave: `chat:${msg.codigo}`,
    });
  }
  return eventos;
}
```

`mesmoEdital` exige `codigo_pncp` preenchido e o nome normalizado do portal contido no título do PNCP. Documento sem `codigo_pncp` nunca funde. É a primeira regra da spec; volume real revisa depois.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/supabase/functions/portal_leitura_test.ts --allow-read --allow-env --no-prompt`

Expected: PASS. Os seis `assertEquals` de fase batem com a tabela da spec.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/portal-compras-leitura.ts tests/supabase/functions/portal_leitura_test.ts
git commit -m "feat(portal): calcula a fase e o diff de eventos"
```

---

### Task 3: Cliente HTTP com erro isolado

**Files:**
- Create: `supabase/functions/_shared/portal-compras-cliente.ts`
- Create: `tests/supabase/functions/portal_cliente_test.ts`

**Interfaces:**
- Consumes: `UnifiedHttpClient` (`fetch` já usado no acompanhamento), normalizadores da Task 1, `parsePortalProcessoUrl`.
- Produces:
  - `lerPortal(http: UnifiedHttpClient, processo: PortalProcesso): Promise<LeituraPortal>`
  - `LeituraPortal` com `detalhe`, `documentos`, `chat`, `itens`, cada um `{ dados, erro }`. `erro` de uma parte não apaga as outras.
  - `baixarRelatorio(http, parametros: string, codigoLicitacao: number): Promise<{ url: string | null; codigo_gerador: number | null; codigo_situacao: number | null; erro: string | null }>`

- [ ] **Step 1: Write the failing test**

```ts
import { assertEquals } from "jsr:@std/assert@1";
import { lerPortal } from "../../../supabase/functions/_shared/portal-compras-cliente.ts";
import { parsePortalProcessoUrl } from "../../../supabase/functions/_shared/portal-compras.ts";

Deno.test("falha do chat não apaga o detalhe", async () => {
  const processo = parsePortalProcessoUrl(
    "https://www.portaldecompraspublicas.com.br/processos/MG/Prefeitura-Municipal-de-Pirauba-4946/RPE-115-2026-2026-513820",
  );
  if (!processo) throw new Error("link de referência");
  const http = {
    fetch: async (url: string) => {
      if (url.includes("/chat")) return new Response("nope", { status: 500 });
      if (url.includes("/itens")) return Response.json({ total: 12, dados: [] });
      if (url.includes("/documentos")) return Response.json([]);
      return Response.json({
        codigoLicitacao: 513820,
        statusProcesso: { codigo: 13, descricao: "Aguardando Início da Sessão Pública" },
        dataHoraFinalRecebimentoPropostas: "2026-10-08T12:59:00.000Z",
        dataHoraAbertura: "2026-10-08T13:00:00.000Z",
      });
    },
  };
  const leitura = await lerPortal(http as never, processo);
  assertEquals(leitura.detalhe.erro, null);
  assertEquals(leitura.detalhe.dados?.situacao.codigo, 13);
  assertEquals(leitura.chat.erro !== null, true);
  assertEquals(leitura.itens.erro, null);
});

Deno.test("relatório gerado pede de novo até a situação 4", async () => {
  const chamadas: unknown[] = [];
  const http = {
    fetch: async (_url: string, init?: RequestInit) => {
      chamadas.push(JSON.parse(String(init?.body)));
      if (chamadas.length === 1) return Response.json({ codigoGeradorArquivo: 77, codigoSituacao: 1 });
      return Response.json({ codigoGeradorArquivo: 77, codigoSituacao: 4, url: "https://arquivos.portaldecompraspublicas.com.br/v1/download/77" });
    },
  };
  const { baixarRelatorio } = await import("../../../supabase/functions/_shared/portal-compras-cliente.ts");
  const resultado = await baixarRelatorio(http, "Impugnacao,513820", 513820, () => Promise.resolve());
  assertEquals(resultado.url, "https://arquivos.portaldecompraspublicas.com.br/v1/download/77");
  assertEquals(resultado.erro, null);
  assertEquals((chamadas[1] as { codigoGeradorArquivo: number }).codigoGeradorArquivo, 77);
});
```

O teste usa um double com `fetch`, não o `UnifiedHttpClient` de produção. `lerPortal` aceita `{ fetch(url: string, init?: RequestInit): Promise<Response> }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/supabase/functions/portal_cliente_test.ts --allow-read --allow-env --no-prompt`

Expected: FAIL, módulo ausente.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { PortalProcesso } from "./portal-compras.ts";
import {
  normalizarChat,
  normalizarDetalhe,
  normalizarDocumentos,
  normalizarItens,
  type ChatPortal,
  type DetalhePortal,
  type DocumentoPortal,
  type ItemPortal,
} from "./portal-compras-leitura.ts";

const API = "https://compras.api.portaldecompraspublicas.com.br";
const CONTEUDO = "https://conteudo.api.portaldecompraspublicas.com.br";
const USER_AGENT = "LicitaGym/acompanhamento";

export interface Parte<T> {
  dados: T;
  erro: string | null;
}

export interface LeituraPortal {
  detalhe: Parte<DetalhePortal | null>;
  documentos: Parte<DocumentoPortal[]>;
  chat: Parte<ChatPortal>;
  itens: Parte<{ dados: ItemPortal[]; total: number }>;
}

type Buscador = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

async function getJson(http: Buscador, url: string): Promise<{ body: unknown; erro: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await http.fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (res.status === 429) return { body: null, erro: "limite do portal" };
    if (!res.ok) return { body: null, erro: `resposta ${res.status}` };
    return { body: await res.json(), erro: null };
  } catch (err) {
    const abortou = err instanceof Error && err.name === "AbortError";
    return { body: null, erro: abortou ? "timeout" : "falha de rede" };
  } finally {
    clearTimeout(timer);
  }
}

export async function lerPortal(http: Buscador, processo: PortalProcesso): Promise<LeituraPortal> {
  const codigo = encodeURIComponent(processo.codigoLicitacao);
  const [detalhe, docsProcesso, docsFornecedores, chat, itensPagina] = await Promise.allSettled([
    getJson(http, processo.api),
    getJson(http, `${API}/v2/licitacao/${codigo}/documentos/processo`),
    getJson(http, `${API}/v2/licitacao/${codigo}/documentos/fornecedores`),
    getJson(http, `${API}/v1/licitacao/${codigo}/chat`),
    getJson(http, `${API}/v2/licitacao/${codigo}/itens?pagina=1`),
  ]);
  const parte = <T>(settled: PromiseSettledResult<{ body: unknown; erro: string | null }>, vazio: T, map: (body: unknown) => T): Parte<T> => {
    if (settled.status === "rejected") return { dados: vazio, erro: "falha de rede" };
    if (settled.value.erro) return { dados: vazio, erro: settled.value.erro };
    return { dados: map(settled.value.body), erro: null };
  };
  const processoDocs = parte(docsProcesso, [] as DocumentoPortal[], normalizarDocumentos);
  const fornecedorDocs = parte(docsFornecedores, [] as DocumentoPortal[], normalizarDocumentos);
  return {
    detalhe: parte(detalhe, null, (body) => normalizarDetalhe(body)),
    documentos: {
      dados: [...processoDocs.dados, ...fornecedorDocs.dados],
      erro: processoDocs.erro ?? fornecedorDocs.erro,
    },
    chat: parte(chat, { dados: [], total: 0, ultima_frase: 0, truncado: false }, normalizarChat),
    itens: parte(itensPagina, { dados: [], total: 0 }, normalizarItens),
  };
}
```

`baixarRelatorio(http, parametros, codigoLicitacao, esperar = (ms) => new Promise((r) => setTimeout(r, ms)))` fica no mesmo arquivo. POST `{ codigoGeradorArquivo: 0, codigoTipoGerador: 2, codigoUsuarioEntidade: 10, parametros, reprocessar: false }` em `CONTEUDO + "/v1/arquivo/download"`, com `User-Agent` e timeout de 20 s. Repetir o POST com o `codigoGeradorArquivo` devolvido, no máximo 5 vezes, chamando `esperar(1000)` entre elas, parando em `codigoSituacao === 4` (devolve `url`) ou em erro. O teste passa `esperar: () => Promise.resolve()`. `parametros` só segue se for string no formato `texto,digitos` (vírgula e o código da licitação no fim). Corpo inesperado: `erro: "formato inesperado"`, `url: null`.

Itens: a primeira página é a do `Promise.allSettled`. Se `total` vier maior que `dados.length`, pedir `pagina=2`, `pagina=3`, … até a página voltar vazia, o acumulado alcançar `total`, ou 20 páginas. Cada página extra é outra chamada, com o mesmo timeout. Erro numa página seguinte guarda os itens já lidos e preenche `itens.erro`. O processo de referência tem 12 itens; uma página basta.

A chave do array de mensagens não está na spec (`codigoUltimaFrase` está). `normalizarChat` aceita corpo array, `mensagens` ou `dados`. A fixture usa `mensagens`. Quando houver um corpo real gravado, trocar a fixture se a chave for outra; o normalizador já cobre as três.

O `UnifiedHttpClient` de produção entra na rota (Task 5) por um adaptador. O método público é `fetchWithRateLimit(url, init, options)` em `supabase/functions/_shared/http-client/unified-client.ts`. Uma tentativa, timeout de 20 s, para as cinco chamadas paralelas não triplicarem em retry:

```ts
const buscador = {
  fetch: (url: string, init?: RequestInit) =>
    httpClient.fetchWithRateLimit(url, init, { attemptTimeoutMs: 20_000, maxAttempts: 1, maxTimeoutRetries: 0 }),
};
```

O lease por host permanece ligado quando `client.schema("private")` existe, como o acompanhamento do PNCP já faz.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/supabase/functions/portal_cliente_test.ts --allow-read --allow-env --no-prompt`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/portal-compras-cliente.ts tests/supabase/functions/portal_cliente_test.ts
git commit -m "feat(portal): lê detalhe, documentos, chat e itens com erro isolado"
```

---

### Task 4: Tabelas, ACL e cron

**Files:**
- Create: `supabase/migrations/20261012120000_portal_acompanhamento.sql`
- Create: `supabase/tests/portal_acompanhamento_check.sql`
- Modify: `supabase/config.toml` (bloco `verify_jwt` da função nova; a função em si vem na Task 6)

**Interfaces:**
- Produces: `public.portal_acompanhamento`, `public.portal_eventos`, índice parcial, job `licitagym-sync-portal-compras-publicas`.

- [ ] **Step 1: Write the failing check**

Copiar a estrutura de `supabase/tests/portal_consulta_check.sql` para as duas tabelas: RLS ligado; `anon`, `authenticated` e `public` sem SELECT/INSERT/UPDATE/DELETE/TRUNCATE; `service_role` com SELECT/INSERT/UPDATE/DELETE. Para `portal_eventos`, também `service_role` sem necessidade de sequence grant se a coluna for `GENERATED ALWAYS AS IDENTITY` (o insert do service_role omite `id`).

- [ ] **Step 2: Run check to verify it fails**

A checagem só roda com o Postgres descartável. Neste passo, o arquivo SQL da checagem existe e a migration ainda não. Rodar depois da migration:

`scripts/validar-migrations.sh`

Expected antes da migration existir no fluxo da skill: a checagem referencia tabela ausente e falha. Na prática, escrever a migration no step 3 e rodar o script uma vez no step 4.

- [ ] **Step 3: Write the migration**

Cabeçalho no padrão da skill `nova-migration`. Corpo:

```sql
begin;

set local lock_timeout = '10s';
set local statement_timeout = '1min';

create table if not exists public.portal_acompanhamento (
  licitacao_id bigint primary key references public.licitacoes_externas (id) on delete cascade,
  origem text not null default 'portaldecompraspublicas',
  codigo_licitacao bigint,
  caminho text,
  fase text not null default 'propostas',
  situacao_codigo integer,
  situacao_descricao text,
  datas jsonb not null default '{}'::jsonb,
  informacoes jsonb not null default '{}'::jsonb,
  documentos jsonb not null default '[]'::jsonb,
  ultima_frase bigint not null default 0,
  consultado_em timestamptz,
  atualizado_em timestamptz,
  proxima_consulta_em timestamptz not null default now(),
  tentativas integer not null default 0,
  ultimo_erro text,
  falha_desde timestamptz,
  constraint portal_acompanhamento_fase_chk check (
    fase in ('propostas', 'vespera_limites', 'aguardando_sessao', 'sessao', 'pos_sessao', 'encerrado')
  ),
  constraint portal_acompanhamento_erro_chk check (ultimo_erro is null or char_length(ultimo_erro) <= 500)
);

create table if not exists public.portal_eventos (
  id bigint generated always as identity primary key,
  licitacao_id bigint not null references public.licitacoes_externas (id) on delete cascade,
  tipo text not null,
  ocorrido_em timestamptz,
  detectado_em timestamptz not null default now(),
  titulo text not null,
  detalhe jsonb not null default '{}'::jsonb,
  chave text not null,
  constraint portal_eventos_tipo_chk check (tipo in ('situacao', 'data', 'documento', 'chat')),
  constraint portal_eventos_chave_uk unique (licitacao_id, chave)
);

create index if not exists portal_acompanhamento_proxima_idx
  on public.portal_acompanhamento (proxima_consulta_em)
  where fase <> 'encerrado';

alter table public.portal_acompanhamento enable row level security;
alter table public.portal_eventos enable row level security;

revoke all on table public.portal_acompanhamento from PUBLIC, anon, authenticated;
revoke all on table public.portal_eventos from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table public.portal_acompanhamento to service_role;
grant select, insert, update, delete on table public.portal_eventos to service_role;

insert into public.portal_acompanhamento (licitacao_id, caminho, codigo_licitacao, proxima_consulta_em)
select le.id,
       substring(le.link_sistema_origem from 'portaldecompraspublicas\.com\.br/processos/([A-Za-z]{2}/[^/?#]+/[^/?#]+)'),
       substring(le.link_sistema_origem from '(\d+)\s*$')::bigint,
       now()
  from public.licitacoes_externas le
 where le.link_sistema_origem ~* '^https://(www\.)?portaldecompraspublicas\.com\.br/processos/[A-Za-z]{2}/'
   and le.data_fim > now()
on conflict (licitacao_id) do nothing;

-- cron: igual a 20261008180000, expressão '* * * * *', timeout 55000, corpo '{"limite": 10}'
-- jobname licitagym-sync-portal-compras-publicas, função sync-portal-compras-publicas
-- se cron ausente, raise notice e return

commit;
```

`falha_desde` não está na tabela da spec. Entra porque a regra de 24 horas precisa do instante da primeira falha. Comentário na migration diz isso.

O bloco do cron copia o `do $cron$` de `20261008180000_portal_consulta.sql`, trocando o nome do job, a expressão e o timeout. Não remover o job diário `licitagym-sync-portal-compras`.

`config.toml`, depois do bloco de `sync-portal-compras`:

```toml
# sync-portal-compras-publicas: Bearer SYNC_CRON_SECRET no código. Uma vez por minuto.
[functions.sync-portal-compras-publicas]
verify_jwt = false
```

- [ ] **Step 4: Run migration validation**

Run: `scripts/validar-migrations.sh`

Expected: a migration nova aplica, reaplica, e `portal_acompanhamento_check.sql` imprime `SUCESSO`. Se o Docker do Postgres 17 não estiver disponível neste ambiente, registrar isso no PR e não marcar a task como verificada.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20261012120000_portal_acompanhamento.sql supabase/tests/portal_acompanhamento_check.sql supabase/config.toml
git commit -m "feat(portal): tabelas de acompanhamento e cron por minuto"
```

---

### Task 5: Seção `portal` na rota de acompanhamento

**Files:**
- Modify: `supabase/functions/api-dashboard-oportunidades/types.ts`
- Modify: `supabase/functions/api-dashboard-oportunidades/portal.ts`
- Modify: `supabase/functions/api-dashboard-oportunidades/acompanhamento.ts`
- Modify: `tests/supabase/functions/portal_compras_test.ts` (o contrato de `atualizar` da rota rica; os testes do alerta diário continuam válidos)

**Interfaces:**
- Consumes: `lerPortal`, `calcularFase`, `diffEventos`, `PORTAL_DEBOUNCE_MS`.
- Produces: `montarSecaoPortal(...)` devolvendo o JSON da spec, mais `atualizado_em` e `leitura` (`"cache"` | `"consultado"` | `"debounce"`) e `indisponivel` (boolean).

Forma quando o link é do portal e a leitura (ou o retrato) existe:

```json
{
  "disponivel": true,
  "origem": "portaldecompraspublicas",
  "codigo_licitacao": 513820,
  "url_portal": "https://www.portaldecompraspublicas.com.br/processos/MG/...",
  "consultado_em": "2026-10-08T13:51:27.000Z",
  "atualizado_em": "2026-10-08T13:51:27.000Z",
  "leitura": "consultado",
  "indisponivel": false,
  "situacao": { "codigo": 13, "descricao": "Aguardando Início da Sessão Pública" },
  "datas": {},
  "informacoes": {},
  "documentos": { "dados": [], "total": 0, "erro": null },
  "chat": { "dados": [], "total": 0, "ultima_frase": 0, "truncado": false, "erro": null },
  "itens": { "dados": [], "total": 0, "erro": null }
}
```

- [ ] **Step 1: Write the failing test**

Em `portal_compras_test.ts`, um teste com cliente Supabase falso (o arquivo `portal_tenant_test.ts` já tem `clienteFalso`): link da Piraúba, `atualizar=false`, linha de `portal_acompanhamento` com `consultado_em` há 1 minuto. A seção volta `leitura: "cache"` e o `fetch` não é chamado.

Segundo caso: `consultado_em` há 10 minutos e `atualizar=true` chama `lerPortal` uma vez. Terceiro: `consultado_em` há 10 segundos e `atualizar=true` volta `leitura: "debounce"` sem `fetch`.

Quarto: link do Comprasnet (`https://cnetmobile.estaleiro.serpro.gov.br/...`) devolve `{ disponivel: false }` e não chama `fetch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/supabase/functions/portal_compras_test.ts tests/supabase/functions/portal_tenant_test.ts --allow-read --allow-env --no-prompt`

Expected: FAIL no teste novo. Os testes atuais de `decidirAtualizacaoPortal` continuam passando: essa função segue no caminho do alerta.

- [ ] **Step 3: Write minimal implementation**

`montarSecaoPortal` em `portal.ts`:

1. `parsePortalProcessoUrl(link)` nulo → `{ disponivel: false }`.
2. Ler `portal_acompanhamento` por `licitacao_id`.
3. Idade = `agora - consultado_em`.
   - idade `< 30s` e `atualizar` → devolver retrato com `leitura: "debounce"`.
   - idade `< 5 min` e `atualizar` falso → retrato com `leitura: "cache"`.
   - senão → `lerPortal`.
4. Gravar o retrato (upsert) e os eventos (`insert` com `onConflict: "licitacao_id,chave"` e `ignoreDuplicates: true`). `atualizado_em = agora` só se o insert de eventos afetou linha. `consultado_em = agora` em leitura ao vivo. `proxima_consulta_em` = agora + `intervaloMs(fase)`, ou agora + `esperaFalhaMs` se o detalhe veio com erro.
5. Fase: `calcularFase` com as datas do detalhe novo (ou do retrato, se a rede falhou) e `existeResultadoPncp` recebido da compra do PNCP já carregada na rota.
6. Se `falha_desde` tem 24 horas ou mais, `indisponivel: true`.
7. Falha do detalhe: manter datas, situação e documentos do retrato anterior; `erro` nas partes que falharam; HTTP da rota continua 200.
8. `portal.eventos`: ler `portal_eventos` da oportunidade, ordem `ocorrido_em` nulo por último e o instante desc, limite 100. Forma `{ dados, total, erro }`. Erro nessa leitura preenche `erro` e devolve `dados: []`; não derruba o PNCP.

Em `acompanhamento.ts`, quando `params.atualizar === true`, não usar `getCachedAcompanhamento`. Depois de montar o payload do PNCP, chamar `montarSecaoPortal` com `existeResultado` de `compra.dados?.existeResultado === true`. Na resposta, irmão das seções:

```ts
atualizado_em: maxIso(compra.dados?.datas.atualizacao ?? null, portal.disponivel ? portal.atualizado_em : null)
```

`anexarAlertaPortal` não muda de forma.

Ação `portal_relatorio` em `validation.ts` e no `index.ts` da função: usuário autenticado (`requireUserAuth`), corpo `{ id: number, parametros: string }`. O `id` é `licitacoes_externas.id`. A função confere que a linha tem link deste portal e que `parametros` é um dos `parametros` guardados em `portal_acompanhamento.documentos`. Só então chama `baixarRelatorio`. Parâmetro solto, fora da lista gravada, responde 400. Assim a rota não vira um proxy aberto do gerador de PDF.

- [ ] **Step 4: Run tests**

Run: `deno test tests/supabase/functions/portal_compras_test.ts tests/supabase/functions/portal_tenant_test.ts tests/supabase/functions/portal_cliente_test.ts --allow-read --allow-env --no-prompt`

Expected: PASS.

Run: `scripts/ci/deno-check-funcoes.sh api-dashboard-oportunidades`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/api-dashboard-oportunidades supabase/functions/_shared/portal-compras-cliente.ts tests/supabase/functions/portal_compras_test.ts
git commit -m "feat(acompanhamento): seção portal com cache de 5 min e atualização forçada"
```

---

### Task 6: Job por minuto

**Files:**
- Create: `supabase/functions/sync-portal-compras-publicas/index.ts`
- Create: `supabase/functions/sync-portal-compras-publicas/sync.ts`
- Create: `tests/supabase/functions/sync_portal_publico_test.ts`

**Interfaces:**
- Consumes: `acquireSyncLock(client, "portal-compras-publicas", "portal-compras-publicas", {})`, `lerPortal`, `calcularFase`, `diffEventos`, `intervaloMs`, `esperaFalhaMs`.
- Produces: `executarSyncPortalPublico(client, runId, limite, deps): Promise<{ status, stats }>`.

- [ ] **Step 1: Write the failing test**

Cliente falso com uma linha `portal_acompanhamento` vencida (`proxima_consulta_em` no passado, fase `propostas`) e o detalhe falso da fixture 513820 mais um documento que não estava no retrato.

Asserts:

- upsert do retrato com `fase` calculada para o `agora` injetado;
- um insert em `portal_eventos` com `chave` `documento:…`;
- segunda execução com o mesmo documento não insere de novo (`ignoreDuplicates`);
- lote pede no máximo 10 e processa 2 em paralelo (o double conta chamadas sobrepostas);
- `httpStatus` 429 na primeira interrompe o lote, grava `ultimo_erro`, aumenta `tentativas`, e `proxima_consulta_em` soma `esperaFalhaMs`;
- linha `encerrado` não entra na seleção.

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/supabase/functions/sync_portal_publico_test.ts --allow-read --allow-env --no-prompt`

Expected: FAIL, função ausente.

- [ ] **Step 3: Write minimal implementation**

`index.ts` espelha `sync-portal-compras/index.ts`: POST, `requireCronAuth`, limite inteiro entre 1 e 10 (padrão 10), trava `portal-compras-publicas`. `already_running` devolve 200 com `status: "already_running"`.

`sync.ts`:

1. Inscrever: select de `licitacoes_externas` com `ilike` do host e `data_fim > agora`, mais ids do pipeline de `tenants.ativo = true`, cujo id ainda não está em `portal_acompanhamento`. Insert com `proxima_consulta_em = agora`, `fase = 'propostas'`, `caminho` e `codigo_licitacao` vindos de `parsePortalProcessoUrl`. Falha nessa leitura conta em `erros` e segue para o lote já inscrito.
2. Seleção: `portal_acompanhamento` onde `proxima_consulta_em <= agora` e `fase <> 'encerrado'`, ordem por `proxima_consulta_em`, limite 10.
3. Para cada uma, em `mapConcurrent` de 2 (a função já existe em `acompanhamento.ts`; mover a função genérica para `_shared` se o import cruzado de função for circular — preferir copiar as 15 linhas para o sync em vez de importar a rota). Orçamento: se `Date.now() - inicio > 45_000`, parar e devolver `parcial`.
4. `lerPortal`. Detalhe com erro: não substituir `datas`/`documentos`/`situacao_*`; `tentativas += 1`; `falha_desde` fica com o valor anterior ou `agora` se era nulo; `ultimo_erro` com o texto; `proxima_consulta_em = agora + esperaFalhaMs(tentativas)`.
5. Detalhe ok: `diffEventos` contra o retrato; insert dos eventos; recalcular fase; `tentativas = 0`; `falha_desde = null`; `ultimo_erro = null`; `consultado_em = agora`; `atualizado_em = agora` se houve evento; `proxima_consulta_em` = agora + intervalo, ou nulo-distante se `encerrado` (gravar `proxima_consulta_em` com `now() + interval '100 years'` para a coluna `not null`, e a fase `encerrado` já sai do índice parcial).
6. Atualizar `portal_consulta` no sucesso: `situacao`, `consultado_em`, `codigo_licitacao`, `url_pagina`, `erro` nulo. Falha desse upsert conta em `erros` e não desfaz o retrato novo.
7. Fechar `private.pncp_sync_run` por `finishSyncRun`, com a mesma régua de status de `executarSyncPortal`.

- [ ] **Step 4: Run tests**

Run: `deno test tests/supabase/functions/sync_portal_publico_test.ts tests/supabase/functions/sync_portal_compras_test.ts --allow-read --allow-env --no-prompt`

Expected: PASS, inclusive o job diário antigo.

Run: `scripts/ci/deno-check-funcoes.sh sync-portal-compras-publicas api-dashboard-oportunidades`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-portal-compras-publicas tests/supabase/functions/sync_portal_publico_test.ts supabase/config.toml
git commit -m "feat(portal): job por minuto grava retrato e eventos"
```

---

### Task 7: Revisão e PR em draft

**Files:** nenhum código novo, salvo ajuste que os revisores apontem.

- [ ] **Step 1: Lint e testes do que mudou**

```bash
git diff --name-only origin/main... | scripts/ci/lint-alterados.sh -
deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt
scripts/ci/deno-check-funcoes.sh api-dashboard-oportunidades sync-portal-compras sync-portal-compras-publicas
```

Migration no diff: `scripts/validar-migrations.sh`.

- [ ] **Step 2: Revisores**

Rodar os roteiros `revisor-codigo`, `revisor-seguranca` e `revisor-migration` sobre o diff. Registrar o resultado no PR.

- [ ] **Step 3: Abrir o PR em draft**

Base `main`. Título: `feat(portal): acompanhamento pelo Portal de Compras Públicas`.

O corpo diz:

- o cron `* * * * *` passa a valer no merge;
- a pergunta aberta dos termos de uso / API de parceiro bloqueia o merge;
- o Dashboard consome o contrato do apêndice e vem noutro PR;
- `falha_desde` é coluna extra para a regra de 24 horas;
- chat pagina só a primeira leva (`truncado` quando vierem 50 frases).

Sem merge e sem deploy.

---

## Apêndice: contrato para o Dashboard

Repositório `n4rch6pjt9-rgb/Dashboard---LicitaGym`. Esta lista não é task deste repo.

- Selo de situação: `portal.situacao.descricao` quando `portal.disponivel`. A situação do PNCP continua ao lado.
- Botão "Ver no portal": `window.open(portal.url_portal)` em aba nova. Some quando `disponivel` é falso.
- "Atualizado em" vira botão. Rótulo com `atualizado_em` da raiz (o mais recente entre PNCP e portal) e "consultado há" a partir de `portal.consultado_em`. O clique manda `atualizar=true`. Se a resposta voltar `leitura: "debounce"`, o horário consultado não muda.
- Fase `sessao`: a tela aberta chama de novo a cada 60 segundos com `atualizar=true`. Nas outras fases, só ao abrir ou no botão.
- Faixa com os seis marcos de `portal.datas` (fechamento fica de fora da faixa, como no portal). O próximo marco é o primeiro instante ainda no futuro. Marco passado só conta como concluído se a situação já deixou aquela etapa; a tela não pinta de verde só porque o relógio passou. Enquanto os códigos de situação não estiverem catalogados, "concluído" usa a fase: `propostas` conclui publicação e início; `aguardando_sessao` conclui também os limites e o fim das propostas; `sessao` e posteriores concluem a abertura.
- Quadro: `portal.informacoes`.
- Linha do tempo: `historico` do PNCP mais `portal.eventos`. A Task 5 inclui `portal.eventos: { dados, total, erro }`, lido de `portal_eventos` por `licitacao_id`, ordem `coalesce(ocorrido_em, detectado_em) desc`, limite 100. Cada item traz `tipo`, `titulo`, `ocorrido_em`, `detectado_em`. O filtro por origem é da tela (selo PNCP ou Portal).
- Documentos: lista do PNCP (`arquivos`) e `portal.documentos.dados`. Uma linha só quando `mesmoEdital` for verdadeiro (`codigo_pncp` preenchido e o nome normalizado do portal contido no título do PNCP). Relatório com `url` vazia e `parametros` preenchido chama a ação `portal_relatorio` e abre a `url` devolvida. Não embute o PDF.
- Itens: enquanto o item do PNCP tiver `temResultado` falso, mostrar `situacao` e `melhor_lance` do item do portal com o mesmo `codigo` numérico. Sem código em comum, o lance do portal aparece na linha do portal, separado. Não copiar lance para o campo de resultado do PNCP.
- `chat.truncado === true`: a tela diz que a lista pode estar incompleta.
- `indisponivel === true`: a tela diz que o portal está indisponível e mostra o último retrato.

## Cobertura da spec

| Critério | Task |
|---|---|
| Código e caminho do link; outro host com `disponivel: false` | 1 e 5 |
| Seção com situação, sete datas, informações, documentos, chat, itens | 1, 3, 5 |
| Datas em UTC; fim 08/10 09:59 e abertura 08/10 10:00 em Brasília | 1 (`12:59Z` e `13:00Z`) |
| Portal fora do ar, PNCP 200, `erro` só nas partes | 3 e 5 |
| Três documentos de impugnação e edital único | 1 (dados) e apêndice (`mesmoEdital`) |
| Relatório em dois passos | 3 (`baixarRelatorio`) e 5 (ação autenticada) |
| 486428: chat de adjudicação/homologação, Ata Final, Termo de Homologação | 1 e 2 (eventos `chat:{codigo}`) |
| Job inscreve abertas e as seis fases | 2, 4, 6 |
| Documento novo gera evento; segunda rodada não duplica | 2 e 6 |
| Botão ignora cache; dois cliques em 30 s, uma consulta | 5 |
| "Ver no portal" | apêndice, com `url_portal` |
| Comprasnet igual nas seções PNCP | 5 |
| Fixtures dos dois processos | 1 |

Pontos que continuam abertos, de propósito: paginação do chat, catálogo de `statusProcesso`, termos de uso da API, comportamento em 429/403 medido em produção, e o fuso de `data_fim`.

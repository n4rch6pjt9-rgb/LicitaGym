// Spec 0032, fase 3 (CA-4): potência do motor no termo de referência. Textos reais dos editais lidos em 19/10/2026.
import { assertEquals } from "jsr:@std/assert@1";
import { agenteEdital, type ChunkEdital, detectarPotencia } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { agenteJuridico } from "../../../supabase/functions/_shared/agentes/juridico.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";

const chunk = (texto: string, id = 1): ChunkEdital => ({ id, documento_id: 9, pagina: 3, texto });
const codigos = (texto: string) => detectarPotencia([chunk(texto)]).map((a) => a.codigo).sort();

// Horizontina (RS), PE 58/2026, item 67 (licitação 3558).
const HORIZONTINA =
  "ESTEIRA ERGOMETRICA ELETRONICA PROFISSIONAL: MOTOR DE CORRENTE ALTERNADA (AC) COM POTENCIA MiNIMA DE 3.0 HP PEAK POWER. " +
  "SISTEMA DE AMORTECIMENTO DE IMPACTOS. VELOCIDADE AJUSTAVEL DE NO MiNIMO 1.6 A 20 KM/H. LONA/CINTA DUPLA DE CAMINHADA COM " +
  "AREA uTIL MiNIMA DE 1500 X 500 MM. CHAVE DE SEGURANCA. CAPACIDADE DE PESO DO USUARIO: NO MiNIMO 180 KG A 200 KG.";
// Paranavaí (PR), PE 9/2026, item 30: termo de referência.
const PARANAVAI = "Esteira Elétrica, Capacidade Máxima: 150 KG, Velocidade Máxima: 18 KM/H, Potência Motor: entre 3 a 5 HP, " +
  "Tensão Alimentação: 110/220 V";
// Texto padrão do CATMAT 373980 (copiado pela 3ª Cia Eng. Combate Mecanizada, PE 05/2022).
const CATMAT = "Esteira elétrica, capacidade máxima 150 kg, velocidade máxima 18 km/h, potência motor 3/5 hp, tensão alimentação 220 v";
// PRF, PE 36/2021, item 6.
const PRF = "Potência mínima: motor com potência nominal de 4,0 HP, com pico de 8 HP; - Alimentação: 220V (ou bivolt); " +
  "nível profissional (utilizadas em academias); Peso máximo do usuário: até 180 kg (ou maior)";
// Edital com contínuo e pico no formato "X HP (Y HP de pico)" (TRT-2 / Evolution, base 373980).
const CONTINUO_E_PICO = "Motor C.a. de 4.0 Hp (8.0 Hp de Pico), Com Gerenciador de Economia de Consumo de Energia; 220 V";
// Escada (PE), PE 049/2026, item 1 (licitação 3641): residencial coerente.
const ESCADA = "ESTEIRA ERGOMÉTRICA, POTÊNCIA DO MOTOR DE 5.0 HPM, VELOCIDADE MAXIMA DE 16 KM/H, SUPORTANDO ATÉ 130 KG DE PESO, " +
  "CONTENDO 02 DOIS NÍVEIS DE INCLINAÇÃO, PODENDO SER DOBRÁVEL";
// Paranavaí: ficha da ONEAL BF790 citada no recurso, com "Motor DC (corrente contínua)".
const DC = "Motor DC (corrente contínua) Sem Escova (brushless) Pico 3.5 HP; VELOCIDADE 1 a 18 km/h";

Deno.test("CA-4: Horizontina, profissional + AC + 180 kg com potência só de pico é especificação inconsistente", () => {
  const achados = detectarPotencia([chunk(HORIZONTINA)]);
  assertEquals(achados.map((a) => a.codigo).sort(), ["especificacao.inconsistente", "especificacao.potencia_so_pico"]);
  const inc = achados.find((a) => a.codigo === "especificacao.inconsistente")!;
  assertEquals(inc.severidade, "atencao");
  assertEquals(inc.natureza, "inferencia");
  assertEquals(inc.dados.pico_hp, 3);
  assertEquals(inc.dados.continuo_estimado_hp, 1.5);
  assertEquals(inc.dados.regra_estimativa, "pico_aprox_2x_continuo");
  assertEquals((inc.dados.perfil as string[]).sort(), ["motor_ac", "peso_usuario_180kg", "profissional"]);
  assertEquals(inc.fontes[0].tipo, "chunk");
  if (inc.fontes[0].tipo === "chunk") assertEquals(inc.fontes[0].trecho.includes("3.0 HP PEAK POWER"), true);
  assertEquals(inc.fontes[1], { tipo: "calculo", regra: "pico_aprox_2x_continuo", versao: "2026-10-26.2" });
});

Deno.test("Paranavaí: 'entre 3 a 5 HP' é faixa ambígua, sem perfil profissional não é inconsistente", () =>
  assertEquals(codigos(PARANAVAI), ["especificacao.potencia_faixa_ambigua"]));

Deno.test("CATMAT: '3/5 hp' é faixa ambígua", () => assertEquals(codigos(CATMAT), ["especificacao.potencia_faixa_ambigua"]));

Deno.test("PRF: nominal e pico explícitos não geram achado", () => assertEquals(codigos(PRF), []));

Deno.test("'4.0 HP (8.0 HP de pico)': o primeiro número é o contínuo, sem achado", () => assertEquals(codigos(CONTINUO_E_PICO), []));

Deno.test("Escada: 'HPM' é pico; residencial (130 kg, dobrável) não é inconsistente", () => {
  const achados = detectarPotencia([chunk(ESCADA)]);
  assertEquals(achados.map((a) => a.codigo), ["especificacao.potencia_so_pico"]);
  assertEquals(achados[0].severidade, "info");
});

Deno.test("'corrente contínua' (motor DC) não conta como potência contínua", () =>
  assertEquals(codigos(DC), ["especificacao.potencia_so_pico"]));

Deno.test("texto sem potência em HP não gera achado", () => assertEquals(codigos("Lona de 150 x 50 cm, capacidade 150 kg."), []));

Deno.test("agente de edital inclui os achados de potência", () => {
  const r = agenteEdital({ chunks: [chunk(HORIZONTINA)], data_abertura: null });
  assertEquals(r.achados.some((a) => a.codigo === "especificacao.inconsistente"), true);
});

Deno.test("CA-4: jurídico sugere pedido de esclarecimento (art. 164) para inconsistência e faixa ambígua", () => {
  const sinais = [...detectarPotencia([chunk(HORIZONTINA)]), ...detectarPotencia([chunk(PARANAVAI, 2)])];
  const r = agenteJuridico({
    sinais,
    dispositivos: [{ norma: "LEI_14133_2021", artigo: 164, texto: "texto 164", conferido_oficial: false }],
  });
  const porSinal = Object.fromEntries(r.achados.map((a) => [a.dados.sinal_origem, a.dados.peca_a_avaliar]));
  assertEquals(porSinal["especificacao.inconsistente"], "pedido_esclarecimento");
  assertEquals(porSinal["especificacao.potencia_faixa_ambigua"], "pedido_esclarecimento");
  assertEquals(porSinal["especificacao.potencia_so_pico"], "nenhuma");
});

// --- Revisão de 19/10 (revisor-codigo e revisor-seguranca) ----------------------------------------------------------

Deno.test("todos os achados de potência passam em validarAchado (senão a api-agentes dá 500)", () => {
  for (const t of [HORIZONTINA, PARANAVAI, CATMAT, ESCADA]) {
    for (const a of detectarPotencia([chunk(t)])) assertEquals(validarAchado(a), null, a.codigo);
  }
});

Deno.test("faixa grava hp_min e hp_max", () => {
  assertEquals(detectarPotencia([chunk(CATMAT)])[0].dados, { hp_min: 3, hp_max: 5 });
  assertEquals(detectarPotencia([chunk(PARANAVAI)])[0].dados, { hp_min: 3, hp_max: 5 });
});

Deno.test("'2 HP (pico 4 HP)' e '4 cv (8 cv de pico)': a primeira menção é a contínua, sem achado", () => {
  assertEquals(codigos("Esteira motor 2 HP (pico 4 HP), uso em academia, usuário até 180 kg"), []);
  assertEquals(codigos("Motor de 4 cv (8 cv de pico)"), []);
});

Deno.test("vários itens no trecho: o contínuo de um item não apaga o pico de outro", () => {
  assertEquals(codigos("Item 1: bicicleta motor 0,5 HP. Item 2: esteira 3 HP de pico, academia"), [
    "especificacao.inconsistente",
    "especificacao.potencia_so_pico",
  ]);
  assertEquals(
    codigos("Item 1: esteira 3 HP de pico, academia, capacidade do usuário 180 kg. Item 2: bomba potência nominal de 1 HP"),
    ["especificacao.inconsistente", "especificacao.potencia_so_pico"],
  );
});

Deno.test("'1/2 HP' é fração, não faixa", () =>
  assertEquals(codigos("Bebedouro industrial com compressor 1/2 HP, para academia"), []));

Deno.test("peso do equipamento ou de piso não vira capacidade do usuário", () => {
  assertEquals(codigos("Esteira 3 HP de pico; capacidade do usuário 120 kg; peso do equipamento 160 kg"), [
    "especificacao.potencia_so_pico",
  ]);
  assertEquals(codigos("Esteira 3 HP de pico; carga do piso 1250 kg"), ["especificacao.potencia_so_pico"]);
});

Deno.test("sequência longa de dígitos não trava a regex (ReDoS): tempo cresce linear, não quadrático", () => {
  const medir = (n: number) => {
    const t0 = performance.now();
    detectarPotencia([chunk("9".repeat(n))]);
    return performance.now() - t0;
  };
  medir(1_000); // aquecimento
  const pequeno = Math.max(medir(10_000), 1);
  const grande = medir(100_000);
  // 10× mais texto: linear dá ~10×, quadrático daria ~100×.
  assertEquals(grande / pequeno < 40, true, `razão ${grande / pequeno}`);
});

Deno.test("número absurdo de HP é descartado", () => assertEquals(codigos("motor " + "9".repeat(400) + " hp de pico"), []));

Deno.test("revisão 2: '3 HP (pico)' e '3 HP (de pico)' continuam sendo pico", () => {
  assertEquals(codigos("Esteira motor 3.0 HP (pico), academia"), ["especificacao.inconsistente", "especificacao.potencia_so_pico"]);
  assertEquals(codigos("Esteira motor 3 HP (de pico), uso profissional"), ["especificacao.inconsistente", "especificacao.potencia_so_pico"]);
});

Deno.test("revisão 2: perfil não vaza para o item vizinho", () => {
  const achados = detectarPotencia([chunk("Item 1 esteira 3 HP de pico, academia. Item 2 esteira 5/7 HP, residencial")]);
  const inc = achados.find((a) => a.codigo === "especificacao.inconsistente")!;
  assertEquals(inc.fontes.filter((f) => f.tipo === "chunk").length, 1);
  assertEquals(inc.dados.pico_hp, 3);
});

Deno.test("revisão 2: '3/4 HP' é fração, não faixa", () =>
  assertEquals(codigos("Bomba de recirculação 3/4 HP, para academia"), []));

Deno.test("revisão 2: vírgula separa capacidade do usuário e peso do equipamento", () =>
  assertEquals(codigos("Esteira 3 HP de pico, capacidade máxima do usuário 180 kg, peso do equipamento 120 kg"), [
    "especificacao.inconsistente",
    "especificacao.potencia_so_pico",
  ]));

Deno.test("revisão 2: lista numerada sem a palavra 'item' separa itens", () =>
  assertEquals(codigos("1. Esteira 3 HP de pico, academia. 2. Bicicleta motor 0,5 HP"), [
    "especificacao.inconsistente",
    "especificacao.potencia_so_pico",
  ]));

Deno.test("Codex #401 (P2): contínuo de outro equipamento no mesmo trecho, sem 'item N', não apaga o aviso da esteira", () =>
  assertEquals(codigos("Compressor potência nominal de 4 HP, 220 V. Esteira profissional motor 3 HPM, uso em academia"), [
    "especificacao.inconsistente",
    "especificacao.potencia_so_pico",
  ]));

// --- Revisão final do #401 ---------------------------------------------------------------------------------------

Deno.test("revisão final: a mesma esteira citada duas vezes com a nominal não gera aviso", () => {
  assertEquals(codigos("Esteira ergométrica profissional, potência de pico 4 HP, uso em academia. A esteira deverá ter potência nominal de 2 HP"), []);
  assertEquals(codigos("Esteira profissional, potência de pico 4 HP. A esteira deverá ter motor de 1,5 HP contínuo"), []);
  assertEquals(codigos("Esteira profissional, potência de pico 4 HP. O aparelho deve ter potência nominal de 2 HP"), []);
});

Deno.test("revisão final: várias fronteiras antes da menção não cortam o item (achado central em TR com vários itens)", () => {
  const t = "ITEM 64 Banco supino. ITEM 65 Bicicleta ergométrica. ITEM 66 Elíptico. " +
    "ITEM 67 ESTEIRA PROFISSIONAL, USUARIO ATE 180 KG, MOTOR 3.0 HP PEAK POWER.";
  const inc = detectarPotencia([chunk(t)]).find((a) => a.codigo === "especificacao.inconsistente");
  assertEquals((inc?.dados.perfil as string[] | undefined)?.sort(), ["peso_usuario_180kg", "profissional"]);
});

Deno.test("revisão final: referência cruzada 'conforme item 3.2' não separa o item", () =>
  assertEquals(codigos("Esteira profissional motor 4 HP de pico, conforme item 3.2 do TR, potência nominal de 2 HP"), []));

Deno.test("revisão final 2: 'do item 2' e 'no lote 2' abrem item novo; duas esteiras não se anulam", () => {
  const dois = ["especificacao.inconsistente", "especificacao.potencia_so_pico"];
  assertEquals(codigos("Especificação do item 1: esteira 3 HP de pico, academia. Especificação do item 2: esteira 4 HP nominal"), dois);
  assertEquals(codigos("Esteira 3 HP de pico, academia; no lote 2 esteira 4 HP nominal"), dois);
  assertEquals(codigos("Item 1 esteira 3 HP de pico, academia. Item 2 esteira 4 HP nominal"), dois);
});

Deno.test("revisão final 2: referência cruzada com número de dois dígitos ou artigo não separa o item", () => {
  assertEquals(codigos("Esteira profissional 4 HP de pico, de acordo com o item 12.3, potência nominal de 2 HP"), []);
  assertEquals(codigos("Esteira profissional 4 HP de pico, conforme o item 3, potência nominal de 2 HP"), []);
  // "item 3," continua sendo fronteira (vírgula depois do número não é N.N).
  assertEquals(codigos("Item 3, esteira 3 HP de pico, academia. Item 4, compressor potência nominal de 2 HP"), [
    "especificacao.inconsistente",
    "especificacao.potencia_so_pico",
  ]);
});

Deno.test("revisão final 2: equipamento do item anterior ou ausente não separa menções da mesma esteira", () => {
  assertEquals(codigos("Item 1 Compressor 1 HP. Item 2: potência nominal 2 HP, para esteira profissional, pico 4 HP"), []);
  assertEquals(codigos("Motor potência nominal 2 HP, esteira profissional com pico de 4 HP, academia"), []);
});

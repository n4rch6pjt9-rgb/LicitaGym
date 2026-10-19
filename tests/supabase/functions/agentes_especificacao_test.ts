// Spec 0032, fase 3 (CA-4): potência do motor no termo de referência. Textos reais dos editais lidos em 19/10/2026.
import { assertEquals } from "jsr:@std/assert@1";
import { agenteEdital, type ChunkEdital, detectarPotencia } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { agenteJuridico } from "../../../supabase/functions/_shared/agentes/juridico.ts";

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

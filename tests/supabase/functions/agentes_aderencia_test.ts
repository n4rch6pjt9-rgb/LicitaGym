import { assertEquals } from "jsr:@std/assert@1";
import { classificarAderencia, compararAtributo } from "../../../supabase/functions/_shared/agentes/aderencia.ts";

Deno.test("comparar: acima do mínimo supera; igual atende; abaixo não atende", () => {
  assertEquals(compararAtributo("minimo", 4, 5), "supera");
  assertEquals(compararAtributo("minimo", 4, 4), "atende");
  assertEquals(compararAtributo("minimo", 180, 150), "nao_atende");
});

Deno.test("comparar: sem ficha é não comprovado, não não atende", () => {
  assertEquals(compararAtributo("minimo", 150, null), "nao_comprovado");
  assertEquals(compararAtributo("texto", null, null, "INMETRO", null), "nao_comprovado");
});

Deno.test("comparar: sem exigência é ausente", () => {
  assertEquals(compararAtributo("minimo", null, 5), "ausente");
  assertEquals(compararAtributo("texto", null, null, null, null), "ausente");
});

Deno.test("conjunto: eliminatório derruba contagem alta; lacuna eliminatória não vira não atende", () => {
  assertEquals(classificarAderencia([
    { atributo: "motor_hp_min", eliminatorio: true, veredito: "supera" },
    { atributo: "velocidade_kmh_min", eliminatorio: false, veredito: "atende" },
    { atributo: "capacidade_usuario_kg_min", eliminatorio: true, veredito: "nao_atende" },
  ]), "nao_atende");
  assertEquals(classificarAderencia([
    { atributo: "motor_hp_min", eliminatorio: true, veredito: "atende" },
    { atributo: "certificacoes", eliminatorio: true, veredito: "nao_comprovado" },
  ]), "nao_comprovado");
  assertEquals(classificarAderencia([
    { atributo: "motor_hp_min", eliminatorio: true, veredito: "supera" },
    { atributo: "area_corrida", eliminatorio: false, veredito: "nao_atende" },
  ]), "parcial");
});

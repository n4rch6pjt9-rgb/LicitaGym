import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  calendarioNacional,
  contarDiasUteis,
  somarDiasUteis,
} from "../../../supabase/functions/_shared/prazos/dias-uteis.ts";

// Feriados nacionais de 2026 e 2027 como estão em public.feriados_nacionais (migration 20261107180000).
const FERIADOS = calendarioNacional([
  "2026-01-01", "2026-04-21", "2026-05-01", "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20",
  "2026-12-25", "2027-01-01", "2027-04-21", "2027-05-01", "2027-09-07", "2027-10-12", "2027-11-02", "2027-11-15",
  "2027-11-20", "2027-12-25",
]);

// Spec 0041 CA-2: abertura 14/10/2026 → 3 dias úteis antes pula 12/10 (feriado) e o fim de semana.
Deno.test("dias úteis (0041 CA-2): 3 dias úteis antes de 14/10/2026 é 08/10/2026", () => {
  const r = somarDiasUteis("2026-10-14T08:30:00-03:00", 3, "antes_de", FERIADOS);
  assertEquals(r, { data: "2026-10-08", feriados_considerados: ["2026-10-12"], abrangencia: "nacional" });
});

Deno.test("dias úteis (0041 CA-2): sem calendário do ano dá erro, nunca 09/10", () => {
  assertThrows(
    () => somarDiasUteis("2026-10-14T08:30:00-03:00", 3, "antes_de", calendarioNacional(["2027-01-01"])),
    RangeError,
    "2026",
  );
  assertThrows(() => somarDiasUteis("2026-10-14", 3, "antes_de", calendarioNacional([])), RangeError);
});

Deno.test("dias úteis: a data do evento usa o dia em Brasília, não em UTC", () => {
  // 15/10 às 23:30 em Brasília já é 16/10 em UTC: a contagem parte de 15/10.
  assertEquals(somarDiasUteis("2026-10-16T02:30:00Z", 3, "antes_de", FERIADOS).data, "2026-10-09");
});

Deno.test("dias úteis: após, atravessando o Natal e a virada do ano", () => {
  const r = somarDiasUteis("2026-12-24", 3, "apos", FERIADOS);
  assertEquals(r, { data: "2026-12-30", feriados_considerados: ["2026-12-25"], abrangencia: "nacional" });
  assertEquals(somarDiasUteis("2026-12-30", 2, "apos", FERIADOS).data, "2027-01-04");
});

Deno.test("dias úteis: a contagem que cruza para um ano sem calendário dá erro", () => {
  assertThrows(() => somarDiasUteis("2027-12-30", 3, "apos", FERIADOS), RangeError, "2028");
});

Deno.test("dias úteis: n inválido e data inválida dão erro", () => {
  assertThrows(() => somarDiasUteis("2026-10-14", 0, "antes_de", FERIADOS), RangeError);
  assertThrows(() => somarDiasUteis("2026-10-14", 1.5, "apos", FERIADOS), RangeError);
  assertThrows(() => somarDiasUteis("14/10/2026", 3, "apos", FERIADOS), RangeError);
  assertThrows(() => calendarioNacional(["2026-02-30"]), RangeError);
});

Deno.test("dias úteis: contar exclui o início, inclui o fim e pula feriado e fim de semana", () => {
  // Spec 0041 CA-4 (base): entrega 01/12/2026 → recebimento definitivo em 7 du = 10/12/2026.
  assertEquals(somarDiasUteis("2026-12-01", 7, "apos", FERIADOS).data, "2026-12-10");
  assertEquals(contarDiasUteis("2026-12-01", "2026-12-10", FERIADOS), 7);
  assertEquals(contarDiasUteis("2026-10-08", "2026-10-14", FERIADOS), 3);
  assertEquals(contarDiasUteis("2026-10-14", "2026-10-14", FERIADOS), 0);
  assertThrows(() => contarDiasUteis("2026-10-14", "2026-10-08", FERIADOS), RangeError);
});

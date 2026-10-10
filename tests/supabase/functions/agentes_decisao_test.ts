import { assertEquals } from "jsr:@std/assert@1";
import { recomendarParticipacao } from "../../../supabase/functions/_shared/agentes/decisao.ts";

const coberto = { eliminatorio_falhou: false, lacuna_eliminatoria: false, abaixo_do_piso: false, prazo_viavel: true, documentacao_ok: true, edital_aberto: true };

Deno.test("decisão: eliminatório e margem são NO-GO, sem pontuação", () => {
  assertEquals(recomendarParticipacao({ ...coberto, eliminatorio_falhou: true }).decisao, "no_go");
  assertEquals(recomendarParticipacao({ ...coberto, abaixo_do_piso: true }).motivos, ["Margem mínima do cliente não atingida."]);
  assertEquals("score" in recomendarParticipacao(coberto), false);
});

Deno.test("decisão: lacuna eliminatória condiciona; sem edital aberto monitora", () => {
  assertEquals(recomendarParticipacao({ ...coberto, lacuna_eliminatoria: true }).decisao, "go_condicionado");
  assertEquals(recomendarParticipacao({ ...coberto, edital_aberto: false }).decisao, "monitorar");
  assertEquals(recomendarParticipacao(coberto).decisao, "go");
});

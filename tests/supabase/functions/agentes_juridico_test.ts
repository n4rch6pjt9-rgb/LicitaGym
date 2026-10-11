import { assertEquals } from "jsr:@std/assert@1";
import { agenteJuridico } from "../../../supabase/functions/_shared/agentes/juridico.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";
import type { Achado } from "../../../supabase/functions/_shared/agentes/tipos.ts";

const sinal = (codigo: string): Achado => ({
  codigo,
  natureza: "analise",
  metodo: "regra",
  severidade: "atencao",
  titulo: "",
  detalhe: "",
  dados: {},
  fontes: [{ tipo: "calculo", regra: "x", versao: "1" }],
});
const disp = (artigo: number, conferido = false) => ({ norma: "LEI_14133_2021", artigo, texto: `texto ${artigo}`, conferido_oficial: conferido });

Deno.test("jurídico: liga sinal ao artigo, marca não conferido e ausente", () => {
  const r = agenteJuridico({ sinais: [sinal("preco.indicio_inexequibilidade")], dispositivos: [disp(59)] });
  assertEquals(r.situacao, "ok");
  assertEquals(r.achados.length, 1);
  const a = r.achados[0];
  assertEquals(a.codigo, "juridico.preco_indicio_inexequibilidade");
  assertEquals(a.severidade, "atencao");
  assertEquals(a.natureza, "inferencia");
  assertEquals(a.dados, {
    sinal_origem: "preco.indicio_inexequibilidade",
    peca_a_avaliar: "demonstracao_exequibilidade",
    dispositivos_ausentes: [11],
    ha_dispositivo_nao_conferido: true,
  });
  assertEquals(a.fontes, [
    { tipo: "dispositivo", norma: "LEI_14133_2021", artigo: 59, conferido_oficial: false },
    { tipo: "calculo", regra: "mapa_sinal_dispositivo", versao: "2026-10-06.1" },
  ]);
  assertEquals(validarAchado(a), null);
});

Deno.test("jurídico: artigo conferido não acende o aviso", () => {
  const r = agenteJuridico({ sinais: [sinal("exigencia.visita_tecnica")], dispositivos: [disp(63, true)] });
  assertEquals(r.achados[0].dados.ha_dispositivo_nao_conferido, false);
  assertEquals(r.achados[0].dados.dispositivos_ausentes, []);
});

Deno.test("jurídico: sinais repetidos viram um; sinal fora do mapa não gera achado", () => {
  const r = agenteJuridico({
    sinais: [sinal("preco.custo_zero"), sinal("preco.custo_zero"), sinal("exigencia.prazo_entrega"), sinal("preco.referencia_praticada")],
    dispositivos: [],
  });
  assertEquals(r.achados.map((a) => a.codigo), ["juridico.preco_custo_zero"]);
  assertEquals(r.achados[0].dados.dispositivos_ausentes, [59, 11]);
});

Deno.test("jurídico: peça 'nenhuma' é informativa", () =>
  assertEquals(agenteJuridico({ sinais: [sinal("prazo.impugnacao")], dispositivos: [disp(164)] }).achados[0].severidade, "info"));

Deno.test("jurídico: sem sinais devolve ok e lista vazia", () =>
  assertEquals(agenteJuridico({ sinais: [], dispositivos: [disp(59)] }).achados, []));

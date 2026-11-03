import { assertEquals } from "jsr:@std/assert@1";
import { agenteEdital, type ChunkEdital } from "../../../../../supabase/functions/_shared/agentes/edital.ts";

// Caso 1: item 17 do TR APMBB (esteira ergométrica)
// - Tabela: "Peso máximo do usuário: 188,44Kg"
// - Spec:   "Suporta usuário de até 180 kg"
// - Potência: "motor com potência nominal de 4,0 HP, com pico de 8 HP" (para teste de controle)
const ITEM_17_CHUNKS: ChunkEdital[] = [
  {
    id: 1,
    documento_id: 1,
    pagina: 12,
    texto:
      "Item 17 - Esteira ergométrica profissional: motor com potência nominal de 4,0 HP, com pico de 8 HP. " +
      "Tabela técnica: Peso máximo do usuário: 188,44Kg.",
  },
  {
    id: 2,
    documento_id: 1,
    pagina: 15,
    texto:
      "Item 17 - Esteira ergométrica profissional: " +
      "Estrutura reforçada. Suporta usuário de até 180 kg.",
  },
];

Deno.test("agenteEdital: caso item 17 TR APMBB detecta divergência de peso de usuário na esteira", () => {
  const res = agenteEdital({
    chunks: ITEM_17_CHUNKS,
    data_abertura: null,
  });

  const achadosDivergencia = res.achados.filter(
    (a) => a.codigo === "especificacao.divergencia_peso_maximo_usuario",
  );
  assertEquals(achadosDivergencia.length, 1);
  assertEquals(achadosDivergencia[0].dados.valor_menor, 180);
  assertEquals(achadosDivergencia[0].dados.valor_maior, 188.44);
  assertEquals(achadosDivergencia[0].dados.unidade, "kg");

  // Controle de potência: nominal + pico juntos não geram achado espúrio de só pico
  const achadosPotencia = res.achados.filter(
    (a) => a.codigo === "especificacao.potencia_so_pico",
  );
  assertEquals(achadosPotencia.length, 0);
});

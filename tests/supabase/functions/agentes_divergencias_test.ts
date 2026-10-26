import { assertEquals } from "jsr:@std/assert@1";
import {
  detectarDivergencias,
  saoDoMesmoItem,
} from "../../../supabase/functions/_shared/agentes/divergencias.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";
import type { ChunkEdital } from "../../../supabase/functions/_shared/agentes/edital.ts";

const c = (id: number, texto: string): ChunkEdital => ({
  id,
  documento_id: 1,
  pagina: id,
  texto,
});

Deno.test("saoDoMesmoItem: regras de identidade de item e equipamento", () => {
  // Mesmo equipamento, sem conflito de item
  assertEquals(
    saoDoMesmoItem({ equipamento: "esteira", itemNumero: "1" }, { equipamento: "esteira", itemNumero: null }),
    true,
  );
  // Equipamentos diferentes
  assertEquals(
    saoDoMesmoItem({ equipamento: "esteira", itemNumero: "1" }, { equipamento: "bicicleta", itemNumero: "2" }),
    false,
  );
  // Mesmo equipamento, mas itens diferentes da licitação
  assertEquals(
    saoDoMesmoItem({ equipamento: "esteira", itemNumero: "1" }, { equipamento: "esteira", itemNumero: "2" }),
    false,
  );
  // Identidade não estabelecida
  assertEquals(
    saoDoMesmoItem({ equipamento: null, itemNumero: null }, { equipamento: null, itemNumero: null }),
    false,
  );
});

Deno.test("divergencias: emite achado quando mesmo equipamento tem valores conflitantes", () => {
  const chunks = [
    c(1, "Item 1 - Esteira ergométrica profissional. Peso máximo do usuário: 188,44 kg."),
    c(2, "5.1 Especificações da Esteira ergométrica: Suporta usuário de até 180 kg."),
  ];

  const achados = detectarDivergencias(chunks);
  assertEquals(achados.length, 1);
  assertEquals(achados[0].codigo, "especificacao.divergencia_peso_maximo_usuario");
  assertEquals(achados[0].severidade, "atencao"); // Categoria 1
  assertEquals(achados[0].dados.valor_menor, 180);
  assertEquals(achados[0].dados.valor_maior, 188.44);
  assertEquals(achados[0].dados.equipamento, "esteira");
  assertEquals(validarAchado(achados[0]), null);
});

Deno.test("divergencias: NÃO emite achado entre equipamentos distintos (ex: esteira 180kg vs bike 120kg)", () => {
  // Bugbot finding #4373107383: esteira 180 kg e bicicleta 120 kg não são contradição
  const chunks = [
    c(1, "Item 1 - Esteira ergométrica profissional. Peso máximo do usuário: 180 kg."),
    c(2, "Item 2 - Bicicleta ergométrica horizontal. Peso máximo do usuário: 120 kg."),
  ];

  const achados = detectarDivergencias(chunks);
  assertEquals(achados.length, 0);
});

Deno.test("divergencias: NÃO emite achado entre itens diferentes do mesmo equipamento", () => {
  const chunks = [
    c(1, "Item 1 - Esteira modelo pesado. Peso do equipamento: 200 kg."),
    c(2, "Item 2 - Esteira modelo compacto. Peso do equipamento: 100 kg."),
  ];

  const achados = detectarDivergencias(chunks);
  assertEquals(achados.length, 0);
});

Deno.test("divergencias: evita afirmar contradição quando identidade não pode ser estabelecida", () => {
  const chunks = [
    c(1, "Capacidade máxima de usuário: 180 kg."),
    c(2, "Capacidade máxima de usuário: 120 kg."),
  ];

  const achados = detectarDivergencias(chunks);
  assertEquals(achados.length, 0);
});

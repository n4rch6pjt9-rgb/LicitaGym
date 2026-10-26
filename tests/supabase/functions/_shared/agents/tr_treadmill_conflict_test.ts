import { assertEquals } from "jsr:@std/assert";
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

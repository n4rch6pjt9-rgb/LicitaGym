#!/usr/bin/env -S deno run --allow-net

/**
 * Discover Piso PDM via API temporária
 *
 * Uso (a função exige sessão de usuário: exporte o access_token de um login do Supabase Auth):
 *   LICITAGYM_USER_JWT=<access_token> deno run --allow-net --allow-env scripts/discover-piso-api.ts
 *   LICITAGYM_USER_JWT=<access_token> deno run --allow-net --allow-env scripts/discover-piso-api.ts --termo "borracha" --estado "sp"
 */

import { parse } from "https://deno.land/std@0.208.0/flags/mod.ts";

interface PdmDiscovery {
  codigoPdm: string;
  nomePdm: string;
  codigoGrupo?: string;
  codigoClasse?: string;
  fonte: string;
  descricaoOriginal: string;
}

interface ApiResponse {
  sucesso: boolean;
  pdmsEncontrados: PdmDiscovery[];
  totalResultados: number;
  avisos: string[];
}

const args = parse(Deno.args, {
  string: ["termo", "estado", "categoria"],
  number: ["limite"],
  default: {
    termo: "piso",
    estado: "",
    categoria: "equipamentos-esportivos-e-lazer",
    limite: 20,
  },
});

console.log("\n🔍 Discovering Piso PDMs via API...\n");
console.log(`   Termo: ${args.termo}`);
console.log(`   Categoria: ${args.categoria}`);
if (args.estado) console.log(`   Estado: ${args.estado}`);
console.log(`   Limite: ${args.limite}\n`);

try {
  // Para desenvolvimento local, usar a API real
  // Em produção, usar a URL do Supabase Edge Function
  const apiUrl = new URL("http://localhost:54321/functions/v1/discover-piso-pdm");
  apiUrl.searchParams.append("termo", args.termo as string);
  apiUrl.searchParams.append("categoria", args.categoria as string);
  apiUrl.searchParams.append("limite", String(args.limite));
  if (args.estado) {
    apiUrl.searchParams.append("estado", args.estado as string);
  }

  console.log(`📡 Chamando: ${apiUrl.pathname}${apiUrl.search}\n`);

  const userJwt = Deno.env.get("LICITAGYM_USER_JWT")?.trim();
  if (!userJwt) {
    console.error("❌ Defina LICITAGYM_USER_JWT (access_token de um usuário logado): a função responde 401 sem sessão.");
    Deno.exit(1);
  }
  const response = await fetch(apiUrl.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${userJwt}`,
    },
  });

  const data: ApiResponse = await response.json();

  if (!data.sucesso) {
    console.error("❌ Erro na API:", data.avisos?.join("; "));
    Deno.exit(1);
  }

  if (data.pdmsEncontrados.length === 0) {
    console.log("⚠️  Nenhum PDM encontrado.");
    console.log(`\n📋 Avisos:\n${data.avisos.map((a) => `   • ${a}`).join("\n")}`);
    Deno.exit(0);
  }

  // Exibir resultados
  console.log(`✅ ${data.totalResultados} PDMs encontrados:\n`);
  console.log("┌─────────┬──────────────────────────────────────────┬──────────┬────────────────┐");
  console.log(
    "│ PDM ID  │ Nome                                     │ Grupo/Cl │ Fonte          │"
  );
  console.log("├─────────┼──────────────────────────────────────────┼──────────┼────────────────┤");

  for (const pdm of data.pdmsEncontrados) {
    const grupoClasse = pdm.codigoGrupo && pdm.codigoClasse ?
      `${pdm.codigoGrupo}/${pdm.codigoClasse}` :
      "—";

    const nomeAbr = pdm.nomePdm.substring(0, 40).padEnd(40);
    const idAbr = String(pdm.codigoPdm).padEnd(7);
    const grupoAbr = grupoClasse.padEnd(8);
    const fonteAbr = pdm.fonte.padEnd(14);

    console.log(
      `│ ${idAbr} │ ${nomeAbr} │ ${grupoAbr} │ ${fonteAbr} │`
    );
  }

  console.log("└─────────┴──────────────────────────────────────────┴──────────┴────────────────┘");

  // Seleção interativa
  console.log("\n📋 Detalhes dos PDMs encontrados:\n");
  for (let i = 0; i < data.pdmsEncontrados.length; i++) {
    const pdm = data.pdmsEncontrados[i];
    console.log(`${i + 1}. ${pdm.nomePdm}`);
    console.log(`   codigoPdm: ${pdm.codigoPdm}`);
    console.log(`   grupo/classe: ${pdm.codigoGrupo}/${pdm.codigoClasse}`);
    console.log(`   fonte: ${pdm.fonte}`);
    if (pdm.descricaoOriginal) {
      console.log(`   descrição: ${pdm.descricaoOriginal.substring(0, 80)}`);
    }
    console.log();
  }

  // Template SQL para copiar
  console.log("💾 SQL para marcar PDM de piso (escolha um):\n");
  for (const pdm of data.pdmsEncontrados.slice(0, 3)) {
    console.log(`-- ${pdm.nomePdm}`);
    console.log(`UPDATE public.catalogo_itens`);
    console.log(`SET categoria_licitagym = 'piso',`);
    console.log(`    taxonomias = jsonb_set(taxonomias, '{material}', '"piso"')`);
    console.log(`WHERE codigo_pdm = '${pdm.codigoPdm}';`);
    console.log();
  }

  if (data.avisos.length > 0) {
    console.log("⚠️  Avisos:\n");
    for (const aviso of data.avisos) {
      console.log(`   • ${aviso}`);
    }
  }

} catch (error) {
  console.error("❌ Erro ao chamar API:", (error as Error).message);
  Deno.exit(1);
}

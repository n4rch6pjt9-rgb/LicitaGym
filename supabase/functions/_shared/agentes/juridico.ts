import { REGRA_VERSAO, type Achado, type Fonte, type ResultadoAgente } from "./tipos.ts";

export type Peca = "pedido_esclarecimento" | "impugnacao" | "demonstracao_exequibilidade" | "nenhuma";

export interface Dispositivo {
  norma: string;
  artigo: number;
  texto: string;
  conferido_oficial: boolean;
}

export const NORMA = "LEI_14133_2021";

export const MAPA_SINAL_DISPOSITIVO: Record<string, { artigos: number[]; peca: Peca }> = {
  "exigencia.amostra": { artigos: [41], peca: "pedido_esclarecimento" },
  "exigencia.marca_modelo": { artigos: [41], peca: "impugnacao" },
  "exigencia.laudo_certificacao": { artigos: [42], peca: "pedido_esclarecimento" },
  "exigencia.visita_tecnica": { artigos: [63], peca: "pedido_esclarecimento" },
  "exigencia.atestado_capacidade": { artigos: [67], peca: "impugnacao" },
  "exigencia.garantia_proposta": { artigos: [58], peca: "nenhuma" },
  "exigencia.garantia_contratual": { artigos: [96], peca: "nenhuma" },
  "prazo.impugnacao": { artigos: [164], peca: "nenhuma" },
  "preco.indicio_inexequibilidade": { artigos: [59, 11], peca: "demonstracao_exequibilidade" },
  "preco.inexequivel_presumida": { artigos: [59], peca: "demonstracao_exequibilidade" },
  "preco.custo_zero": { artigos: [59, 11], peca: "demonstracao_exequibilidade" },
  "preco.garantia_adicional": { artigos: [59], peca: "nenhuma" },
  "preco.acima_do_estimado": { artigos: [59, 61], peca: "nenhuma" },
};

export function agenteJuridico(entrada: { sinais: Achado[]; dispositivos: Dispositivo[] }): ResultadoAgente {
  const vistos = new Set<string>();
  const achados: Achado[] = [];
  for (const sinal of entrada.sinais) {
    if (vistos.has(sinal.codigo)) continue;
    const mapa = MAPA_SINAL_DISPOSITIVO[sinal.codigo];
    if (!mapa) continue;
    vistos.add(sinal.codigo);
    const porArtigo = new Map(entrada.dispositivos.filter((d) => d.norma === NORMA).map((d) => [d.artigo, d]));
    const fontes: Fonte[] = [];
    const trechos: string[] = [];
    const ausentes: number[] = [];
    let naoConferido = false;
    for (const artigo of mapa.artigos) {
      const dispositivo = porArtigo.get(artigo);
      if (!dispositivo) {
        ausentes.push(artigo);
        continue;
      }
      if (!dispositivo.conferido_oficial) naoConferido = true;
      fontes.push({
        tipo: "dispositivo",
        norma: NORMA,
        artigo,
        conferido_oficial: dispositivo.conferido_oficial,
      });
      const aviso = dispositivo.conferido_oficial ? "" : " (texto não conferido com a fonte oficial)";
      trechos.push(`Art. ${artigo} ${dispositivo.texto}${aviso}`);
    }
    fontes.push({ tipo: "calculo", regra: "mapa_sinal_dispositivo", versao: REGRA_VERSAO });
    achados.push({
      codigo: `juridico.${sinal.codigo.replaceAll(".", "_")}`,
      natureza: "inferencia",
      metodo: "regra",
      severidade: mapa.peca === "nenhuma" ? "info" : "atencao",
      titulo: sinal.codigo,
      detalhe: trechos.join(" "),
      dados: {
        sinal_origem: sinal.codigo,
        peca_a_avaliar: mapa.peca,
        dispositivos_ausentes: ausentes,
        ha_dispositivo_nao_conferido: naoConferido,
      },
      fontes,
    });
  }
  return { agente: "juridico", situacao: "ok", achados, regra_versao: REGRA_VERSAO };
}

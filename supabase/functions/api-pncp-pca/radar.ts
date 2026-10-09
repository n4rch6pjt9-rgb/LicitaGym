// Stub da fase red (spec 0006): o comportamento vem no próximo commit.
export const RADAR_VIEW = "v_bi_pca_radar";

export interface RadarDeps {
  requireAuth?: (req: Request) => Promise<Response | null>;
  criarCliente?: () => unknown;
}

export function responderRadar(_req: Request, _url: URL, _deps: RadarDeps = {}): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ error: "não implementado" }), { status: 501 }));
}

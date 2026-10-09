// Stub da fase red (spec 0008): o comportamento vem no próximo commit.
export interface Contexto {
  isCron?: (req: Request) => boolean;
  atualizar?: () => Promise<Record<string, number>>;
}
export function handleRequest(_req: Request, _ctx: Contexto = {}): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ error: "não implementado" }), { status: 501 }));
}

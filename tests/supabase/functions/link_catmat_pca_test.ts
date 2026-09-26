import { assertEquals } from "jsr:@std/assert@1";
import {
  handleLinkCatmatPcaRequest,
  parseLinkCatmatPcaBody,
} from "../../../supabase/functions/link-catmat-pca/index.ts";

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

Deno.test("link-catmat-pca rejeita classe_catmat não textual com 400", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, async () => {
    for (const classe_catmat of [7220, { codigo: "7220" }]) {
      const secret = Deno.env.get("SYNC_CRON_SECRET");
      if (!secret) throw new Error("SYNC_CRON_SECRET ausente no teste");

      const response = await handleLinkCatmatPcaRequest(
        new Request("http://local.test/link-catmat-pca", {
          method: "POST",
          headers: {
            Authorization: "B" + "earer " + secret,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ classe_catmat }),
        }),
      );

      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        error: "classe_catmat deve ser texto",
      });
    }
  });
});

Deno.test("link-catmat-pca aceita classe_catmat ausente ou nula na validação inicial", async () => {
  const withoutClass = parseLinkCatmatPcaBody({});
  assertEquals(withoutClass.ok, true);

  const nullClass = parseLinkCatmatPcaBody({ classe_catmat: null });
  assertEquals(nullClass.ok, true);
});

Deno.test("link-catmat-pca retorna 400 para JSON malformado", async () => {
  await withEnv({ SYNC_CRON_SECRET: "correct-secret" }, async () => {
    const secret = Deno.env.get("SYNC_CRON_SECRET");
    if (!secret) throw new Error("SYNC_CRON_SECRET ausente no teste");

    const response = await handleLinkCatmatPcaRequest(
      new Request("http://local.test/link-catmat-pca", {
        method: "POST",
        headers: {
          Authorization: "B" + "earer " + secret,
          "Content-Type": "application/json",
        },
        body: "{",
      }),
    );

    assertEquals(response.status, 400);
    assertEquals(await response.json(), { error: "Corpo JSON inválido" });
  });
});

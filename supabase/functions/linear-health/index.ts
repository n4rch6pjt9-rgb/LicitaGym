import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_API_KEY = Deno.env.get("LINEAR_API_KEY");

if (!LINEAR_API_KEY) {
  throw new Error("LINEAR_API_KEY is required");
}

const headers = {
  "Content-Type": "application/json",
  "Authorization": `Bearer ${LINEAR_API_KEY}`,
};

const viewerQuery = `
  query Viewer {
    viewer {
      id
      name
      email
      displayName
    }
  }
`;

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Allow": "GET",
        },
      },
    );
  }

  try {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: viewerQuery }),
    });

    const body = await response.json();

    if (!response.ok || body.errors?.length) {
      console.error("Linear API error", {
        status: response.status,
        errors: body.errors,
      });

      return new Response(
        JSON.stringify({
          connected: false,
          error: "Linear API request failed",
        }),
        {
          status: response.status >= 400 ? response.status : 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        connected: true,
        viewer: body.data?.viewer ?? null,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Linear connection error", error);

    return new Response(
      JSON.stringify({
        connected: false,
        error: "Unable to reach Linear API",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});

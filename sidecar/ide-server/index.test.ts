import { describe, expect, test } from "bun:test";

// index.ts boots a real Bun.serve + MCP transport as an import side effect
// (it's the process entrypoint). Set the required env var before importing
// so the module under test doesn't exit(1) during `bun test`; the boot
// side effects themselves are exercised manually/via the sidecar
// supervisor, not here — this file only unit-tests the exported
// `createFetchHandler` routing/auth logic.
process.env.MOTHERSHIP_IDE_TOKEN ??= "boot-time-token-for-tests";

const { createFetchHandler } = await import("./index");

const TOKEN = "secret-token";

function stubBridge(ready: boolean) {
  return { isReady: () => ready };
}

function stubTransport(response: Response) {
  return { handleRequest: async () => response };
}

function noopUpgrade() {
  return false;
}

describe("createFetchHandler — 401 uniformity", () => {
  test("/health without a bearer returns an empty 401", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(new Request("http://127.0.0.1/health"), {
      upgrade: noopUpgrade,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("/health with the correct bearer returns 200 when ready", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(
      new Request("http://127.0.0.1/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      { upgrade: noopUpgrade },
    );
    expect(res.status).toBe(200);
  });

  test("/health with the correct bearer returns 503 when not ready", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(false),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(
      new Request("http://127.0.0.1/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      { upgrade: noopUpgrade },
    );
    expect(res.status).toBe(503);
  });

  test("/health with a wrong bearer returns 401", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(
      new Request("http://127.0.0.1/health", {
        headers: { authorization: "Bearer wrong" },
      }),
      { upgrade: noopUpgrade },
    );
    expect(res.status).toBe(401);
  });

  test("/ws non-upgrade request returns an empty 401, not a distinct 400", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(new Request("http://127.0.0.1/ws"), {
      upgrade: noopUpgrade,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });

  test("/mcp without a bearer returns 401 (existing contract, unchanged)", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response("mcp-ok", { status: 200 })),
    );
    const res = await handler(new Request("http://127.0.0.1/mcp"), {
      upgrade: noopUpgrade,
    });
    expect(res.status).toBe(401);
  });

  test("an unmatched path returns the same empty 401", async () => {
    const handler = createFetchHandler(
      TOKEN,
      stubBridge(true),
      stubTransport(new Response(null, { status: 200 })),
    );
    const res = await handler(new Request("http://127.0.0.1/nope"), {
      upgrade: noopUpgrade,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("");
  });
});

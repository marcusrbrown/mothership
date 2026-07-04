/**
 * Real end-to-end MCP session test (regression test for the stateless-
 * transport-reuse bug): boots an ACTUAL Bun.serve using the real
 * `createFetchHandler` + a per-request `McpRequestHandlerFactory` (exactly
 * what `index.ts` wires up), then drives a real multi-request MCP session
 * over HTTP using the SDK's own `Client` + `StreamableHTTPClientTransport`.
 *
 * Before the fix, `index.ts` connected ONE `McpServer` to ONE stateless
 * `WebStandardStreamableHTTPServerTransport` and reused it for every `/mcp`
 * request. The SDK's stateless transport throws on any request after the
 * first ("Stateless transport cannot be reused across requests"), so the
 * `initialize` request succeeded but the very next request (SDK sends
 * `notifications/initialized` immediately after) hit the reused transport
 * and surfaced as an HTTP 500 — no MCP client could ever complete a
 * session. This test proves multiple sequential requests now succeed
 * against one long-lived server instance.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "bun";

// index.ts boots a real Bun.serve as an import side effect and exits(1)
// without this env var set (see index.test.ts for the same pattern).
process.env.MOTHERSHIP_IDE_TOKEN ??= "boot-time-token-for-tests";

const { createFetchHandler } = await import("./index");
type McpRequestHandlerFactory = Parameters<typeof createFetchHandler>[2];
const { createIdeMcpServer } = await import("./mcp-server");
const { createWsBridge } = await import("./ws-bridge");

const TOKEN = "session-test-token";

function bootSidecar(): Server {
  const bridge = createWsBridge(TOKEN);

  const makeMcpRequestHandler: McpRequestHandlerFactory = async () => {
    const mcpServer = createIdeMcpServer(bridge);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    return {
      handleRequest: (req: Request) => transport.handleRequest(req),
      dispose: async () => {
        await transport.close();
        await mcpServer.close();
      },
    };
  };

  const handleFetch = createFetchHandler(TOKEN, bridge, makeMcpRequestHandler);

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: handleFetch as never,
  });
}

describe("real end-to-end MCP session over /mcp (regression: stateless transport reuse)", () => {
  test("initialize -> notifications/initialized -> tools/list all succeed on one server", async () => {
    const server = bootSidecar();
    try {
      const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      const client = new Client({ name: "test-client", version: "0.0.0" });

      // client.connect() performs initialize + sends notifications/initialized
      // internally — this is exactly the sequence that 500'd pre-fix.
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "ide_close_panel",
          "ide_focus",
          "ide_get_layout",
          "ide_list_panels",
          "ide_move_panel",
          "ide_open_panel",
          "ide_set_layout",
          "ide_split",
        ].sort(),
      );

      await client.close();
    } finally {
      server.stop(true);
    }
  });

  test("tools/call with no webview bridge connected returns a graceful error result, not a crash", async () => {
    const server = bootSidecar();
    try {
      const url = new URL(`http://127.0.0.1:${server.port}/mcp`);
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(transport);

      const result = await client.callTool({
        name: "ide_list_panels",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0]
        ?.text;
      expect(text).toBeDefined();
      expect(() => JSON.parse(text ?? "")).not.toThrow();
      const parsed = JSON.parse(text ?? "{}") as { error?: unknown };
      expect(parsed.error).toBeDefined();

      await client.close();
    } finally {
      server.stop(true);
    }
  });
});

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
/**
 * Bun sidecar entry. Hosts BOTH the MCP streamable-HTTP server
 * (`/mcp`) and the WS bridge (`/ws`) on one `Bun.serve` instance bound to
 * 127.0.0.1:0 (OS-assigned port — localhost-only). Reads the bearer
 * token from `MOTHERSHIP_IDE_TOKEN` (NEVER argv, so it never shows up in
 * `ps`), prints `IDE_PORT=<n>` as the first stdout line (the Rust
 * supervisor's rendezvous handshake), then keeps running until SIGTERM,
 * which drains and exits.
 *
 * Bun has native HTTP+WS via `Bun.serve`; the streamable-HTTP transport
 * used is `WebStandardStreamableHTTPServerTransport` (confirmed against the
 * installed `@modelcontextprotocol/sdk@1.29.0` — the Node-specific
 * `StreamableHTTPServerTransport` wraps IncomingMessage/ServerResponse and
 * doesn't fit Bun's Web-standard Request/Response server model).
 */
import type { Server, ServerWebSocket } from "bun";
import { isAuthorized, unauthorizedResponse } from "./http-auth";
import { createIdeMcpServer } from "./mcp-server";
import type { WsBridge } from "./ws-bridge";
import { createWsBridge } from "./ws-bridge";

interface WsData {
  authed?: boolean;
}

/**
 * Factory for a fresh, single-use MCP transport (+ connected server) per
 * `/mcp` request. `WebStandardStreamableHTTPServerTransport` in stateless
 * mode (`sessionIdGenerator: undefined`) throws on a second `handleRequest`
 * call ("Stateless transport cannot be reused across requests"), so every
 * `/mcp` request gets its own transport+server pair; the shared `WsBridge`
 * (the actual state — the WS connection to the webview) is closed over by
 * the tool handlers registered inside `createIdeMcpServer` and is NOT
 * recreated here.
 */
export type McpRequestHandlerFactory = () => Promise<{
  handleRequest: (req: Request) => Promise<Response> | Response;
  dispose: () => Promise<void>;
}>;

/**
 * Builds the `Bun.serve` fetch handler. Exported (undocumented, test-only
 * export) so `index.test.ts` can exercise the routing/auth-uniformity
 * contract without booting the real MCP transport or a live WS server:
 * every pre-auth HTTP response that isn't a valid WS upgrade or an authed
 * `/mcp`|`/health` is an indistinguishable empty 401.
 */
export function createFetchHandler(
  token: string,
  bridge: Pick<WsBridge, "isReady">,
  makeMcpRequestHandler: McpRequestHandlerFactory,
) {
  return async function fetch(
    req: Request,
    srv: { upgrade: (req: Request, opts: { data: WsData }) => boolean },
  ): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(req, { data: {} });
      if (upgraded) return undefined as unknown as Response;
      // A non-upgrade request to /ws is indistinguishable from any other
      // unauthed path — no distinct status/body revealing the path exists.
      return unauthorizedResponse();
    }

    if (url.pathname === "/health") {
      if (!isAuthorized(req.headers.get("authorization"), token)) {
        return unauthorizedResponse();
      }
      const healthy = bridge.isReady();
      return new Response(null, { status: healthy ? 200 : 503 });
    }

    if (url.pathname === "/mcp") {
      if (!isAuthorized(req.headers.get("authorization"), token)) {
        return unauthorizedResponse();
      }
      const { handleRequest, dispose } = await makeMcpRequestHandler();
      let response: Response;
      try {
        response = await handleRequest(req);
      } catch (err) {
        await dispose();
        throw err;
      }
      // `handleRequest` resolves as soon as the Response (often a
      // streaming SSE body) is constructed — the JSON-RPC reply is written
      // to that stream asynchronously afterwards. Disposing the per-request
      // transport/server immediately here would tear down the stream mid-
      // write. Tee the body: return one branch to the caller untouched,
      // drain the other in the background, and dispose only once the
      // stream has actually finished (or the response has no body at all).
      if (!response.body) {
        await dispose();
        return response;
      }
      const [passthrough, drain] = response.body.tee();
      void (async () => {
        const reader = drain.getReader();
        try {
          let result = await reader.read();
          while (!result.done) {
            result = await reader.read();
          }
        } catch {
          // Stream errored/aborted — still dispose below.
        } finally {
          await dispose();
        }
      })();
      return new Response(passthrough, {
        status: response.status,
        headers: response.headers,
      });
    }

    // Uniform empty 401 for every other unauthenticated path — no
    // information leakage about which paths exist (plan requirement).
    return unauthorizedResponse();
  };
}

const token = process.env.MOTHERSHIP_IDE_TOKEN;
if (!token) {
  console.error("MOTHERSHIP_IDE_TOKEN is required (set via env, never argv)");
  process.exit(1);
}

const bridge = createWsBridge(token);

// Stateless mode: no MCP session management needed for a single localhost
// operator/token; every request round-trips through the one WS-bridged
// webview regardless of MCP session id. The SDK's stateless transport
// forbids reuse across requests, so a new McpServer+transport pair is
// created per `/mcp` request; the shared `bridge` (the actual WS state) is
// the same instance across every request.
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

const handleFetch = createFetchHandler(token, bridge, makeMcpRequestHandler);

const server: Server = Bun.serve<WsData, Record<string, never>>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: handleFetch as never,
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      bridge.onOpen(ws);
    },
    message(ws: ServerWebSocket<WsData>, message) {
      bridge.onMessage(ws, message.toString());
    },
    close(ws: ServerWebSocket<WsData>) {
      bridge.onClose(ws);
    },
  },
});

// Rendezvous handshake: the Rust supervisor reads this exact line from
// stdout to learn the OS-assigned port. Must be the first (and only)
// stdout line of this shape.
console.log(`IDE_PORT=${server.port}`);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

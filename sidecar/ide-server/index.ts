import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
/**
 * Bun sidecar entry (U1.7 / AE3). Hosts BOTH the MCP streamable-HTTP server
 * (`/mcp`) and the WS bridge (`/ws`) on one `Bun.serve` instance bound to
 * 127.0.0.1:0 (OS-assigned port — localhost-only per R15). Reads the bearer
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
import { createWsBridge } from "./ws-bridge";

const token = process.env.MOTHERSHIP_IDE_TOKEN;
if (!token) {
  console.error("MOTHERSHIP_IDE_TOKEN is required (set via env, never argv)");
  process.exit(1);
}

const bridge = createWsBridge(token);
const mcpServer = createIdeMcpServer(bridge);

// Stateless mode: no MCP session management needed for a single localhost
// operator/token; every request round-trips through the one WS-bridged
// webview regardless of MCP session id.
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});
await mcpServer.connect(transport);

interface WsData {
  authed?: boolean;
}

const server: Server = Bun.serve<WsData, Record<string, never>>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(req, { data: {} });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname === "/health") {
      const healthy = bridge.isReady();
      return new Response(null, { status: healthy ? 200 : 503 });
    }

    if (url.pathname === "/mcp") {
      if (!isAuthorized(req.headers.get("authorization"), token)) {
        return unauthorizedResponse();
      }
      return transport.handleRequest(req);
    }

    // Uniform empty 401 for every other unauthenticated path — no
    // information leakage about which paths exist (plan requirement).
    return unauthorizedResponse();
  },
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
  void transport.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

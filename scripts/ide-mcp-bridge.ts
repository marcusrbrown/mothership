#!/usr/bin/env bun
/**
 * Persistent stdio↔HTTP MCP bridge for connecting an opencode `type: local`
 * MCP server entry to Mothership's running `ide_*` streamable-HTTP server.
 *
 * opencode.json is static and can't hardcode Mothership's per-launch random
 * port/token, so this bridge re-reads the 0600 rendezvous file at spawn
 * time, opens a streamable-HTTP client to the current endpoint, and
 * transparently forwards `tools/list` / `tools/call` over stdio to opencode.
 *
 * If Mothership isn't running (no rendezvous file) or the connection drops
 * (Mothership relaunched → stale port/token), this process exits non-zero
 * so opencode surfaces the server as unavailable rather than hanging.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RENDEZVOUS = join(
  homedir(),
  "Library",
  "Application Support",
  "com.marcusrbrown.mothership",
  "ide-bridge.json",
);

interface Rendezvous {
  port: number;
  token: string;
}

async function readRendezvous(): Promise<Rendezvous> {
  const file = Bun.file(RENDEZVOUS);
  if (!(await file.exists())) {
    throw new Error(
      `Mothership is not running / no ide-bridge.json at ${RENDEZVOUS} — start Mothership first.`,
    );
  }
  return (await file.json()) as Rendezvous;
}

/**
 * Connects to Mothership's `ide_*` MCP server over streamable-HTTP and
 * returns the connected client plus its current tool list. Split out from
 * the stdio wiring so it can be exercised headlessly (see
 * `scripts/ide-mcp-bridge.test.ts`) without driving a full stdio JSON-RPC
 * handshake.
 */
export async function connectToSidecar(rendezvous: Rendezvous): Promise<{
  client: Client;
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
}> {
  const url = new URL(`http://127.0.0.1:${rendezvous.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: { Authorization: `Bearer ${rendezvous.token}` },
    },
  });

  const client = new Client({
    name: "mothership-ide-bridge",
    version: "0.1.0",
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, tools };
}

async function main(): Promise<void> {
  const rendezvous = await readRendezvous();
  const { client, tools } = await connectToSidecar(rendezvous);

  const server = new Server(
    { name: "mothership-ide-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return client.callTool({
      name: request.params.name,
      arguments: request.params.arguments,
    });
  });

  client.onclose = () => {
    // Mothership relaunched (or shut down) mid-session: the port/token this
    // bridge holds is now stale. Exit so opencode restarts the bridge,
    // which re-reads the rendezvous file and reconnects to the current
    // endpoint.
    console.error("mothership-ide-bridge: sidecar connection closed, exiting");
    process.exit(1);
  };

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

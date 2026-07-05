#!/usr/bin/env bun
/**
 * Prints the opencode MCP config for connecting an agent to Mothership's
 * running `ide_*` server. Reads {port, token} from the 0600 rendezvous file
 * the app writes on launch. Run while Mothership is open.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const RENDEZVOUS = join(
  homedir(),
  "Library",
  "Application Support",
  "com.marcusrbrown.mothership",
  "ide-bridge.json",
);

const file = Bun.file(RENDEZVOUS);
if (!(await file.exists())) {
  console.error(
    `No rendezvous file at ${RENDEZVOUS}\nIs Mothership running? The ide_* server writes this on launch.`,
  );
  process.exit(1);
}

const { port, token } = (await file.json()) as { port: number; token: string };

const config = {
  mcpServers: {
    "mothership-ide": {
      type: "remote",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
};

console.log(JSON.stringify(config, null, 2));

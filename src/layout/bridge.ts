/**
 * Webview WS client for the `ide_*` MCP bridge (U1.7 / AE3). Connects to the
 * Bun sidecar's `/ws` endpoint using {port, token} delivered over Tauri IPC
 * (`invoke("ide_bridge_info")`); the token is read once into a closure here
 * and never assigned to `window`/globals. Sends the auth first-frame
 * immediately on open, then answers every relayed `BridgeRequest` by running
 * `executeCommand` against the live adapter (source: 'mcp_tool' — feeds the
 * audit log identically to UI-originated commands). Reconnects on drop with
 * a fixed backoff; this module owns no UI, only wiring (mounted from
 * DockviewShell once the adapter exists).
 */
import { invoke } from "@tauri-apps/api/core";
import type { DockviewAdapter } from "./adapter";
import {
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  READ_TOOL_NAMES,
  layoutCommandSchema,
} from "./bridge-protocol";
import type { LayoutCommand, LayoutErrorCode } from "./commands";
import { executeCommand } from "./executor";

export interface BridgeInfo {
  port: number;
  token: string;
}

/** Minimal WebSocket surface this module needs — lets tests supply a stub
 * without a real network socket. */
export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface BridgeDeps {
  /** Resolves {port, token} — defaults to the real Tauri IPC call. */
  getBridgeInfo: () => Promise<BridgeInfo>;
  /** WebSocket constructor seam — defaults to the global `WebSocket`. */
  createSocket: (url: string) => WsLike;
  /** Reconnect delay in ms — defaults to 1000, overridable for tests. */
  reconnectDelayMs?: number;
}

const defaultDeps: BridgeDeps = {
  getBridgeInfo: () => invoke<BridgeInfo>("ide_bridge_info"),
  createSocket: (url: string) => new WebSocket(url) as unknown as WsLike,
};

function toLayoutError(code: LayoutErrorCode | string, message: string) {
  return { code, message };
}

/** Executes one relayed request against the given adapter and returns the
 * `BridgeResponse` to send back. Exported for direct unit testing without a
 * socket. */
export function handleBridgeRequest(
  req: BridgeRequest,
  adapter: DockviewAdapter,
): BridgeResponse {
  if ((READ_TOOL_NAMES as readonly string[]).includes(req.tool)) {
    return {
      kind: "response",
      seq: req.seq,
      ok: true,
      layout: adapter.toJSON(),
    };
  }

  const parsed = layoutCommandSchema.safeParse(req.params);
  if (!parsed.success) {
    return {
      kind: "response",
      seq: req.seq,
      ok: false,
      error: toLayoutError("invalid_layout", parsed.error.message),
    };
  }

  const cmd: LayoutCommand = parsed.data;
  const result = executeCommand(cmd, adapter, { source: "mcp_tool" });

  if (result.ok) {
    return { kind: "response", seq: req.seq, ok: true, layout: result.layout };
  }
  return {
    kind: "response",
    seq: req.seq,
    ok: false,
    error: toLayoutError(result.error.code, result.error.message),
  };
}

export interface LayoutBridge {
  close(): void;
}

/**
 * Connects to the sidecar and starts answering relayed requests against
 * `adapter`. Call once per DockviewShell mount, after the adapter exists.
 */
export function connectLayoutBridge(
  adapter: DockviewAdapter,
  deps: Partial<BridgeDeps> = {},
): LayoutBridge {
  const {
    getBridgeInfo,
    createSocket,
    reconnectDelayMs = 1000,
  } = {
    ...defaultDeps,
    ...deps,
  };

  let closed = false;
  let socket: WsLike | undefined;

  function scheduleReconnect(): void {
    if (closed) return;
    setTimeout(() => {
      if (!closed) void connect();
    }, reconnectDelayMs);
  }

  async function connect(): Promise<void> {
    if (closed) return;
    let info: BridgeInfo;
    try {
      info = await getBridgeInfo();
    } catch {
      scheduleReconnect();
      return;
    }

    const ws = createSocket(`ws://127.0.0.1:${info.port}/ws`);
    socket = ws;

    ws.onopen = () => {
      const auth: BridgeMessage = {
        kind: "auth",
        token: info.token,
      };
      ws.send(JSON.stringify(auth));
    };

    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const record = msg as { kind?: string };
      if (record.kind !== "request") return;
      const req = msg as BridgeRequest;
      const response = handleBridgeRequest(req, adapter);
      ws.send(JSON.stringify(response));
    };

    ws.onclose = () => {
      if (socket === ws) socket = undefined;
      scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  void connect();

  return {
    close(): void {
      closed = true;
      socket?.close();
      socket = undefined;
    },
  };
}

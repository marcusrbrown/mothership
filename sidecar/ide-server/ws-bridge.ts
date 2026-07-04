/**
 * WS server-side half of the `ide_*` bridge (U1.7 / AE3). Single-webview-
 * client model: the tracer has one operator, one webview, one token — the
 * trust model documented in the plan ("all bearer-holders are equally
 * privileged in the tracer"). A connecting socket's FIRST frame must be a
 * valid `BridgeAuthFrame` carrying the correct token within
 * `AUTH_TIMEOUT_MS`, or the socket is closed before any command flows
 * (browser WebSocket can't set headers, so this is the only auth surface).
 *
 * Boot ordering: until a webview client has authenticated, `dispatch()`
 * resolves immediately with an `unavailable` error — never a hang. Every
 * dispatched request carries a `seq` and a timeout; on WS disconnect every
 * pending request rejects immediately with `disconnected` (no orphans).
 */
import {
  type BridgeMessage,
  type BridgeResponse,
  bridgeMessageSchema,
} from "../../src/layout/bridge-protocol";

export const AUTH_TIMEOUT_MS = 3000;
export const REQUEST_TIMEOUT_MS = 10000;

interface PendingEntry {
  resolve: (res: BridgeResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The minimal socket surface this module needs — satisfied by Bun's
 * `ServerWebSocket` and by test doubles alike. */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WsBridge {
  /** Call when a new WS connection is accepted (before any frames arrive). */
  onOpen(socket: BridgeSocket): void;
  /** Call with each raw text frame received on `socket`. */
  onMessage(socket: BridgeSocket, raw: string): void;
  /** Call when `socket` disconnects, however that happens. */
  onClose(socket: BridgeSocket): void;
  /** True once a webview client has completed the auth handshake. */
  isReady(): boolean;
  /**
   * Relay a mutation/read to the authenticated webview client and await its
   * reply. Resolves `{ok:false, error:{code:"unavailable"}}` immediately
   * (never hangs) if no client is authed yet; resolves
   * `{ok:false, error:{code:"disconnected"}}` if the client disconnects
   * while the request is in flight; resolves `{ok:false,
   * error:{code:"timeout"}}` if `REQUEST_TIMEOUT_MS` elapses with no reply.
   */
  dispatch(tool: string, params: unknown): Promise<BridgeResponse>;
}

export function createWsBridge(
  token: string,
  opts: { requestTimeoutMs?: number; authTimeoutMs?: number } = {},
): WsBridge {
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;

  let authedSocket: BridgeSocket | undefined;
  let nextSeq = 1;
  const pending = new Map<number, PendingEntry>();
  const pendingAuthTimers = new WeakMap<
    BridgeSocket,
    ReturnType<typeof setTimeout>
  >();

  function rejectAllPending(code: string): void {
    for (const [seq, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        kind: "response",
        seq,
        ok: false,
        error: { code, message: `request ${seq} ${code}` },
      });
    }
    pending.clear();
  }

  return {
    onOpen(socket: BridgeSocket): void {
      const timer = setTimeout(() => {
        pendingAuthTimers.delete(socket);
        socket.close(4001, "auth timeout");
      }, authTimeoutMs);
      pendingAuthTimers.set(socket, timer);
    },

    onMessage(socket: BridgeSocket, raw: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        socket.close(4002, "malformed frame");
        return;
      }

      const result = bridgeMessageSchema.safeParse(parsed);
      if (!result.success) {
        if (socket !== authedSocket) socket.close(4002, "malformed frame");
        return;
      }
      const msg: BridgeMessage = result.data;

      if (socket !== authedSocket) {
        // Pre-auth: only an auth frame with the right token is acceptable.
        const authTimer = pendingAuthTimers.get(socket);
        if (msg.kind !== "auth" || msg.token !== token) {
          if (authTimer) clearTimeout(authTimer);
          pendingAuthTimers.delete(socket);
          socket.close(4003, "unauthorized");
          return;
        }
        if (authTimer) clearTimeout(authTimer);
        pendingAuthTimers.delete(socket);
        // A second client replaces the first (single-client trust model).
        authedSocket = socket;
        return;
      }

      if (msg.kind === "response") {
        const entry = pending.get(msg.seq);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.seq);
        entry.resolve(msg);
      }
    },

    onClose(socket: BridgeSocket): void {
      const authTimer = pendingAuthTimers.get(socket);
      if (authTimer) {
        clearTimeout(authTimer);
        pendingAuthTimers.delete(socket);
      }
      if (socket === authedSocket) {
        authedSocket = undefined;
        rejectAllPending("disconnected");
      }
    },

    isReady(): boolean {
      return authedSocket !== undefined;
    },

    dispatch(tool: string, params: unknown): Promise<BridgeResponse> {
      if (!authedSocket) {
        return Promise.resolve({
          kind: "response",
          seq: -1,
          ok: false,
          error: {
            code: "unavailable",
            message: "no webview client connected",
          },
        });
      }

      const seq = nextSeq++;
      const socket = authedSocket;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          resolve({
            kind: "response",
            seq,
            ok: false,
            error: { code: "timeout", message: `request ${seq} timed out` },
          });
        }, requestTimeoutMs);

        pending.set(seq, { resolve, timer });

        const req: BridgeMessage = { kind: "request", seq, tool, params };
        socket.send(JSON.stringify(req));
      });
    },
  };
}

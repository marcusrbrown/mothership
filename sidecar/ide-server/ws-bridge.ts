/**
 * WS server-side half of the `ide_*` bridge. Single-webview-
 * client model: one operator, one webview, one token — all bearer-holders
 * are equally privileged. A connecting socket's FIRST frame must be a
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
  /** The authenticated-socket generation this request was sent under. */
  generation: number;
}

/** The minimal socket surface this module needs — satisfied by Bun's
 * `ServerWebSocket` and by test doubles alike.
 *
 * `send`'s return value follows Bun's `ServerWebSocket.send` contract:
 * `0` means the frame was dropped/not sent (backpressure limit hit,
 * definitely not delivered), `-1` means queued under backpressure (accepted,
 * outcome indeterminate), and any positive number means the byte count
 * written (accepted). A socket implementation that returns `void` (no
 * return value at all, e.g. a minimal test double) is treated the same as
 * "accepted" — only an explicit `0` is classified as not-sent. */
export interface BridgeSocket {
  // biome-ignore lint/suspicious/noConfusingVoidType: Bun's ServerWebSocket.send returns number (0/-1/positive); simple test doubles/hand-written clients that don't follow that contract return void — both must satisfy this interface unchanged.
  send(data: string): number | void;
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
  /** Number of requests currently awaiting a response. Test/introspection
   * use only — optional so unrelated `WsBridge` stubs/consumers (e.g.
   * `mcp-server.test.ts`'s minimal test double) are never forced to
   * implement diagnostics they don't need. */
  pendingCount?(): number;
}

export function createWsBridge(
  token: string,
  opts: { requestTimeoutMs?: number; authTimeoutMs?: number } = {},
): WsBridge {
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const authTimeoutMs = opts.authTimeoutMs ?? AUTH_TIMEOUT_MS;

  let authedSocket: BridgeSocket | undefined;
  /** Monotonic identity for the currently-authenticated socket. Bumped on
   * every successful auth handshake so pending requests and late responses
   * can be attributed to the socket generation that issued them. */
  let generation = 0;
  let nextSeq = 1;
  const pending = new Map<number, PendingEntry>();
  const pendingAuthTimers = new WeakMap<
    BridgeSocket,
    ReturnType<typeof setTimeout>
  >();
  /** Sockets whose pre-auth lifecycle has already resolved one way or
   * another (authenticated-then-replaced, auth-timed-out, or
   * auth-rejected). A settled socket can never re-enter the pre-auth path
   * and evict the current generation — any further frames from it are
   * ignored outright. */
  const settledSockets = new WeakSet<BridgeSocket>();

  /** Builds a sidecar-generated (never webview-sourced) transport failure.
   * Every sidecar-originated error is `domain: "transport"` so it can never
   * be confused with a webview-returned layout/session response, and
   * carries an explicit delivery classification: `"not_sent"` when the
   * request definitely never reached the webview (no authenticated socket,
   * or the send itself failed/was dropped before acceptance), and
   * `"indeterminate"` when the request WAS accepted for send but the
   * outcome can no longer be known (replaced, disconnected, timed out). */
  function transportError(
    seq: number,
    code: string,
    delivery: "not_sent" | "indeterminate",
  ): BridgeResponse {
    return {
      kind: "response",
      domain: "transport",
      seq,
      ok: false,
      error: { code, message: `request ${seq} ${code}`, delivery },
    };
  }

  /** Reject every pending request owned by `gen`, leaving requests from any
   * other generation untouched. Always `"indeterminate"`: every pending
   * request was already accepted for send (registered only after a
   * successful/queued `send`), so a replacement or disconnect can never
   * prove the request wasn't delivered — only that its outcome is now
   * unknowable. */
  function rejectGeneration(gen: number, code: string): void {
    for (const [seq, entry] of pending) {
      if (entry.generation !== gen) continue;
      clearTimeout(entry.timer);
      pending.delete(seq);
      entry.resolve(transportError(seq, code, "indeterminate"));
    }
  }

  return {
    onOpen(socket: BridgeSocket): void {
      const timer = setTimeout(() => {
        pendingAuthTimers.delete(socket);
        settledSockets.add(socket);
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
        // A socket that has already settled (authenticated-then-replaced,
        // timed out, or rejected) can never re-enter the pre-auth path.
        // Without this gate, a stale/replaced socket resending a valid
        // auth frame could evict the *current* authenticated socket.
        if (settledSockets.has(socket)) return;

        // Pre-auth: only an auth frame with the right token is acceptable.
        const authTimer = pendingAuthTimers.get(socket);
        if (msg.kind !== "auth" || msg.token !== token) {
          if (authTimer) clearTimeout(authTimer);
          pendingAuthTimers.delete(socket);
          settledSockets.add(socket);
          socket.close(4003, "unauthorized");
          return;
        }
        if (authTimer) clearTimeout(authTimer);
        pendingAuthTimers.delete(socket);
        // A second client replaces the first (single-client trust model).
        // Reject every pending request owned by the outgoing generation
        // *before* the new generation becomes active, so nothing can be
        // stranded and no late old-generation response can be misattributed.
        if (authedSocket !== undefined) {
          rejectGeneration(generation, "replaced");
          settledSockets.add(authedSocket);
        }
        authedSocket = socket;
        generation += 1;
        return;
      }

      if (msg.kind === "response") {
        if (socket !== authedSocket) return; // stray frame from a stale generation
        const entry = pending.get(msg.seq);
        if (!entry) return;
        if (entry.generation !== generation) return; // seq reused across generations
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
        rejectGeneration(generation, "disconnected");
      }
      // A close event for an already-replaced (old-generation) socket is a
      // no-op: its pending requests were already rejected as "replaced".
    },

    isReady(): boolean {
      return authedSocket !== undefined;
    },

    pendingCount(): number {
      return pending.size;
    },

    dispatch(tool: string, params: unknown): Promise<BridgeResponse> {
      if (!authedSocket) {
        return Promise.resolve(transportError(0, "unavailable", "not_sent"));
      }

      const seq = nextSeq++;
      const socket = authedSocket;
      const gen = generation;

      // Send synchronously so a throw here classifies as "definitely not
      // sent" and never registers a pending entry that could later be
      // mistaken for an indeterminate (post-send) outcome.
      const req: BridgeMessage = { kind: "request", seq, tool, params };
      // biome-ignore lint/suspicious/noConfusingVoidType: mirrors BridgeSocket.send's number|void contract.
      let sendResult: number | void;
      try {
        sendResult = socket.send(JSON.stringify(req));
      } catch {
        return Promise.resolve(transportError(seq, "send_failed", "not_sent"));
      }
      // Only an explicit `0` return means Bun definitely dropped the frame.
      // `-1` (queued/backpressure) and any positive byte count are
      // indeterminate-or-accepted outcomes and stay pending; `void` (a test
      // double with no return value) is treated the same as accepted.
      if (sendResult === 0) {
        return Promise.resolve(transportError(seq, "send_failed", "not_sent"));
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          resolve(transportError(seq, "timeout", "indeterminate"));
        }, requestTimeoutMs);

        pending.set(seq, { resolve, timer, generation: gen });
      });
    },
  };
}

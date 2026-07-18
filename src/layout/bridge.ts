/**
 * Webview WS client for the `ide_*` MCP bridge. Connects to the
 * Bun sidecar's `/ws` endpoint using {port, token} delivered over Tauri IPC
 * (`invoke("ide_bridge_info")`); the token is read once into a closure here
 * and never assigned to `window`/globals. Sends the auth first-frame
 * immediately on open, then answers every relayed `BridgeRequest` — routed
 * by the validated `tool` name to EITHER the layout domain (`executeCommand`
 * against the live adapter) OR the session-tool domain (`runSessionTool`
 * against injected `SessionToolDeps`), never both, never a heuristic on the
 * request payload shape. Reconnects on drop with a fixed backoff; this
 * module owns no UI, only wiring (mounted from DockviewShell once the
 * adapter exists).
 *
 * Session routing: `sessionTools` is an OPTIONAL bridge dep —
 * `connectLayoutBridge`'s existing call sites (e.g. `DockviewShell`)
 * compile and run unchanged without it. A request whose
 * `tool` name is a registered session tool (see
 * `src/ide/executor.ts`'s `isRegisteredSessionTool`) but for which no
 * `sessionTools` deps were supplied returns a stable `unavailable`/
 * `not_sent` response — it NEVER falls through to the layout path (a
 * session-tool name accidentally executed as a layout command would be
 * silently misrouted with attacker-controlled semantics). A request whose
 * `tool` name is neither a known layout tool nor a registered session tool
 * returns a stable `unknown_tool`/`not_sent` response.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  type SessionToolDeps,
  isRegisteredSessionTool,
  runSessionTool,
} from "../ide/executor";
import type { DockviewAdapter } from "./adapter";
import {
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  MUTATION_TOOL_NAMES,
  READ_TOOL_NAMES,
  bridgeRequestSchema,
  layoutCommandSchema,
  transportError,
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
  /**
   * Optional session-tool execution deps. Absent by default — every
   * existing `connectLayoutBridge` call site compiles and behaves
   * exactly as before without it. When present, a request naming a
   * registered session tool is routed to `runSessionTool` against these
   * deps instead of the layout path.
   */
  sessionTools?: SessionToolDeps;
}

const defaultDeps: Omit<BridgeDeps, "sessionTools"> = {
  getBridgeInfo: () => invoke<BridgeInfo>("ide_bridge_info"),
  createSocket: (url: string) => new WebSocket(url) as unknown as WsLike,
};

/** Program-owned, stable message for every closed `LayoutErrorCode` —
 * mirrors `src/ide/errors.ts`'s `normalizeHandlerError` for the layout
 * domain. `executeCommand`'s own error messages interpolate the CALLER-
 * supplied `panelId`/`panelType`/`referencePanelId` (and, for
 * `set_layout`, a `dockview-core` exception's own message, which may
 * itself echo layout content) — none of that ever crosses the bridge
 * boundary. A code not in this table (defense-in-depth against a future
 * `LayoutErrorCode` addition landing here without updating this map)
 * falls back to the same generic message `invalid_layout` uses. */
const LAYOUT_ERROR_CODE_MESSAGES: Record<LayoutErrorCode, string> = {
  panel_not_found: "No panel matches the given id.",
  unknown_panel_type: "No panel type is registered for the given value.",
  invalid_layout: "The given layout command is invalid.",
  reference_panel_not_found: "No reference panel matches the given id.",
  panel_not_mcp_openable: "The given panel type cannot be opened via MCP.",
};

/** Normalizes a layout executor error into the bridge-boundary shape:
 * validates `code` is a real `LayoutErrorCode` and replaces `message`
 * with the program-owned constant for that code — `executeCommand`'s own
 * message (which may contain the caller-supplied `panelId`/`panelType`/
 * `referencePanelId`, or a raw `dockview-core` exception message for
 * `set_layout`) is NEVER forwarded. An unrecognized code — which should
 * be unreachable given `LayoutErrorCode`'s closed union, but is handled
 * defensively rather than assumed — falls back to the `invalid_layout`
 * message. */
function toLayoutError(code: LayoutErrorCode | string, _rawMessage: string) {
  const message =
    code in LAYOUT_ERROR_CODE_MESSAGES
      ? LAYOUT_ERROR_CODE_MESSAGES[code as LayoutErrorCode]
      : LAYOUT_ERROR_CODE_MESSAGES.invalid_layout;
  return { code, message };
}

/** Handles a relayed request already routed to the LAYOUT domain. Always
 * returns a `domain: "layout"` response. */
function handleLayoutRequest(
  req: BridgeRequest,
  adapter: DockviewAdapter,
): BridgeResponse {
  if ((READ_TOOL_NAMES as readonly string[]).includes(req.tool)) {
    return {
      kind: "response",
      domain: "layout",
      seq: req.seq,
      ok: true,
      layout: adapter.toJSON(),
    };
  }

  const parsed = layoutCommandSchema.safeParse(req.params);
  if (!parsed.success) {
    return {
      kind: "response",
      domain: "layout",
      seq: req.seq,
      ok: false,
      error: toLayoutError("invalid_layout", parsed.error.message),
    };
  }

  const cmd: LayoutCommand = parsed.data;
  const result = executeCommand(cmd, adapter, { source: "mcp_tool" });

  if (result.ok) {
    return {
      kind: "response",
      domain: "layout",
      seq: req.seq,
      ok: true,
      layout: result.layout,
    };
  }
  return {
    kind: "response",
    domain: "layout",
    seq: req.seq,
    ok: false,
    error: toLayoutError(result.error.code, result.error.message),
  };
}

/** Handles a relayed request already routed to the SESSION domain — runs
 * `runSessionTool` against `sessionTools` and reshapes its
 * `SessionToolResult` into a `domain: "session"` `BridgeResponse`,
 * preserving the executor's error code AND delivery classification
 * (`not_sent` vs `indeterminate`) verbatim. Always returns a
 * `domain: "session"` response — `layout` is never populated. */
async function handleSessionRequest(
  req: BridgeRequest,
  sessionTools: SessionToolDeps,
): Promise<BridgeResponse> {
  const result = await runSessionTool(
    req.tool,
    req.params,
    sessionTools,
    "mcp_tool",
  );
  if (result.ok) {
    return {
      kind: "response",
      domain: "session",
      seq: req.seq,
      ok: true,
      data: result.data,
    };
  }
  return {
    kind: "response",
    domain: "session",
    seq: req.seq,
    ok: false,
    error: {
      code: result.error.code,
      message: result.error.message,
      delivery: result.error.delivery,
    },
  };
}

/** A registered-but-unroutable session tool (no `sessionTools` deps
 * supplied yet) — stable `unavailable`/`not_sent`. NEVER falls through
 * to the layout path: a session-tool name executed as a layout command
 * would be silently misrouted with attacker-controlled semantics. */
function sessionToolsUnavailable(req: BridgeRequest): BridgeResponse {
  return {
    kind: "response",
    domain: "session",
    seq: req.seq,
    ok: false,
    error: {
      code: "unavailable",
      message: "Session tool execution is not available.",
      delivery: "not_sent",
    },
  };
}

/** A `tool` name that is neither a known layout tool nor a registered
 * session tool at all — not attributable to either domain, so it uses
 * `domain: "transport"` (the same domain a malformed incoming frame
 * gets — see `transportError` in `./bridge-protocol.ts`), never
 * `"session"`. A registered-but-currently-unroutable session tool (no
 * `sessionTools` deps supplied yet — see `sessionToolsUnavailable`
 * above) is a DIFFERENT case and stays `domain: "session"`: that tool
 * name IS known to belong to the session domain, it just can't be
 * executed right now. */
function unknownTool(req: BridgeRequest): BridgeResponse {
  return transportError(
    req.seq,
    "unknown_tool",
    "No tool matches the given name.",
    "not_sent",
  );
}

/**
 * Executes one relayed request and returns the `BridgeResponse` to send
 * back. Exported for direct unit testing without a socket.
 *
 * Routing is by validated `tool` name only, checked in this fixed order:
 * 1. A known layout tool name (read or mutation) → the layout domain.
 * 2. A registered session tool name (see
 *    `src/ide/executor.ts`'s `isRegisteredSessionTool`) → the session
 *    domain via `runSessionTool`, if `sessionTools` deps were supplied;
 *    otherwise a stable `unavailable`/`not_sent` session-domain response
 *    — never a fall-through to the layout path.
 * 3. Anything else — neither a known layout tool nor a registered
 *    session tool — a stable `domain: "transport"` `unknown_tool`/
 *    `not_sent` response.
 *
 * There is exactly one command-execution path per domain (no duplicated
 * dispatch) and exactly one socket/transport (this function never opens
 * a second connection) — both domains are relayed over the single
 * authenticated WS connection `connectLayoutBridge` already owns.
 */
const KNOWN_LAYOUT_TOOL_NAMES: readonly string[] = [
  ...READ_TOOL_NAMES,
  ...MUTATION_TOOL_NAMES,
];

export async function handleBridgeRequest(
  req: BridgeRequest,
  adapter: DockviewAdapter,
  sessionTools?: SessionToolDeps,
): Promise<BridgeResponse> {
  try {
    if (KNOWN_LAYOUT_TOOL_NAMES.includes(req.tool)) {
      return handleLayoutRequest(req, adapter);
    }

    if (isRegisteredSessionTool(req.tool)) {
      if (!sessionTools) return sessionToolsUnavailable(req);
      // Awaited INSIDE this try, not merely returned — a bare `return
      // handleSessionRequest(...)` returns a pending promise without
      // ever entering this function's own catch scope if that promise
      // later rejects; the rejection would instead surface at whatever
      // call site awaits `handleBridgeRequest`, unsanitized. Awaiting
      // here is what makes this function's own try/catch — and its
      // sanitized `transportError(...)` fallback — actually cover an
      // async rejection from the session-tool path, not just a
      // synchronous throw.
      return await handleSessionRequest(req, sessionTools);
    }

    return unknownTool(req);
  } catch {
    // An exception ESCAPING routing/domain-handling itself — a bug in
    // this codebase's own dependency wiring (e.g. a store getter that
    // throws outside `runSessionTool`'s own try/catch scope), not a
    // handler-reported failure. Routing already committed to invoking a
    // domain handler by this point, so this can never be proven
    // `not_sent` — mirrors `src/ide/executor.ts`'s post-handler-failure
    // classification. Never leaks raw exception text.
    return transportError(
      req.seq,
      "internal_error",
      "An internal error occurred.",
      "indeterminate",
    );
  }
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
    sessionTools,
  } = {
    ...defaultDeps,
    ...deps,
  };

  let closed = false;
  let socket: WsLike | undefined;
  /** Monotonic identity for the currently-connected socket. Bumped every
   * time a NEW socket is created (initial connect or reconnect) so an
   * in-flight async response computed against a PRIOR socket generation
   * can be detected and dropped instead of written to whatever socket
   * happens to be current when it finally resolves — mirrors
   * `sidecar/ide-server/ws-bridge.ts`'s own generation tracking on the
   * server side of this same protocol. */
  let generation = 0;

  function scheduleReconnect(): void {
    if (closed) return;
    setTimeout(() => {
      if (!closed) void connect();
    }, reconnectDelayMs);
  }

  /** Sends `response` on `ws` ONLY if `ws` is still the current socket
   * (by generation) and the bridge hasn't been closed — never writes a
   * stale response to a socket that has since closed/reconnected, and
   * never throws even if the underlying `send` does (the throw is
   * swallowed: there is no useful recovery action for a webview-side
   * send failure beyond not crashing the message-handling call stack). */
  function sendIfCurrent(
    ws: WsLike,
    ownGeneration: number,
    response: BridgeResponse,
  ): void {
    if (closed || socket !== ws || generation !== ownGeneration) return;
    try {
      ws.send(JSON.stringify(response));
    } catch {
      // Deliberately swallowed — a send failure here has no in-band
      // recovery path (the caller that originated the request already
      // moved on; there is nothing to retry against). Never let a send
      // throw escape into an unhandled rejection from within an
      // `onmessage` handler.
    }
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
    // Re-check `closed` after the awaited call — the bridge may have
    // been closed WHILE `getBridgeInfo` was pending; without this check
    // a shutdown-race would still create and leak a socket no one is
    // going to close.
    if (closed) return;

    const ws = createSocket(`ws://127.0.0.1:${info.port}/ws`);
    // A second shutdown race: `createSocket` itself is synchronous, but
    // re-check once more before committing `ws` as the current socket —
    // if `close()` ran on the microtask boundary between the two awaits
    // above and this line, close the JUST-CREATED socket immediately
    // rather than adopting it as current.
    if (closed) {
      ws.close();
      return;
    }
    socket = ws;
    generation += 1;
    const ownGeneration = generation;

    ws.onopen = () => {
      const auth: BridgeMessage = {
        kind: "auth",
        token: info.token,
      };
      ws.send(JSON.stringify(auth));
    };

    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        // Malformed JSON entirely — no seq is extractable at all, so
        // this frame is deliberately ignored rather than guessing a seq
        // to respond with.
        return;
      }

      // A raw, best-effort seq extraction used ONLY to decide whether a
      // malformed-but-JSON-parseable frame deserves a transport error
      // reply — the real validation is `bridgeRequestSchema.safeParse`
      // below; this never trusts `parsed` as a `BridgeRequest` via a
      // cast.
      const rawSeq = (parsed as { seq?: unknown } | null)?.seq;
      const hasSafeSeq =
        typeof rawSeq === "number" &&
        Number.isFinite(rawSeq) &&
        Number.isInteger(rawSeq) &&
        rawSeq >= 0;

      const validated = bridgeRequestSchema.safeParse(parsed);
      if (!validated.success) {
        // A frame that parses as JSON but doesn't match the real request
        // shape (missing `tool`, wrong `kind`, etc): reply with exactly
        // one stable transport error ONLY if a safe numeric seq could be
        // extracted — otherwise there is no seq to correlate a reply to,
        // and the frame is deliberately ignored (no reply at all), never
        // closing or guessing.
        if (hasSafeSeq) {
          sendIfCurrent(
            ws,
            ownGeneration,
            transportError(
              rawSeq as number,
              "invalid_request",
              "The given request is invalid.",
              "not_sent",
            ),
          );
        }
        return;
      }
      if (validated.data.kind !== "request") return;

      const req: BridgeRequest = validated.data;
      void handleBridgeRequest(req, adapter, sessionTools)
        .then((response) => {
          sendIfCurrent(ws, ownGeneration, response);
        })
        .catch(() => {
          // handleBridgeRequest itself never rejects (it has its own
          // top-level try/catch) — this is defense-in-depth against a
          // future regression reintroducing an unhandled rejection here.
          sendIfCurrent(
            ws,
            ownGeneration,
            transportError(
              req.seq,
              "internal_error",
              "An internal error occurred.",
              "indeterminate",
            ),
          );
        });
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

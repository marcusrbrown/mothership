/**
 * Fetch-based SSE reader for `GET /event?directory=<dir>`.
 *
 * v0.6.0 MANAGED servers require Basic auth, and native `EventSource`
 * cannot set an `Authorization` header — so this hand-rolls SSE parsing on
 * top of `fetch`'s streaming `response.body`, letting us send credentials.
 * `directory` still goes in the query string (matching the server SDK's
 * own GET rewrite — see client.ts); auth (when present) goes in a Basic
 * `Authorization` header.
 *
 * Every frame is zod-parsed through `sseEventSchema`; malformed frames are
 * skipped and logged, never kill the stream (open-union SSE posture from
 * Key Technical Decisions).
 *
 * Per the live-verified contract
 * (docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md):
 * the protocol-level `id:` field is ABSENT on the wire, so literal
 * `Last-Event-ID` resume is not available. Every (re)connect — including
 * the very first connect — fires `onReconcile`, and the consumer is
 * expected to pull full state (session-store.reconcile) rather than trust
 * any delta accumulated before the reconnect. This is the safety net, not
 * an optimization.
 */
import { type SseEvent, sseEventSchema } from "./types";

export type SseConnectionState = "connecting" | "open" | "reconnecting";

export interface SseCredentials {
  username?: string;
  password?: string;
}

export interface SseClientOptions {
  baseUrl: string;
  directory: string;
  onEvent: (event: SseEvent) => void;
  /** Fired on every (re)connect — including the first — before any events
   * for that connection are guaranteed to have arrived. Consumer should run
   * a full-state reconciliation here. */
  onReconcile: () => void;
  onStateChange?: (state: SseConnectionState) => void;
  /** Basic auth credentials for the managed server. When `password` is
   * absent, no `Authorization` header is sent (unauthenticated
   * externally-managed / virtual servers keep working unchanged). */
  credentials?: SseCredentials;
  /** Injectable fetch, defaults to the global. Used for tests. */
  fetchImpl?: typeof fetch;
  /** Initial backoff in ms before the first reconnect attempt. Defaults to 1000. */
  initialBackoffMs?: number;
  /** Backoff cap in ms. Defaults to 10000. */
  maxBackoffMs?: number;
}

export interface SseClient {
  readonly state: SseConnectionState;
  close(): void;
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader(
  credentials: SseCredentials | undefined,
): Record<string, string> {
  if (!credentials?.password) return {};
  const username = credentials.username ?? "opencode";
  return {
    Authorization: `Basic ${toBase64(`${username}:${credentials.password}`)}`,
  };
}

/**
 * Connects to `/event` via a streamed `fetch`. Reconnects on stream
 * end/error with capped exponential backoff. Never throws — parse failures
 * and connection errors are logged (console.warn) and handled internally.
 */
export function connectSse(options: SseClientOptions): SseClient {
  const {
    baseUrl,
    directory,
    onEvent,
    onReconcile,
    onStateChange,
    credentials,
    fetchImpl = globalThis.fetch,
    initialBackoffMs = 1000,
    maxBackoffMs = 10_000,
  } = options;

  let state: SseConnectionState = "connecting";
  let closed = false;
  let backoffMs = initialBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let abortController: AbortController | undefined;

  function setState(next: SseConnectionState) {
    state = next;
    onStateChange?.(next);
  }

  function url(): string {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}/event${separator}directory=${encodeURIComponent(directory)}`;
  }

  function scheduleReconnect() {
    if (closed) return;
    setState("reconnecting");
    reconnectTimer = setTimeout(() => {
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      void open();
    }, backoffMs);
  }

  function handleMessage(raw: string) {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.warn("[sse] failed to JSON-parse frame", e);
      return;
    }
    const parsed = sseEventSchema.safeParse(data);
    if (!parsed.success) {
      console.warn(
        "[sse] frame failed schema validation, skipping",
        parsed.error,
      );
      return;
    }
    onEvent(parsed.data);
  }

  /** Splits an SSE stream buffer into `data:` payloads. Frames are
   * separated by a blank line (`\n\n`); within a frame, lines other than
   * `data:` (e.g. `event:`, `id:` — absent on this server's wire, but kept
   * generic) are ignored, and multiple `data:` lines are joined per the
   * SSE spec. */
  function extractFrames(buffer: string): { frames: string[]; rest: string } {
    const parts = buffer.split("\n\n");
    const rest = parts.pop() ?? "";
    const frames: string[] = [];
    for (const part of parts) {
      const dataLines = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
      if (dataLines.length > 0) frames.push(dataLines.join("\n"));
    }
    return { frames, rest };
  }

  async function open() {
    if (closed) return;
    if (!fetchImpl) {
      console.warn("[sse] no fetch implementation available");
      return;
    }
    setState(state === "connecting" ? "connecting" : "reconnecting");

    abortController = new AbortController();
    const signal = abortController.signal;

    let response: Response;
    try {
      response = await fetchImpl(url(), {
        headers: { ...authHeader(credentials), Accept: "text/event-stream" },
        signal,
      });
    } catch (e) {
      if (closed) return;
      console.warn("[sse] connection failed", e);
      scheduleReconnect();
      return;
    }

    if (closed) return;

    if (!response.ok || !response.body) {
      console.warn(`[sse] unexpected response status ${response.status}`);
      scheduleReconnect();
      return;
    }

    backoffMs = initialBackoffMs;
    setState("open");
    // Every (re)connect — first connect included — triggers full
    // reconciliation. The `id:`-absent gap means deltas across any gap
    // (including this one) can never be trusted.
    onReconcile();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = extractFrames(buffer);
        buffer = rest;
        for (const frame of frames) handleMessage(frame);
      }
    } catch (e) {
      if (closed) return;
      console.warn("[sse] stream read failed", e);
    }

    if (closed) return;
    scheduleReconnect();
  }

  void open();

  return {
    get state() {
      return state;
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abortController?.abort();
      setState("reconnecting");
    },
  };
}

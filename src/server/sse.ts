/**
 * Native `EventSource` wrapper for `GET /event?directory=<dir>`.
 *
 * `EventSource` can't set headers, so `directory` goes in the query string
 * (matching the server SDK's own GET rewrite — see client.ts). Every frame
 * is zod-parsed through `sseEventSchema`; malformed frames are skipped and
 * logged, never kill the stream (open-union SSE posture from Key Technical
 * Decisions).
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

export interface SseClientOptions {
  baseUrl: string;
  directory: string;
  onEvent: (event: SseEvent) => void;
  /** Fired on every (re)connect — including the first — before any events
   * for that connection are guaranteed to have arrived. Consumer should run
   * a full-state reconciliation here. */
  onReconcile: () => void;
  onStateChange?: (state: SseConnectionState) => void;
  /** Injectable EventSource constructor, defaults to the global. Used for tests. */
  EventSourceImpl?: typeof EventSource;
  /** Initial backoff in ms before the first reconnect attempt. Defaults to 1000. */
  initialBackoffMs?: number;
  /** Backoff cap in ms. Defaults to 10000. */
  maxBackoffMs?: number;
}

export interface SseClient {
  readonly state: SseConnectionState;
  close(): void;
}

/**
 * Connects to `/event`. Reconnects on error/close with capped exponential
 * backoff. Never throws — parse failures and connection errors are logged
 * (console.warn) and handled internally.
 */
export function connectSse(options: SseClientOptions): SseClient {
  const {
    baseUrl,
    directory,
    onEvent,
    onReconcile,
    onStateChange,
    EventSourceImpl = globalThis.EventSource,
    initialBackoffMs = 1000,
    maxBackoffMs = 10_000,
  } = options;

  let state: SseConnectionState = "connecting";
  let source: EventSource | undefined;
  let closed = false;
  let backoffMs = initialBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
      open();
    }, backoffMs);
  }

  function handleMessage(raw: unknown) {
    let data: unknown;
    try {
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
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

  function open() {
    if (closed) return;
    if (!EventSourceImpl) {
      console.warn("[sse] no EventSource implementation available");
      return;
    }
    setState(state === "connecting" ? "connecting" : "reconnecting");
    const es = new EventSourceImpl(url());
    source = es;

    es.onopen = () => {
      if (closed) return;
      backoffMs = initialBackoffMs;
      setState("open");
      // Every (re)connect — first connect included — triggers full
      // reconciliation. The `id:`-absent gap means deltas across any gap
      // (including this one) can never be trusted.
      onReconcile();
    };

    es.onmessage = (evt: MessageEvent) => {
      handleMessage(evt.data);
    };

    es.onerror = () => {
      if (closed) return;
      es.close();
      scheduleReconnect();
    };
  }

  open();

  return {
    get state() {
      return state;
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      source?.close();
      setState("reconnecting");
    },
  };
}

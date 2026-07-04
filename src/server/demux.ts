/**
 * Fans one `/event` stream out by `sessionID`. Pure logic, DOM-free,
 * unit-testable — no dependency on `EventSource` or fetch.
 *
 * Events whose `properties.sessionID` is present route to that session's
 * subscribers. Every event (regardless of sessionID) also reaches the
 * firehose — the roster/session-store's session-lifecycle listener. Unknown
 * `type` strings are logged (not thrown); malformed frames (missing/wrong
 * shaped `properties`) are skipped without killing dispatch to other
 * subscribers.
 */
import type { SseEvent } from "./types";

export type DemuxListener = (event: SseEvent) => void;

/** Event types with no natural per-session home — always land on the
 * firehose, never require a matching per-session subscriber to be useful. */
const LIFECYCLE_EVENT_TYPES = new Set([
  "server.connected",
  "server.heartbeat",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "question.asked",
  "question.replied",
  "question.rejected",
]);

export interface Demux {
  /** Subscribe to events for a specific sessionID (from `properties.sessionID`). */
  subscribe(sessionID: string, listener: DemuxListener): () => void;
  /** Subscribe to every event, regardless of sessionID (roster/session-store feed). */
  subscribeFirehose(listener: DemuxListener): () => void;
  /** Feed one raw (already zod-parsed) SSE event into the demux. */
  dispatch(event: SseEvent): void;
}

function extractSessionID(event: SseEvent): string | undefined {
  const props = event.properties;
  if (props === null || typeof props !== "object") return undefined;
  const sessionID = (props as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" ? sessionID : undefined;
}

export function createDemux(): Demux {
  const perSession = new Map<string, Set<DemuxListener>>();
  const firehose = new Set<DemuxListener>();

  return {
    subscribe(sessionID, listener) {
      let set = perSession.get(sessionID);
      if (!set) {
        set = new Set();
        perSession.set(sessionID, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
        if (set && set.size === 0) perSession.delete(sessionID);
      };
    },

    subscribeFirehose(listener) {
      firehose.add(listener);
      return () => firehose.delete(listener);
    },

    dispatch(event) {
      if (!event || typeof event.type !== "string") {
        console.warn("[demux] malformed event, skipping", event);
        return;
      }

      if (!LIFECYCLE_EVENT_TYPES.has(event.type)) {
        // Open-union posture: unknown type strings are logged, never
        // thrown. Still fanned out — a future-known type shouldn't be
        // silently dropped just because this build doesn't recognize it.
        console.info("[demux] unrecognized event type", event.type);
      }

      for (const listener of firehose) listener(event);

      const sessionID = extractSessionID(event);
      if (sessionID !== undefined) {
        const set = perSession.get(sessionID);
        if (set) {
          for (const listener of set) listener(event);
        }
      }
    },
  };
}

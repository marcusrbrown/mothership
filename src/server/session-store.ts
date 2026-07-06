/**
 * Reconcilable session store. Accumulates authoritative per-project session
 * state from two sources:
 *
 * 1. `applyEvent()` — incremental updates from the demux firehose
 *    (`session.created/updated/deleted`, `session.status`, `session.idle`,
 *    `question.asked`/`question.replied`/`question.rejected`).
 * 2. `reconcile()` — full-state replacement from `listSessions()` +
 *    `getSessionStatus()` + `listQuestions()`, run on every SSE (re)connect.
 *    `reconcile()` is the authority — any session present before but absent
 *    from a reconcile call is removed.
 *
 * Pure logic, DOM-free, fully unit-testable.
 */
import type {
  MessageList,
  QuestionList,
  SessionList,
  SessionStatusMap,
  SseEvent,
} from "./types";

export type SessionBusyState = "busy" | "idle" | "unknown";

export interface StoredSession {
  id: string;
  directory?: string;
  title?: string;
  status: SessionBusyState;
  /** Server-side recency timestamp (epoch ms), read from the loosely-typed
   * `time.updated`/`time.created` fields (untyped on the static session/event
   * types). Basis for "most recent session" — NOT store insertion order. */
  updatedAt?: number;
  /** Server-side creation timestamp (epoch ms), same caveats as `updatedAt`. */
  createdAt?: number;
  /** Parent session's id, present on subagent/child sessions (loosely-typed
   * `parentID` field). Primary signal for subagent detection in
   * `sessions-view.ts`'s `isSubagentSession`; the title-suffix regex is
   * only a fallback for payloads/fixtures lacking this field. */
  parentID?: string;
}

export interface StoredQuestion {
  requestID: string;
  sessionID: string;
  questions: QuestionList[number]["questions"];
}

export interface SessionStoreSnapshot {
  sessions: StoredSession[];
  pendingQuestions: StoredQuestion[];
}

export type SessionStoreListener = (snapshot: SessionStoreSnapshot) => void;

export interface ReconcileInput {
  /** Project directory this reconcile pass covers. Sessions previously
   * recorded for this directory but absent from `sessions` are removed. */
  directory: string;
  sessions: SessionList;
  statuses?: SessionStatusMap;
  questions?: QuestionList;
}

export interface SessionStore {
  getSessions(directory?: string): StoredSession[];
  getSession(id: string): StoredSession | undefined;
  getPendingQuestions(sessionID?: string): StoredQuestion[];
  subscribe(listener: SessionStoreListener): () => void;
  applyEvent(event: SseEvent): void;
  reconcile(input: ReconcileInput): void;
}

function statusTypeToBusyState(type: string | undefined): SessionBusyState {
  if (type === undefined) return "unknown";
  if (type === "idle") return "idle";
  // Unrecognized non-idle types default to "busy" rather than hiding activity.
  return "busy";
}

function propsOf(event: SseEvent): Record<string, unknown> {
  const props = event.properties;
  return props !== null && typeof props === "object"
    ? (props as Record<string, unknown>)
    : {};
}

/** `session.created`/`session.updated`/`session.deleted` nest the session
 * under `properties.info` (`EventSessionCreated`: `{ properties: { info:
 * Session } }`), not flat on `properties`. Falls back to `props` itself
 * when `info` is absent, for flat-shape fixture payloads. */
function sessionFieldsOf(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const info = props.info;
  return info !== null && typeof info === "object"
    ? (info as Record<string, unknown>)
    : props;
}

/** `session.status` nests the busy-state type under `properties.status.type`
 * (`EventSessionStatus`), not a flat `properties.type`. Falls back to the
 * flat field for flat-shape fixtures. */
function statusTypeOf(props: Record<string, unknown>): string | undefined {
  const status = props.status;
  if (status !== null && typeof status === "object") {
    const nested = str((status as Record<string, unknown>).type);
    if (nested) return nested;
  }
  return str(props.type);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Narrow accessor for the `time.updated`/`time.created` fields (present at
 * runtime, untyped statically). Reads defensively: unexpected shapes yield
 * `undefined` rather than throwing. */
function timeFieldsOf(raw: unknown): { updated?: number; created?: number } {
  if (raw === null || typeof raw !== "object") return {};
  const time = (raw as { time?: unknown }).time;
  if (time === null || typeof time !== "object") return {};
  const t = time as { updated?: unknown; created?: unknown };
  return { updated: num(t.updated), created: num(t.created) };
}

/** Narrow accessor for the `parentID` field (stamped on subagent/child
 * sessions, present at runtime, untyped statically). */
function parentIdOf(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  return str((raw as { parentID?: unknown }).parentID);
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, StoredSession>();
  // sessionID -> directory, tracked separately so reconcile() can scope
  // removal to sessions belonging to the directory being reconciled.
  const sessionDirectory = new Map<string, string>();
  const pendingQuestions = new Map<string, StoredQuestion>(); // keyed by requestID
  const listeners = new Set<SessionStoreListener>();

  function snapshot(): SessionStoreSnapshot {
    return {
      sessions: [...sessions.values()],
      pendingQuestions: [...pendingQuestions.values()],
    };
  }

  function notify(): void {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
  }

  function upsertSession(partial: {
    id: string;
    directory?: string;
    title?: string;
    status?: SessionBusyState;
    updatedAt?: number;
    createdAt?: number;
    parentID?: string;
  }): void {
    const existing = sessions.get(partial.id);
    const merged: StoredSession = {
      id: partial.id,
      directory: partial.directory ?? existing?.directory,
      title: partial.title ?? existing?.title,
      status: partial.status ?? existing?.status ?? "unknown",
      updatedAt: partial.updatedAt ?? existing?.updatedAt,
      createdAt: partial.createdAt ?? existing?.createdAt,
      parentID: partial.parentID ?? existing?.parentID,
    };
    sessions.set(partial.id, merged);
    if (merged.directory) sessionDirectory.set(partial.id, merged.directory);
  }

  function removeSession(id: string): void {
    sessions.delete(id);
    sessionDirectory.delete(id);
    for (const [requestID, q] of pendingQuestions) {
      if (q.sessionID === id) pendingQuestions.delete(requestID);
    }
  }

  return {
    getSessions(directory) {
      const all = [...sessions.values()];
      if (directory === undefined) return all;
      return all.filter((s) => s.directory === directory);
    },

    getSession(id) {
      return sessions.get(id);
    },

    getPendingQuestions(sessionID) {
      const all = [...pendingQuestions.values()];
      if (sessionID === undefined) return all;
      return all.filter((q) => q.sessionID === sessionID);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    applyEvent(event) {
      const props = propsOf(event);

      switch (event.type) {
        case "session.created":
        case "session.updated": {
          const fields = sessionFieldsOf(props);
          const id = str(fields.id) ?? str(fields.sessionID);
          if (!id) return;
          const time = timeFieldsOf(fields);
          upsertSession({
            id,
            directory: str(fields.directory),
            title: str(fields.title),
            updatedAt: time.updated ?? time.created,
            createdAt: time.created,
            parentID: parentIdOf(fields),
          });
          notify();
          return;
        }

        case "session.deleted": {
          const fields = sessionFieldsOf(props);
          const id = str(fields.id) ?? str(fields.sessionID);
          if (!id) return;
          removeSession(id);
          notify();
          return;
        }

        case "session.status": {
          const sessionID = str(props.sessionID) ?? str(props.id);
          if (!sessionID) return;
          // Updates only — an unknown session id no-ops rather than
          // upserting a directory-less zombie.
          if (!sessions.has(sessionID)) return;
          const time = timeFieldsOf(props);
          upsertSession({
            id: sessionID,
            status: statusTypeToBusyState(statusTypeOf(props)),
            updatedAt: time.updated,
          });
          notify();
          return;
        }

        case "session.idle": {
          const sessionID = str(props.sessionID) ?? str(props.id);
          if (!sessionID) return;
          if (!sessions.has(sessionID)) return;
          const time = timeFieldsOf(props);
          upsertSession({
            id: sessionID,
            status: "idle",
            updatedAt: time.updated,
          });
          notify();
          return;
        }

        case "question.asked": {
          const requestID = str(props.id);
          const sessionID = str(props.sessionID);
          if (!requestID || !sessionID) return;
          pendingQuestions.set(requestID, {
            requestID,
            sessionID,
            questions:
              (props.questions as QuestionList[number]["questions"]) ??
              undefined,
          });
          notify();
          return;
        }

        case "question.replied":
        case "question.rejected": {
          const requestID = str(props.requestID) ?? str(props.id);
          if (requestID) pendingQuestions.delete(requestID);
          notify();
          return;
        }

        default:
          // Open union: unrecognized event types are simply ignored by the
          // store (demux already logs them). No throw.
          return;
      }
    },

    reconcile(input) {
      const { directory, sessions: incoming, statuses, questions } = input;

      // Remove sessions previously attributed to this directory that are
      // absent from the incoming authoritative set.
      const incomingIds = new Set(incoming.map((s) => s.id));
      for (const [id, dir] of sessionDirectory) {
        if (dir === directory && !incomingIds.has(id)) {
          removeSession(id);
        }
      }

      for (const s of incoming) {
        const statusEntry = statuses?.[s.id];
        const time = timeFieldsOf(s);
        upsertSession({
          id: s.id,
          directory: s.directory ?? directory,
          title: s.title,
          status: statusEntry
            ? statusTypeToBusyState(statusEntry.type)
            : undefined,
          updatedAt: time.updated ?? time.created,
          createdAt: time.created,
          parentID: parentIdOf(s),
        });
      }

      if (questions) {
        // Reconcile replaces the pending-question set for sessions in this
        // directory: drop stale entries for sessions we just reconciled,
        // then repopulate from the authoritative list.
        for (const [requestID, q] of pendingQuestions) {
          if (incomingIds.has(q.sessionID)) pendingQuestions.delete(requestID);
        }
        for (const q of questions) {
          pendingQuestions.set(q.id, {
            requestID: q.id,
            sessionID: q.sessionID,
            questions: q.questions,
          });
        }
      }

      notify();
    },
  };
}

/** Re-exported for panels that need the raw message-list type without a
 * direct dependency on ./types (keeps import surfaces narrow). */
export type { MessageList };

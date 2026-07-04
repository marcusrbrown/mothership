/**
 * Reconcilable session store — the fix for the space-bus `/core` session-
 * listing gap (no per-session listing, only project aggregates +
 * pendingQuestions). Accumulates authoritative per-project session state
 * from two sources:
 *
 * 1. `applyEvent()` — incremental updates from the demux firehose
 *    (`session.created/updated/deleted`, `session.status`, `session.idle`,
 *    `question.asked`/`question.replied`/`question.rejected`).
 * 2. `reconcile()` — full-state replacement from `listSessions()` +
 *    `getSessionStatus()` + `listQuestions()`, run on every SSE (re)connect
 *    per the SSE contract facts doc: the wire has no `id:` field, so deltas
 *    are never trusted across a reconnect gap. `reconcile()` is the
 *    authority — any session present before but absent from a reconcile
 *    call is removed.
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
  // Any non-idle known status type (e.g. "busy", "running") counts as busy;
  // unrecognized types default conservatively to "busy" rather than
  // silently hiding activity.
  return "busy";
}

function propsOf(event: SseEvent): Record<string, unknown> {
  const props = event.properties;
  return props !== null && typeof props === "object"
    ? (props as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  }): void {
    const existing = sessions.get(partial.id);
    const merged: StoredSession = {
      id: partial.id,
      directory: partial.directory ?? existing?.directory,
      title: partial.title ?? existing?.title,
      status: partial.status ?? existing?.status ?? "unknown",
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
          const id = str(props.id) ?? str(props.sessionID);
          if (!id) return;
          upsertSession({
            id,
            directory: str(props.directory),
            title: str(props.title),
          });
          notify();
          return;
        }

        case "session.deleted": {
          const id = str(props.id) ?? str(props.sessionID);
          if (!id) return;
          removeSession(id);
          notify();
          return;
        }

        case "session.status": {
          const sessionID = str(props.sessionID) ?? str(props.id);
          if (!sessionID) return;
          upsertSession({
            id: sessionID,
            status: statusTypeToBusyState(str(props.type)),
          });
          notify();
          return;
        }

        case "session.idle": {
          const sessionID = str(props.sessionID) ?? str(props.id);
          if (!sessionID) return;
          upsertSession({ id: sessionID, status: "idle" });
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
        upsertSession({
          id: s.id,
          directory: s.directory ?? directory,
          title: s.title,
          status: statusEntry
            ? statusTypeToBusyState(statusEntry.type)
            : undefined,
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

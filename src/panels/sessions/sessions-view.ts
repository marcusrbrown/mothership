/**
 * DOM-free view logic for the sessions panel.
 *
 * U1.3 fix: previously this rendered only the partial view `snapshot()`
 * exposes (pendingQuestions). Now it renders the full per-project session
 * list from `session-store.ts`, which is reconciled from `listSessions()` +
 * `getSessionStatus()` + `listQuestions()` on every SSE (re)connect and
 * kept live via `applyEvent()`. `SessionRow.needsAttention` drives the
 * magenta needs-attention marker (shared with the roster badge).
 */
import type { StoredSession } from "../../server/session-store";

export interface SessionRow {
  id: string;
  title: string;
  busy: boolean;
  needsAttention: boolean;
}

export type SessionsViewState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: SessionRow[] };

/** Derives session rows for a project from the store's session list plus
 * the set of sessionIDs with at least one pending question. */
export function toSessionRows(
  sessions: StoredSession[],
  pendingSessionIds: ReadonlySet<string>,
): SessionRow[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title ?? s.id,
    busy: s.status === "busy",
    needsAttention: pendingSessionIds.has(s.id),
  }));
}

export function toSessionsViewState(
  result:
    | {
        ok: true;
        sessions: StoredSession[];
        pendingSessionIds: ReadonlySet<string>;
      }
    | { ok: false; error: string },
): SessionsViewState {
  if (!result.ok) return { status: "error", message: result.error };
  const rows = toSessionRows(result.sessions, result.pendingSessionIds);
  if (rows.length === 0) return { status: "empty" };
  return { status: "ready", rows };
}

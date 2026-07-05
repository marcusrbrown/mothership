/**
 * DOM-free view logic for the sessions panel.
 *
 * Renders the full per-project session list from `session-store.ts`,
 * not just the partial view `snapshot()` exposes (pendingQuestions).
 * The list is reconciled from `listSessions()` +
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
 * the set of sessionIDs with at least one pending question, ordered
 * MOST-RECENT-FIRST (bug 210c) so a just-dispatched/continued session
 * surfaces at the top instead of buried at the bottom.
 *
 * Recency is the REAL server timestamp (`StoredSession.updatedAt`, sourced
 * from the SDK `Session.time.updated`/`time.created` fields — see
 * `session-store.ts`), not store insertion order: the server can return
 * sessions in any order, so insertion order is not a reliable recency
 * proxy. Sessions without a timestamp (older server, or not yet
 * reconciled) sink below all timestamped sessions; when timestamps are
 * equal or both absent, original (insertion) order is preserved as a
 * stable fallback. */
export function toSessionRows(
  sessions: StoredSession[],
  pendingSessionIds: ReadonlySet<string>,
): SessionRow[] {
  return sessions
    .map((s, index) => ({ s, index }))
    .sort((a, b) => {
      const at = a.s.updatedAt;
      const bt = b.s.updatedAt;
      if (at !== undefined && bt !== undefined) {
        if (at !== bt) return bt - at;
        return a.index - b.index; // stable
      }
      if (at !== undefined) return -1; // timestamped sinks above unknown
      if (bt !== undefined) return 1;
      return a.index - b.index; // both unknown -> stable insertion order
    })
    .map(({ s }) => ({
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

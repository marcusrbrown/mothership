/**
 * DOM-free view logic for the sessions panel.
 *
 * GAP: `src/server/bus` (the space-bus /core facade) has no session-listing
 * call — `roster`/`snapshot` return only project-level aggregates
 * (`busyCount`/`sessionCount`), and `status(sessionId)` needs an id you
 * already have. The only session-shaped data snapshot() exposes is
 * `pendingQuestions: {sessionId, preview, options}[]` (sessions currently
 * blocked on a question). This module renders that partial view and is
 * built so a real per-project session list (once the facade gains one, or
 * once U1.3's SSE reconciliation accumulates session ids) drops in without
 * a panel rewrite — see `SessionRow`'s shape.
 */
import type { SnapshotProject } from "../../server/bus";

export interface SessionRow {
  id: string;
  title: string;
  /** True when the session is blocked on a pending question (the only
   * per-session signal available from snapshot() today). */
  busy: boolean;
}

export type SessionsViewState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: SessionRow[] };

/** Derives the (partial) session list for a project from its snapshot entry. */
export function toSessionRows(
  project: SnapshotProject | undefined,
): SessionRow[] {
  if (!project?.pendingQuestions) return [];
  return project.pendingQuestions.map((q) => ({
    id: q.sessionId,
    title: q.preview,
    busy: true,
  }));
}

export function toSessionsViewState(
  result:
    | { ok: true; project: SnapshotProject | undefined }
    | { ok: false; error: string },
): SessionsViewState {
  if (!result.ok) return { status: "error", message: result.error };
  const rows = toSessionRows(result.project);
  if (rows.length === 0) return { status: "empty" };
  return { status: "ready", rows };
}

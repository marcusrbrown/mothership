/**
 * DOM-free view logic for the roster panel — plain data transforms so the
 * loading/empty/error/row-state derivation is testable without React or a
 * DOM. `RosterPanel.tsx` is a thin renderer over this module.
 */
import type { SnapshotProject } from "../../server/bus";

export type RosterRowState =
  | {
      kind: "ok";
      project: SnapshotProject;
      busy: boolean;
      needsAttention: boolean;
      active: boolean;
    }
  | { kind: "missing-path"; project: SnapshotProject; active: boolean }
  | {
      kind: "status-error";
      project: SnapshotProject;
      error: string;
      active: boolean;
    };

export type RosterViewState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: RosterRowState[] };

/** Derives per-project row state from a snapshot's projects. Isolates a
 * single project's `error` field to a `status-error` row without failing
 * the rest of the roster (per-project error isolation).
 * `needsAttention` is true when the session-store reports at least one
 * pending question for this project — drives the magenta emphasis badge.
 * `active` (issue 3 fix) is true when this project's directory is the one
 * the operator is currently viewing/dispatched to — drives the cyan
 * `--color-accent` highlight border, matching the sessions-view active-row
 * treatment (`SessionsPanel.tsx`'s `activeSessionId` highlight). NOTE:
 * `SnapshotProject.path` carries the EXPANDED path despite its name —
 * space-bus's `fetchSnapshotProject` assigns it `p.expandedPath` — so a
 * plain string-equals against the caller's directory (also always
 * expanded, e.g. `ActiveSessionRef.directory`) is correct. */
export function toRosterRow(
  project: SnapshotProject,
  needsAttention = false,
  active = false,
): RosterRowState {
  if (!project.exists) return { kind: "missing-path", project, active };
  if (project.error) {
    return { kind: "status-error", project, error: project.error, active };
  }
  return {
    kind: "ok",
    project,
    busy: (project.busyCount ?? 0) > 0,
    needsAttention,
    active,
  };
}

/** Builds the full view state from a snapshot result (or a fetch-level error).
 * `projectsNeedingAttention` lists projects with at least one
 * pending question in the session store — optional so this stays callable
 * without a session store wired up. `activeDirectory` (issue 3 fix) is the
 * expanded-path directory of the project currently active (viewed or
 * dispatched to) — optional so callers with no active-session concept
 * (or no selection yet) degrade to no row highlighted, never an error. */
export function toRosterViewState(
  result:
    | { ok: true; projects: SnapshotProject[] }
    | { ok: false; error: string },
  projectsNeedingAttention: ReadonlySet<string> = new Set(),
  activeDirectory?: string,
): RosterViewState {
  if (!result.ok) return { status: "error", message: result.error };
  if (result.projects.length === 0) return { status: "empty" };
  return {
    status: "ready",
    rows: result.projects.map((p) =>
      toRosterRow(
        p,
        projectsNeedingAttention.has(p.name),
        activeDirectory !== undefined && p.path === activeDirectory,
      ),
    ),
  };
}

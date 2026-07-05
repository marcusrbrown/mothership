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
    }
  | { kind: "missing-path"; project: SnapshotProject }
  | { kind: "status-error"; project: SnapshotProject; error: string };

export type RosterViewState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: RosterRowState[] };

/** Derives per-project row state from a snapshot's projects. Isolates a
 * single project's `error` field to a `status-error` row without failing
 * the rest of the roster (per-project error isolation).
 * `needsAttention` is true when the session-store reports at least one
 * pending question for this project — drives the magenta emphasis badge. */
export function toRosterRow(
  project: SnapshotProject,
  needsAttention = false,
): RosterRowState {
  if (!project.exists) return { kind: "missing-path", project };
  if (project.error) {
    return { kind: "status-error", project, error: project.error };
  }
  return {
    kind: "ok",
    project,
    busy: (project.busyCount ?? 0) > 0,
    needsAttention,
  };
}

/** Builds the full view state from a snapshot result (or a fetch-level error).
 * `projectsNeedingAttention` lists projects with at least one
 * pending question in the session store — optional so this stays callable
 * without a session store wired up. */
export function toRosterViewState(
  result:
    | { ok: true; projects: SnapshotProject[] }
    | { ok: false; error: string },
  projectsNeedingAttention: ReadonlySet<string> = new Set(),
): RosterViewState {
  if (!result.ok) return { status: "error", message: result.error };
  if (result.projects.length === 0) return { status: "empty" };
  return {
    status: "ready",
    rows: result.projects.map((p) =>
      toRosterRow(p, projectsNeedingAttention.has(p.name)),
    ),
  };
}

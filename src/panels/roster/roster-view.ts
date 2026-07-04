/**
 * DOM-free view logic for the roster panel — plain data transforms so the
 * loading/empty/error/row-state derivation is testable without React or a
 * DOM. `RosterPanel.tsx` is a thin renderer over this module.
 */
import type { SnapshotProject } from "../../server/bus";

export type RosterRowState =
  | { kind: "ok"; project: SnapshotProject; busy: boolean }
  | { kind: "missing-path"; project: SnapshotProject }
  | { kind: "status-error"; project: SnapshotProject; error: string };

export type RosterViewState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: RosterRowState[] };

/** Derives per-project row state from a snapshot's projects. Isolates a
 * single project's `error` field to a `status-error` row without failing
 * the rest of the roster (per-project error isolation, U1.2b requirement). */
export function toRosterRow(project: SnapshotProject): RosterRowState {
  if (!project.exists) return { kind: "missing-path", project };
  if (project.error) {
    return { kind: "status-error", project, error: project.error };
  }
  return { kind: "ok", project, busy: (project.busyCount ?? 0) > 0 };
}

/** Builds the full view state from a snapshot result (or a fetch-level error). */
export function toRosterViewState(
  result:
    | { ok: true; projects: SnapshotProject[] }
    | { ok: false; error: string },
): RosterViewState {
  if (!result.ok) return { status: "error", message: result.error };
  if (result.projects.length === 0) return { status: "empty" };
  return { status: "ready", rows: result.projects.map(toRosterRow) };
}

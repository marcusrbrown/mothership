/**
 * DOM-free imperative focus controller for the workspace's "what's
 * currently selected" state: which project directory is scoped into the
 * sessions/roster panels, which session (if any) drives the transcript,
 * and which single directory the one live SSE stream follows. Used
 * IDENTICALLY by DockviewShell's UI click handlers and by
 * `SessionToolDeps.focus` (`ide_select_project`/`ide_select_session`) —
 * one behavior, two call sites, never two implementations that could
 * drift apart.
 *
 * Owns behavior only, not rendering: callers inject the panel-update/SSE
 * seams; this module never touches React, dockview, or the network.
 */

export interface FocusProjectTarget {
  name: string;
  directory: string;
}

export interface FocusSessionTarget {
  id: string;
  project: string;
  directory: string;
}

export interface FocusState {
  project?: string;
  sessionId?: string;
  directory?: string;
}

/** The PromptBar-facing "active session" shape — `undefined` when no
 * session is currently focused. Kept as its own named type since it's
 * the one piece of focus state a React component (PromptBar) reads
 * directly, rather than through `getActiveContext()`. */
export type ActiveSession =
  | { sessionId: string; directory: string }
  | undefined;

/** Injected effect seams — DockviewShell wires these to real
 * `panel.api.updateParameters(...)` calls, the active-directory SSE
 * controller, and (for `updateActiveSession`) React `setActiveSession`;
 * tests wire them to plain recorders. */
export interface FocusSeams {
  updateTranscriptParams(params: {
    directory?: string;
    sessionID?: string | undefined;
  }): void;
  updateSessionsParams(params: {
    directory?: string;
    activeSessionId?: string | undefined;
  }): void;
  updateRosterParams(params: { activeDirectory?: string }): void;
  setActiveDirectory(directory: string): void;
  /** Called with the controller's new active-session value on every
   * `selectProject`/`selectSession` call — the ONE place that decides
   * "is there still an active session", so a caller (DockviewShell) never
   * needs a second, separately-maintained rule for when to clear/set its
   * own `activeSession` state. Optional so existing/test seam objects
   * that don't need it compile unchanged. */
  updateActiveSession?(session: ActiveSession): void;
}

export interface FocusController {
  /** Focuses a project: scopes the sessions panel to its directory, marks
   * the roster row active, switches the single SSE stream, and updates
   * the active logical context to `{project}`. If the newly-selected
   * project's directory differs from whatever was previously focused,
   * the active session (if any) is cleared — it belonged to a different
   * project's directory and would otherwise silently keep targeting a
   * stale session for prompt dispatch/transcript display. Re-selecting
   * the SAME directory (e.g. re-clicking the already-active project row)
   * preserves whatever session was already active. */
  selectProject(project: FocusProjectTarget): void;
  /** Focuses a session: points the transcript at it, marks it active on
   * the sessions panel, marks its owning directory active on the roster,
   * switches the single SSE stream to that directory, and updates the
   * active logical context to `{project, sessionId}`. */
  selectSession(session: FocusSessionTarget): void;
  /** Returns the current logical `{project?, sessionId?}` — read by
   * `ide_get_active_context` and by UI code that needs to know what's
   * focused right now. */
  getActiveContext(): { project?: string; sessionId?: string };
  /** Prunes `sessionId` from the active session ONLY if it is still the
   * currently-focused session (and, when `directory` is supplied, only if
   * it matches the currently-focused directory too) — a no-op otherwise,
   * so a stale/late prune notification for a session that was already
   * superseded by a newer selection can never clobber it. Keeps the
   * active PROJECT/directory untouched (this clears the session only,
   * not the whole focus): clears the transcript's `sessionID` and the
   * sessions panel's `activeSessionId` params, and reports the new
   * (session-less) active-session value via `updateActiveSession`. */
  clearSessionIfCurrent(sessionId: string, directory?: string): void;
}

/**
 * Builds a focus controller bound to `seams`. Each call to
 * `selectProject`/`selectSession` is synchronous and fully replaces the
 * in-memory state before returning — concurrent/rapid calls resolve
 * last-write-wins with no interleaving, since there is no `await`
 * between reading and writing state.
 */
export function createFocusController(seams: FocusSeams): FocusController {
  let state: FocusState = {};

  return {
    selectProject(project) {
      const switchingDirectory = state.directory !== project.directory;
      const preservedSessionId = switchingDirectory
        ? undefined
        : state.sessionId;

      state = {
        project: project.name,
        sessionId: preservedSessionId,
        directory: project.directory,
      };

      seams.updateSessionsParams({
        directory: project.directory,
        activeSessionId: preservedSessionId,
      });
      seams.updateRosterParams({ activeDirectory: project.directory });
      seams.setActiveDirectory(project.directory);
      if (switchingDirectory) {
        seams.updateTranscriptParams({
          directory: project.directory,
          sessionID: undefined,
        });
      }
      seams.updateActiveSession?.(
        preservedSessionId !== undefined
          ? { sessionId: preservedSessionId, directory: project.directory }
          : undefined,
      );
    },

    selectSession(session) {
      state = {
        project: session.project,
        sessionId: session.id,
        directory: session.directory,
      };

      seams.updateTranscriptParams({
        directory: session.directory,
        sessionID: session.id,
      });
      seams.updateSessionsParams({
        directory: session.directory,
        activeSessionId: session.id,
      });
      seams.updateRosterParams({ activeDirectory: session.directory });
      seams.setActiveDirectory(session.directory);
      seams.updateActiveSession?.({
        sessionId: session.id,
        directory: session.directory,
      });
    },

    getActiveContext() {
      return {
        ...(state.project !== undefined && { project: state.project }),
        ...(state.sessionId !== undefined && { sessionId: state.sessionId }),
      };
    },

    clearSessionIfCurrent(sessionId, directory) {
      if (state.sessionId !== sessionId) return;
      if (directory !== undefined && state.directory !== directory) return;

      state = {
        project: state.project,
        sessionId: undefined,
        directory: state.directory,
      };

      seams.updateTranscriptParams({
        directory: state.directory,
        sessionID: undefined,
      });
      seams.updateSessionsParams({
        directory: state.directory,
        activeSessionId: undefined,
      });
      seams.updateActiveSession?.(undefined);
    },
  };
}

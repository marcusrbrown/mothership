/**
 * Pure dispatch logic for the prompt bar (dispatch side): wraps
 * `@fro.bot/space-bus/core`'s `dispatch()` (re-exported from `../server/bus`)
 * to shape the discriminated `DispatchArgs` union correctly for the two
 * cases the prompt bar cares about:
 *
 * - First submit (no `sessionId`): dispatches a NEW session against the
 *   project resolved by (in order) an explicit `project` arg (the
 *   PromptBar's first @-mention, when it names a real roster project),
 *   then the workspace's first roster project as the fallback
 *   control-agent session. `DispatchArgs`' first-submit
 *   variant requires `project` and forbids `sessionId`.
 * - Follow-up submit (`sessionId` present): dispatches into the existing
 *   session (space-bus's follow-up/steering semantics) — `project` is not
 *   required once a `sessionId` is known.
 *
 * The `dispatch` core function is injectable so tests never need to stub
 * `globalThis.fetch` (the injection pattern used elsewhere in this repo,
 * e.g. `workspace/config.ts`'s `readTextFile`).
 */
import {
  type CoreOpts,
  type DispatchResult,
  type Result,
  dispatch as busDispatch,
} from "../server/bus";
import type { SessionStore } from "../server/session-store";
import type { BusContext } from "../server/types";

const CONTROL_SESSION_TITLE = "control";

export interface DispatchPromptArgs {
  context: BusContext;
  prompt: string;
  /** Present → follow-up/steer into this session. Absent → new control session. */
  sessionId?: string;
  title?: string;
  /** Explicit target project for a new session (bug-2 fix): the caller
   * (PromptBar) resolves this from the prompt's first @-project mention.
   * Ignored on the follow-up path. Falls back to `context.roster.projects[0]`
   * when absent or when it doesn't name a real roster project — a mention
   * of a project that's since disappeared from the roster degrades to the
   * default rather than erroring. */
  project?: string;
}

export interface ActiveSessionRef {
  sessionId: string;
  directory: string;
}

export interface ResolveDispatchTargetArgs {
  /** The session currently shown in the transcript (last selected or
   * dispatched), if any — the single source of truth DockviewShell keeps. */
  activeSession?: ActiveSessionRef;
  /** The resolved target project (first @-mention naming a real roster
   * project, else the workspace default). */
  targetProject: { name: string; expandedPath: string };
  /** Source of "most-recent session in a directory" (bug 210). */
  store?: SessionStore;
}

export type ResolveDispatchTargetResult =
  | { kind: "follow-up"; sessionId: string }
  | { kind: "create"; project: string };

/**
 * Resolves which session a dispatch should target (bug 210): eliminates
 * the pile-up of new "control" sessions by continuing the target
 * project's most-recent conversation instead of always creating a new
 * one. Priority:
 *
 * 1. The currently-ACTIVE session, if it belongs to the target project's
 *    directory -> follow-up into it.
 * 2. Else the MOST-RECENT session in the target project's directory (ANY
 *    title, not filtered to "control") -> follow-up into it.
 * 3. Else (zero sessions for the target project) -> create a new session.
 *
 * Pure and store-shape-only (no network) so it's unit-testable without the
 * editor.
 */
export function resolveDispatchTarget(
  args: ResolveDispatchTargetArgs,
): ResolveDispatchTargetResult {
  const { activeSession, targetProject, store } = args;

  if (activeSession && activeSession.directory === targetProject.expandedPath) {
    return { kind: "follow-up", sessionId: activeSession.sessionId };
  }

  const sessions = store?.getSessions(targetProject.expandedPath) ?? [];
  if (sessions.length > 0) {
    // Most-recent = MAX real server timestamp (StoredSession.updatedAt,
    // sourced from the SDK's `time.updated`/`time.created`), not array
    // position. Falls back to the last-in-array (insertion-order) pick
    // when no session in this directory carries a timestamp, so behavior
    // stays defined for older servers / not-yet-reconciled state.
    const timestamped = sessions.filter((s) => s.updatedAt !== undefined);
    const mostRecent =
      timestamped.length > 0
        ? timestamped.reduce((max, s) =>
            (s.updatedAt ?? 0) > (max.updatedAt ?? 0) ? s : max,
          )
        : sessions[sessions.length - 1];
    if (mostRecent) {
      return { kind: "follow-up", sessionId: mostRecent.id };
    }
  }

  return { kind: "create", project: targetProject.name };
}

export interface DispatchPromptDeps {
  dispatch?: (
    args: Parameters<typeof busDispatch>[0],
    opts: CoreOpts,
  ) => ReturnType<typeof busDispatch>;
}

/**
 * Dispatches a prompt to the workspace control-agent session: creates one
 * on the first submit, reuses it (as a follow-up) on every subsequent
 * submit for which a `sessionId` is passed in.
 */
export async function dispatchPrompt(
  args: DispatchPromptArgs,
  deps: DispatchPromptDeps = {},
): Promise<Result<DispatchResult>> {
  const dispatch = deps.dispatch ?? busDispatch;
  const opts: CoreOpts = { context: args.context };

  if (args.sessionId) {
    return dispatch(
      { prompt: args.prompt, title: args.title, sessionId: args.sessionId },
      opts,
    );
  }

  const requestedProject = args.project
    ? args.context.roster.projects.find((p) => p.name === args.project)?.name
    : undefined;
  const project = requestedProject ?? args.context.roster.projects[0]?.name;
  if (!project) {
    return {
      ok: false,
      error: "No project configured for the workspace control session.",
    };
  }

  return dispatch(
    {
      prompt: args.prompt,
      title: args.title ?? CONTROL_SESSION_TITLE,
      project,
    },
    opts,
  );
}

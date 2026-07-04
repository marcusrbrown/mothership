/**
 * Pure dispatch logic for the prompt bar (U1.5, F2 dispatch side): wraps
 * `@fro.bot/space-bus/core`'s `dispatch()` (re-exported from `../server/bus`)
 * to shape the discriminated `DispatchArgs` union correctly for the two
 * cases the prompt bar cares about:
 *
 * - First submit (no `sessionId`): dispatches a NEW session against the
 *   project resolved by (in order) an explicit `project` arg (bug-2 fix —
 *   the PromptBar's first @-mention, when it names a real roster project),
 *   then the workspace's first roster project as the fallback
 *   "control-agent session" per the plan. `DispatchArgs`' first-submit
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

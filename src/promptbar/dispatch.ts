/**
 * Pure dispatch logic for the prompt bar (U1.5, F2 dispatch side): wraps
 * `@fro.bot/space-bus/core`'s `dispatch()` (re-exported from `../server/bus`)
 * to shape the discriminated `DispatchArgs` union correctly for the two
 * cases the prompt bar cares about:
 *
 * - First submit (no `sessionId`): dispatches a NEW session against the
 *   workspace's first roster project — the "control-agent session" per the
 *   plan. `DispatchArgs`' first-submit variant requires `project` and
 *   forbids `sessionId`.
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

  const project = args.context.roster.projects[0]?.name;
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

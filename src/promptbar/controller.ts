/**
 * DOM-free prompt-bar state machine: owns the "current control session id"
 * seam so `dispatch.ts` can stay pure (sessionId in, result out). Mirrors
 * the sending-lock / error-preservation semantics the transcript panel's
 * answer box already establishes (see `panels/transcript/transcript-view.ts`).
 */
import { type DispatchPromptArgs, dispatchPrompt } from "./dispatch";

export interface PromptBarState {
  sessionId?: string;
  sending: boolean;
  error?: string;
}

export function initialPromptBarState(): PromptBarState {
  return { sending: false };
}

export type SubmitPromptDeps = Parameters<typeof dispatchPrompt>[1];

/**
 * Submits a prompt against the current controller state. No-ops (returns
 * the input state unchanged) for a blank/whitespace-only prompt or while
 * already sending — the caller is expected to re-render with the returned
 * state either way.
 *
 * `project`, when passed, routes a new-session dispatch (bug-2 fix): the
 * caller (PromptBar) resolves it from the prompt doc's first @-project
 * mention. Ignored once `state.sessionId` is set (follow-up path).
 */
/** Matches the space-bus error surfaced when a dispatch targets a session
 * id that no longer exists server-side (bug A, belt-and-braces layer 3):
 * "no manifest project has a session with id <id>" — deleted mid-session,
 * after the resolution-layer/DockviewShell checks already missed the
 * window. Case-insensitive, tolerant of minor wording drift around
 * "session"/"session id"/"session-not-found", AND the raw opencode server
 * error shape observed live when a follow-up `prompt_async` targets a
 * session deleted out-of-band (e.g. in the TUI):
 * `{"name":"NotFoundError","data":{"message":"Session not found: ses_..."}}`
 * — that body text is embedded verbatim in space-bus's thrown error
 * string, so matching the bare `NotFoundError` name is a second,
 * independent trigger alongside the wording-based match (belt-and-braces:
 * a future server message that drops the words "session"/"not"/"found"
 * but keeps the error name still clears the stale session). */
const SESSION_NOT_FOUND_ERROR =
  /no manifest project has a session with id|session.*not.*found|NotFoundError/i;

export async function submitPrompt(
  state: PromptBarState,
  context: DispatchPromptArgs["context"],
  prompt: string,
  deps: SubmitPromptDeps = {},
  project?: string,
): Promise<PromptBarState> {
  const trimmed = prompt.trim();
  if (!trimmed || state.sending) return state;

  const sending: PromptBarState = { ...state, sending: true, error: undefined };

  const result = await dispatchPrompt(
    { context, prompt: trimmed, sessionId: state.sessionId, project },
    deps,
  );

  if (!result.ok) {
    // Clear the remembered sessionId so the NEXT submit re-resolves fresh
    // (via resolveDispatchTarget) instead of retrying the same dead id
    // forever. The error banner still surfaces today's message unchanged.
    const clearSessionId = SESSION_NOT_FOUND_ERROR.test(result.error);
    return {
      ...sending,
      sending: false,
      error: result.error,
      sessionId: clearSessionId ? undefined : state.sessionId,
    };
  }

  return {
    ...sending,
    sending: false,
    sessionId: result.sessionId,
    error: undefined,
  };
}

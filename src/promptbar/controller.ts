/**
 * DOM-free prompt-bar state machine: owns the "current control session id"
 * seam so `dispatch.ts` can stay pure (sessionId in, result out). Mirrors
 * the sending-lock / error-preservation semantics U1.3's answer box already
 * establishes (see `panels/transcript/transcript-view.ts`).
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
 */
export async function submitPrompt(
  state: PromptBarState,
  context: DispatchPromptArgs["context"],
  prompt: string,
  deps: SubmitPromptDeps = {},
): Promise<PromptBarState> {
  const trimmed = prompt.trim();
  if (!trimmed || state.sending) return state;

  const sending: PromptBarState = { ...state, sending: true, error: undefined };

  const result = await dispatchPrompt(
    { context, prompt: trimmed, sessionId: state.sessionId },
    deps,
  );

  if (!result.ok) {
    return { ...sending, sending: false, error: result.error };
  }

  return {
    ...sending,
    sending: false,
    sessionId: result.sessionId,
    error: undefined,
  };
}

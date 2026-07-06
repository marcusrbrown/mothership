/**
 * DOM-free state machine for the transcript panel. Handles:
 * - backfill (listMessages) then live merge via `message.part.updated` events
 *   (append when `delta` is present, replace with `part.text` when absent)
 * - pending-question tracking per session (multiple independent, each with
 *   its own optimistic-lock state)
 * - `session.deleted` for the open session flips to read-only historical
 *
 * `TranscriptPanel.tsx` is a thin renderer over this module.
 */
import type { MessageList } from "../../server/types";

export interface TranscriptPart {
  id: string;
  role: string;
  type: string;
  text: string;
}

export type AnswerBoxState =
  | { status: "idle" }
  | { status: "sending"; answer: string }
  | { status: "error"; message: string; answer: string };

export interface PendingQuestionView {
  requestID: string;
  question?: string;
  options: string[];
  answerState: AnswerBoxState;
}

export type TranscriptStatus =
  | "loading"
  | "empty"
  | "error"
  | "ready"
  | "read-only";

export interface TranscriptState {
  status: TranscriptStatus;
  message?: string;
  parts: TranscriptPart[];
  pendingQuestions: PendingQuestionView[];
}

export function initialTranscriptState(): TranscriptState {
  return { status: "loading", parts: [], pendingQuestions: [] };
}

/** Converts a backfilled message list into the flat part-list the panel
 * renders. Each part gets a synthetic id (`${messageIndex}:${partIndex}`)
 * since backfilled messages carry no stable part id in this shape. */
export function fromBackfill(messages: MessageList): TranscriptState {
  const parts: TranscriptPart[] = [];
  messages.forEach((msg, msgIndex) => {
    msg.parts.forEach((part, partIndex) => {
      parts.push({
        id: `${msgIndex}:${partIndex}`,
        role: msg.info.role,
        type: part.type,
        text: part.text ?? "",
      });
    });
  });
  return {
    status: parts.length === 0 ? "empty" : "ready",
    parts,
    pendingQuestions: [],
  };
}

export function toErrorState(message: string): TranscriptState {
  return { status: "error", message, parts: [], pendingQuestions: [] };
}

export type BackfillResult =
  | { ok: true; value: MessageList }
  | { ok: false; error: { message: string } };

export type BackfillFetcher = () => Promise<BackfillResult>;

/**
 * Runs one backfill attempt against `fetchMessages`, but only returns a
 * state update if `generation` is still current by the time the fetch
 * resolves (checked via `isCurrent`). Returns `undefined` when stale —
 * callers must NOT call `setState` in that case.
 *
 * This is the ordering guard for R4: `TranscriptPanel` increments a
 * ref-counted generation before calling this, and passes a closure that
 * always reads the latest ref value. A fast A->B session switch bumps the
 * generation past A's in-flight call; if A's `listMessages` resolves after
 * B's, its result is discarded here instead of overwriting B's transcript.
 */
export async function resolveBackfill(
  fetchMessages: BackfillFetcher,
  generation: number,
  isCurrent: (generation: number) => boolean,
): Promise<TranscriptState | undefined> {
  const result = await fetchMessages();
  if (!isCurrent(generation)) return undefined;
  if (!result.ok) return toErrorState(result.error.message);
  return fromBackfill(result.value);
}

/**
 * Applies a `message.part.updated` event's payload. `delta` present ->
 * append to the existing part's text (or create it if new); `delta` absent
 * -> replace with the authoritative `part.text`.
 */
export function applyPartUpdate(
  state: TranscriptState,
  update: {
    partId: string;
    role: string;
    type: string;
    text?: string;
    delta?: string;
  },
): TranscriptState {
  if (state.status !== "ready" && state.status !== "empty") return state;

  const idx = state.parts.findIndex((p) => p.id === update.partId);
  const existing = idx >= 0 ? state.parts[idx] : undefined;

  const nextText =
    update.delta !== undefined
      ? (existing?.text ?? "") + update.delta
      : (update.text ?? existing?.text ?? "");

  const nextPart: TranscriptPart = {
    id: update.partId,
    role: update.role,
    type: update.type,
    text: nextText,
  };

  const parts =
    idx >= 0
      ? state.parts.map((p, i) => (i === idx ? nextPart : p))
      : [...state.parts, nextPart];

  return { ...state, status: "ready", parts };
}

/** Adds a pending question to the state (from `question.asked`, live or via
 * reconciliation). Independent of other pending questions for this session. */
export function addPendingQuestion(
  state: TranscriptState,
  question: { requestID: string; question?: string; options: string[] },
): TranscriptState {
  if (state.pendingQuestions.some((q) => q.requestID === question.requestID)) {
    return state;
  }
  return {
    ...state,
    pendingQuestions: [
      ...state.pendingQuestions,
      {
        requestID: question.requestID,
        question: question.question,
        options: question.options,
        answerState: { status: "idle" },
      },
    ],
  };
}

/** Removes a pending question (from `question.replied`/`question.rejected`
 * confirmation, or reconciliation dropping it). This is the event that
 * clears the optimistic lock on confirmed success. */
export function removePendingQuestion(
  state: TranscriptState,
  requestID: string,
): TranscriptState {
  return {
    ...state,
    pendingQuestions: state.pendingQuestions.filter(
      (q) => q.requestID !== requestID,
    ),
  };
}

/** Sets the optimistic lock for a pending question's answer box while the
 * reply request is in flight. */
export function setAnswerSending(
  state: TranscriptState,
  requestID: string,
  answer: string,
): TranscriptState {
  return {
    ...state,
    pendingQuestions: state.pendingQuestions.map((q) =>
      q.requestID === requestID
        ? { ...q, answerState: { status: "sending", answer } }
        : q,
    ),
  };
}

/** Reply failed: unlock the answer box, preserve the attempted answer, show
 * a visible error. */
export function setAnswerError(
  state: TranscriptState,
  requestID: string,
  message: string,
): TranscriptState {
  return {
    ...state,
    pendingQuestions: state.pendingQuestions.map((q) => {
      if (q.requestID !== requestID) return q;
      const answer =
        q.answerState.status !== "idle" ? q.answerState.answer : "";
      return { ...q, answerState: { status: "error", message, answer } };
    }),
  };
}

/** `session.deleted` for the currently open session flips the panel to a
 * read-only historical view — parts remain visible, no further mutation. */
export function toReadOnly(state: TranscriptState): TranscriptState {
  return { ...state, status: "read-only" };
}

/**
 * Issue 2 fix: detects a session deleted OUT-OF-BAND — i.e. via a live
 * `session.deleted` SSE event for a DIFFERENT directory than the one
 * currently streaming (so this panel's demux subscription never saw it;
 * see `TranscriptPanel.tsx`'s demux subscription which is scoped to a
 * single sessionID/directory pair). The reconcile poller (`reconcile-
 * poller.ts`) polls every roster project on a ~2.5s cadence regardless of
 * which directory is "active", so it eventually prunes the deleted session
 * from the store even when no SSE event reaches this client — this
 * function is the seam that reacts to that prune and flips the panel
 * read-only instead of continuing to render (and accept appends into) a
 * dead session.
 *
 * `sessionsInDirectory` must be `store.getSessions(directory)` for the
 * panel's OWN directory — comparing against the wrong directory would
 * always report the session as absent. Deliberately conservative like
 * DockviewShell's own stale-`activeSession` guard: an EMPTY
 * `sessionsInDirectory` means "this directory hasn't been reconciled yet"
 * (not "every session in it was deleted"), so it's treated as
 * inconclusive and the state passes through unchanged — otherwise a
 * freshly-dispatched session in a not-yet-reconciled directory would flip
 * read-only before the store had a chance to catch up. Already-read-only
 * or non-ready/non-empty states (loading/error) are left alone; this is
 * purely a `ready`/`empty` -> `read-only` transition once conclusive.
 */
export function checkSessionStillTracked(
  state: TranscriptState,
  sessionsInDirectory: { id: string }[],
  sessionID: string | undefined,
): TranscriptState {
  if (!sessionID) return state;
  if (state.status !== "ready" && state.status !== "empty") return state;
  if (sessionsInDirectory.length === 0) return state; // inconclusive — not yet reconciled
  const stillExists = sessionsInDirectory.some((s) => s.id === sessionID);
  if (stillExists) return state;
  return toReadOnly(state);
}

/**
 * Issue 4 fix: pure decision for whether a newly-appended message/delta
 * should pull the transcript's scroll position down to the live edge.
 * Standard "stick to bottom" chat/log pattern — auto-scroll ONLY when the
 * user was already at (or very near) the bottom before the append;
 * otherwise they've scrolled up to read history and an auto-scroll would
 * yank the view out from under them. `thresholdPx` (default 48) tolerates
 * sub-pixel/rounding gaps from browser scroll math without requiring an
 * exact 0 gap. DOM-free — `TranscriptPanel.tsx`'s scroll effect is the
 * thin, untestable-at-this-layer wiring around this decision (measuring
 * `scrollHeight - scrollTop - clientHeight` and calling `scrollTo`).
 */
export function shouldAutoScroll(
  distanceFromBottomPx: number,
  thresholdPx = 48,
): boolean {
  return distanceFromBottomPx <= thresholdPx;
}

/**
 * The shared question-domain answer operation used by BOTH
 * `TranscriptPanel` (UI answer box) and `ide_answer_question` (MCP). This
 * module owns cardinality/ownership validation and the one place a
 * `que_...` request id is checked against a pending question's real
 * structure BEFORE any answer I/O — the UI answer box and the MCP
 * executor call the same function rather than each re-implementing this
 * validation, so the two can never silently drift apart on what counts
 * as a valid answer.
 *
 * IO-agnostic by design: `answer()` is injected, so this module has no
 * dependency on `@fro.bot/space-bus` or the raw opencode HTTP client —
 * the MCP executor wires it to the shared `bus.answerQuestion` facade
 * (`src/server/bus.ts`); `TranscriptPanel` wires it to
 * `client.replyQuestion`. Both callers get identical wrong-ID,
 * cardinality, and stale-question rejection behavior for free.
 *
 * Never retries `answer()` automatically — this module calls it EXACTLY
 * ONCE per `answerQuestionOperation` call. Cross-request reconciliation
 * after an indeterminate answer failure (re-listing pending questions to
 * classify `resolved`/`still_pending`/`unavailable`) is caller-owned
 * (`src/ide/executor.ts`'s `answerQuestionHandler`) since only the
 * MCP-facing path has a bounded space-bus re-list primitive available;
 * the UI path relies on the existing SSE/reconcile flow instead.
 */

/** Structural subset of a pending request's own subquestion metadata —
 * matches both `@fro.bot/space-bus/core`'s `PendingSubquestion` and
 * `StoredQuestion["questions"]` element shape, read defensively (every
 * field optional/loosely typed) so a malformed/poisoned upstream or
 * store entry degrades to a validation failure rather than throwing. */
export interface QuestionSubquestionLike {
  multiple?: boolean;
  custom?: boolean;
  options?: readonly { label?: string }[];
}

export type AnswerCardinalityFailureReason =
  | "no_metadata"
  | "row_count_mismatch"
  | "empty_row"
  | "too_many_selections"
  | "invalid_option";

/**
 * Validates `answers` (the caller-supplied `string[][]` body) against
 * `subquestions` (the pending request's OWN, already-fetched subquestion
 * metadata — never caller-supplied) before any answer I/O:
 *
 * - `subquestions` missing or empty: `"no_metadata"` — refuses to answer
 *   without a verified cardinality (mirrors space-bus's own posture).
 * - `answers.length !== subquestions.length`: `"row_count_mismatch"`.
 * - Any row with zero entries: `"empty_row"`.
 * - A row with more than one entry for a subquestion whose `multiple` is
 *   not `true`: `"too_many_selections"`.
 * - For a NON-`custom` subquestion, any row entry that doesn't exactly
 *   match one of that subquestion's own `options[].label` values:
 *   `"invalid_option"`. A `custom: true` subquestion skips this check —
 *   free-text answers are exactly what `custom` means.
 *
 * Never throws. Read-only, no I/O.
 */
export function validateAnswerCardinality(
  subquestions: readonly QuestionSubquestionLike[] | undefined,
  answers: readonly (readonly string[])[],
): { ok: true } | { ok: false; reason: AnswerCardinalityFailureReason } {
  if (subquestions === undefined || subquestions.length === 0) {
    return { ok: false, reason: "no_metadata" };
  }
  if (answers.length !== subquestions.length) {
    return { ok: false, reason: "row_count_mismatch" };
  }

  for (let i = 0; i < subquestions.length; i++) {
    const sub = subquestions[i];
    const row = answers[i];
    if (!sub || !row) {
      return { ok: false, reason: "row_count_mismatch" };
    }
    if (row.length === 0) {
      return { ok: false, reason: "empty_row" };
    }
    if (sub.multiple !== true && row.length > 1) {
      return { ok: false, reason: "too_many_selections" };
    }
    if (sub.custom !== true) {
      const validLabels = new Set(
        (sub.options ?? [])
          .map((o) => o.label)
          .filter((l): l is string => typeof l === "string"),
      );
      for (const answer of row) {
        if (!validLabels.has(answer)) {
          return { ok: false, reason: "invalid_option" };
        }
      }
    }
  }

  return { ok: true };
}

/** Structural subset of a pending request — matches both
 * `session-store.ts`'s `StoredQuestion` and (once mapped) space-bus's
 * `PendingQuestionView`. */
export interface PendingQuestionLookup {
  sessionID: string;
  questions?: readonly QuestionSubquestionLike[];
}

export type AnswerQuestionErrorCode =
  | "unknown_question"
  | "question_session_mismatch"
  | "invalid_answer_cardinality"
  | "upstream_error"
  | "internal_error";

export type AnswerQuestionOperationResult =
  | { ok: true; data: { sessionId: string; requestId: string } }
  | {
      ok: false;
      code: AnswerQuestionErrorCode;
      delivery: "not_sent" | "indeterminate";
    };

export interface AnswerQuestionOperationInput {
  sessionId: string;
  requestId: string;
  answers: string[][];
}

/** Injected IO — the ONE place `answerQuestionOperation` crosses a
 * boundary out of this pure-logic module. Returns a minimal
 * discriminated result (never throws by contract; a rejection is
 * treated identically to `{ok:false}` by the caller's try/catch). */
export type AnswerQuestionIo = (
  sessionId: string,
  requestId: string,
  answers: string[][],
) => Promise<
  { ok: true; sessionId: string; requestId: string } | { ok: false }
>;

export interface AnswerQuestionOperationDeps {
  /** Read-only pending-request lookup by `requestID` — the `que_...` id,
   * never an SSE envelope id. Wired to `SessionStore.getPendingQuestion`
   * (UI) or an equivalent lookup (MCP executor). */
  getPendingQuestion: (requestId: string) => PendingQuestionLookup | undefined;
  /** Injected answer IO — see `AnswerQuestionIo`. */
  answer: AnswerQuestionIo;
}

/**
 * The shared question-domain operation: validates the request id EXISTS
 * and is CURRENT, belongs to the given session, and that `answers`
 * satisfies the pending request's own cardinality/selection/custom
 * semantics — ALL before `deps.answer()` (the one I/O call) ever runs.
 *
 * - Missing/already-resolved request (absent from `getPendingQuestion`):
 *   `unknown_question`/`not_sent` — never calls `answer()`.
 * - A request that resolves to a DIFFERENT session than the one supplied:
 *   `question_session_mismatch`/`not_sent` — never calls `answer()`.
 *   This is what makes an event-ID (or any id belonging to a different
 *   session) fail closed rather than silently answering the wrong
 *   question.
 * - Wrong cardinality (row count, empty row, too many selections for a
 *   single-select subquestion, or an option not in a non-custom
 *   subquestion's own label set): `invalid_answer_cardinality`/
 *   `not_sent` — never calls `answer()`.
 * - `deps.answer()` throwing or returning `{ok:false}`:
 *   `upstream_error`/`indeterminate` — the one I/O call was attempted and
 *   its outcome could not be confirmed by this function alone (see this
 *   module's header comment for where reconciliation happens).
 * - A successful `answer()` result whose own `sessionId`/`requestId`
 *   disagrees with the input is treated as an invariant breach, never
 *   trusted: `internal_error`/`indeterminate`.
 *
 * Calls `deps.answer()` AT MOST ONCE — never retried by this function.
 */
export async function answerQuestionOperation(
  input: AnswerQuestionOperationInput,
  deps: AnswerQuestionOperationDeps,
): Promise<AnswerQuestionOperationResult> {
  const pending = deps.getPendingQuestion(input.requestId);
  if (!pending) {
    return { ok: false, code: "unknown_question", delivery: "not_sent" };
  }
  if (pending.sessionID !== input.sessionId) {
    return {
      ok: false,
      code: "question_session_mismatch",
      delivery: "not_sent",
    };
  }

  const cardinality = validateAnswerCardinality(
    pending.questions,
    input.answers,
  );
  if (!cardinality.ok) {
    return {
      ok: false,
      code: "invalid_answer_cardinality",
      delivery: "not_sent",
    };
  }

  let result: Awaited<ReturnType<AnswerQuestionIo>>;
  try {
    result = await deps.answer(input.sessionId, input.requestId, input.answers);
  } catch {
    return { ok: false, code: "upstream_error", delivery: "indeterminate" };
  }

  if (!result.ok) {
    return { ok: false, code: "upstream_error", delivery: "indeterminate" };
  }

  if (
    result.sessionId !== input.sessionId ||
    result.requestId !== input.requestId
  ) {
    return { ok: false, code: "internal_error", delivery: "indeterminate" };
  }

  return {
    ok: true,
    data: { sessionId: result.sessionId, requestId: result.requestId },
  };
}

/**
 * Thin facade over `@fro.bot/space-bus/core`. Panels and app code import the
 * /core surface from here, never from the package directly — a single
 * audit point for the space-bus dependency and a future swap seam.
 *
 * Note: /core reads `globalThis.fetch` directly; `CoreOpts` carries only
 * `{context}` (a `BusContext`), no fetch injection. Tests stub
 * `globalThis.fetch` rather than passing a fetch implementation.
 *
 * `@fro.bot/space-bus@0.14.0` (plan Unit 9, KTD15) adds `messages()`,
 * `questions()`, and `answerQuestion()` — full transcript/question read and
 * explicit-answer primitives — and extends `dispatch()`/`toDispatchArgs()`
 * with an opt-in `onPendingQuestion: "blocked"` policy so a follow-up
 * dispatch against a session with a pending question can refuse the
 * mutation entirely (required by `ide_dispatch_prompt`, R2) instead of
 * v0.13.1's default implicit `"question-reply"` behavior, which existing
 * callers keep unless they opt in.
 */
export {
  roster,
  status,
  snapshot,
  dispatch,
  toDispatchArgs,
  result,
  messages,
  questions,
  answerQuestion,
} from "@fro.bot/space-bus/core";
export type {
  CoreOpts,
  Result,
  RosterProject,
  DispatchArgs,
  DispatchResult,
  SessionStatusResult,
  SessionResultResult,
  SnapshotProject,
  DiffSource,
  MessageOpts,
  SessionMessage,
  MessagesResult,
  QuestionTarget,
  PendingSubquestion,
  PendingQuestionView,
  QuestionsResult,
  AnswerQuestionArgs,
  AnswerQuestionResult,
} from "@fro.bot/space-bus/core";

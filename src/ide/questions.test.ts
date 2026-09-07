import { describe, expect, test } from "bun:test";
import {
  type AnswerQuestionIo,
  type PendingQuestionLookup,
  answerQuestionOperation,
  validateAnswerCardinality,
} from "./questions";

describe("validateAnswerCardinality", () => {
  test("happy path: single-select answer for a single subquestion validates", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: false,
          custom: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
      [["Yes"]],
    );
    expect(result.ok).toBe(true);
  });

  test("happy path: multi-select answer for a multiple:true subquestion validates", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: true,
          custom: false,
          options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        },
      ],
      [["A", "C"]],
    );
    expect(result.ok).toBe(true);
  });

  test("happy path: custom subquestion accepts free-text not in options", () => {
    const result = validateAnswerCardinality(
      [{ multiple: false, custom: true, options: [{ label: "Yes" }] }],
      [["something else entirely"]],
    );
    expect(result.ok).toBe(true);
  });

  test("happy path: multiple subquestions each validated against their own row", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: false,
          custom: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
        {
          multiple: true,
          custom: false,
          options: [{ label: "X" }, { label: "Y" }],
        },
      ],
      [["Yes"], ["X", "Y"]],
    );
    expect(result.ok).toBe(true);
  });

  test("edge case: no subquestion metadata refuses to answer without a verified cardinality", () => {
    const result = validateAnswerCardinality(undefined, [["Yes"]]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_metadata");
  });

  test("edge case: empty subquestion array refuses to answer", () => {
    const result = validateAnswerCardinality([], [["Yes"]]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("no_metadata");
  });

  test("error path: wrong row count (fewer rows than subquestions) fails cardinality", () => {
    const result = validateAnswerCardinality(
      [
        { multiple: false, custom: false, options: [{ label: "Yes" }] },
        { multiple: false, custom: false, options: [{ label: "Yes" }] },
      ],
      [["Yes"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("row_count_mismatch");
  });

  test("error path: wrong row count (more rows than subquestions) fails cardinality", () => {
    const result = validateAnswerCardinality(
      [{ multiple: false, custom: false, options: [{ label: "Yes" }] }],
      [["Yes"], ["No"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("row_count_mismatch");
  });

  test("error path: an empty row for a subquestion fails cardinality", () => {
    const result = validateAnswerCardinality(
      [{ multiple: false, custom: false, options: [{ label: "Yes" }] }],
      [[]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("empty_row");
  });

  test("error path: multiple selections for a single-select (multiple:false) subquestion fails cardinality", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: false,
          custom: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      [["A", "B"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("too_many_selections");
  });

  test("error path: a non-custom subquestion answer not matching any option label fails cardinality", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: false,
          custom: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
      [["Maybe"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_option");
  });

  test("error path: a multi-select subquestion with one invalid option among valid ones fails cardinality", () => {
    const result = validateAnswerCardinality(
      [
        {
          multiple: true,
          custom: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      [["A", "Z"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_option");
  });

  test("security: an option with a poisoned/malformed label (non-string) never matches — treated as absent, not a wildcard", () => {
    const result = validateAnswerCardinality(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed fixture
      [{ multiple: false, custom: false, options: [{ label: 123 as any }] }],
      [["123"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_option");
  });

  test("edge case: subquestion with no options array at all and custom:false rejects every answer", () => {
    const result = validateAnswerCardinality(
      [{ multiple: false, custom: false }],
      [["anything"]],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("invalid_option");
  });
});

describe("answerQuestionOperation", () => {
  function makeDeps(
    overrides: Partial<{
      pending: PendingQuestionLookup | undefined;
      answer: AnswerQuestionIo;
    }> = {},
  ) {
    const defaultPending: PendingQuestionLookup = {
      sessionID: "ses_live",
      questions: [
        {
          multiple: false,
          custom: false,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
    let answerCalls = 0;
    const answer: AnswerQuestionIo =
      overrides.answer ??
      (async (sessionId, requestId) => {
        answerCalls++;
        return { ok: true, sessionId, requestId };
      });
    return {
      deps: {
        getPendingQuestion: () =>
          "pending" in overrides ? overrides.pending : defaultPending,
        answer,
      },
      getAnswerCalls: () => answerCalls,
    };
  }

  test("happy path: a valid single-select answer calls answer() exactly once and returns sessionId/requestId", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      answer: async (sessionId, requestId) => {
        calls++;
        return { ok: true, sessionId, requestId };
      },
    });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({ sessionId: "ses_live", requestId: "que_1" });
    expect(calls).toBe(1);
  });

  test("happy path: a valid multi-select answer calls answer() with the full string[][] body", async () => {
    let seenAnswers: string[][] | undefined;
    const { deps } = makeDeps({
      pending: {
        sessionID: "ses_live",
        questions: [
          {
            multiple: true,
            custom: false,
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
      answer: async (sessionId, requestId, answers) => {
        seenAnswers = answers;
        return { ok: true, sessionId, requestId };
      },
    });
    await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["A", "B"]] },
      deps,
    );
    expect(seenAnswers).toEqual([["A", "B"]]);
  });

  test("happy path: a valid custom answer calls answer() with the free-text body", async () => {
    const { deps } = makeDeps({
      pending: {
        sessionID: "ses_live",
        questions: [{ multiple: false, custom: true, options: [] }],
      },
    });
    const result = await answerQuestionOperation(
      {
        sessionId: "ses_live",
        requestId: "que_1",
        answers: [["a free-text reply"]],
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  test("error path: an unknown/missing request id never calls answer()", async () => {
    const { deps, getAnswerCalls } = makeDeps({ pending: undefined });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_unknown", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("unknown_question");
    expect(result.delivery).toBe("not_sent");
    expect(getAnswerCalls()).toBe(0);
  });

  test("error path: an already-resolved (absent) question never calls answer() — same as unknown", async () => {
    const { deps, getAnswerCalls } = makeDeps({ pending: undefined });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_resolved", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("unknown_question");
    expect(getAnswerCalls()).toBe(0);
  });

  test("error path: a request id belonging to a different session (event-ID/mismatch case) never calls answer()", async () => {
    const { deps, getAnswerCalls } = makeDeps({
      pending: {
        sessionID: "ses_other",
        questions: [
          { multiple: false, custom: false, options: [{ label: "Yes" }] },
        ],
      },
    });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("question_session_mismatch");
    expect(result.delivery).toBe("not_sent");
    expect(getAnswerCalls()).toBe(0);
  });

  test("error path: wrong answer cardinality never calls answer()", async () => {
    const { deps, getAnswerCalls } = makeDeps();
    const result = await answerQuestionOperation(
      {
        sessionId: "ses_live",
        requestId: "que_1",
        answers: [["Yes"], ["No"]], // two rows, one subquestion
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("invalid_answer_cardinality");
    expect(result.delivery).toBe("not_sent");
    expect(getAnswerCalls()).toBe(0);
  });

  test("error path: an evt_-shaped id is never treated as a valid requestId match — the lookup itself returns undefined for a non-matching key", async () => {
    const { deps, getAnswerCalls } = makeDeps({
      pending: undefined, // simulates a store keyed only by real que_ ids
    });
    const result = await answerQuestionOperation(
      {
        sessionId: "ses_live",
        requestId: "evt_wrongIdKind",
        answers: [["Yes"]],
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("unknown_question");
    expect(getAnswerCalls()).toBe(0);
  });

  test("reliability: answer() throwing maps to upstream_error/indeterminate, called exactly once", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      answer: async () => {
        calls++;
        throw new Error("network exploded");
      },
    });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("upstream_error");
    expect(result.delivery).toBe("indeterminate");
    expect(calls).toBe(1);
  });

  test("reliability: answer() returning ok:false maps to upstream_error/indeterminate, never retried", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      answer: async () => {
        calls++;
        return { ok: false };
      },
    });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("upstream_error");
    expect(calls).toBe(1);
  });

  test("invariant: a successful answer() result whose own sessionId/requestId disagrees with the input is never trusted", async () => {
    const { deps } = makeDeps({
      answer: async () => ({
        ok: true,
        sessionId: "ses_other",
        requestId: "que_other",
      }),
    });
    const result = await answerQuestionOperation(
      { sessionId: "ses_live", requestId: "que_1", answers: [["Yes"]] },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.code).toBe("internal_error");
    expect(result.delivery).toBe("indeterminate");
  });

  test("security: answers/question text never appear in the result shape (data is sessionId/requestId only)", async () => {
    const { deps } = makeDeps({
      pending: {
        sessionID: "ses_live",
        questions: [{ multiple: false, custom: true, options: [] }],
      },
    });
    const result = await answerQuestionOperation(
      {
        sessionId: "ses_live",
        requestId: "que_1",
        answers: [["confidential answer content"]],
      },
      deps,
    );
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("confidential answer content");
  });
});

import { describe, expect, test } from "bun:test";
import type { MessageList } from "../../server/types";
import {
  addPendingQuestion,
  applyPartUpdate,
  fromBackfill,
  initialTranscriptState,
  removePendingQuestion,
  resolveBackfill,
  setAnswerError,
  setAnswerSending,
  toReadOnly,
} from "./transcript-view";

describe("initialTranscriptState", () => {
  test("starts in loading with no parts", () => {
    expect(initialTranscriptState()).toEqual({
      status: "loading",
      parts: [],
      pendingQuestions: [],
    });
  });
});

describe("fromBackfill", () => {
  test("flattens messages into parts", () => {
    const messages: MessageList = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    ];
    const state = fromBackfill(messages);
    expect(state.status).toBe("ready");
    expect(state.parts).toEqual([
      { id: "0:0", role: "assistant", type: "text", text: "hi" },
    ]);
  });

  test("no messages -> empty status", () => {
    expect(fromBackfill([]).status).toBe("empty");
  });
});

describe("applyPartUpdate", () => {
  test("delta present appends to existing text", () => {
    let state = fromBackfill([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    ]);
    state = applyPartUpdate(state, {
      partId: "0:0",
      role: "assistant",
      type: "text",
      delta: " there",
    });
    expect(state.parts[0]?.text).toBe("hi there");
  });

  test("delta absent replaces with part.text", () => {
    let state = fromBackfill([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    ]);
    state = applyPartUpdate(state, {
      partId: "0:0",
      role: "assistant",
      type: "text",
      text: "replaced",
    });
    expect(state.parts[0]?.text).toBe("replaced");
  });

  test("unknown partId creates a new part (backfill + live merge)", () => {
    let state = initialTranscriptState();
    state = { ...state, status: "empty" };
    state = applyPartUpdate(state, {
      partId: "new:0",
      role: "assistant",
      type: "text",
      text: "fresh",
    });
    expect(state.status).toBe("ready");
    expect(state.parts).toHaveLength(1);
  });
});

describe("pending questions", () => {
  test("addPendingQuestion adds a question with idle answer state", () => {
    let state = initialTranscriptState();
    state = addPendingQuestion(state, {
      requestID: "que_1",
      question: "Proceed?",
      options: ["Yes", "No"],
    });
    expect(state.pendingQuestions).toHaveLength(1);
    expect(state.pendingQuestions[0]?.answerState).toEqual({ status: "idle" });
  });

  test("multiple pending questions tracked independently", () => {
    let state = initialTranscriptState();
    state = addPendingQuestion(state, { requestID: "que_1", options: [] });
    state = addPendingQuestion(state, { requestID: "que_2", options: [] });
    state = setAnswerSending(state, "que_1", "Yes");
    expect(
      state.pendingQuestions.find((q) => q.requestID === "que_1")?.answerState
        .status,
    ).toBe("sending");
    expect(
      state.pendingQuestions.find((q) => q.requestID === "que_2")?.answerState
        .status,
    ).toBe("idle");
  });

  test("setAnswerSending sets the optimistic lock", () => {
    let state = addPendingQuestion(initialTranscriptState(), {
      requestID: "que_1",
      options: [],
    });
    state = setAnswerSending(state, "que_1", "Yes");
    expect(state.pendingQuestions[0]?.answerState).toEqual({
      status: "sending",
      answer: "Yes",
    });
  });

  test("removePendingQuestion clears the lock on confirm event", () => {
    let state = addPendingQuestion(initialTranscriptState(), {
      requestID: "que_1",
      options: [],
    });
    state = setAnswerSending(state, "que_1", "Yes");
    state = removePendingQuestion(state, "que_1");
    expect(state.pendingQuestions).toHaveLength(0);
  });

  test("setAnswerError unlocks and preserves the answer, shows the error", () => {
    let state = addPendingQuestion(initialTranscriptState(), {
      requestID: "que_1",
      options: [],
    });
    state = setAnswerSending(state, "que_1", "Yes");
    state = setAnswerError(state, "que_1", "network down");
    expect(state.pendingQuestions[0]?.answerState).toEqual({
      status: "error",
      message: "network down",
      answer: "Yes",
    });
  });
});

describe("resolveBackfill", () => {
  test("happy path: single in-flight backfill resolves to ready state", async () => {
    const messages: MessageList = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    ];
    const state = await resolveBackfill(
      async () => ({ ok: true, value: messages }),
      1,
      () => true,
    );
    expect(state?.status).toBe("ready");
    expect(state?.parts).toEqual([
      { id: "0:0", role: "assistant", type: "text", text: "hi" },
    ]);
  });

  test("race: A's backfill resolving after B's is discarded, B's result wins", async () => {
    // A starts first (generation 1) but resolves after B (generation 2).
    let currentGeneration = 1;
    let resolveA!: (v: {
      ok: true;
      value: MessageList;
    }) => void;
    const aPromise = new Promise<{ ok: true; value: MessageList }>(
      (resolve) => {
        resolveA = resolve;
      },
    );

    const aResultPromise = resolveBackfill(
      () => aPromise,
      1,
      (gen) => gen === currentGeneration,
    );

    // B starts second and bumps the generation immediately (sync fetch).
    currentGeneration = 2;
    const bMessages: MessageList = [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "B" }] },
    ];
    const bResultPromise = resolveBackfill(
      async () => ({ ok: true, value: bMessages }),
      2,
      (gen) => gen === currentGeneration,
    );

    const bResult = await bResultPromise;
    // Now let A resolve, after B already won.
    resolveA({
      ok: true,
      value: [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "A" }] },
      ],
    });
    const aResult = await aResultPromise;

    expect(aResult).toBeUndefined();
    expect(bResult?.parts).toEqual([
      { id: "0:0", role: "assistant", type: "text", text: "B" },
    ]);
  });

  test("error result is only applied when generation is current", async () => {
    const state = await resolveBackfill(
      async () => ({ ok: false, error: { message: "boom" } }),
      1,
      () => true,
    );
    expect(state?.status).toBe("error");
    expect(state?.message).toBe("boom");
  });
});

describe("toReadOnly", () => {
  test("session.deleted flips status to read-only, preserving parts", () => {
    let state = fromBackfill([
      { info: { role: "assistant" }, parts: [{ type: "text", text: "hi" }] },
    ]);
    state = toReadOnly(state);
    expect(state.status).toBe("read-only");
    expect(state.parts).toHaveLength(1);
  });
});

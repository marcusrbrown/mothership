import { describe, expect, test } from "bun:test";
import type { BusContext } from "../server/types";
import { initialPromptBarState, submitPrompt } from "./controller";

const context: BusContext = {
  roster: {
    server: { baseUrl: "http://127.0.0.1:4096" },
    projects: [
      {
        name: "fro-bot/dashboard",
        path: "~/src/fro-bot/dashboard",
        expandedPath: "/Users/marcus/src/fro-bot/dashboard",
        description: "",
        exists: true,
      },
    ],
  },
} as unknown as BusContext;

describe("submitPrompt controller", () => {
  test("first submit stores the returned sessionId", async () => {
    const dispatch = async (args: unknown) => ({
      ok: true as const,
      sessionId: "sess-1",
      project: "fro-bot/dashboard",
      mode: "new" as const,
      directory: "x",
      _args: args,
    });

    const state = await submitPrompt(
      initialPromptBarState(),
      context,
      "first prompt",
      { dispatch },
    );

    expect(state.sessionId).toBe("sess-1");
    expect(state.sending).toBe(false);
    expect(state.error).toBeUndefined();
  });

  test("second submit reuses the stored sessionId (follow-up)", async () => {
    let capturedArgs: unknown;
    const dispatch = async (args: unknown) => {
      capturedArgs = args;
      return {
        ok: true as const,
        sessionId: "sess-1",
        project: "fro-bot/dashboard",
        mode: "follow-up" as const,
      };
    };

    const stateAfterFirst = { sending: false, sessionId: "sess-1" };
    const state = await submitPrompt(
      stateAfterFirst,
      context,
      "second prompt",
      { dispatch },
    );

    expect(capturedArgs).toMatchObject({
      sessionId: "sess-1",
      prompt: "second prompt",
    });
    expect(state.sessionId).toBe("sess-1");
  });

  test("dispatch Err surfaces the error, does not advance sessionId, preserves nothing extra", async () => {
    const dispatch = async () => ({
      ok: false as const,
      error: "server unreachable",
    });

    const initial = { sending: false, sessionId: undefined };
    const state = await submitPrompt(initial, context, "will fail", {
      dispatch,
    });

    expect(state.error).toBe("server unreachable");
    expect(state.sessionId).toBeUndefined();
    expect(state.sending).toBe(false);
  });

  test("empty/whitespace prompt -> no dispatch call, state unchanged", async () => {
    let called = false;
    const dispatch = async () => {
      called = true;
      return {
        ok: true as const,
        sessionId: "x",
        project: "x",
        mode: "new" as const,
        directory: "x",
      };
    };

    const initial = initialPromptBarState();
    const state = await submitPrompt(initial, context, "   ", { dispatch });

    expect(called).toBe(false);
    expect(state).toBe(initial);
  });

  test("bug A layer 3: a session-not-found dispatch error clears the remembered sessionId so the next submit re-resolves fresh", async () => {
    const dispatch = async () => ({
      ok: false as const,
      error:
        "space-bus: no manifest project has a session with id ses_0ccf76c09ffe3k9GXL96trIzYR",
    });

    const stateWithStaleSession = { sending: false, sessionId: "sess-stale" };
    const state = await submitPrompt(
      stateWithStaleSession,
      context,
      "keep going",
      { dispatch },
    );

    expect(state.error).toContain("no manifest project has a session");
    expect(state.sessionId).toBeUndefined();
    expect(state.sending).toBe(false);
  });

  test("bug A regression: a raw server NotFoundError body (deleted mid-session, async failure) clears the remembered sessionId and surfaces the error", async () => {
    // Live-observed shape from the transcript SSE payload when a dispatch
    // targets a session deleted out-of-band (e.g. in the TUI): the server's
    // JSON error body embeds `"name":"NotFoundError"` — space-bus's thrown
    // error string carries this verbatim. Previously only the
    // "no manifest project has a session with id" / "session...not...found"
    // wording matched, so this literal NotFoundError shape slipped through
    // and the stale sessionId was retried forever with no banner.
    const dispatch = async () => ({
      ok: false as const,
      error:
        'space-bus: follow-up prompt to session ses_0ccf76c09ffe3k9GXL96trIzYR failed (404): {"name":"NotFoundError","data":{"message":"Session not found: ses_0ccf76c09ffe3k9GXL96trIzYR"}}',
    });

    const stateWithStaleSession = { sending: false, sessionId: "sess-stale" };
    const state = await submitPrompt(
      stateWithStaleSession,
      context,
      "What is this repo?",
      { dispatch },
    );

    expect(state.error).toContain("NotFoundError");
    expect(state.sessionId).toBeUndefined();
    expect(state.sending).toBe(false);
  });

  test("a non-session-not-found dispatch error preserves the remembered sessionId (still a follow-up target)", async () => {
    const dispatch = async () => ({
      ok: false as const,
      error: "server unreachable",
    });

    const stateWithSession = { sending: false, sessionId: "sess-1" };
    const state = await submitPrompt(stateWithSession, context, "retry", {
      dispatch,
    });

    expect(state.error).toBe("server unreachable");
    expect(state.sessionId).toBe("sess-1");
  });

  test("in-flight sending lock: submit while already sending is a no-op", async () => {
    let calls = 0;
    const dispatch = async () => {
      calls++;
      return {
        ok: true as const,
        sessionId: "x",
        project: "x",
        mode: "new" as const,
        directory: "x",
      };
    };

    const sendingState = { sending: true, sessionId: undefined };
    const state = await submitPrompt(sendingState, context, "double submit", {
      dispatch,
    });

    expect(calls).toBe(0);
    expect(state).toBe(sendingState);
  });
});

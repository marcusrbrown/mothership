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

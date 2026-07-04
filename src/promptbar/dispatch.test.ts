import { describe, expect, test } from "bun:test";
import type { BusContext } from "../server/types";
import { dispatchPrompt } from "./dispatch";

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

describe("dispatchPrompt", () => {
  test("first submit (no sessionId) dispatches a new session against the first project", async () => {
    let capturedArgs: unknown;
    const dispatch = async (args: unknown) => {
      capturedArgs = args;
      return {
        ok: true as const,
        sessionId: "sess-1",
        project: "fro-bot/dashboard",
        mode: "new" as const,
        directory: "/Users/marcus/src/fro-bot/dashboard",
      };
    };

    const result = await dispatchPrompt(
      { context, prompt: "do the thing" },
      { dispatch },
    );

    expect(result.ok).toBe(true);
    expect(capturedArgs).toMatchObject({
      prompt: "do the thing",
      project: "fro-bot/dashboard",
    });
    expect((capturedArgs as { sessionId?: string }).sessionId).toBeUndefined();
    if (result.ok) {
      expect(result.sessionId).toBe("sess-1");
    }
  });

  test("follow-up submit (sessionId present) dispatches with the stored sessionId, no project required", async () => {
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

    const result = await dispatchPrompt(
      { context, prompt: "keep going", sessionId: "sess-1" },
      { dispatch },
    );

    expect(result.ok).toBe(true);
    expect(capturedArgs).toMatchObject({
      prompt: "keep going",
      sessionId: "sess-1",
    });
  });

  test("propagates a dispatch Err result unchanged", async () => {
    const dispatch = async () => ({ ok: false as const, error: "boom" });

    const result = await dispatchPrompt(
      { context, prompt: "do the thing" },
      { dispatch },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("boom");
    }
  });

  test("no project in the workspace and no sessionId -> typed error, no dispatch call", async () => {
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

    const emptyContext: BusContext = {
      roster: { server: { baseUrl: "http://127.0.0.1:4096" }, projects: [] },
    } as unknown as BusContext;

    const result = await dispatchPrompt(
      { context: emptyContext, prompt: "do the thing" },
      { dispatch },
    );

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

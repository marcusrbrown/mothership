import { describe, expect, test } from "bun:test";
import { createSessionStore } from "../server/session-store";
import type { BusContext } from "../server/types";
import { dispatchPrompt, resolveDispatchTarget } from "./dispatch";

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
      {
        name: "fro-bot/agent",
        path: "~/src/fro-bot/agent",
        expandedPath: "/Users/marcus/src/fro-bot/agent",
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

  test("first submit with an explicit project arg (bug-2 fix) routes to the mentioned project, not projects[0]", async () => {
    let capturedArgs: unknown;
    const dispatch = async (args: unknown) => {
      capturedArgs = args;
      return {
        ok: true as const,
        sessionId: "sess-2",
        project: "fro-bot/agent",
        mode: "new" as const,
        directory: "/Users/marcus/src/fro-bot/agent",
      };
    };

    const result = await dispatchPrompt(
      { context, prompt: "@fro-bot/agent summarize", project: "fro-bot/agent" },
      { dispatch },
    );

    expect(result.ok).toBe(true);
    expect(capturedArgs).toMatchObject({ project: "fro-bot/agent" });
  });

  test("first submit with a project arg that doesn't name a real roster project falls back to projects[0]", async () => {
    let capturedArgs: unknown;
    const dispatch = async (args: unknown) => {
      capturedArgs = args;
      return {
        ok: true as const,
        sessionId: "sess-3",
        project: "fro-bot/dashboard",
        mode: "new" as const,
        directory: "/Users/marcus/src/fro-bot/dashboard",
      };
    };

    const result = await dispatchPrompt(
      { context, prompt: "@nonexistent summarize", project: "nonexistent" },
      { dispatch },
    );

    expect(result.ok).toBe(true);
    expect(capturedArgs).toMatchObject({ project: "fro-bot/dashboard" });
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

describe("resolveDispatchTarget", () => {
  const targetProject = {
    name: "fro-bot/dashboard",
    expandedPath: "/Users/marcus/src/fro-bot/dashboard",
  };
  const otherProject = {
    name: "fro-bot/agent",
    expandedPath: "/Users/marcus/src/fro-bot/agent",
  };

  test("active session belonging to the target project -> follow-up into it", () => {
    const result = resolveDispatchTarget({
      activeSession: {
        sessionId: "sess-active",
        directory: targetProject.expandedPath,
      },
      targetProject,
    });
    expect(result).toEqual({ kind: "follow-up", sessionId: "sess-active" });
  });

  test("active session belonging to a DIFFERENT project is ignored -> falls through to most-recent/create", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: targetProject.expandedPath,
      sessions: [
        {
          id: "sess-old",
          directory: targetProject.expandedPath,
          title: "control",
        },
      ],
    });

    const result = resolveDispatchTarget({
      activeSession: {
        sessionId: "sess-active",
        directory: otherProject.expandedPath,
      },
      targetProject,
      store,
    });
    expect(result).toEqual({ kind: "follow-up", sessionId: "sess-old" });
  });

  test("no active session, target project has sessions (any title) -> most-recent follow-up, by array order when untimestamped", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: targetProject.expandedPath,
      sessions: [
        {
          id: "sess-1",
          directory: targetProject.expandedPath,
          title: "control",
        },
        {
          id: "sess-2",
          directory: targetProject.expandedPath,
          title: "refactor auth",
        },
      ],
    });

    const result = resolveDispatchTarget({ targetProject, store });
    // Neither session carries a server timestamp here -> falls back to
    // last-in-array (insertion order), regardless of title.
    expect(result).toEqual({ kind: "follow-up", sessionId: "sess-2" });
  });

  test("most-recent pick uses MAX updatedAt, not array position", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: targetProject.expandedPath,
      // Inserted oldest-last: sess-2 is last in the array but has the
      // OLDER timestamp. The newer-by-time session (sess-1) must win.
      sessions: [
        {
          id: "sess-1",
          directory: targetProject.expandedPath,
          title: "control",
          time: { created: 100, updated: 500 },
        },
        {
          id: "sess-2",
          directory: targetProject.expandedPath,
          title: "refactor auth",
          time: { created: 100, updated: 200 },
        },
      ],
    });

    const result = resolveDispatchTarget({ targetProject, store });
    expect(result).toEqual({ kind: "follow-up", sessionId: "sess-1" });
  });

  test("target project has zero sessions -> create", () => {
    const store = createSessionStore();
    const result = resolveDispatchTarget({ targetProject, store });
    expect(result).toEqual({ kind: "create", project: targetProject.name });
  });

  test("no store at all -> create (degrades safely)", () => {
    const result = resolveDispatchTarget({ targetProject });
    expect(result).toEqual({ kind: "create", project: targetProject.name });
  });

  test("@mention overrides an active session from a different project (via targetProject already resolved to the mention)", () => {
    const store = createSessionStore();
    store.reconcile({
      directory: otherProject.expandedPath,
      sessions: [
        {
          id: "sess-agent-1",
          directory: otherProject.expandedPath,
          title: "control",
        },
      ],
    });

    // Caller resolves targetProject to the @-mentioned project (otherProject)
    // even though activeSession belongs to targetProject (dashboard) from a
    // prior dispatch/select.
    const result = resolveDispatchTarget({
      activeSession: {
        sessionId: "sess-dashboard-1",
        directory: targetProject.expandedPath,
      },
      targetProject: otherProject,
      store,
    });
    expect(result).toEqual({ kind: "follow-up", sessionId: "sess-agent-1" });
  });
});

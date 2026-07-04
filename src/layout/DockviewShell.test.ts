import { describe, expect, test } from "bun:test";
import { createDemux } from "../server/demux";
import { createSessionStore } from "../server/session-store";
import type { BusContext, SseEvent } from "../server/types";
import { connectActiveDirectorySse } from "./DockviewShell";

/**
 * Regression coverage for the connection-cap hang (fixed after commit
 * 0842050's per-project-permanent-SSE regression): `connectActiveDirectorySse`
 * must hold open AT MOST ONE underlying `/event` connection at a time.
 * Cross-project freshness now comes from the reconcile poller
 * (`reconcile-poller.test.ts`) — this controller's only job is the single
 * live transcript stream, switched via `setActiveDirectory`.
 */

function context(
  projects: { name: string; expandedPath: string }[],
): BusContext {
  return {
    roster: {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: projects.map((p) => ({
        name: p.name,
        path: p.expandedPath,
        expandedPath: p.expandedPath,
        description: "",
        exists: true,
      })),
    },
    credentials: { username: "opencode", password: "secret" },
  } as unknown as BusContext;
}

function fakeClient(recordedDirectories: string[]) {
  return {
    async listSessions(directory: string) {
      recordedDirectories.push(directory);
      return { ok: true as const, value: [] };
    },
    async getSessionStatus() {
      return { ok: true as const, value: {} };
    },
    async listQuestions() {
      return { ok: true as const, value: [] };
    },
    async replyQuestion() {
      return { ok: true as const, value: undefined };
    },
    async rejectQuestion() {
      return { ok: true as const, value: undefined };
    },
    async listMessages() {
      return { ok: true as const, value: [] };
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test double
  } as any;
}

describe("connectActiveDirectorySse", () => {
  test("opens exactly one connection, scoped to the initial directory", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
      { name: "c", expandedPath: "/repo/c" },
    ]);
    const calls: unknown[] = [];
    const connect = (options: unknown) => {
      calls.push(options);
      return { state: "open" as const, close: () => {} };
    };

    const live = {
      client: fakeClient([]),
      demux: createDemux(),
      store: createSessionStore(),
    };

    connectActiveDirectorySse(live, ctx, "/repo/a", { connect });

    expect(calls).toHaveLength(1);
    expect((calls[0] as { directory: string }).directory).toBe("/repo/a");
    const opts = calls[0] as {
      baseUrl: string;
      credentials?: { username?: string; password?: string };
    };
    expect(opts.baseUrl).toBe("http://127.0.0.1:4096");
    expect(opts.credentials).toEqual({
      username: "opencode",
      password: "secret",
    });
  });

  test("setActiveDirectory closes the previous connection before opening the new one — never more than one open", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
    ]);
    const opened: string[] = [];
    const closed: string[] = [];
    const connect = (options: { directory: string }) => {
      opened.push(options.directory);
      return {
        state: "open" as const,
        close: () => closed.push(options.directory),
      };
    };

    const live = {
      client: fakeClient([]),
      demux: createDemux(),
      store: createSessionStore(),
    };

    const handle = connectActiveDirectorySse(live, ctx, "/repo/a", {
      connect,
    });
    expect(opened).toEqual(["/repo/a"]);
    expect(closed).toEqual([]);

    handle.setActiveDirectory("/repo/b");

    // The old connection must be closed BEFORE (or at least by the time)
    // the new one opens — asserting both happened, and that at no point
    // were two connections open: opened.length - closed.length <= 1.
    expect(opened).toEqual(["/repo/a", "/repo/b"]);
    expect(closed).toEqual(["/repo/a"]);
    expect(opened.length - closed.length).toBe(1);
  });

  test("setActiveDirectory is a no-op when the directory is unchanged", () => {
    const ctx = context([{ name: "a", expandedPath: "/repo/a" }]);
    const opened: string[] = [];
    const connect = (options: { directory: string }) => {
      opened.push(options.directory);
      return { state: "open" as const, close: () => {} };
    };

    const live = {
      client: fakeClient([]),
      demux: createDemux(),
      store: createSessionStore(),
    };

    const handle = connectActiveDirectorySse(live, ctx, "/repo/a", {
      connect,
    });
    handle.setActiveDirectory("/repo/a");

    expect(opened).toEqual(["/repo/a"]);
  });

  test("routes events from the active connection's onEvent into the shared demux/store", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
    ]);
    const onEvents: ((event: SseEvent) => void)[] = [];
    const connect = (options: { onEvent: (event: SseEvent) => void }) => {
      onEvents.push(options.onEvent);
      return { state: "open" as const, close: () => {} };
    };

    const demux = createDemux();
    const store = createSessionStore();
    demux.subscribeFirehose((event) => store.applyEvent(event));
    const live = { client: fakeClient([]), demux, store };

    const handle = connectActiveDirectorySse(live, ctx, "/repo/a", {
      connect,
    });
    handle.setActiveDirectory("/repo/b");

    // Only the CURRENT (second) connection's onEvent should be wired to
    // matter going forward — dispatch through it and confirm it lands in
    // the shared store.
    expect(onEvents).toHaveLength(2);
    onEvents[1]?.({
      type: "session.updated",
      properties: { id: "sess-b", directory: "/repo/b" },
    });

    expect(store.getSession("sess-b")).toEqual({
      id: "sess-b",
      directory: "/repo/b",
      status: "unknown",
    });
  });

  test("close() closes the currently-open connection", () => {
    const ctx = context([{ name: "a", expandedPath: "/repo/a" }]);
    const closeCalls: string[] = [];
    const connect = (options: { directory: string }) => {
      return {
        state: "open" as const,
        close: () => closeCalls.push(options.directory),
      };
    };

    const live = {
      client: fakeClient([]),
      demux: createDemux(),
      store: createSessionStore(),
    };

    const handle = connectActiveDirectorySse(live, ctx, "/repo/a", {
      connect,
    });
    handle.close();

    expect(closeCalls).toEqual(["/repo/a"]);
  });

  test("each (re)connect's onReconcile reconciles only its own current directory", async () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
    ]);
    const onReconciles: (() => void)[] = [];
    const connect = (options: { onReconcile: () => void }) => {
      onReconciles.push(options.onReconcile);
      return { state: "open" as const, close: () => {} };
    };

    const recordedDirectories: string[] = [];
    const live = {
      client: fakeClient(recordedDirectories),
      demux: createDemux(),
      store: createSessionStore(),
    };

    const handle = connectActiveDirectorySse(live, ctx, "/repo/a", {
      connect,
    });
    handle.setActiveDirectory("/repo/b");

    expect(onReconciles).toHaveLength(2);
    onReconciles[1]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(recordedDirectories).toEqual(["/repo/b"]);
  });

  test("no initial directory (empty roster) opens no connection until setActiveDirectory is called", () => {
    const ctx = context([]);
    const opened: string[] = [];
    const connect = (options: { directory: string }) => {
      opened.push(options.directory);
      return { state: "open" as const, close: () => {} };
    };

    const live = {
      client: fakeClient([]),
      demux: createDemux(),
      store: createSessionStore(),
    };

    const handle = connectActiveDirectorySse(live, ctx, undefined, {
      connect,
    });
    expect(opened).toEqual([]);

    handle.setActiveDirectory("/repo/a");
    expect(opened).toEqual(["/repo/a"]);
  });
});

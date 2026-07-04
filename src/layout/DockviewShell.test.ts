import { describe, expect, test } from "bun:test";
import { createDemux } from "../server/demux";
import { createSessionStore } from "../server/session-store";
import type { BusContext, SseEvent } from "../server/types";
import { connectWorkspaceSse } from "./DockviewShell";

/**
 * Regression coverage for the "only the first roster project streams"
 * bug: `GET /event?directory=<dir>` is server-side directory-scoped, so a
 * single workspace-wide connection scoped to `projects[0]` never receives
 * events for any other project. `connectWorkspaceSse` must open one
 * connection per UNIQUE project directory, fanning all of them into the
 * same shared demux/store, and its composite `close()` must tear down
 * every underlying connection.
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

describe("connectWorkspaceSse", () => {
  test("opens one connection per unique project directory, with correct directory/baseUrl/credentials", () => {
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

    const demux = createDemux();
    const store = createSessionStore();
    const live = {
      client: fakeClient([]),
      demux,
      store,
    };

    connectWorkspaceSse(live, ctx, { connect });

    expect(calls).toHaveLength(3);
    const directories = calls.map(
      (c) => (c as { directory: string }).directory,
    );
    expect(directories.sort()).toEqual(["/repo/a", "/repo/b", "/repo/c"]);
    for (const c of calls) {
      const opts = c as {
        baseUrl: string;
        credentials?: { username?: string; password?: string };
      };
      expect(opts.baseUrl).toBe("http://127.0.0.1:4096");
      expect(opts.credentials).toEqual({
        username: "opencode",
        password: "secret",
      });
    }
  });

  test("dedupes two projects sharing the same directory into one connection", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/shared" },
      { name: "b", expandedPath: "/repo/shared" },
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

    connectWorkspaceSse(live, ctx, { connect });

    expect(calls).toHaveLength(1);
    expect((calls[0] as { directory: string }).directory).toBe("/repo/shared");
  });

  test("routes events from any connection's onEvent into the shared demux/store", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
    ]);
    const onEvents: ((event: SseEvent) => void)[] = [];
    const connect = (options: {
      onEvent: (event: SseEvent) => void;
    }) => {
      onEvents.push(options.onEvent);
      return { state: "open" as const, close: () => {} };
    };

    const demux = createDemux();
    const store = createSessionStore();
    demux.subscribeFirehose((event) => store.applyEvent(event));
    const live = { client: fakeClient([]), demux, store };

    connectWorkspaceSse(live, ctx, { connect });

    expect(onEvents).toHaveLength(2);
    // Connection #2 (index 1) corresponds to project "b" — dispatch an
    // event through it and confirm it lands in the shared store, proving
    // cross-project events (the bug's symptom) now reach the store.
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

  test("composite close() closes every underlying connection", () => {
    const ctx = context([
      { name: "a", expandedPath: "/repo/a" },
      { name: "b", expandedPath: "/repo/b" },
    ]);
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

    const handle = connectWorkspaceSse(live, ctx, { connect });
    handle.close();

    expect(closeCalls.sort()).toEqual(["/repo/a", "/repo/b"]);
  });

  test("each connection's onReconcile reconciles only its own directory", async () => {
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

    connectWorkspaceSse(live, ctx, { connect });

    expect(onReconciles).toHaveLength(2);
    onReconciles[1]?.();
    // onReconcile fires an async reconcile — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(recordedDirectories).toEqual(["/repo/b"]);
  });
});

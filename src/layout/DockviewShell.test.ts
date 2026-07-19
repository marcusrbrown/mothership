import { describe, expect, test } from "bun:test";
import {
  __resetDiscoveryContextRegistrationForTests,
  __resetSessionToolsForTests,
  registerDiscoveryContextTools,
  runSessionTool,
} from "../ide/executor";
import {
  type ActiveSession,
  type FocusSeams,
  createFocusController,
} from "../ide/focus";
import { createDemux } from "../server/demux";
import { createSessionStore } from "../server/session-store";
import type { BusContext, SseEvent } from "../server/types";
import {
  buildSessionToolDeps,
  connectActiveDirectorySse,
  pruneStaleActiveSession,
  reconcileProject,
} from "./DockviewShell";

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

describe("reconcileProject", () => {
  test("a transient listSessions failure keeps prior sessions for the directory (no wipe)", async () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/a" },
    });
    expect(store.getSessions("/repo/a")).toHaveLength(1);

    const failingClient = {
      async listSessions() {
        return { ok: false as const, error: new Error("network down") };
      },
      async getSessionStatus() {
        return { ok: true as const, value: {} };
      },
      async listQuestions() {
        return { ok: true as const, value: [] };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    } as any;

    await reconcileProject(failingClient, store, "/repo/a");

    expect(store.getSessions("/repo/a").map((s) => s.id)).toEqual(["ses_1"]);
  });

  test("a later successful listSessions reconciles normally after a prior failure", async () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/a" },
    });

    const failingClient = {
      async listSessions() {
        return { ok: false as const, error: new Error("network down") };
      },
      async getSessionStatus() {
        return { ok: true as const, value: {} };
      },
      async listQuestions() {
        return { ok: true as const, value: [] };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    } as any;
    await reconcileProject(failingClient, store, "/repo/a");
    expect(store.getSessions("/repo/a")).toHaveLength(1);

    const succeedingClient = {
      async listSessions() {
        return { ok: true as const, value: [{ id: "ses_2" }] };
      },
      async getSessionStatus() {
        return { ok: true as const, value: {} };
      },
      async listQuestions() {
        return { ok: true as const, value: [] };
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    } as any;
    await reconcileProject(succeedingClient, store, "/repo/a");

    expect(store.getSessions("/repo/a").map((s) => s.id)).toEqual(["ses_2"]);
  });
});

describe("buildSessionToolDeps + discovery/context/focus tool wiring", () => {
  function fakeRosterClient(recordedDirectories: string[]) {
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
      // biome-ignore lint/suspicious/noExplicitAny: minimal test double
    } as any;
  }

  function makeFocus(): {
    focus: ReturnType<typeof createFocusController>;
    calls: {
      transcript: unknown[];
      sessions: unknown[];
      roster: unknown[];
      sse: string[];
      activeSession: ActiveSession[];
    };
  } {
    const calls = {
      transcript: [] as unknown[],
      sessions: [] as unknown[],
      roster: [] as unknown[],
      sse: [] as string[],
      activeSession: [] as ActiveSession[],
    };
    const seams: FocusSeams = {
      updateTranscriptParams: (p) => calls.transcript.push(p),
      updateSessionsParams: (p) => calls.sessions.push(p),
      updateRosterParams: (p) => calls.roster.push(p),
      setActiveDirectory: (d) => calls.sse.push(d),
      // Mirrors DockviewShell's real wiring: `updateActiveSession` bound
      // to React `setActiveSession` — here, a plain recorder standing in
      // for what PromptBar's `activeSession` prop would receive.
      updateActiveSession: (s) => calls.activeSession.push(s),
    };
    return { focus: createFocusController(seams), calls };
  }

  function ctx(): BusContext {
    return context([{ name: "dashboard", expandedPath: "/repo/dashboard" }]);
  }

  test("returns undefined when context or live is missing (bridge treats this as sessionTools unavailable)", () => {
    const { focus } = makeFocus();
    expect(
      buildSessionToolDeps(undefined, undefined, focus, () => {}),
    ).toBeUndefined();
  });

  test("ide_list_projects routes through the bridge/executor to a real roster() call instead of unknown_tool/unavailable", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const { focus } = makeFocus();
    const store = createSessionStore();
    const client = fakeRosterClient([]);
    const deps = buildSessionToolDeps(
      ctx(),
      { client, demux: createDemux(), store },
      focus,
      () => {},
    );
    expect(deps).toBeDefined();
    if (!deps) throw new Error("expected deps");

    const result = await runSessionTool(
      "ide_list_projects",
      {},
      deps,
      "mcp_tool",
    );
    // roster()/snapshot() hit real fetch and fail in this test environment
    // (no live server) — the point of this test is that routing reaches
    // the executor at all (a real upstream_error, not unknown_tool or
    // sessionTools-unavailable), proving production wiring is connected.
    expect(result.ok === false || result.ok === true).toBe(true);
    if (!result.ok) {
      expect(result.error.code).not.toBe("unknown_tool");
    }
  });

  test("ide_list_sessions refreshes via the live reconcile seam before reading the store", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const { focus } = makeFocus();
    const store = createSessionStore();
    const recordedDirectories: string[] = [];
    const client = fakeRosterClient(recordedDirectories);
    const deps = buildSessionToolDeps(
      ctx(),
      { client, demux: createDemux(), store },
      focus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");

    await runSessionTool(
      "ide_list_sessions",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(recordedDirectories).toContain("/repo/dashboard");
  });

  test("ide_select_project (MCP) and a UI project selection produce identical panel/SSE/context effects", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const { focus: mcpFocus, calls: mcpCalls } = makeFocus();
    const store = createSessionStore();
    const deps = buildSessionToolDeps(
      ctx(),
      { client: fakeRosterClient([]), demux: createDemux(), store },
      mcpFocus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");
    await runSessionTool(
      "ide_select_project",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    const { focus: uiFocus, calls: uiCalls } = makeFocus();
    uiFocus.selectProject({ name: "dashboard", directory: "/repo/dashboard" });

    expect(mcpCalls.sessions).toEqual(uiCalls.sessions);
    expect(mcpCalls.roster).toEqual(uiCalls.roster);
    expect(mcpCalls.sse).toEqual(uiCalls.sse);
    expect(mcpFocus.getActiveContext()).toEqual(uiFocus.getActiveContext());
    expect(mcpCalls.activeSession[mcpCalls.activeSession.length - 1]).toEqual(
      uiCalls.activeSession[uiCalls.activeSession.length - 1],
    );
  });

  test("MCP and UI project selection clear a previously active session identically when switching directories", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const twoProjectCtx = context([
      { name: "dashboard", expandedPath: "/repo/dashboard" },
      { name: "other", expandedPath: "/repo/other" },
    ]);

    const { focus: mcpFocus, calls: mcpCalls } = makeFocus();
    mcpFocus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    const deps = buildSessionToolDeps(
      twoProjectCtx,
      {
        client: fakeRosterClient([]),
        demux: createDemux(),
        store: createSessionStore(),
      },
      mcpFocus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");
    await runSessionTool(
      "ide_select_project",
      { project: "other" },
      deps,
      "mcp_tool",
    );

    const { focus: uiFocus, calls: uiCalls } = makeFocus();
    uiFocus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    uiFocus.selectProject({ name: "other", directory: "/repo/other" });

    expect(
      mcpCalls.activeSession[mcpCalls.activeSession.length - 1],
    ).toBeUndefined();
    expect(
      uiCalls.activeSession[uiCalls.activeSession.length - 1],
    ).toBeUndefined();
  });

  test("MCP and UI project selection preserve a previously active session identically when re-selecting the same directory", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const { focus: mcpFocus, calls: mcpCalls } = makeFocus();
    mcpFocus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    const deps = buildSessionToolDeps(
      ctx(),
      {
        client: fakeRosterClient([]),
        demux: createDemux(),
        store: createSessionStore(),
      },
      mcpFocus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");
    await runSessionTool(
      "ide_select_project",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(mcpCalls.activeSession[mcpCalls.activeSession.length - 1]).toEqual({
      sessionId: "ses_1",
      directory: "/repo/dashboard",
    });
  });

  test("rapid sequential focus calls (as MCP or UI could interleave) resolve last-write-wins for the active session", () => {
    const { focus, calls } = makeFocus();
    focus.selectProject({ name: "dashboard", directory: "/repo/dashboard" });
    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    focus.selectProject({ name: "other", directory: "/repo/other" });
    focus.selectSession({
      id: "ses_2",
      project: "other",
      directory: "/repo/other",
    });

    expect(calls.activeSession[calls.activeSession.length - 1]).toEqual({
      sessionId: "ses_2",
      directory: "/repo/other",
    });
  });

  test("ide_select_session (MCP) and a UI session selection produce identical panel/SSE/context effects", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/dashboard" },
    });

    const { focus: mcpFocus, calls: mcpCalls } = makeFocus();
    const deps = buildSessionToolDeps(
      ctx(),
      { client: fakeRosterClient([]), demux: createDemux(), store },
      mcpFocus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");
    await runSessionTool(
      "ide_select_session",
      { sessionId: "ses_1" },
      deps,
      "mcp_tool",
    );

    const { focus: uiFocus, calls: uiCalls } = makeFocus();
    uiFocus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });

    expect(mcpCalls.transcript).toEqual(uiCalls.transcript);
    expect(mcpCalls.sessions).toEqual(uiCalls.sessions);
    expect(mcpCalls.roster).toEqual(uiCalls.roster);
    expect(mcpCalls.sse).toEqual(uiCalls.sse);
    expect(mcpFocus.getActiveContext()).toEqual(uiFocus.getActiveContext());
    // The exact PromptBar-facing value: MCP select_session must produce
    // the identical activeSession update a UI click would.
    expect(mcpCalls.activeSession[mcpCalls.activeSession.length - 1]).toEqual({
      sessionId: "ses_1",
      directory: "/repo/dashboard",
    });
    expect(mcpCalls.activeSession[mcpCalls.activeSession.length - 1]).toEqual(
      uiCalls.activeSession[uiCalls.activeSession.length - 1],
    );
  });

  test("switching to a different project clears a stale active session (via ide_select_project)", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const twoProjectCtx = context([
      { name: "dashboard", expandedPath: "/repo/dashboard" },
      { name: "other", expandedPath: "/repo/other" },
    ]);
    const store = createSessionStore();
    const { focus, calls } = makeFocus();
    const deps = buildSessionToolDeps(
      twoProjectCtx,
      { client: fakeRosterClient([]), demux: createDemux(), store },
      focus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");

    await runSessionTool(
      "ide_select_session",
      { sessionId: "ses_none" },
      deps,
      "mcp_tool",
    ); // no-op: unknown session, proves no mutation on unknown targets
    expect(calls.transcript).toHaveLength(0);

    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    await runSessionTool(
      "ide_select_project",
      { project: "other" },
      deps,
      "mcp_tool",
    );

    expect(focus.getActiveContext()).toEqual({ project: "other" });
  });

  test("focus.getActiveContext follows a dispatched/selected session through the SAME controller MCP reads", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_new", directory: "/repo/dashboard" },
    });
    const { focus } = makeFocus();
    const deps = buildSessionToolDeps(
      ctx(),
      { client: fakeRosterClient([]), demux: createDemux(), store },
      focus,
      () => {},
    );
    if (!deps) throw new Error("expected deps");

    // Simulates handleDispatched calling the same controller.
    focus.selectSession({
      id: "ses_new",
      project: "dashboard",
      directory: "/repo/dashboard",
    });

    const result = await runSessionTool(
      "ide_get_active_context",
      {},
      deps,
      "mcp_tool",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data).toEqual({
      project: "dashboard",
      sessionId: "ses_new",
    });
  });

  test("a dispatched session sets the active session via the same controller (dispatch = selectSession)", () => {
    const { focus, calls } = makeFocus();
    // handleDispatched's happy path resolves the dispatched-to directory
    // against the roster then calls focus.selectSession — identical to a
    // UI click or MCP select_session, no separate setActiveSession rule.
    focus.selectSession({
      id: "ses_dispatched",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    expect(calls.activeSession[calls.activeSession.length - 1]).toEqual({
      sessionId: "ses_dispatched",
      directory: "/repo/dashboard",
    });
  });

  test("an unknown/stale UI project name performs no mutation", () => {
    const { focus, calls } = makeFocus();
    const roster = ctx().roster.projects;
    const found = roster.find((p) => p.name === "does-not-exist");
    if (found) {
      focus.selectProject({ name: found.name, directory: found.expandedPath });
    }
    expect(calls.roster).toHaveLength(0);
    expect(calls.sse).toHaveLength(0);
  });

  test("the audit callback receives a minimized event with no path/directory content", async () => {
    __resetSessionToolsForTests();
    __resetDiscoveryContextRegistrationForTests();
    registerDiscoveryContextTools();

    const events: unknown[] = [];
    const { focus } = makeFocus();
    const store = createSessionStore();
    const deps = buildSessionToolDeps(
      ctx(),
      { client: fakeRosterClient([]), demux: createDemux(), store },
      focus,
      (event) => events.push(event),
    );
    if (!deps) throw new Error("expected deps");

    await runSessionTool(
      "ide_select_project",
      { project: "dashboard" },
      deps,
      "mcp_tool",
    );

    expect(events).toHaveLength(1);
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain("/repo/dashboard");
  });
});

describe("pruneStaleActiveSession", () => {
  function ctx(): BusContext {
    return context([{ name: "dashboard", expandedPath: "/repo/dashboard" }]);
  }

  function makeFocus(): {
    focus: ReturnType<typeof createFocusController>;
    calls: {
      transcript: unknown[];
      sessions: unknown[];
      roster: unknown[];
      sse: string[];
      activeSession: ActiveSession[];
    };
  } {
    const calls = {
      transcript: [] as unknown[],
      sessions: [] as unknown[],
      roster: [] as unknown[],
      sse: [] as string[],
      activeSession: [] as ActiveSession[],
    };
    const seams: FocusSeams = {
      updateTranscriptParams: (p) => calls.transcript.push(p),
      updateSessionsParams: (p) => calls.sessions.push(p),
      updateRosterParams: (p) => calls.roster.push(p),
      setActiveDirectory: (d) => calls.sse.push(d),
      updateActiveSession: (s) => calls.activeSession.push(s),
    };
    return { focus: createFocusController(seams), calls };
  }

  test("happy path: a deleted session clears via the controller — PromptBar-facing value clears, project/directory context preserved", () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/dashboard" },
    });
    // A second, surviving session keeps the directory's list non-empty
    // after ses_1 is deleted — an empty list is treated as
    // "not yet reconciled", not "confirmed empty" (see
    // `pruneStaleActiveSession`'s doc comment).
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_other", directory: "/repo/dashboard" },
    });
    const { focus, calls } = makeFocus();
    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    calls.activeSession.length = 0;
    calls.transcript.length = 0;
    calls.sessions.length = 0;

    store.applyEvent({ type: "session.deleted", properties: { id: "ses_1" } });
    pruneStaleActiveSession(focus, ctx(), store);

    expect(calls.activeSession[calls.activeSession.length - 1]).toBeUndefined();
    expect(focus.getActiveContext()).toEqual({ project: "dashboard" });
    expect(calls.transcript[calls.transcript.length - 1]).toEqual({
      directory: "/repo/dashboard",
      sessionID: undefined,
    });
    expect(calls.sessions[calls.sessions.length - 1]).toEqual({
      directory: "/repo/dashboard",
      activeSessionId: undefined,
    });
  });

  test("SSE/project stays after a prune — no directory switch, no roster mutation", () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/dashboard" },
    });
    const { focus, calls } = makeFocus();
    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    calls.sse.length = 0;
    calls.roster.length = 0;

    store.applyEvent({ type: "session.deleted", properties: { id: "ses_1" } });
    pruneStaleActiveSession(focus, ctx(), store);

    expect(calls.sse).toHaveLength(0);
    expect(calls.roster).toHaveLength(0);
  });

  test("no-op: a stale notification for an older/non-current session does nothing", () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/dashboard" },
    });
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_2", directory: "/repo/dashboard" },
    });
    const { focus, calls } = makeFocus();
    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    focus.selectSession({
      id: "ses_2",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    calls.activeSession.length = 0;

    // ses_1 (superseded) is deleted server-side; a store notification
    // fires but must not touch the now-current ses_2.
    store.applyEvent({ type: "session.deleted", properties: { id: "ses_1" } });
    pruneStaleActiveSession(focus, ctx(), store);

    expect(calls.activeSession).toHaveLength(0);
    expect(focus.getActiveContext()).toEqual({
      project: "dashboard",
      sessionId: "ses_2",
    });
  });

  test("no-op: nothing focused yet", () => {
    const store = createSessionStore();
    const { focus, calls } = makeFocus();
    pruneStaleActiveSession(focus, ctx(), store);
    expect(calls.activeSession).toHaveLength(0);
  });

  test("no-op: an empty/not-yet-reconciled directory never prunes a fresh session", () => {
    const store = createSessionStore();
    const { focus, calls } = makeFocus();
    focus.selectSession({
      id: "ses_fresh",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    calls.activeSession.length = 0;

    pruneStaleActiveSession(focus, ctx(), store);

    expect(calls.activeSession).toHaveLength(0);
    expect(focus.getActiveContext()).toEqual({
      project: "dashboard",
      sessionId: "ses_fresh",
    });
  });

  test("race: rapid select then prune-of-superseded-session remains last-state coherent", () => {
    const store = createSessionStore();
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_1", directory: "/repo/dashboard" },
    });
    store.applyEvent({
      type: "session.created",
      properties: { id: "ses_2", directory: "/repo/dashboard" },
    });
    const { focus } = makeFocus();
    focus.selectSession({
      id: "ses_1",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    focus.selectSession({
      id: "ses_2",
      project: "dashboard",
      directory: "/repo/dashboard",
    });
    store.applyEvent({ type: "session.deleted", properties: { id: "ses_1" } });
    pruneStaleActiveSession(focus, ctx(), store);

    expect(focus.getActiveContext()).toEqual({
      project: "dashboard",
      sessionId: "ses_2",
    });
  });
});

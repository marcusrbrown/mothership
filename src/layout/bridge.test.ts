import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  projectTargetSchema,
  sessionResultSchema,
  sessionTargetSchema,
} from "../ide/commands";
import {
  type SessionToolDeps,
  __resetSessionToolsForTests,
  registerSessionTool,
} from "../ide/executor";
import type { BridgeDeps, WsLike } from "./bridge";
import { connectLayoutBridge, handleBridgeRequest } from "./bridge";
import type { BridgeRequest, LooseBridgeResponse } from "./bridge-protocol";
import { __resetRegistryForTests, registerPanelType } from "./registry";
import { StubDockviewAdapter } from "./test-stub-adapter";

function DummyComponent() {
  return null;
}

beforeEach(() => {
  __resetRegistryForTests();
  registerPanelType("terminal", {
    component: DummyComponent as never,
    title: "Terminal",
  });
});

/** Minimal live-shaped `SessionToolDeps` fixture — one roster project
 * (`dashboard`) and one live session (`ses_live`) owned by it, mirroring
 * `src/ide/executor.test.ts`'s fixture so bridge-layer tests exercise the
 * real resolution path, not a bespoke stub. */
function makeSessionToolDeps(
  overrides: Partial<SessionToolDeps> = {},
): SessionToolDeps {
  return {
    context: {
      roster: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [
          {
            name: "dashboard",
            path: "~/src/dashboard",
            description: "",
            expandedPath: "/Users/marcus/src/dashboard",
            exists: true,
          },
        ],
      },
    },
    store: {
      getSessions: () => [],
      getSession: (id: string) =>
        id === "ses_live"
          ? {
              id: "ses_live",
              directory: "/Users/marcus/src/dashboard",
              status: "idle" as const,
            }
          : undefined,
      getPendingQuestions: () => [],
      subscribe: () => () => {},
      applyEvent: () => {},
      reconcile: () => {},
    },
    bus: {},
    focus: {},
    ...overrides,
  };
}

describe("handleBridgeRequest", () => {
  test("relays a valid mutation through executeCommand and returns the layout", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 1,
      tool: "ide_open_panel",
      params: {
        type: "open_panel",
        panelId: "p1",
        panelType: "terminal",
      },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    expect(res.layout).toBeDefined();
    expect(adapter.hasPanel("p1")).toBe(true);
  });

  test("returns a typed error reply for a command targeting a nonexistent panel", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 2,
      tool: "ide_focus",
      params: { type: "focus", panelId: "missing" },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("panel_not_found");
  });

  test("returns invalid_layout for malformed params against a known layout tool name", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 3,
      tool: "ide_focus",
      params: { type: "not_a_real_command" },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_layout");
  });

  test("security: a panel_not_found error from a malicious/path-shaped panelId never echoes the caller-supplied value in the bridge response", async () => {
    const adapter = new StubDockviewAdapter();
    const maliciousPanelId = "/Users/marcus/.ssh/id_rsa";
    const req: BridgeRequest = {
      kind: "request",
      seq: 12,
      tool: "ide_focus",
      params: { type: "focus", panelId: maliciousPanelId },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("panel_not_found");
    expect(res.error?.message).not.toContain(maliciousPanelId);
    expect(res.error?.message).not.toContain("/Users/marcus");
  });

  test("security: a reference_panel_not_found error from an Authorization/Bearer-shaped referencePanelId never echoes it", async () => {
    const adapter = new StubDockviewAdapter();
    const maliciousRef = "Authorization: Bearer secret-token-xyz";
    const req: BridgeRequest = {
      kind: "request",
      seq: 13,
      tool: "ide_split",
      params: {
        type: "split",
        panelId: "p13",
        panelType: "terminal",
        referencePanelId: maliciousRef,
        direction: "right",
      },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("reference_panel_not_found");
    expect(res.error?.message).not.toContain(maliciousRef);
    expect(res.error?.message).not.toContain("Bearer secret-token-xyz");
  });

  test("security: an unknown_panel_type error from a credential-shaped panelType never echoes it", async () => {
    const adapter = new StubDockviewAdapter();
    const maliciousType = "password=hunter2";
    const req: BridgeRequest = {
      kind: "request",
      seq: 14,
      tool: "ide_open_panel",
      params: { type: "open_panel", panelId: "p14", panelType: maliciousType },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_panel_type");
    expect(res.error?.message).not.toContain(maliciousType);
  });

  test("security: a move_panel panel_not_found error from a path-shaped panelId never echoes it", async () => {
    const adapter = new StubDockviewAdapter();
    const maliciousPanelId = "/etc/passwd";
    const req: BridgeRequest = {
      kind: "request",
      seq: 15,
      tool: "ide_move_panel",
      params: {
        type: "move_panel",
        panelId: maliciousPanelId,
        referencePanelId: "ref",
        direction: "left",
      },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("panel_not_found");
    expect(res.error?.message).not.toContain(maliciousPanelId);
  });

  test("security: an invalid_layout error from a malformed set_layout payload with credential-shaped content never echoes it, including a raw dockview-core throw message", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 16,
      tool: "ide_set_layout",
      params: {
        type: "set_layout",
        layout:
          "not-an-object — Authorization: Bearer abc123 /Users/marcus/secret",
      },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_layout");
    expect(res.error?.message).not.toContain("Bearer abc123");
    expect(res.error?.message).not.toContain("/Users/marcus");
  });

  test("security: a read tool (ide_get_layout/ide_list_panels) success path is unaffected by error normalization — never applies to ok:true responses", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 17,
      tool: "ide_get_layout",
      params: {},
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("layout");
    expect(res.ok).toBe(true);
    expect(res.layout).toBeDefined();
    expect(res.error).toBeUndefined();
  });

  test("unknown tool name (neither a layout tool nor a registered session tool) returns a stable domain:'transport' unknown_tool/not_sent response", async () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 4,
      tool: "totally_bogus_tool_name",
      params: {},
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("transport");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_tool");
    expect(res.error?.delivery).toBe("not_sent");
    expect(res.layout).toBeUndefined();
    expect(res.data).toBeUndefined();
  });

  test("a registered session tool name with no sessionTools deps supplied returns unavailable/not_sent, never falling through to the layout path", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_probe", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    const req: BridgeRequest = {
      kind: "request",
      seq: 5,
      tool: "ide_test_probe",
      params: {},
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
    )) as LooseBridgeResponse; // no sessionTools passed
    expect(res.domain).toBe("session");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unavailable");
    expect(res.error?.delivery).toBe("not_sent");
    // Never populated the layout field — proves no fall-through to the
    // layout path occurred.
    expect(res.layout).toBeUndefined();
  });

  test("a registered session tool name WITH sessionTools deps reaches runSessionTool and returns domain:'session'", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_probe_ok", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    const req: BridgeRequest = {
      kind: "request",
      seq: 6,
      tool: "ide_test_probe_ok",
      params: {},
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
      makeSessionToolDeps(),
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("session");
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.data).toEqual({ probed: true });
    expect(res.layout).toBeUndefined();
  });

  test("a session tool handler failure preserves the executor's error code AND delivery classification verbatim", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_probe_indeterminate", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => {
        throw new Error("simulated upstream failure after partial I/O");
      },
    });

    const req: BridgeRequest = {
      kind: "request",
      seq: 7,
      tool: "ide_test_probe_indeterminate",
      params: {},
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
      makeSessionToolDeps(),
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("session");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal_error");
    expect(res.error?.delivery).toBe("indeterminate");
    // No raw exception text crosses the boundary.
    expect(JSON.stringify(res)).not.toContain("simulated upstream failure");
  });

  test("a session-tool result never populates layout, and a layout result never populates data — the two shapes cannot cross", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_probe_shape", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    const sessionReq: BridgeRequest = {
      kind: "request",
      seq: 8,
      tool: "ide_test_probe_shape",
      params: {},
    };
    const sessionRes = (await handleBridgeRequest(
      sessionReq,
      adapter,
      makeSessionToolDeps(),
    )) as LooseBridgeResponse;
    expect(sessionRes.layout).toBeUndefined();
    expect(sessionRes.data).toBeDefined();

    const layoutReq: BridgeRequest = {
      kind: "request",
      seq: 9,
      tool: "ide_open_panel",
      params: { type: "open_panel", panelId: "p9", panelType: "terminal" },
    };
    const layoutRes = (await handleBridgeRequest(
      layoutReq,
      adapter,
    )) as LooseBridgeResponse;
    expect(layoutRes.data).toBeUndefined();
    expect(layoutRes.layout).toBeDefined();
  });

  test("malformed/poisoned raw params against a session tool are rejected by the executor before the handler runs, without any layout adapter I/O", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    let handlerCalled = false;
    registerSessionTool("ide_test_poisoned", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "session",
      handler: async () => {
        handlerCalled = true;
        return { ok: true, data: {} };
      },
    });

    const req: BridgeRequest = {
      kind: "request",
      seq: 10,
      tool: "ide_test_poisoned",
      params: { sessionId: "/Users/marcus/../escape" },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
      makeSessionToolDeps(),
    )) as LooseBridgeResponse;
    expect(res.domain).toBe("session");
    expect(res.ok).toBe(false);
    expect(handlerCalled).toBe(false);
    expect(adapter.hasPanel("p1")).toBe(false);
  });

  test("a dependency (store getter) throw ESCAPING runSessionTool's own try/catch (during target resolution, before the handler runs) is caught by handleBridgeRequest's own try and sanitized to transport internal_error/indeterminate — no raw text, no unhandled rejection", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_dep_throw_target_resolution", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "session",
      handler: async () => ({ ok: true, data: {} }),
    });

    const req: BridgeRequest = {
      kind: "request",
      seq: 20,
      tool: "ide_test_dep_throw_target_resolution",
      params: { sessionId: "ses_live" },
    };
    const throwingDeps = makeSessionToolDeps({
      // getSession is called during resolveTarget/resolveSession,
      // BEFORE runSessionTool's own handler try/catch scope — a throw
      // here escapes runSessionTool entirely and must be caught by
      // handleBridgeRequest's own try instead.
      store: {
        getSessions: () => [],
        getSession: () => {
          throw new Error("store exploded: /Users/marcus/secret leaked");
        },
        getPendingQuestions: () => [],
        subscribe: () => () => {},
        applyEvent: () => {},
        reconcile: () => {},
      },
    });

    const res = (await handleBridgeRequest(
      req,
      adapter,
      throwingDeps,
    )) as LooseBridgeResponse;

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("internal_error");
    expect(res.error?.delivery).toBe("indeterminate");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("/Users/marcus");
    expect(serialized).not.toContain("store exploded");
  });

  test("safe closed session-tool audit events are emitted with no raw payload/args content, when sessionTools.audit is supplied", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_audit_probe", {
      argsSchema: projectTargetSchema,
      resultSchema: sessionResultSchema({ secretPayload: z.string() }),
      target: "project",
      handler: async () => ({ ok: true, data: { secretPayload: "nope" } }),
    });

    const events: unknown[] = [];
    const req: BridgeRequest = {
      kind: "request",
      seq: 11,
      tool: "ide_test_audit_probe",
      params: { project: "dashboard" },
    };
    const res = (await handleBridgeRequest(
      req,
      adapter,
      makeSessionToolDeps({ audit: (payload) => events.push(payload) }),
    )) as LooseBridgeResponse;
    expect(res.ok).toBe(true);
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.tool).toBe("ide_test_audit_probe");
    expect(event.project).toBe("dashboard");
    expect(JSON.stringify(event)).not.toContain("secretPayload");
    expect(JSON.stringify(event)).not.toContain("nope");
  });
});

class FakeWs implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe("connectLayoutBridge", () => {
  test("sends the auth first-frame with the token before anything else", async () => {
    const adapter = new StubDockviewAdapter();
    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "secret-token" }),
      createSocket: (_url: string) => {
        created = new FakeWs();
        return created;
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();

    created?.onopen?.();
    expect(created?.sent).toHaveLength(1);
    const frame = JSON.parse(created?.sent[0] ?? "{}");
    expect(frame).toEqual({ kind: "auth", token: "secret-token" });

    bridge.close();
  });

  test("answers a relayed request with executeCommand result over the socket", async () => {
    const adapter = new StubDockviewAdapter();
    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    const req: BridgeRequest = {
      kind: "request",
      seq: 7,
      tool: "ide_open_panel",
      params: { type: "open_panel", panelId: "px", panelType: "terminal" },
    };
    created?.onmessage?.({ data: JSON.stringify(req) });
    // handleBridgeRequest is async (session-tool routing awaits
    // runSessionTool) — let its promise settle before reading the reply.
    await Promise.resolve();
    await Promise.resolve();

    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.domain).toBe("layout");
    expect(reply.ok).toBe(true);
    expect(reply.seq).toBe(7);
    expect(adapter.hasPanel("px")).toBe(true);

    bridge.close();
  });

  test("reconnects after the socket closes", async () => {
    const adapter = new StubDockviewAdapter();
    let createCount = 0;
    let latest: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        createCount++;
        latest = new FakeWs();
        return latest;
      },
      reconnectDelayMs: 0,
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(createCount).toBe(1);

    // Simulate a drop of the currently-connected socket.
    latest?.onclose?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(createCount).toBeGreaterThan(1);
    bridge.close();
  });

  test("routes a relayed session-tool request to runSessionTool when sessionTools deps are supplied via connectLayoutBridge", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_connect_probe", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      sessionTools: makeSessionToolDeps(),
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    const req: BridgeRequest = {
      kind: "request",
      seq: 42,
      tool: "ide_test_connect_probe",
      params: {},
    };
    created?.onmessage?.({ data: JSON.stringify(req) });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(created?.sent.length).toBeGreaterThan(1);
    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.domain).toBe("session");
    expect(reply.ok).toBe(true);
    expect(reply.data).toEqual({ probed: true });

    bridge.close();
  });

  test("getSessionTools is resolved PER REQUEST — deps that change after connectLayoutBridge are picked up by the next request, not just the first", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_connect_dynamic", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    const depsHolder: { current: SessionToolDeps | undefined } = {
      current: undefined,
    };
    let created: FakeWs | undefined;
    const bridgeDeps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      getSessionTools: () => depsHolder.current,
    };
    const bridge = connectLayoutBridge(adapter, bridgeDeps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    const req = (seq: number): BridgeRequest => ({
      kind: "request",
      seq,
      tool: "ide_test_connect_dynamic",
      params: {},
    });

    // First request: no deps yet -> unavailable.
    created?.onmessage?.({ data: JSON.stringify(req(1)) });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const firstReply = JSON.parse(created?.sent[1] ?? "{}");
    expect(firstReply.ok).toBe(false);
    expect(firstReply.error.code).toBe("unavailable");

    // Deps become available (simulating a workspace connect completing
    // after the bridge was already mounted) -> the NEXT request must see
    // them, without reconnecting or reconstructing the bridge.
    depsHolder.current = makeSessionToolDeps();
    created?.onmessage?.({ data: JSON.stringify(req(2)) });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const secondReply = JSON.parse(created?.sent[2] ?? "{}");
    expect(secondReply.ok).toBe(true);
    expect(secondReply.data).toEqual({ probed: true });

    bridge.close();
  });

  test("a fixed sessionTools value is still honored when no getSessionTools resolver is supplied (backward compatibility)", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_connect_fixed", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      sessionTools: makeSessionToolDeps(),
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    created?.onmessage?.({
      data: JSON.stringify({
        kind: "request",
        seq: 1,
        tool: "ide_test_connect_fixed",
        params: {},
      }),
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.ok).toBe(true);

    bridge.close();
  });

  test("without sessionTools deps supplied, a relayed session-tool request over the socket returns unavailable/not_sent, never a layout adapter mutation", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    registerSessionTool("ide_test_connect_unavailable", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({ probed: z.boolean() }),
      target: "none",
      handler: async () => ({ ok: true, data: { probed: true } }),
    });

    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      // no sessionTools
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    const req: BridgeRequest = {
      kind: "request",
      seq: 43,
      tool: "ide_test_connect_unavailable",
      params: {},
    };
    created?.onmessage?.({ data: JSON.stringify(req) });
    await Promise.resolve();
    await Promise.resolve();

    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.domain).toBe("session");
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("unavailable");
    expect(reply.error.delivery).toBe("not_sent");
    expect(reply.layout).toBeUndefined();

    bridge.close();
  });

  // --- F: incoming async bridge reliability ---------------------------

  test("a malformed frame with a valid numeric seq gets exactly one stable transport invalid_request/not_sent response", async () => {
    const adapter = new StubDockviewAdapter();
    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    // Valid JSON, valid seq, but not a real request shape (missing tool).
    created?.onmessage?.({
      data: JSON.stringify({ kind: "request", seq: 99 }),
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(created?.sent.length).toBe(2); // auth + exactly one response
    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.domain).toBe("transport");
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("invalid_request");
    expect(reply.error.delivery).toBe("not_sent");
    expect(reply.seq).toBe(99);

    bridge.close();
  });

  test("a malformed frame with NO extractable seq is ignored — no response sent for it at all", async () => {
    const adapter = new StubDockviewAdapter();
    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    created?.onmessage?.({ data: JSON.stringify({ kind: "request" }) }); // no seq
    created?.onmessage?.({ data: "not even json{{{" });
    created?.onmessage?.({ data: JSON.stringify({ totally: "unrelated" }) });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(created?.sent.length).toBe(1); // only the auth frame

    bridge.close();
  });

  test("a send() throw for the response is caught — never an unhandled rejection, never crashes the bridge", async () => {
    const adapter = new StubDockviewAdapter();
    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    let sendCallCount = 0;
    if (created) {
      // Overridden AFTER the auth frame was already sent via onopen —
      // this override only affects the response send that follows.
      created.send = () => {
        sendCallCount++;
        throw new Error("socket write failed");
      };
    }

    const req: BridgeRequest = {
      kind: "request",
      seq: 5,
      tool: "ide_open_panel",
      params: { type: "open_panel", panelId: "px", panelType: "terminal" },
    };
    expect(() =>
      created?.onmessage?.({ data: JSON.stringify(req) }),
    ).not.toThrow();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The send was attempted (and threw) exactly once — the throw never
    // escaped as an unhandled rejection, and the bridge kept running.
    expect(sendCallCount).toBe(1);

    bridge.close();
  });

  test("a dependency (sessionTools handler) throw during routing after routing already picked a domain is caught, sending a sanitized transport internal_error/indeterminate if the socket is still current", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    // Registered so isRegisteredSessionTool is true, but runSessionTool
    // itself is what we're forcing to reject unexpectedly via a broken
    // dep, simulating an exception ESCAPING runSessionTool's own
    // try/catch (a bug in the executor itself, not a handler throw).
    registerSessionTool("ide_test_transport_dep_throw", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: async () => ({ ok: true, data: {} }),
    });

    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      sessionTools: makeSessionToolDeps({
        // A malformed store whose getSession getter throws — this forces
        // an exception path that runSessionTool's own try/catch does NOT
        // cover (a throw during target resolution, before the handler's
        // own try/catch scope).
        store: {
          getSessions: () => [],
          getSession: () => {
            throw new Error("store exploded: /Users/marcus/secret");
          },
          getPendingQuestions: () => [],
          subscribe: () => () => {},
          applyEvent: () => {},
          reconcile: () => {},
        },
      }),
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    created?.onopen?.();

    // sessionId target forces resolveSession -> store.getSession() throw.
    registerSessionTool("ide_test_transport_dep_throw_session", {
      argsSchema: sessionTargetSchema,
      resultSchema: sessionResultSchema({}),
      target: "session",
      handler: async () => ({ ok: true, data: {} }),
    });
    const req: BridgeRequest = {
      kind: "request",
      seq: 6,
      tool: "ide_test_transport_dep_throw_session",
      params: { sessionId: "ses_live" },
    };
    expect(() =>
      created?.onmessage?.({ data: JSON.stringify(req) }),
    ).not.toThrow();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(created?.sent.length).toBeGreaterThan(1);
    const reply = JSON.parse(created?.sent[1] ?? "{}");
    expect(reply.ok).toBe(false);
    expect(reply.error.delivery).toBe("indeterminate");
    // No raw exception text/path crosses the boundary.
    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain("/Users/marcus");
    expect(serialized).not.toContain("store exploded");

    bridge.close();
  });

  test("a stale response for a request whose socket has since closed/reconnected is never sent — only the current socket generation is written to", async () => {
    const adapter = new StubDockviewAdapter();
    __resetSessionToolsForTests();
    let resolveHandler: (() => void) | undefined;
    registerSessionTool("ide_test_stale_response", {
      argsSchema: z.object({}),
      resultSchema: sessionResultSchema({}),
      target: "none",
      handler: () =>
        new Promise<{ ok: true; data: Record<string, never> }>((resolve) => {
          resolveHandler = () => resolve({ ok: true, data: {} });
        }),
    });

    let created: FakeWs | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => ({ port: 1234, token: "t" }),
      createSocket: () => {
        created = new FakeWs();
        return created;
      },
      reconnectDelayMs: 0,
      sessionTools: makeSessionToolDeps(),
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();
    await Promise.resolve();
    const firstSocket = created;
    firstSocket?.onopen?.();

    const req: BridgeRequest = {
      kind: "request",
      seq: 10,
      tool: "ide_test_stale_response",
      params: {},
    };
    firstSocket?.onmessage?.({ data: JSON.stringify(req) });
    await Promise.resolve();

    // The socket closes (and reconnects) BEFORE the pending handler
    // resolves.
    firstSocket?.onclose?.();
    await new Promise((r) => setTimeout(r, 5));
    const secondSocket = created;
    expect(secondSocket).not.toBe(firstSocket);

    const sentBeforeResolve = firstSocket?.sent.length ?? 0;
    // Now the slow handler finally resolves.
    resolveHandler?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The now-closed first socket never received the stale response.
    expect(firstSocket?.sent.length).toBe(sentBeforeResolve);
    // The second (current) socket never received it either — the
    // response belonged to a request issued on the FIRST socket's
    // generation and must not leak onto whichever socket happens to be
    // current when the slow handler finally settles.
    expect(secondSocket?.sent.some((s) => s.includes('"seq":10'))).toBe(false);

    bridge.close();
  });

  test("close-during-getBridgeInfo: closing the bridge while getBridgeInfo is still pending never creates a socket afterward", async () => {
    const adapter = new StubDockviewAdapter();
    let createSocketCallCount = 0;
    let resolveInfo: (() => void) | undefined;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: () =>
        new Promise((resolve) => {
          resolveInfo = () =>
            resolve({ port: 1234, token: "t" } as unknown as never);
        }),
      createSocket: () => {
        createSocketCallCount++;
        return new FakeWs();
      },
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await Promise.resolve();

    bridge.close();
    resolveInfo?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(createSocketCallCount).toBe(0);
  });

  test("getBridgeInfo dependency throw during connect never crashes — schedules a reconnect instead", async () => {
    const adapter = new StubDockviewAdapter();
    let attempts = 0;
    const deps: Partial<BridgeDeps> = {
      getBridgeInfo: async () => {
        attempts++;
        if (attempts === 1) throw new Error("IPC unavailable");
        return { port: 1234, token: "t" };
      },
      createSocket: () => new FakeWs(),
      reconnectDelayMs: 0,
    };
    const bridge = connectLayoutBridge(adapter, deps);
    await new Promise((r) => setTimeout(r, 10));

    expect(attempts).toBeGreaterThan(1);
    bridge.close();
  });
});

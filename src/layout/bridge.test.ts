import { beforeEach, describe, expect, test } from "bun:test";
import type { BridgeDeps, WsLike } from "./bridge";
import { connectLayoutBridge, handleBridgeRequest } from "./bridge";
import type { BridgeRequest } from "./bridge-protocol";
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

describe("handleBridgeRequest", () => {
  test("relays a valid mutation through executeCommand and returns the layout", () => {
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
    const res = handleBridgeRequest(req, adapter);
    expect(res.ok).toBe(true);
    expect(res.seq).toBe(1);
    expect(res.layout).toBeDefined();
    expect(adapter.hasPanel("p1")).toBe(true);
  });

  test("returns a typed error reply for a command targeting a nonexistent panel", () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 2,
      tool: "ide_focus",
      params: { type: "focus", panelId: "missing" },
    };
    const res = handleBridgeRequest(req, adapter);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("panel_not_found");
  });

  test("returns invalid_layout for malformed params", () => {
    const adapter = new StubDockviewAdapter();
    const req: BridgeRequest = {
      kind: "request",
      seq: 3,
      tool: "ide_focus",
      params: { type: "not_a_real_command" },
    };
    const res = handleBridgeRequest(req, adapter);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_layout");
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

    const reply = JSON.parse(created?.sent[1] ?? "{}");
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
});

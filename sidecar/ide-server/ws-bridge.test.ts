import { describe, expect, test } from "bun:test";
import type { BridgeSocket } from "./ws-bridge";
import { createWsBridge } from "./ws-bridge";

class FakeSocket implements BridgeSocket {
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | undefined;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
  }
}

describe("ws-bridge auth", () => {
  test("correct first-frame token authenticates the socket", () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));
    expect(bridge.isReady()).toBe(true);
    expect(sock.closedWith).toBeUndefined();
  });

  test("wrong first-frame token closes the socket", () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "wrong" }));
    expect(bridge.isReady()).toBe(false);
    expect(sock.closedWith?.[0]).toBe(4003);
  });

  test("missing/malformed first-frame closes the socket", () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(
      sock,
      JSON.stringify({ kind: "response", seq: 1, ok: true }),
    );
    expect(bridge.isReady()).toBe(false);
    expect(sock.closedWith?.[0]).toBe(4003);
  });

  test("auth timeout closes an unauthenticated socket", async () => {
    const bridge = createWsBridge("tok", { authTimeoutMs: 5 });
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    await new Promise((r) => setTimeout(r, 20));
    expect(sock.closedWith?.[0]).toBe(4001);
  });
});

describe("ws-bridge dispatch", () => {
  test("dispatch before any webview auth returns unavailable, never hangs", async () => {
    const bridge = createWsBridge("tok");
    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unavailable");
  });

  test("dispatch after auth relays request and resolves on matching response", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(sock.sent).toHaveLength(1);
    const sentReq = JSON.parse(sock.sent[0] ?? "{}");
    expect(sentReq.kind).toBe("request");
    expect(sentReq.tool).toBe("ide_focus");

    bridge.onMessage(
      sock,
      JSON.stringify({
        kind: "response",
        seq: sentReq.seq,
        ok: true,
        layout: { panels: {} },
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
  });

  test("WS drop after dispatch rejects pending request with disconnected, no orphans", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    bridge.onClose(sock);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("disconnected");
  });

  test("dispatch times out if no response arrives", async () => {
    const bridge = createWsBridge("tok", { requestTimeoutMs: 5 });
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("timeout");
  });
});

import { describe, expect, test } from "bun:test";
import type {
  BridgeError,
  BridgeResponse,
} from "../../src/layout/bridge-protocol";
import type { BridgeSocket } from "./ws-bridge";
import { createWsBridge } from "./ws-bridge";

/** Narrows a `BridgeResponse` to its `ok:false` branch and returns its
 * `error`, throwing (failing the test with a clear message) if the
 * response was actually `ok:true` — a genuine type-narrowing assertion,
 * not merely an `expect(...).toBe(false)` runtime check that leaves
 * `error` unnarrowed for the type checker. */
function expectError(res: BridgeResponse): BridgeError {
  if (res.ok) {
    throw new Error(
      `expected an ok:false response, got ok:true domain:"${res.domain}"`,
    );
  }
  return res.error;
}

class FakeSocket implements BridgeSocket {
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | undefined;
  /** Bun `ServerWebSocket.send` return value to simulate. Defaults to a
   * positive byte count (accepted). */
  sendReturn = 1;
  send(data: string): number {
    this.sent.push(data);
    return this.sendReturn;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
  }
}

/** A minimal socket double whose `send` returns `void`, matching a
 * hand-written client that doesn't follow Bun's numeric-return contract. */
class VoidSendSocket implements BridgeSocket {
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
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: 1,
        ok: true,
        layout: {},
      }),
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

describe("WsBridge is source-compatible with a minimal unrelated stub", () => {
  test("a stub implementing only the required members (no pendingCount) satisfies WsBridge and typechecks", async () => {
    // Mirrors sidecar/ide-server/mcp-server.test.ts's `stubBridge` shape:
    // a WsBridge consumer that never calls pendingCount() must not be
    // forced to implement it.
    const stub: import("./ws-bridge").WsBridge = {
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
      isReady: () => true,
      dispatch: async () => ({
        kind: "response",
        domain: "layout",
        seq: 1,
        ok: true,
        layout: {},
      }),
    };
    expect(stub.isReady()).toBe(true);
    expect(stub.pendingCount).toBeUndefined();
    const res = await stub.dispatch("ide_focus", {});
    expect(res.ok).toBe(true);
  });
});

describe("ws-bridge dispatch", () => {
  test("dispatch before any webview auth returns unavailable, never hangs; domain:transport delivery:not_sent", async () => {
    const bridge = createWsBridge("tok");
    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    const error = expectError(res);
    expect(error.code).toBe("unavailable");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("not_sent");
  });

  test("dispatch after auth relays request and resolves on matching response, passing through the webview's own domain/delivery unchanged", async () => {
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
        domain: "layout",
        seq: sentReq.seq,
        ok: true,
        layout: { panels: {} },
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
    // The sidecar must pass the webview's own domain through verbatim,
    // never overwriting it with "transport".
    expect(res.domain).toBe("layout");
  });

  test("dispatch after auth passes through a webview session-domain error response's delivery unchanged", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_get_session", { sessionId: "s1" });
    const sentReq = JSON.parse(sock.sent[0] ?? "{}");

    bridge.onMessage(
      sock,
      JSON.stringify({
        kind: "response",
        domain: "session",
        seq: sentReq.seq,
        ok: false,
        error: {
          code: "not_found",
          message: "session not found",
          delivery: "indeterminate",
        },
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(res.domain).toBe("session");
    const error = expectError(res);
    expect(error.code).toBe("not_found");
    expect(error.delivery).toBe("indeterminate");
  });

  test("WS drop after dispatch rejects pending request with disconnected, no orphans; domain:transport delivery:indeterminate (accepted send, outcome unknown)", async () => {
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
    const error = expectError(res);
    expect(error.code).toBe("disconnected");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("indeterminate");
  });

  test("dispatch times out if no response arrives; domain:transport delivery:indeterminate (accepted send, outcome unknown)", async () => {
    const bridge = createWsBridge("tok", { requestTimeoutMs: 5 });
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    const error = expectError(res);
    expect(error.code).toBe("timeout");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("indeterminate");
  });

  test("send throw classifies as not-sent, never registers pending; domain:transport delivery:not_sent", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));
    sock.send = () => {
      throw new Error("socket blew up with secret token abc123");
    };

    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    const error = expectError(res);
    expect(error.code).toBe("send_failed");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("not_sent");
    // No leaked raw error text (tokens/paths/payload) in the classified result.
    expect(JSON.stringify(res)).not.toContain("secret token");
    expect(bridge.pendingCount?.()).toBe(0);
  });

  test("send returning 0 (Bun-dropped frame) classifies as not-sent, never registers pending; domain:transport delivery:not_sent", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));
    sock.sendReturn = 0;

    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    const error = expectError(res);
    expect(error.code).toBe("send_failed");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("not_sent");
    expect(bridge.pendingCount?.()).toBe(0);
  });

  test("send returning -1 (queued/backpressure) stays pending and resolves normally on response", async () => {
    const bridge = createWsBridge("tok");
    const sock = new FakeSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));
    sock.sendReturn = -1;

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(bridge.pendingCount?.()).toBe(1);
    const sentReq = JSON.parse(sock.sent[0] ?? "{}");

    bridge.onMessage(
      sock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: sentReq.seq,
        ok: true,
        layout: {},
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(bridge.pendingCount?.()).toBe(0);
  });

  test("a void-returning send (non-Bun test double) is treated as accepted, not not-sent", async () => {
    const bridge = createWsBridge("tok");
    const sock = new VoidSendSocket();
    bridge.onOpen(sock);
    bridge.onMessage(sock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(bridge.pendingCount?.()).toBe(1);
    const sentReq = JSON.parse(sock.sent[0] ?? "{}");

    bridge.onMessage(
      sock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: sentReq.seq,
        ok: true,
        layout: {},
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
  });
});

describe("ws-bridge socket generation / replacement", () => {
  test("replacement rejects pending requests owned by the old generation before activating the new socket; domain:transport delivery:indeterminate", async () => {
    const bridge = createWsBridge("tok");
    const oldSock = new FakeSocket();
    bridge.onOpen(oldSock);
    bridge.onMessage(oldSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(bridge.pendingCount?.()).toBe(1);

    const newSock = new FakeSocket();
    bridge.onOpen(newSock);
    bridge.onMessage(newSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const res = await promise;
    expect(res.ok).toBe(false);
    const error = expectError(res);
    expect(error.code).toBe("replaced");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("indeterminate");
    expect(bridge.pendingCount?.()).toBe(0);
    expect(bridge.isReady()).toBe(true);
  });

  test("a late response from the old generation cannot resolve a request on the new generation, even with a colliding seq", async () => {
    const bridge = createWsBridge("tok");
    const oldSock = new FakeSocket();
    bridge.onOpen(oldSock);
    bridge.onMessage(oldSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const oldPromise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    const oldSeq = JSON.parse(oldSock.sent[0] ?? "{}").seq;

    const newSock = new FakeSocket();
    bridge.onOpen(newSock);
    bridge.onMessage(newSock, JSON.stringify({ kind: "auth", token: "tok" }));
    await oldPromise; // rejected as "replaced" once the new socket authenticated

    const newPromise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "y",
    });
    const newSeq = JSON.parse(newSock.sent[0] ?? "{}").seq;

    // Simulate a seq collision: the (no longer authenticated) old socket
    // sends a response carrying the new generation's seq number.
    bridge.onMessage(
      oldSock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: newSeq,
        ok: true,
        layout: {},
      }),
    );

    // The stray frame must not resolve the live request.
    const race = await Promise.race([
      newPromise.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("pending"), 20)),
    ]);
    expect(race).toBe("pending");

    bridge.onMessage(
      newSock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: newSeq,
        ok: true,
        layout: {},
      }),
    );
    const res = await newPromise;
    expect(res.ok).toBe(true);
    expect(oldSeq).not.toBe(newSeq);
  });

  test("close of the old generation's socket after replacement does not touch the new generation's pending requests", async () => {
    const bridge = createWsBridge("tok");
    const oldSock = new FakeSocket();
    bridge.onOpen(oldSock);
    bridge.onMessage(oldSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const newSock = new FakeSocket();
    bridge.onOpen(newSock);
    bridge.onMessage(newSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(bridge.pendingCount?.()).toBe(1);

    // The old, already-replaced socket disconnects.
    bridge.onClose(oldSock);

    expect(bridge.pendingCount?.()).toBe(1);
    expect(bridge.isReady()).toBe(true);

    const seq = JSON.parse(newSock.sent[0] ?? "{}").seq;
    bridge.onMessage(
      newSock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq,
        ok: true,
        layout: {},
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
  });

  test("a replaced (stale) socket sending another valid auth frame cannot re-auth and evict the current socket", async () => {
    const bridge = createWsBridge("tok");
    const oldSock = new FakeSocket();
    bridge.onOpen(oldSock);
    bridge.onMessage(oldSock, JSON.stringify({ kind: "auth", token: "tok" }));

    const newSock = new FakeSocket();
    bridge.onOpen(newSock);
    bridge.onMessage(newSock, JSON.stringify({ kind: "auth", token: "tok" }));
    expect(bridge.isReady()).toBe(true);

    const promise = bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(bridge.pendingCount?.()).toBe(1);

    // The stale, already-replaced socket resends a perfectly valid auth
    // frame. It must be ignored outright — it can never re-enter the
    // pre-auth path and evict the current generation.
    oldSock.sent = [];
    bridge.onMessage(oldSock, JSON.stringify({ kind: "auth", token: "tok" }));

    // The current socket and its in-flight request are untouched.
    expect(bridge.pendingCount?.()).toBe(1);
    expect(bridge.isReady()).toBe(true);

    const sentReq = JSON.parse(newSock.sent[0] ?? "{}");
    bridge.onMessage(
      newSock,
      JSON.stringify({
        kind: "response",
        domain: "layout",
        seq: sentReq.seq,
        ok: true,
        layout: {},
      }),
    );
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(oldSock.closedWith).toBeUndefined();
  });

  test("close of the current generation's socket rejects only that generation's pending requests as disconnected; domain:transport delivery:indeterminate", async () => {
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
    const error = expectError(res);
    expect(error.code).toBe("disconnected");
    expect(res.domain).toBe("transport");
    expect(error.delivery).toBe("indeterminate");
    expect(bridge.pendingCount?.()).toBe(0);
    expect(bridge.isReady()).toBe(false);
  });
});

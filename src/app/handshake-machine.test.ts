/**
 * DOM-free tests for the supervision-aware handshake machine. Stubs
 * `ensureServer`/`connectServer` directly (the injected HandshakeDeps),
 * matching this module's own DOM-free design rather than mocking Tauri's
 * `invoke`/`listen` (that boundary is covered by StartupHandshake.test.ts).
 */
import { describe, expect, test } from "bun:test";
import type {
  HandshakeDeps,
  HandshakeState,
  ServerStateWire,
} from "./handshake-machine";
import { reduceLiveStatus, runSupervisedHandshake } from "./handshake-machine";

function deps(overrides: Partial<HandshakeDeps> = {}): HandshakeDeps {
  return {
    ensureServer: async () => ({ status: "running", adopted: true }),
    connectServer: async (workspaceDir) => ({
      status: "connected",
      context: { fixture: true },
      workspacePath: workspaceDir,
    }),
    ...overrides,
  };
}

describe("runSupervisedHandshake", () => {
  test("adopted server -> straight to connecting then connected, no spawn UI stall", async () => {
    const updates: HandshakeState["status"][] = [];
    const result = await runSupervisedHandshake(
      "/ws",
      deps({
        ensureServer: async () => ({ status: "running", adopted: true }),
      }),
      (s) => updates.push(s.status),
    );
    expect(result.status).toBe("connected");
    expect(updates).toEqual(["starting", "connecting", "connected"]);
  });

  test("spawned/running server -> shows starting then connected", async () => {
    const updates: HandshakeState["status"][] = [];
    const result = await runSupervisedHandshake(
      "/ws",
      deps({
        ensureServer: async () => ({ status: "running", adopted: false }),
      }),
      (s) => updates.push(s.status),
    );
    expect(result.status).toBe("connected");
    expect(updates).toEqual(["starting", "connecting", "connected"]);
  });

  test("ensure_server reports failed -> failed state, no connectServer call", async () => {
    let connectServerCalled = false;
    const result = await runSupervisedHandshake(
      "/ws",
      deps({
        ensureServer: async () => ({
          status: "failed",
          adopted: false,
          reason: "opencode not on PATH",
        }),
        connectServer: async () => {
          connectServerCalled = true;
          return { status: "connected", context: {}, workspacePath: "/ws" };
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.message).toBe("opencode not on PATH");
    expect(connectServerCalled).toBe(false);
  });

  test("ensure_server throws -> failed state with the error message", async () => {
    const result = await runSupervisedHandshake(
      "/ws",
      deps({
        ensureServer: async () => {
          throw new Error("invoke unavailable");
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.message).toBe("invoke unavailable");
  });

  test("retry re-invokes ensure_server and can succeed after a prior failure", async () => {
    let call = 0;
    const ensureServer = async (): Promise<ServerStateWire> => {
      call += 1;
      return call === 1
        ? { status: "failed", adopted: false, reason: "boom" }
        : { status: "running", adopted: true };
    };
    const first = await runSupervisedHandshake("/ws", deps({ ensureServer }));
    expect(first.status).toBe("failed");
    const second = await runSupervisedHandshake("/ws", deps({ ensureServer }));
    expect(second.status).toBe("connected");
    expect(call).toBe(2);
  });

  test("connectServer failure after a running server -> failed state", async () => {
    const result = await runSupervisedHandshake(
      "/ws",
      deps({
        connectServer: async () => ({
          status: "failed",
          message: "roster probe failed",
        }),
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.message).toBe("roster probe failed");
  });
});

describe("reduceLiveStatus", () => {
  test("restarting event after connect -> restarting", () => {
    expect(
      reduceLiveStatus("running", { status: "restarting", adopted: false }),
    ).toBe("restarting");
  });

  test("running event after a restart -> back to running", () => {
    expect(
      reduceLiveStatus("restarting", { status: "running", adopted: false }),
    ).toBe("running");
  });

  test("failed event (restart cap exceeded) -> failed", () => {
    expect(
      reduceLiveStatus("restarting", {
        status: "failed",
        adopted: false,
        reason: "restart cap exceeded",
      }),
    ).toBe("failed");
  });
});

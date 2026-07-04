/**
 * Exercises `runHandshake` (the DOM-free handshake state machine). Stubs
 * `globalThis.fetch` (the actual boundary space-bus's /core reads —
 * consistent with src/server/bus.test.ts's convention, avoiding
 * `mock.module`'s process-global leakage across test files) so the
 * `roster()` probe can be driven ok/error, and injects stub
 * readTextFile/pathExists directly since `runHandshake` accepts a
 * workspaceDir + uses the real tauri-fs module — for this DOM-free test we
 * exercise the underlying pieces (loadWorkspace/buildBusContext/roster)
 * that `runHandshake` composes, matching the config.test.ts/context.test.ts
 * stubbing style, then verify runHandshake's own control flow against a
 * virtual (missing spacebus.json) workspace so no real file I/O occurs.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// Stub the Tauri IPC boundary so loadWorkspace's readTextFile "fails" like a
// missing spacebus.json (ENOENT) without touching the real filesystem or
// requiring a live Tauri runtime — same approach as tauri-fs.test.ts.
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "read_text_file") throw new Error("ENOENT");
    if (cmd === "path_exists") return true;
    if (cmd === "home_dir") return "/Users/marcus";
    throw new Error(`unexpected invoke: ${cmd}`);
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    handler(String(input))) as typeof fetch;
}

describe("runHandshake", () => {
  test("server answers -> connected with a BusContext", async () => {
    stubFetch((url) => {
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/session")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const { runHandshake } = await import("./StartupHandshake");
    // No spacebus.json on this synthetic directory -> virtual workspace,
    // real filesystem never touched (tauri-fs's readTextFile against a
    // path that doesn't exist behaves like ENOENT via the real Tauri
    // command, but we never invoke it here — homeDir()/readTextFile()
    // calls fail closed in a non-Tauri test environment, which
    // loadWorkspace treats as "missing file").
    const state = await runHandshake("/tmp/mothership-handshake-test-ok");
    expect(state.status).toBe("connected");
    if (state.status !== "connected") throw new Error("expected connected");
    expect(state.workspacePath).toBe("/tmp/mothership-handshake-test-ok");
    expect(state.context.roster.projects).toHaveLength(1);
  });

  test("server fails -> failed state with a message", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));

    const { runHandshake } = await import("./StartupHandshake");
    const state = await runHandshake("/tmp/mothership-handshake-test-fail");
    expect(state.status).toBe("failed");
    if (state.status !== "failed") throw new Error("expected failed");
    expect(state.message.length).toBeGreaterThan(0);
  });

  test("retry after failure re-probes and can succeed", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const { runHandshake } = await import("./StartupHandshake");
    const first = await runHandshake("/tmp/mothership-handshake-test-retry");
    expect(first.status).toBe("failed");

    stubFetch((url) => {
      if (url.includes("/session/status")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes("/session")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const second = await runHandshake("/tmp/mothership-handshake-test-retry");
    expect(second.status).toBe("connected");
  });
});

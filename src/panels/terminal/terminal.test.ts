import { describe, expect, mock, test } from "bun:test";
import { createTerminalController } from "./terminal-controller";
import type { Terminal, TerminalExitInfo } from "./terminal-interface";

/** Builds a stub Terminal backend with controllable data/exit emission. */
function createStubBackend() {
  const dataHandlers = new Map<string, (chunk: string) => void>();
  const exitHandlers = new Map<string, (info: TerminalExitInfo) => void>();
  const writes: Array<{ sessionId: string; data: string }> = [];
  const resizes: Array<{ sessionId: string; cols: number; rows: number }> = [];
  const killed: string[] = [];
  let nextId = 0;
  let spawnImpl: ((cols: number, rows: number) => Promise<string>) | null =
    null;

  const backend: Terminal = {
    spawn: mock(async (cols: number, rows: number) => {
      if (spawnImpl) return spawnImpl(cols, rows);
      return `session-${nextId++}`;
    }),
    write: mock(async (sessionId: string, data: string) => {
      writes.push({ sessionId, data });
    }),
    resize: mock(async (sessionId: string, cols: number, rows: number) => {
      resizes.push({ sessionId, cols, rows });
    }),
    kill: mock(async (sessionId: string) => {
      killed.push(sessionId);
    }),
    onData: mock(
      async (sessionId: string, handler: (chunk: string) => void) => {
        dataHandlers.set(sessionId, handler);
        return () => dataHandlers.delete(sessionId);
      },
    ),
    onExit: mock(
      async (sessionId: string, handler: (info: TerminalExitInfo) => void) => {
        exitHandlers.set(sessionId, handler);
        return () => exitHandlers.delete(sessionId);
      },
    ),
  };

  return {
    backend,
    writes,
    resizes,
    killed,
    emitData: (sessionId: string, chunk: string) =>
      dataHandlers.get(sessionId)?.(chunk),
    emitExit: (sessionId: string, info: TerminalExitInfo) =>
      exitHandlers.get(sessionId)?.(info),
    setSpawnImpl: (impl: (cols: number, rows: number) => Promise<string>) => {
      spawnImpl = impl;
    },
  };
}

describe("terminal-controller", () => {
  test("spawn-on-mount lifecycle: spawning → running with session id", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);

    expect(controller.getState().status).toBe("spawning");

    await controller.spawn(80, 24);

    const state = controller.getState();
    expect(state.status).toBe("running");
    expect(stub.backend.spawn).toHaveBeenCalledWith(80, 24, undefined);
    if (state.status === "running") {
      expect(state.sessionId).toBe("session-0");
    }
  });

  test("data round-trip through the interface", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    await controller.spawn(80, 24);

    const received: string[] = [];
    controller.onOutput((chunk) => received.push(chunk));

    stub.emitData("session-0", "hello\r\n");

    expect(received).toEqual(["hello\r\n"]);

    await controller.write("echo hi\n");
    expect(stub.writes).toEqual([
      { sessionId: "session-0", data: "echo hi\n" },
    ]);
  });

  test("kill on unmount (dispose)", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    await controller.spawn(80, 24);

    await controller.dispose();

    expect(stub.killed).toEqual(["session-0"]);
  });

  test("resize propagates cols/rows to the backend", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    await controller.spawn(80, 24);

    await controller.resize(120, 40);

    expect(stub.resizes).toEqual([
      { sessionId: "session-0", cols: 120, rows: 40 },
    ]);
  });

  test("resize is a no-op when not running", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    // Not spawned yet — status is "spawning".

    await controller.resize(120, 40);

    expect(stub.resizes).toEqual([]);
  });

  test("PTY exit transitions to exited state, no zombie subscriptions", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    await controller.spawn(80, 24);

    const states: string[] = [];
    controller.onStateChange((s) => states.push(s.status));

    stub.emitExit("session-0", { code: 0 });

    const state = controller.getState();
    expect(state.status).toBe("exited");
    if (state.status === "exited") {
      expect(state.sessionId).toBe("session-0");
      expect(state.exitInfo).toEqual({ code: 0 });
    }
    expect(states).toEqual(["exited"]);

    // write after exit should be a no-op, not throw.
    await controller.write("still typing\n");
    expect(stub.writes).toEqual([]);
  });

  test("spawn failure surfaces error state instead of throwing", async () => {
    const stub = createStubBackend();
    stub.setSpawnImpl(async () => {
      throw new Error("openpty failed");
    });
    const controller = createTerminalController(stub.backend);

    await controller.spawn(80, 24);

    const state = controller.getState();
    expect(state.status).toBe("error");
    if (state.status === "error") {
      expect(state.message).toBe("openpty failed");
    }
  });

  test("respawn tears down previous session subscriptions before spawning anew", async () => {
    const stub = createStubBackend();
    const controller = createTerminalController(stub.backend);
    await controller.spawn(80, 24);
    await controller.spawn(80, 24);

    const state = controller.getState();
    expect(state.status).toBe("running");
    if (state.status === "running") {
      expect(state.sessionId).toBe("session-1");
    }

    // Old session's data handler should no longer be attached.
    const received: string[] = [];
    controller.onOutput((chunk) => received.push(chunk));
    stub.emitData("session-0", "stale");
    expect(received).toEqual([]);
  });
});

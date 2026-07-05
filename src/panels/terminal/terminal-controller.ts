// Plain state machine for the terminal panel — no DOM, no xterm. TerminalPanel
// is a thin shell over this controller so lifecycle logic (spawn/write/kill/
// resize/exit) is testable without a browser environment.

import type { Terminal, TerminalExitInfo } from "./terminal-interface";

export type TerminalControllerState =
  | { status: "spawning" }
  | { status: "running"; sessionId: string }
  | { status: "exited"; sessionId: string; exitInfo: TerminalExitInfo }
  | { status: "error"; message: string };

export interface TerminalController {
  getState(): TerminalControllerState;
  /** Spawns (or respawns) a session at the given dimensions, optionally in `cwd`. */
  spawn(cols: number, rows: number, cwd?: string): Promise<void>;
  /** Writes data to the active session; no-op if not running. */
  write(data: string): Promise<void>;
  /** Propagates a resize to the active session; no-op if not running. */
  resize(cols: number, rows: number): Promise<void>;
  /** Kills the active session, if any, and tears down subscriptions. */
  dispose(): Promise<void>;
  /** Subscribes to output chunks from the active session. */
  onOutput(handler: (chunk: string) => void): () => void;
  /** Subscribes to state transitions. */
  onStateChange(handler: (state: TerminalControllerState) => void): () => void;
}

export function createTerminalController(
  backend: Terminal,
): TerminalController {
  let state: TerminalControllerState = { status: "spawning" };
  let unsubscribers: Array<() => void> = [];
  const outputHandlers = new Set<(chunk: string) => void>();
  const stateHandlers = new Set<(state: TerminalControllerState) => void>();

  function setState(next: TerminalControllerState): void {
    state = next;
    for (const handler of stateHandlers) handler(state);
  }

  async function teardownSession(): Promise<void> {
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
  }

  async function spawn(
    cols: number,
    rows: number,
    cwd?: string,
  ): Promise<void> {
    await teardownSession();
    setState({ status: "spawning" });

    let sessionId: string;
    try {
      sessionId = await backend.spawn(cols, rows, cwd);
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const unData = await backend.onData(sessionId, (chunk) => {
      for (const handler of outputHandlers) handler(chunk);
    });
    const unExit = await backend.onExit(sessionId, (info) => {
      setState({ status: "exited", sessionId, exitInfo: info });
    });
    unsubscribers = [unData, unExit];

    setState({ status: "running", sessionId });
  }

  async function write(data: string): Promise<void> {
    if (state.status !== "running") return;
    await backend.write(state.sessionId, data);
  }

  async function resize(cols: number, rows: number): Promise<void> {
    if (state.status !== "running") return;
    await backend.resize(state.sessionId, cols, rows);
  }

  async function dispose(): Promise<void> {
    await teardownSession();
    if (state.status === "running") {
      await backend.kill(state.sessionId);
    }
  }

  function onOutput(handler: (chunk: string) => void): () => void {
    outputHandlers.add(handler);
    return () => outputHandlers.delete(handler);
  }

  function onStateChange(
    handler: (state: TerminalControllerState) => void,
  ): () => void {
    stateHandlers.add(handler);
    return () => stateHandlers.delete(handler);
  }

  return {
    getState: () => state,
    spawn,
    write,
    resize,
    dispose,
    onOutput,
    onStateChange,
  };
}

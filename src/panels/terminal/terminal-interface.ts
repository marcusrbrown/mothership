// Reversibility seam (promoted from spikes/0b-pty, decision doc:
// docs/solutions/best-practices/pty-portable-pty-xterm6-decision-2026-07-04.md):
// the terminal panel consumes ONLY this interface, never the Tauri APIs
// directly. Swapping the backend (e.g. tauri-plugin-pty, a WebSocket bridge,
// a mock for tests) means implementing this interface — nothing else changes.

export interface TerminalExitInfo {
  code: number | null;
}

export interface Terminal {
  /** Spawns the backing process/PTY and returns an opaque session id.
   * `cwd`, when given, is the working directory the shell should start in. */
  spawn(cols: number, rows: number, cwd?: string): Promise<string>;
  /** Writes raw bytes/text to the session's stdin. */
  write(sessionId: string, data: string): Promise<void>;
  /** Propagates a terminal resize (rows/cols) to the backing process. */
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Terminates the backing process and releases its resources. */
  kill(sessionId: string): Promise<void>;
  /** Subscribes to output chunks; returns an unsubscribe function. */
  onData(
    sessionId: string,
    handler: (chunk: string) => void,
  ): Promise<() => void>;
  /** Subscribes to the session's exit event; returns an unsubscribe function. */
  onExit(
    sessionId: string,
    handler: (info: TerminalExitInfo) => void,
  ): Promise<() => void>;
}

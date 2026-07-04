// Tauri implementation of the Terminal seam (./terminal-interface.ts).
// Talks to src-tauri/src/pty.rs commands + pty://output/{id} / pty://exit/{id}
// events. Promoted from spikes/0b-pty/tauri-terminal.ts.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal, TerminalExitInfo } from "./terminal-interface";

export const tauriTerminal: Terminal = {
  async spawn(cols, rows) {
    return invoke<string>("pty_spawn", { cols, rows });
  },
  async write(sessionId, data) {
    await invoke("pty_write", { ptyId: sessionId, data });
  },
  async resize(sessionId, cols, rows) {
    await invoke("pty_resize", { ptyId: sessionId, cols, rows });
  },
  async kill(sessionId) {
    await invoke("pty_kill", { ptyId: sessionId });
  },
  async onData(sessionId, handler) {
    const unlisten = await listen<string>(
      `pty://output/${sessionId}`,
      (event) => {
        handler(event.payload);
      },
    );
    return unlisten;
  },
  async onExit(sessionId, handler) {
    const unlisten = await listen<TerminalExitInfo>(
      `pty://exit/${sessionId}`,
      (event) => {
        handler(event.payload);
      },
    );
    return unlisten;
  },
};

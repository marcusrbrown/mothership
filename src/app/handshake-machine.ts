/**
 * DOM-free supervision-aware handshake state machine (U1.9). Wraps the
 * `ensure_server`/`server_state` Tauri commands and the `server://state`
 * event, then gates the existing workspace/bus-context/roster probe
 * (`connectServer`, injected — see StartupHandshake.tsx) behind a running
 * server. Extracted from StartupHandshake.tsx so it's testable without
 * mounting React or a real Tauri runtime.
 */

export type ServerStatus = "starting" | "running" | "restarting" | "failed";

export interface ServerStateWire {
  status: ServerStatus;
  adopted: boolean;
  reason?: string | null;
}

export type HandshakeState =
  | { status: "starting" }
  | { status: "connecting" }
  | {
      status: "connected";
      context: unknown;
      workspacePath: string;
      manifest?: unknown;
    }
  | { status: "failed"; message: string };

export interface HandshakeDeps {
  /** Invokes the `ensure_server` Tauri command. */
  ensureServer: (dir?: string) => Promise<ServerStateWire>;
  /** Runs the existing workspace→bus-context→roster probe once the server
   * is confirmed running. Returns a connected/failed handshake outcome. */
  connectServer: (workspaceDir: string) => Promise<
    | {
        status: "connected";
        context: unknown;
        workspacePath: string;
        manifest?: unknown;
      }
    | { status: "failed"; message: string }
  >;
}

/**
 * Runs one full attempt: ensure_server (adopt-or-spawn) → on success, the
 * existing connectServer probe. `onUpdate` is called for every intermediate
 * state (starting/connecting) so a caller can render live progress; the
 * returned promise resolves with the terminal state (connected or failed).
 *
 * ensure_server's Tauri command blocks until the server is confirmed
 * running or failed (it does its own bounded probe/spawn poll on the Rust
 * side), so "starting" here is purely a UI signal for the spawn window —
 * there's no separate "restarting" branch mid-attempt; restarts that happen
 * *after* a successful connect are reflected via `reduceServerEvent`
 * against live `server://state` events instead.
 */
export async function runSupervisedHandshake(
  workspaceDir: string,
  deps: HandshakeDeps,
  onUpdate?: (state: HandshakeState) => void,
): Promise<HandshakeState> {
  onUpdate?.({ status: "starting" });
  let wire: ServerStateWire;
  try {
    wire = await deps.ensureServer(workspaceDir);
  } catch (err) {
    const failed: HandshakeState = {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
    onUpdate?.(failed);
    return failed;
  }

  if (wire.status !== "running") {
    const failed: HandshakeState = {
      status: "failed",
      message: wire.reason ?? "opencode serve failed to start",
    };
    onUpdate?.(failed);
    return failed;
  }

  onUpdate?.({ status: "connecting" });
  const result = await deps.connectServer(workspaceDir);
  onUpdate?.(result);
  return result;
}

/**
 * Post-connect live-status reducer for the `server://state` event stream.
 * Pure function of (current chip status, incoming wire event) -> next chip
 * status — kept separate from `HandshakeState` because a restart while
 * already connected shouldn't tear down the mounted workspace; it should
 * only move a small status chip (running -> restarting -> running, or ->
 * failed if the restart cap is exceeded).
 */
export function reduceLiveStatus(
  _current: ServerStatus,
  event: ServerStateWire,
): ServerStatus {
  return event.status;
}

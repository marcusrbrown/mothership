/**
 * Startup handshake screen (Flow Analysis item 5 / U1.2's handshake
 * requirement, extended by U1.9 for server supervision): ensures
 * `opencode serve` is running (adopted or spawned via the Rust
 * server_supervisor), loads the workspace, builds a BusContext, and probes
 * the server with a cheap `roster()` call before mounting the real shell.
 * States: starting (spawning opencode serve…) → connecting (cyan pulse,
 * connecting-only glow per DESIGN.md) → connected (renders children) or
 * failed (with retry, orange highlight). After connecting, a small status
 * chip reflects live `server://state` events (e.g. a supervised restart)
 * without tearing down the mounted workspace.
 *
 * Workspace directory source (tracer decision — see WORKSPACE_DIR below):
 * defaults to the space-bus fixture workspace path used by the U0.4 spike
 * (`spikes/0c-server-connectivity/index.tsx`'s FIXTURE_DIRECTORY), since
 * that's the only workspace with a live `opencode serve` + spacebus.json
 * verified so far. TODO(U1.9-followup): replace with real workspace
 * selection (open-directory dialog / last-used workspace).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { roster } from "../server/bus";
import type { BusContext } from "../server/types";
import { loadWorkspace } from "../workspace/config";
import { buildBusContext } from "../workspace/context";
import { homeDir, pathExists, readTextFile } from "../workspace/tauri-fs";
import {
  type HandshakeDeps,
  type HandshakeState,
  type ServerStateWire,
  type ServerStatus,
  reduceLiveStatus,
  runSupervisedHandshake,
} from "./handshake-machine";

// TODO(U1.9-followup): source from real workspace selection, not a
// hardcoded fixture path.
export const WORKSPACE_DIR = "/Users/mrbrown/src/github.com/fro-bot/space-bus";

export interface StartupHandshakeProps {
  workspaceDir?: string;
  children: (context: BusContext, workspacePath: string) => React.ReactNode;
}

/** Existing workspace-load → bus-context → server-probe sequence, run once
 * `ensure_server` reports the server is running. Exported so tests can
 * drive it without mounting React. Unchanged in behavior from pre-U1.9. */
export async function connectServer(
  workspaceDir: string,
): Promise<
  | { status: "connected"; context: BusContext; workspacePath: string }
  | { status: "failed"; message: string }
> {
  try {
    const home = await homeDir().catch(() => undefined);
    const workspace = await loadWorkspace(workspaceDir, {
      readTextFile,
      homeDir: home,
    });

    if (workspace.kind === "error") {
      return { status: "failed", message: workspace.message };
    }

    const context = await buildBusContext(workspace, undefined, { pathExists });

    const probe = await roster({ context });
    if (!probe.ok) {
      return {
        status: "failed",
        message: `Server did not answer: ${probe.error}`,
      };
    }
    // roster() absorbs per-project HTTP failures into `statusError` rather
    // than a top-level Err — if every existing project failed to answer,
    // treat the handshake as failed rather than silently degrading into a
    // shell full of per-panel error rows.
    const existing = probe.projects.filter((p) => p.pathExists);
    const allFailed =
      existing.length > 0 && existing.every((p) => p.statusError);
    if (allFailed) {
      return {
        status: "failed",
        message: `Server did not answer: ${existing[0]?.statusError}`,
      };
    }

    return { status: "connected", context, workspacePath: workspaceDir };
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ensureServer(dir?: string): Promise<ServerStateWire> {
  return invoke<ServerStateWire>("ensure_server", { dir });
}

const deps: HandshakeDeps = { ensureServer, connectServer };

/** Runs the full supervised handshake (ensure_server → connectServer).
 * Exported so tests can drive it without mounting React. */
export async function runHandshake(
  workspaceDir: string,
  onUpdate?: (state: HandshakeState) => void,
): Promise<HandshakeState> {
  return runSupervisedHandshake(workspaceDir, deps, onUpdate);
}

const CHIP_LABEL: Record<ServerStatus, string> = {
  starting: "starting",
  running: "connected",
  restarting: "restarting…",
  failed: "server failed",
};

const CHIP_COLOR: Record<ServerStatus, string> = {
  starting: "var(--color-accent)",
  running: "var(--color-success)",
  restarting: "var(--color-warning)",
  failed: "var(--color-error)",
};

export function StartupHandshake({
  workspaceDir = WORKSPACE_DIR,
  children,
}: StartupHandshakeProps) {
  const [state, setState] = useState<HandshakeState>({ status: "starting" });
  const [liveStatus, setLiveStatus] = useState<ServerStatus>("running");
  const connectedRef = useRef(false);

  const attempt = useCallback(() => {
    connectedRef.current = false;
    setState({ status: "starting" });
    void runHandshake(workspaceDir, setState).then((result) => {
      if (result.status === "connected") {
        connectedRef.current = true;
        setLiveStatus("running");
      }
    });
  }, [workspaceDir]);

  useEffect(() => {
    attempt();
  }, [attempt]);

  // Live status chip: reflects server://state events (e.g. a supervised
  // restart) after the initial connect, without tearing down the mounted
  // workspace. Failures here surface as a chip, not a re-render of the
  // full failed screen — the mounted shell keeps whatever it already has.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ServerStateWire>("server://state", (event) => {
      if (!connectedRef.current) return;
      setLiveStatus((prev) => reduceLiveStatus(prev, event.payload));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (state.status === "connected") {
    return (
      <>
        {liveStatus !== "running" && (
          <div
            style={{
              position: "fixed",
              top: "var(--space-2)",
              right: "var(--space-2)",
              zIndex: 1000,
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-1) var(--space-3)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-raised)",
              border: `1px solid ${CHIP_COLOR[liveStatus]}`,
              color: CHIP_COLOR[liveStatus],
              fontSize: "var(--text-xs)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: CHIP_COLOR[liveStatus],
                boxShadow: `0 0 6px ${CHIP_COLOR[liveStatus]}`,
              }}
            />
            opencode server: {CHIP_LABEL[liveStatus]}
          </div>
        )}
        {children(state.context as BusContext, state.workspacePath)}
      </>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        width: "100%",
        gap: "var(--space-4)",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {(state.status === "starting" || state.status === "connecting") && (
        <>
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "var(--color-accent)",
              boxShadow: "0 0 12px var(--color-accent)",
              animation: "mothership-handshake-pulse 1.2s ease-in-out infinite",
            }}
          />
          <span
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
            }}
          >
            {state.status === "starting"
              ? "Starting opencode server…"
              : "Connecting to workspace…"}
          </span>
        </>
      )}

      {state.status === "failed" && (
        <>
          <strong
            style={{
              color: "var(--color-highlight)",
              fontSize: "var(--text-lg)",
            }}
          >
            Connection failed
          </strong>
          <span
            style={{
              color: "var(--color-text-muted)",
              fontSize: "var(--text-sm)",
              maxWidth: 480,
              textAlign: "center",
            }}
          >
            {state.message}
          </span>
          <button
            type="button"
            onClick={attempt}
            style={{
              color: "var(--color-bg)",
              background: "var(--color-accent)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-2) var(--space-4)",
              fontSize: "var(--text-sm)",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </>
      )}
      <style>
        {`@keyframes mothership-handshake-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }`}
      </style>
    </div>
  );
}

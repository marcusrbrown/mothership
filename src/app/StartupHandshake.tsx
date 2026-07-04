/**
 * Startup handshake screen (Flow Analysis item 5 / U1.2's handshake
 * requirement): loads the workspace, builds a BusContext, and probes the
 * server with a cheap `roster()` call before mounting the real shell.
 * States: connecting (cyan pulse, connecting-only glow per DESIGN.md) →
 * connected (renders children) or failed (with retry, orange highlight).
 *
 * Workspace directory source (tracer decision — see WORKSPACE_DIR below):
 * defaults to the space-bus fixture workspace path used by the U0.4 spike
 * (`spikes/0c-server-connectivity/index.tsx`'s FIXTURE_DIRECTORY), since
 * that's the only workspace with a live `opencode serve` + spacebus.json
 * verified so far. TODO(U1.9): replace with real workspace selection
 * (open-directory dialog / last-used workspace) once server supervision
 * lands and the app can target arbitrary directories.
 */
import { useCallback, useEffect, useState } from "react";
import { roster } from "../server/bus";
import type { BusContext } from "../server/types";
import { loadWorkspace } from "../workspace/config";
import { buildBusContext } from "../workspace/context";
import { homeDir, pathExists, readTextFile } from "../workspace/tauri-fs";

// TODO(U1.9): source from real workspace selection, not a hardcoded fixture path.
export const WORKSPACE_DIR = "/Users/mrbrown/src/github.com/fro-bot/space-bus";

export type HandshakeState =
  | { status: "connecting" }
  | { status: "connected"; context: BusContext; workspacePath: string }
  | { status: "failed"; message: string };

export interface StartupHandshakeProps {
  workspaceDir?: string;
  children: (context: BusContext, workspacePath: string) => React.ReactNode;
}

/** Runs the workspace-load → bus-context → server-probe sequence. Exported
 * so tests can drive it without mounting React. */
export async function runHandshake(
  workspaceDir: string,
): Promise<HandshakeState> {
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

export function StartupHandshake({
  workspaceDir = WORKSPACE_DIR,
  children,
}: StartupHandshakeProps) {
  const [state, setState] = useState<HandshakeState>({ status: "connecting" });

  const attempt = useCallback(() => {
    setState({ status: "connecting" });
    void runHandshake(workspaceDir).then(setState);
  }, [workspaceDir]);

  useEffect(() => {
    attempt();
  }, [attempt]);

  if (state.status === "connected") {
    return <>{children(state.context, state.workspacePath)}</>;
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
      {state.status === "connecting" && (
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
            Connecting to workspace…
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

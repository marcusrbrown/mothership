/**
 * Startup handshake screen: ensures a server is reachable before mounting
 * the shell. Ensures `opencode serve` is running (adopted or spawned via the Rust
 * server_supervisor), loads the workspace, builds a BusContext, and probes
 * the server with a cheap `roster()` call before mounting the real shell.
 * States: starting (spawning opencode serve…) → connecting (cyan pulse,
 * connecting-only glow per DESIGN.md) → connected (renders children) or
 * failed (with retry, orange highlight). After connecting, a small status
 * chip reflects live `server://state` events (e.g. a supervised restart)
 * without tearing down the mounted workspace.
 *
 * Workspace directory source: when no `workspaceDir` prop is given, resolved
 * at runtime via the Rust `resolve_workspace_dir` command — the
 * `MOTHERSHIP_WORKSPACE` env var if set, else the app process's current
 * working directory (so the workspace + terminal follow wherever the app
 * was launched from, not a baked-in fixture). TODO: replace
 * with real workspace selection (open-directory dialog / last-used
 * workspace).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { detectWorkspace } from "../detect/detectors";
import type { WorkspaceManifest } from "../detect/manifest";
import { roster } from "../server/bus";
import type { BusContext } from "../server/types";
import { loadWorkspace } from "../workspace/config";
import { type ResolvedServer, buildBusContext } from "../workspace/context";
import {
  homeDir,
  pathExists,
  readTextFile,
  resolveManagedServer,
  resolveWorkspaceDir,
} from "../workspace/tauri-fs";
import {
  type HandshakeDeps,
  type HandshakeState,
  type ServerStateWire,
  type ServerStatus,
  reduceLiveStatus,
  runSupervisedHandshake,
} from "./handshake-machine";

export interface StartupHandshakeProps {
  workspaceDir?: string;
  children: (
    context: BusContext,
    workspacePath: string,
    manifest: WorkspaceManifest,
  ) => React.ReactNode;
}

/** Existing workspace-load → bus-context → server-probe sequence, run once
 * `ensure_server` reports the server is running. Exported so tests can
 * drive it without mounting React. */
/** Resolves the concrete server target (baseUrl + optional credentials) for
 * a loaded workspace: `managed` rosters attach via space-bus discovery
 * (never spawning anything themselves), `baseUrl` rosters use the
 * externally-managed URL directly, and `virtual` workspaces (no
 * spacebus.json) fall back to the default loopback port. */
async function resolveServerTarget(
  workspace: Extract<
    Awaited<ReturnType<typeof loadWorkspace>>,
    { kind: "workspace" | "virtual" }
  >,
  workspaceDir: string,
): Promise<
  { ok: true; resolved: ResolvedServer } | { ok: false; message: string }
> {
  if (workspace.kind === "virtual") {
    return { ok: true, resolved: { baseUrl: "http://127.0.0.1:4096" } };
  }
  const { server } = workspace.config;
  if (server.managed) {
    try {
      const { baseUrl, username, password } =
        await resolveManagedServer(workspaceDir);
      return {
        ok: true,
        resolved: { baseUrl, credentials: { username, password } },
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // Schema guarantees exactly one of baseUrl/managed is set.
  return { ok: true, resolved: { baseUrl: server.baseUrl as string } };
}

/** Returns true when the workspace's spacebus.json declares a `managed`
 * server — used to skip `ensure_server`'s spawn/adopt entirely for
 * managed rosters, since space-bus (not mothership) owns that daemon's
 * lifecycle. Any load failure (including "no spacebus.json") is treated as
 * not-managed, deferring to the existing external/virtual flow. */
export async function isManagedWorkspace(
  workspaceDir: string,
): Promise<boolean> {
  try {
    const home = await homeDir().catch(() => undefined);
    const workspace = await loadWorkspace(workspaceDir, {
      readTextFile,
      homeDir: home,
    });
    return (
      workspace.kind === "workspace" &&
      workspace.config.server.managed !== undefined
    );
  } catch {
    return false;
  }
}

export async function connectServer(workspaceDir: string): Promise<
  | {
      status: "connected";
      context: BusContext;
      workspacePath: string;
      manifest: WorkspaceManifest;
    }
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

    const target = await resolveServerTarget(workspace, workspaceDir);
    if (!target.ok) {
      return { status: "failed", message: target.message };
    }

    const context = await buildBusContext(workspace, target.resolved, {
      pathExists,
    });

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

    // Mechanical detection (no LLM, no network — filesystem
    // existence/read via the same injected seams as the workspace load
    // above) runs once per successful connect, feeding the placeholder
    // tabs DockviewShell seeds per detected interface.
    const manifest = await detectWorkspace(context.roster.projects, {
      pathExists,
      readTextFile,
    });

    return {
      status: "connected",
      context,
      workspacePath: workspaceDir,
      manifest,
    };
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

const deps: HandshakeDeps = {
  ensureServer,
  connectServer,
  isManaged: isManagedWorkspace,
};

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
  workspaceDir: workspaceDirProp,
  children,
}: StartupHandshakeProps) {
  const [state, setState] = useState<HandshakeState>({ status: "starting" });
  const [liveStatus, setLiveStatus] = useState<ServerStatus>("running");
  const connectedRef = useRef(false);
  // Resolved lazily when no explicit prop is given (see resolveWorkspaceDir
  // docblock above) — undefined until resolution completes, at which point
  // `attempt` fires via the effect below.
  const [resolvedWorkspaceDir, setResolvedWorkspaceDir] = useState<
    string | undefined
  >(workspaceDirProp);

  const attempt = useCallback((workspaceDir: string) => {
    connectedRef.current = false;
    setState({ status: "starting" });
    void runHandshake(workspaceDir, setState).then((result) => {
      if (result.status === "connected") {
        connectedRef.current = true;
        setLiveStatus("running");
      }
    });
  }, []);

  useEffect(() => {
    if (workspaceDirProp) {
      setResolvedWorkspaceDir(workspaceDirProp);
      return;
    }
    let cancelled = false;
    void resolveWorkspaceDir().then((dir) => {
      if (!cancelled) setResolvedWorkspaceDir(dir);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceDirProp]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is stable (no deps); retrigger only on the resolved dir changing
  useEffect(() => {
    if (resolvedWorkspaceDir === undefined) return;
    attempt(resolvedWorkspaceDir);
  }, [resolvedWorkspaceDir]);

  const retry = useCallback(() => {
    if (resolvedWorkspaceDir !== undefined) attempt(resolvedWorkspaceDir);
  }, [attempt, resolvedWorkspaceDir]);

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
        {children(
          state.context as BusContext,
          state.workspacePath,
          (state.manifest as WorkspaceManifest | undefined) ?? { projects: [] },
        )}
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
            onClick={retry}
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

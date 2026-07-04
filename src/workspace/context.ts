/**
 * Builds a /contract-valid `BusContext` from `loadWorkspace()`'s result.
 *
 * space-bus's Node-side `config.ts#loadContext` computes `exists` flags via
 * direct filesystem access (`fs.existsSync`) — not available in the
 * webview. This module mirrors that shape using an injected `pathExists`
 * seam, following the same injection pattern as `workspace/config.ts`'s
 * `readTextFile`.
 *
 * Validates through `busContextSchema` once at the boundary (parse, don't
 * validate) before returning.
 */
import {
  type BusContext,
  type Credentials,
  busContextSchema,
} from "../server/types";
import type { Project, WorkspaceResult } from "./config";

export type BuildBusContextOptions = {
  /** Injected existence check; defaults to assuming every path exists
   * (safe default for environments where the check is unavailable — the
   * roster's per-project error surfacing degrades gracefully either way). */
  pathExists?: (path: string) => Promise<boolean>;
};

/** The resolved server target for a workspace: a concrete loopback
 * `baseUrl` plus optional `credentials` when the server requires auth
 * (managed rosters, discovered via `resolveManagedServer`). Callers resolve
 * this BEFORE calling `buildBusContext` — `workspace.config.server` may be
 * `managed` (no baseUrl at all), so the manifest alone is no longer enough
 * to derive the roster's server block. */
export type ResolvedServer = {
  baseUrl: string;
  credentials?: Credentials;
};

async function defaultPathExists(_path: string): Promise<boolean> {
  return true;
}

async function toRosterProject(
  project: Project,
  pathExists: (path: string) => Promise<boolean>,
) {
  return {
    name: project.name,
    path: project.path,
    description: project.description,
    expandedPath: project.expandedPath,
    exists: await pathExists(project.expandedPath),
  };
}

/**
 * Builds a validated `BusContext` from a `loadWorkspace()` result.
 *
 * - `{kind: 'workspace'}` → roster from the manifest's projects, each
 *   `exists`-flagged via the injected `pathExists` seam.
 * - `{kind: 'virtual'}` → single-project roster synthesized from the
 *   virtual project, with a synthetic loopback `baseUrl` (virtual
 *   workspaces have no `spacebus.json`, hence no configured server —
 *   callers wire the real server URL separately for virtual workspaces
 *   that do have one available, e.g. from app config).
 * - `{kind: 'error'}` → throws; callers should not attempt to build a bus
 *   context from a failed workspace load (mirrors `loadContext`'s
 *   throw-on-invalid posture).
 */
export async function buildBusContext(
  workspace: WorkspaceResult,
  resolved: ResolvedServer,
  options: BuildBusContextOptions = {},
): Promise<BusContext> {
  const pathExists = options.pathExists ?? defaultPathExists;

  if (workspace.kind === "error") {
    throw new Error(
      `cannot build bus context from a failed workspace load: ${workspace.message}`,
    );
  }

  if (workspace.kind === "virtual") {
    const project = await toRosterProject(workspace.project, pathExists);
    const raw = {
      roster: {
        server: { baseUrl: resolved.baseUrl },
        projects: [project],
      },
      credentials: resolved.credentials,
    };
    return busContextSchema.parse(raw);
  }

  const projects = await Promise.all(
    workspace.projects.map((p) => toRosterProject(p, pathExists)),
  );
  const raw = {
    roster: {
      server: { baseUrl: resolved.baseUrl },
      projects,
    },
    credentials: resolved.credentials,
  };
  return busContextSchema.parse(raw);
}

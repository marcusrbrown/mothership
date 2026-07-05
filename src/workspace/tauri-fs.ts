import {
  type AttachSeams,
  resolveManagedServer as resolveManagedServerLib,
} from "@fro.bot/space-bus/attach";
/**
 * Real Tauri-backed implementations of the injected filesystem seams used by
 * `workspace/config.ts` (`readTextFile`) and `workspace/context.ts`
 * (`pathExists`), plus `homeDir` for `~` expansion. Talks to the
 * `read_text_file` / `path_exists` / `home_dir` Rust commands
 * (`src-tauri/src/workspace_fs.rs`) via `@tauri-apps/api/core` — NOT
 * `@tauri-apps/plugin-fs`, which is intentionally not a dependency.
 */
import { invoke } from "@tauri-apps/api/core";

/** Reads a UTF-8 text file via the Rust `read_text_file` command. */
export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Checks path existence via the Rust `path_exists` command. */
export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

let cachedHomeDir: Promise<string> | undefined;

/** Returns (and caches) the user's home directory via the Rust `home_dir` command. */
export async function homeDir(): Promise<string> {
  if (!cachedHomeDir) {
    cachedHomeDir = invoke<string>("home_dir");
  }
  return cachedHomeDir;
}

/** Test/dev helper — clears the home dir cache (module-level singleton otherwise). */
export function __resetHomeDirCacheForTests(): void {
  cachedHomeDir = undefined;
}

/** Resolves the workspace directory via the Rust `resolve_workspace_dir`
 * command: `MOTHERSHIP_WORKSPACE` env var if set, else the app process's
 * current working directory. Replaces the previous hardcoded fixture path. */
export async function resolveWorkspaceDir(): Promise<string> {
  return invoke<string>("resolve_workspace_dir");
}

export type ManagedServer = {
  baseUrl: string;
  username: string;
  password: string;
};

/** `AttachSeams` implementation backed by the generic Rust `realpath` /
 * `read_text_file` / `env_var` / `home_dir` commands — the entire
 * filesystem surface `@fro.bot/space-bus/attach`'s `resolveManagedServer`
 * needs to locate and validate a managed daemon's discovery file. No
 * discovery-scheme knowledge (hashing, roster paths, loopback checks) lives
 * in mothership anymore; that all moved into the space-bus library. */
const seams: AttachSeams = {
  realpath: (path) => invoke<string | null>("realpath", { path }),
  readTextFile: async (path) => {
    try {
      return await invoke<string>("read_text_file", { path });
    } catch {
      // `read_text_file` rejects on missing/unreadable files; the seam
      // contract wants `null` instead.
      return null;
    }
  },
  env: (name) => invoke<string | null>("env_var", { name }),
  homeDir: () => homeDir(),
};

/** Resolves a space-bus v0.6.0 MANAGED server's discovery info (baseUrl +
 * credentials) for the workspace at `workspaceDir`, via
 * `@fro.bot/space-bus/attach#resolveManagedServer` — the browser-safe
 * library that owns roster-path resolution, the discovery-dir hash,
 * discovery.json validation, the loopback guard, and daemon liveness.
 * Mothership never spawns the managed daemon itself — it only attaches to
 * the already-running server this discovers. Throws (rejects) with the
 * library's actionable error message when the daemon isn't running or the
 * roster is missing. */
export async function resolveManagedServer(
  workspaceDir: string,
): Promise<ManagedServer> {
  const result = await resolveManagedServerLib(workspaceDir, seams);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return {
    baseUrl: result.baseUrl,
    username: result.credentials.username,
    password: result.credentials.password,
  };
}

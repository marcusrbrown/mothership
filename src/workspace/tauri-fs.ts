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

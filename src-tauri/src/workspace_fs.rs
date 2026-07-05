//! Minimal filesystem seam for the webview's workspace loader
//! (`src/workspace/tauri-fs.ts`). `@tauri-apps/plugin-fs` is intentionally
//! not a dependency (stack lock) — these three commands are the entire
//! filesystem surface the webview gets, and they're read-only /
//! existence-check only. No arbitrary write, no directory listing.

use std::path::Path;

/// Reads a UTF-8 text file at `path`. Used by `workspace/config.ts`'s
/// injected `readTextFile` seam to load `spacebus.json`.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("failed to read {path}: {e}"))
}

/// Reports whether `path` exists on disk. Used by `workspace/context.ts`'s
/// injected `pathExists` seam for per-project roster existence flags.
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// Returns the current user's home directory, for `~` expansion in
/// `workspace/config.ts#expandHome`.
#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())
}

/// Pure decision: given the raw `MOTHERSHIP_WORKSPACE` env value (as
/// `std::env::var` would return it) and a fallback (typically the process's
/// current working directory), picks `MOTHERSHIP_WORKSPACE` when set and
/// non-empty, else the fallback. Extracted from `resolve_workspace_dir` so
/// the decision is testable without depending on process env/CWD.
fn resolve_workspace_dir_from(env_value: Option<String>, fallback: String) -> String {
    env_value.filter(|s| !s.is_empty()).unwrap_or(fallback)
}

/// Resolves the workspace directory the app should use: `MOTHERSHIP_WORKSPACE`
/// if set (non-empty), else the process's current working directory. Replaces
/// the previous hardcoded fixture path in `StartupHandshake.tsx` — the user
/// expects the workspace (and terminal cwd) to follow wherever the app was
/// launched from, not a baked-in space-bus fixture.
#[tauri::command]
pub fn resolve_workspace_dir() -> String {
    let fallback = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
        .unwrap_or_default();
    resolve_workspace_dir_from(std::env::var("MOTHERSHIP_WORKSPACE").ok(), fallback)
}

/// Canonicalizes `path` (realpath); `None` if it doesn't exist. Backs the
/// `@fro.bot/space-bus/attach` `AttachSeams.realpath` seam consumed by
/// `workspace/tauri-fs.ts#resolveManagedServer`.
#[tauri::command]
pub fn realpath(path: String) -> Option<String> {
    std::fs::canonicalize(&path)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Reads an environment variable; `None` if unset OR empty, matching the
/// `AttachSeams.env` contract (`@fro.bot/space-bus/attach`).
#[tauri::command]
pub fn env_var(name: String) -> Option<String> {
    std::env::var(&name).ok().filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_workspace_dir_from_prefers_set_nonempty_env_value() {
        assert_eq!(
            resolve_workspace_dir_from(
                Some("/some/workspace".to_string()),
                "/fallback/cwd".to_string()
            ),
            "/some/workspace"
        );
    }

    #[test]
    fn resolve_workspace_dir_from_falls_back_when_env_unset() {
        assert_eq!(
            resolve_workspace_dir_from(None, "/fallback/cwd".to_string()),
            "/fallback/cwd"
        );
    }

    #[test]
    fn resolve_workspace_dir_from_falls_back_when_env_empty() {
        assert_eq!(
            resolve_workspace_dir_from(Some(String::new()), "/fallback/cwd".to_string()),
            "/fallback/cwd"
        );
    }

    #[test]
    fn env_var_filters_empty_string_to_none() {
        let key = "MOTHERSHIP_TEST_ENV_VAR_EMPTY";
        // SAFETY: test-local, sequential within this test's scope.
        unsafe {
            std::env::set_var(key, "");
        }
        assert_eq!(env_var(key.to_string()), None);
        unsafe {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn env_var_returns_some_for_nonempty_value() {
        let key = "MOTHERSHIP_TEST_ENV_VAR_SET";
        // SAFETY: test-local, sequential within this test's scope.
        unsafe {
            std::env::set_var(key, "hello");
        }
        assert_eq!(env_var(key.to_string()), Some("hello".to_string()));
        unsafe {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn env_var_returns_none_for_unset_var() {
        let key = "MOTHERSHIP_TEST_ENV_VAR_UNSET_DEFINITELY";
        unsafe {
            std::env::remove_var(key);
        }
        assert_eq!(env_var(key.to_string()), None);
    }
}

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

/// Resolves the workspace directory the app should use: `MOTHERSHIP_WORKSPACE`
/// if set (non-empty), else the process's current working directory. Replaces
/// the previous hardcoded fixture path in `StartupHandshake.tsx` — the user
/// expects the workspace (and terminal cwd) to follow wherever the app was
/// launched from, not a baked-in space-bus fixture.
#[tauri::command]
pub fn resolve_workspace_dir() -> String {
    std::env::var("MOTHERSHIP_WORKSPACE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|p| p.to_str().map(String::from))
                .unwrap_or_default()
        })
}

//! `ide_*` MCP sidecar supervision. Mirrors
//! `server_supervisor.rs`'s spawn/monitor/restart pattern for a second
//! supervised child: the Bun `sidecar/ide-server` process that hosts both
//! the MCP streamable-HTTP server and the WS bridge the webview dials.
//!
//! Token/rendezvous contract: a fresh random 32-byte hex bearer token is
//! generated per launch and passed to the child via the `MOTHERSHIP_IDE_TOKEN`
//! env var (NEVER argv — argv is visible to every local user via `ps`). The
//! child prints `IDE_PORT=<n>` as its first stdout line once its
//! OS-assigned port is bound; we parse that line, then write `{port, token}`
//! as JSON to a 0600 rendezvous file under the Tauri app-data dir. This file
//! is the env-readable location an external MCP client config (opencode)
//! points at to connect directly, e.g.:
//!
//! ```jsonc
//! // opencode MCP config (see docs note in shutdown() below for the full
//! // snippet) — command/env pulled from the rendezvous file:
//! {
//!   "mcpServers": {
//!     "mothership-ide": {
//!       "type": "remote",
//!       "url": "http://127.0.0.1:<port>/mcp",
//!       "headers": { "Authorization": "Bearer <token>" }
//!     }
//!   }
//! }
//! ```
//!
//! `ide_bridge_info()` exposes the same {port, token} pair to the webview
//! over Tauri IPC so the in-process bridge client can dial `/ws` without
//! reading the rendezvous file itself.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::supervisor_common::{resolve_spawn_race, should_restart, window_expired, RaceWinner};

const SPAWN_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_POLL: Duration = Duration::from_millis(500);
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const RENDEZVOUS_FILE: &str = "ide-bridge.json";

fn generate_token() -> String {
    // 32 random bytes, hex-encoded — no external RNG crate needed beyond
    // `uuid` (already a dependency): four v4 UUIDs concatenated give 64
    // hex-nibble-equivalent bytes of randomness, well past the 32-byte bar.
    let mut token = String::with_capacity(64);
    for _ in 0..2 {
        token.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    token
}

#[derive(Clone, Serialize, Debug)]
pub struct IdeBridgeInfo {
    pub port: u16,
    pub token: String,
}

struct Inner {
    child: Option<Child>,
    token: String,
    info: Option<IdeBridgeInfo>,
    restart_count: u32,
    window_start: Instant,
    owned: bool,
    shutting_down: bool,
    app_data_dir: Option<std::path::PathBuf>,
    sidecar_dir: Option<String>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            child: None,
            token: String::new(),
            info: None,
            restart_count: 0,
            window_start: Instant::now(),
            owned: false,
            shutting_down: false,
            app_data_dir: None,
            sidecar_dir: None,
        }
    }
}

#[derive(Default)]
pub struct IdeSidecar(Mutex<Inner>);

fn rendezvous_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join(RENDEZVOUS_FILE)
}

/// Writes `{port, token}` to the rendezvous file such that the file is
/// never observably world/group-readable, even for an instant: on Unix we
/// write to a sibling temp file created with mode 0600 from the start
/// (`OpenOptions::mode`, not a post-hoc `set_permissions` after a plain
/// `fs::write`), then atomically rename it over the target. The parent
/// app-data dir is also tightened to 0700 (best-effort — a failure here
/// isn't fatal, since the file itself is still 0600).
fn write_rendezvous_file(app_data_dir: &std::path::Path, info: &IdeBridgeInfo) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(app_data_dir, std::fs::Permissions::from_mode(0o700));
    }

    let path = rendezvous_path(app_data_dir);
    let contents = serde_json::to_string(info).unwrap_or_default();

    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp_path = app_data_dir.join(format!("{RENDEZVOUS_FILE}.tmp"));
        {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp_path)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp_path, &path)?;
        return Ok(());
    }

    #[cfg(not(unix))]
    {
        std::fs::write(&path, contents)?;
        Ok(())
    }
}

/// Resolves the default sidecar dir to an ABSOLUTE path anchored on
/// `CARGO_MANIFEST_DIR` (which is `<repo>/src-tauri` at build time), so the
/// child process's CWD (which under `tauri dev` is `src-tauri/`) never
/// matters. Canonicalizes to normalize the `..` component; if the path
/// doesn't exist yet, falls back to the raw joined path so any resulting
/// error message still names a concrete absolute path.
///
/// This anchor is correct for `bun run dev` (dev only).
// TODO(packaging): a production-bundled app must ship the sidecar as a
// Tauri resource and resolve it via `app.path().resource_dir()` instead of
// this dev-only CARGO_MANIFEST_DIR anchor.
fn default_sidecar_dir() -> String {
    let joined = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/ide-server"));
    match std::fs::canonicalize(&joined) {
        Ok(canon) => canon.to_string_lossy().into_owned(),
        Err(_) => joined.to_string_lossy().into_owned(),
    }
}

/// Truncates a byte buffer to at most `max` bytes (on a UTF-8 boundary) for
/// safe inclusion in an error message.
fn truncate_tail(bytes: &[u8], max: usize) -> String {
    let start = bytes.len().saturating_sub(max);
    let mut s = String::from_utf8_lossy(&bytes[start..]).into_owned();
    if start > 0 {
        s = format!("...{s}");
    }
    s
}

/// Spawns `bun run <sidecar_dir>/index.ts` with the token in env (never
/// argv), reads the `IDE_PORT=<n>` line from its stdout, and returns the
/// running child plus the parsed port. Blocks (with a bounded timeout) on
/// the child's stdout only for that one line. Captures stderr so a spawn
/// or port-timeout failure can surface a diagnosable tail instead of
/// failing silently.
fn spawn_and_await_port(
    sidecar_dir: &str,
    token: &str,
) -> std::io::Result<(Child, u16)> {
    let entry = format!("{sidecar_dir}/index.ts");
    if !std::path::Path::new(&entry).exists() {
        return Err(std::io::Error::other(format!(
            "ide sidecar entry not found at {entry}"
        )));
    }

    let mut cmd = std::process::Command::new("bun");
    cmd.arg("run").arg(&entry);
    cmd.env("MOTHERSHIP_IDE_TOKEN", token);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| std::io::Error::other("sidecar stdout not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("sidecar stderr not piped"))?;

    let stderr_buf = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
    {
        let stderr_buf = stderr_buf.clone();
        thread::spawn(move || {
            use std::io::Read;
            let mut reader = stderr;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        let mut guard = stderr_buf.lock().unwrap_or_else(|p| p.into_inner());
                        guard.extend_from_slice(&buf[..n]);
                    }
                }
            }
        });
    }

    let (tx, rx) = std::sync::mpsc::channel::<Option<u16>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if let Some(rest) = trimmed.strip_prefix("IDE_PORT=") {
                        if let Ok(port) = rest.parse::<u16>() {
                            let _ = tx.send(Some(port));
                            return;
                        }
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });

    match rx.recv_timeout(SPAWN_PROBE_TIMEOUT) {
        Ok(Some(port)) => Ok((child, port)),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            let tail = {
                let guard = stderr_buf.lock().unwrap_or_else(|p| p.into_inner());
                truncate_tail(&guard, 500)
            };
            Err(std::io::Error::other(format!(
                "ide sidecar failed to start ({entry}): {tail}"
            )))
        }
    }
}

/// Probes `/health` with the bearer token (the endpoint requires auth like
/// every other pre-auth surface — see `sidecar/ide-server/index.ts`).
fn probe_health(port: u16, token: &str) -> bool {
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let req = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    use std::io::Read;
    matches!(stream.read(&mut buf), Ok(n) if n > 0 && buf.starts_with(b"HTTP/1.1 200"))
}

/// Starts (or reuses) the ide sidecar and returns `{port, token}` for the
/// webview bridge. `sidecar_dir` is the absolute path to
/// `<repo>/sidecar/ide-server`.
#[tauri::command]
pub fn ide_bridge_info(
    app: AppHandle,
    state: State<'_, IdeSidecar>,
    sidecar_dir: Option<String>,
) -> Result<IdeBridgeInfo, String> {
    {
        let inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(info) = &inner.info {
            return Ok(info.clone());
        }
    }

    let dir = match sidecar_dir {
        Some(d) if !d.is_empty() => d,
        _ => default_sidecar_dir(),
    };
    let token = generate_token();
    let (child, port) = spawn_and_await_port(&dir, &token).map_err(|e| e.to_string())?;
    let info = IdeBridgeInfo { port, token: token.clone() };

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let mut child = child;
    {
        // RE-VALIDATE-AFTER-REACQUIRE: another concurrent `ide_bridge_info`
        // call may have won this same race while we were unlocked spawning
        // and awaiting the port. Deterministic winner: whichever sidecar
        // got registered first keeps running; kill our loser instead of
        // orphaning it.
        let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let race_winner = resolve_spawn_race(inner.info.is_some() && inner.owned);
        if race_winner == RaceWinner::Existing {
            let existing = inner.info.clone();
            drop(inner);
            let _ = child.kill();
            let _ = child.wait();
            return existing.ok_or_else(|| "ide sidecar race lost but no existing info".to_string());
        }
        write_rendezvous_file(&app_data_dir, &info).map_err(|e| e.to_string())?;
        inner.child = Some(child);
        inner.token = token;
        inner.info = Some(info.clone());
        inner.owned = true;
        inner.restart_count = 0;
        inner.window_start = Instant::now();
        inner.app_data_dir = Some(app_data_dir);
        inner.sidecar_dir = Some(dir);
    }

    spawn_health_monitor(app);
    Ok(info)
}

/// Health-checks the sidecar and restarts it with a capped-retry window on
/// failure, mirroring `server_supervisor::spawn_monitor`'s shape. Exits once
/// the sidecar is no longer owned (shut down or restart cap exceeded).
fn spawn_health_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(HEALTH_POLL);
        let state = app.state::<IdeSidecar>();

        let (port, token, exited) = {
            let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if inner.shutting_down || !inner.owned {
                return;
            }
            let exited = match inner.child.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            };
            let port = inner.info.as_ref().map(|i| i.port);
            let token = inner.token.clone();
            (port, token, exited)
        };

        let unhealthy =
            exited || !port.map(|p| probe_health(p, &token)).unwrap_or(false);
        if !unhealthy {
            continue;
        }

        let (restart_allowed, dir) = {
            let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if inner.shutting_down || !inner.owned {
                return;
            }
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let now = Instant::now();
            if window_expired(inner.window_start, now, RESTART_WINDOW) {
                inner.restart_count = 0;
                inner.window_start = now;
            }
            let allowed = should_restart(inner.restart_count, MAX_RESTARTS);
            if allowed {
                inner.restart_count += 1;
            } else {
                inner.owned = false;
                inner.info = None;
            }
            (allowed, inner.sidecar_dir.clone())
        };

        if !restart_allowed {
            return;
        }

        let Some(dir) = dir else { return };
        let token = generate_token();
        match spawn_and_await_port(&dir, &token) {
            Ok((child, new_port)) => {
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                if inner.shutting_down || !inner.owned {
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                let info = IdeBridgeInfo { port: new_port, token: token.clone() };
                if let Some(app_data_dir) = &inner.app_data_dir {
                    let _ = write_rendezvous_file(app_data_dir, &info);
                }
                inner.child = Some(child);
                inner.token = token;
                inner.info = Some(info);
            }
            Err(_) => {
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                inner.owned = false;
                inner.info = None;
                return;
            }
        }
    });
}

/// Kills the owned sidecar on app exit. Called from `RunEvent::Exit`
/// alongside `pty::kill_all` and `server_supervisor::shutdown`.
pub fn shutdown(state: &IdeSidecar) {
    let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
    inner.shutting_down = true;
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if let Some(app_data_dir) = &inner.app_data_dir {
        let _ = std::fs::remove_file(rendezvous_path(app_data_dir));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Restart-cap policy unit tests (`should_restart`/`window_expired`) live
    // in `supervisor_common.rs`, the module these fns are imported from.

    #[test]
    fn generate_token_is_64_hex_chars_and_varies() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}

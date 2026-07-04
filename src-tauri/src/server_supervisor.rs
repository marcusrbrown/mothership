//! Minimal `opencode serve` supervision (U1.9) — the app owns the server
//! lifecycle instead of deferring it. Adopt-don't-spawn: if a server already
//! answers on `127.0.0.1:4096`, we never spawn a second one and never kill
//! it on quit. Otherwise we spawn `opencode serve` as a supervised child,
//! restart it on unexpected exit with a capped-retry window, and kill only
//! the owned child on app exit.
//!
//! No HTTP client dependency: the probe is a raw one-shot GET over
//! `std::net::TcpStream` against `/doc` (cheap, always present per
//! docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md).
//! Spawning uses `std::process::Command` — no `tauri-plugin-shell` needed.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 4096;
const PROBE_PATH: &str = "/doc";
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const SPAWN_PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const SPAWN_PROBE_POLL: Duration = Duration::from_millis(200);
const MONITOR_POLL: Duration = Duration::from_millis(500);
/// Restart-cap policy: at most this many restarts within the rolling window
/// below; past the cap the supervisor gives up and reports `failed`.
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Unstarted,
    Adopted,
    Owned,
    Failed,
    ShuttingDown,
}

#[derive(Clone, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ServerStatus {
    Starting,
    Running,
    Restarting,
    Failed,
}

/// Wire state sent to the frontend, both as the `ensure_server`/`server_state`
/// return value and as the `server://state` event payload.
#[derive(Clone, Serialize, Debug)]
pub struct ServerState {
    pub status: ServerStatus,
    pub adopted: bool,
    pub reason: Option<String>,
}

struct Inner {
    mode: Mode,
    child: Option<Child>,
    restart_count: u32,
    window_start: Instant,
    workspace_dir: Option<String>,
    state: ServerState,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            mode: Mode::Unstarted,
            child: None,
            restart_count: 0,
            window_start: Instant::now(),
            workspace_dir: None,
            state: ServerState {
                status: ServerStatus::Starting,
                adopted: false,
                reason: None,
            },
        }
    }
}

#[derive(Default)]
pub struct ServerSupervisor(Mutex<Inner>);

/// Pure restart-cap decision, extracted so it's unit-testable without
/// spawning a real process. `count` is restarts already used within the
/// current window; returns whether one more restart is allowed.
pub fn should_restart(count: u32, max: u32) -> bool {
    count < max
}

/// Pure window-reset decision: has enough time passed since `window_start`
/// that the restart counter should reset to zero?
pub fn window_expired(window_start: Instant, now: Instant, window: Duration) -> bool {
    now.duration_since(window_start) >= window
}

fn probe_once(timeout: Duration) -> bool {
    let addr = format!("{SERVER_HOST}:{SERVER_PORT}");
    let Ok(mut resolved) = addr.parse() else {
        return false;
    };
    let stream = TcpStream::connect_timeout(&resolved, timeout);
    let mut stream = match stream {
        Ok(s) => s,
        Err(_) => {
            // Re-resolve isn't needed (literal IP), kept for clippy's benefit
            // that `resolved` is used above.
            let _ = &mut resolved;
            return false;
        }
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req =
        format!("GET {PROBE_PATH} HTTP/1.1\r\nHost: {SERVER_HOST}:{SERVER_PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(stream.read(&mut buf), Ok(n) if n > 0 && buf.starts_with(b"HTTP/"))
}

fn wait_for_probe(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if probe_once(PROBE_CONNECT_TIMEOUT) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(SPAWN_PROBE_POLL);
    }
}

fn spawn_child(dir: Option<&str>) -> std::io::Result<Child> {
    let mut cmd = std::process::Command::new("opencode");
    cmd.arg("serve");
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.spawn()
}

fn emit_state(app: &AppHandle, state: &ServerState) {
    let _ = app.emit("server://state", state.clone());
}

/// Probes for an existing server; adopts it if present, otherwise spawns and
/// supervises `opencode serve`. Safe to call again after a `failed` state
/// (e.g. from a UI retry) — it starts a fresh attempt.
#[tauri::command]
pub fn ensure_server(
    app: AppHandle,
    state: State<'_, ServerSupervisor>,
    dir: Option<String>,
) -> ServerState {
    {
        let inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(inner.mode, Mode::Adopted | Mode::Owned)
            && inner.state.status == ServerStatus::Running
        {
            return inner.state.clone();
        }
    }

    if probe_once(PROBE_CONNECT_TIMEOUT) {
        let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        inner.mode = Mode::Adopted;
        inner.workspace_dir = dir;
        inner.state = ServerState {
            status: ServerStatus::Running,
            adopted: true,
            reason: None,
        };
        let out = inner.state.clone();
        drop(inner);
        emit_state(&app, &out);
        return out;
    }

    {
        let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        inner.workspace_dir = dir.clone();
        inner.state = ServerState {
            status: ServerStatus::Starting,
            adopted: false,
            reason: None,
        };
        let out = inner.state.clone();
        drop(inner);
        emit_state(&app, &out);
    }

    match spawn_child(dir.as_deref()) {
        Ok(child) => {
            if wait_for_probe(SPAWN_PROBE_TIMEOUT) {
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                inner.mode = Mode::Owned;
                inner.child = Some(child);
                inner.restart_count = 0;
                inner.window_start = Instant::now();
                inner.state = ServerState {
                    status: ServerStatus::Running,
                    adopted: false,
                    reason: None,
                };
                let out = inner.state.clone();
                drop(inner);
                emit_state(&app, &out);
                spawn_monitor(app);
                out
            } else {
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                inner.mode = Mode::Failed;
                inner.state = ServerState {
                    status: ServerStatus::Failed,
                    adopted: false,
                    reason: Some("opencode serve did not answer within 15s".to_string()),
                };
                let out = inner.state.clone();
                drop(inner);
                emit_state(&app, &out);
                out
            }
        }
        Err(e) => {
            let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
            inner.mode = Mode::Failed;
            inner.state = ServerState {
                status: ServerStatus::Failed,
                adopted: false,
                reason: Some(format!("failed to spawn opencode serve: {e}")),
            };
            let out = inner.state.clone();
            drop(inner);
            emit_state(&app, &out);
            out
        }
    }
}

/// Returns the current supervision state without probing/spawning.
#[tauri::command]
pub fn server_state(state: State<'_, ServerSupervisor>) -> ServerState {
    state
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .state
        .clone()
}

/// Watches the owned child for unexpected exit and restarts it with a
/// capped-retry window, emitting `server://state` on every transition. Exits
/// the thread once the supervisor is no longer `Owned` (adopted, failed, or
/// shutting down).
fn spawn_monitor(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(MONITOR_POLL);
        let state = app.state::<ServerSupervisor>();
        let exited = {
            let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
            if inner.mode != Mode::Owned {
                return;
            }
            match inner.child.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => true,
            }
        };
        if !exited {
            continue;
        }

        let (restart_allowed, dir) = {
            let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
            inner.child = None;
            let now = Instant::now();
            if window_expired(inner.window_start, now, RESTART_WINDOW) {
                inner.restart_count = 0;
                inner.window_start = now;
            }
            let allowed = should_restart(inner.restart_count, MAX_RESTARTS);
            if allowed {
                inner.restart_count += 1;
                inner.state = ServerState {
                    status: ServerStatus::Restarting,
                    adopted: false,
                    reason: None,
                };
            } else {
                inner.mode = Mode::Failed;
                inner.state = ServerState {
                    status: ServerStatus::Failed,
                    adopted: false,
                    reason: Some("opencode serve exited repeatedly; restart cap exceeded".to_string()),
                };
            }
            let out = inner.state.clone();
            let dir = inner.workspace_dir.clone();
            drop(inner);
            emit_state(&app, &out);
            (allowed, dir)
        };

        if !restart_allowed {
            return;
        }

        match spawn_child(dir.as_deref()) {
            Ok(child) if wait_for_probe(SPAWN_PROBE_TIMEOUT) => {
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                if inner.mode != Mode::Owned {
                    // Shut down or otherwise superseded while we were
                    // restarting — don't resurrect state, just reap.
                    let mut child = child;
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
                inner.child = Some(child);
                inner.state = ServerState {
                    status: ServerStatus::Running,
                    adopted: false,
                    reason: None,
                };
                let out = inner.state.clone();
                drop(inner);
                emit_state(&app, &out);
            }
            Ok(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                inner.mode = Mode::Failed;
                inner.state = ServerState {
                    status: ServerStatus::Failed,
                    adopted: false,
                    reason: Some("restarted opencode serve did not answer within 15s".to_string()),
                };
                let out = inner.state.clone();
                drop(inner);
                emit_state(&app, &out);
                return;
            }
            Err(e) => {
                let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
                inner.mode = Mode::Failed;
                inner.state = ServerState {
                    status: ServerStatus::Failed,
                    adopted: false,
                    reason: Some(format!("failed to respawn opencode serve: {e}")),
                };
                let out = inner.state.clone();
                drop(inner);
                emit_state(&app, &out);
                return;
            }
        }
    });
}

/// Kills only an owned child on app exit; an adopted (externally-managed)
/// server is never touched. Called from lib.rs's `RunEvent::Exit` handler
/// alongside `pty::kill_all`.
pub fn shutdown(state: &ServerSupervisor) {
    let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
    inner.mode = Mode::ShuttingDown;
    if let Some(mut child) = inner.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_restart_allows_up_to_cap() {
        assert!(should_restart(0, MAX_RESTARTS));
        assert!(should_restart(1, MAX_RESTARTS));
        assert!(should_restart(2, MAX_RESTARTS));
        assert!(!should_restart(3, MAX_RESTARTS));
        assert!(!should_restart(4, MAX_RESTARTS));
    }

    #[test]
    fn window_expired_is_pure_and_monotonic() {
        let start = Instant::now();
        assert!(!window_expired(start, start, RESTART_WINDOW));
        let mid = start + Duration::from_secs(30);
        assert!(!window_expired(start, mid, RESTART_WINDOW));
        let after = start + Duration::from_secs(61);
        assert!(window_expired(start, after, RESTART_WINDOW));
    }
}

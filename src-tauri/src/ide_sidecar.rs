//! `ide_*` MCP sidecar supervision. Mirrors `server_supervisor.rs`'s
//! spawn/monitor/restart pattern for the Bun `sidecar/ide-server` process
//! (MCP streamable-HTTP server + WS bridge the webview dials).
//!
//! A fresh random bearer token is generated per launch and passed to the
//! child via the `MOTHERSHIP_IDE_TOKEN` env var (never argv — argv is
//! visible to every local user via `ps`). The child prints `IDE_PORT=<n>`
//! on stdout once bound; we parse it and write `{port, token}` to a 0600
//! rendezvous file under the Tauri app-data dir, which an external MCP
//! client config (opencode) can read to connect directly.
//!
//! `ide_bridge_info()` exposes the same `{port, token}` pair to the webview
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

/// 64 hex chars from two concatenated v4 UUIDs — no extra RNG dependency.
fn generate_token() -> String {
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

/// Writes `{port, token}` to the rendezvous file, never observably
/// world/group-readable: created at mode 0600 via a sibling temp file, then
/// atomically renamed over the target (Unix only).
fn write_rendezvous_file(
    app_data_dir: &std::path::Path,
    info: &IdeBridgeInfo,
) -> std::io::Result<()> {
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

/// Resolves the default sidecar dir as an absolute path anchored on
/// `CARGO_MANIFEST_DIR`, independent of the child process's CWD. Dev only —
/// production builds never read from the source tree; see
/// [`resolve_sidecar_command`].
fn default_sidecar_dir() -> String {
    let joined = std::path::PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidecar/ide-server"
    ));
    match std::fs::canonicalize(&joined) {
        Ok(canon) => canon.to_string_lossy().into_owned(),
        Err(_) => joined.to_string_lossy().into_owned(),
    }
}

/// The sidecar name registered in `bundle.externalBin` (target-triple
/// suffix stripped at build/bundle time by Tauri).
const BUNDLED_SIDECAR_NAME: &str = "ide-server";

/// How to launch the sidecar process, decided once per spawn.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SidecarCommand {
    /// Debug/dev builds: `bun run <dir>/index.ts` from the source tree.
    DevSource { entry: String },
    /// Release builds: exec the compiled, bundled sidecar binary directly
    /// (no Bun/source-tree dependency at runtime).
    Bundled { binary: std::path::PathBuf },
}

/// Pure decision: debug builds always use the source-tree Bun fallback;
/// release builds always require a resolved bundled-binary path. Kept
/// separate from filesystem existence checks so it's unit-testable without
/// touching disk, mirroring `supervisor_common`'s pure-decision pattern.
fn resolve_sidecar_command(
    is_debug: bool,
    bundled_binary: Option<std::path::PathBuf>,
    dev_dir: &str,
) -> SidecarCommand {
    if is_debug {
        return SidecarCommand::DevSource {
            entry: format!("{dev_dir}/index.ts"),
        };
    }
    SidecarCommand::Bundled {
        binary: bundled_binary.unwrap_or_default(),
    }
}

/// Resolves the bundled sidecar binary path for release builds: Tauri
/// places `externalBin` binaries alongside the main app executable (not in
/// the resource dir), with the target-triple suffix stripped.
fn bundled_sidecar_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join(BUNDLED_SIDECAR_NAME))
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

/// Spawns the ide sidecar (dev: `bun run <dir>/index.ts` from the source
/// tree; release: the bundled compiled binary next to the app executable),
/// reads the `IDE_PORT=<n>` line from stdout, and returns the child plus
/// parsed port. Captures stderr so a spawn/timeout failure has a
/// diagnosable tail.
fn spawn_and_await_port(sidecar_dir: &str, token: &str) -> std::io::Result<(Child, u16)> {
    let command = resolve_sidecar_command(
        cfg!(debug_assertions),
        bundled_sidecar_path(),
        sidecar_dir,
    );

    let (mut cmd, label) = match &command {
        SidecarCommand::DevSource { entry } => {
            if !std::path::Path::new(entry).exists() {
                return Err(std::io::Error::other(format!(
                    "ide sidecar entry not found at {entry}"
                )));
            }
            let mut cmd = std::process::Command::new("bun");
            cmd.arg("run").arg(entry);
            (cmd, entry.clone())
        }
        SidecarCommand::Bundled { binary } => {
            if !binary.exists() {
                return Err(std::io::Error::other(format!(
                    "bundled ide sidecar binary not found at {} — this build is missing its packaged sidecar",
                    binary.display()
                )));
            }
            let cmd = std::process::Command::new(binary);
            (cmd, binary.display().to_string())
        }
    };
    let entry = label;

    cmd.env("MOTHERSHIP_IDE_TOKEN", token);
    cmd.env(
        "MOTHERSHIP_IDE_PARENT_PID",
        std::process::id().to_string(),
    );
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

/// Probes `/health` with the bearer token (auth required, per
/// `sidecar/ide-server/index.ts`).
fn probe_health(port: u16, token: &str) -> bool {
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &addr
            .parse()
            .unwrap_or_else(|_| "127.0.0.1:0".parse().unwrap()),
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

/// Like `resolve_spawn_race`, but also checks the existing child's liveness:
/// a published/owned info whose child already died is stale and must not
/// win the race.
fn ide_race_winner(info_present: bool, owned: bool, existing_alive: bool) -> RaceWinner {
    resolve_spawn_race(info_present && owned && existing_alive)
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
        let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if inner.info.is_some() {
            // Confirm liveness: the health monitor reaps dead children
            // asynchronously, so `info` may still be stale here.
            let alive = matches!(inner.child.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
            if alive {
                return Ok(inner.info.clone().expect("info present"));
            }
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            inner.info = None;
            inner.owned = false;
        }
    }

    let dir = match sidecar_dir {
        Some(d) if !d.is_empty() => d,
        _ => default_sidecar_dir(),
    };
    let token = generate_token();
    let (child, port) = spawn_and_await_port(&dir, &token).map_err(|e| e.to_string())?;
    let info = IdeBridgeInfo {
        port,
        token: token.clone(),
    };

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let mut child = child;
    {
        // Re-validate after reacquiring the lock: a concurrent
        // `ide_bridge_info` call may have won this race while we were
        // unlocked spawning; kill our loser instead of orphaning it.
        let mut inner = state.0.lock().unwrap_or_else(|p| p.into_inner());
        let existing_alive = matches!(inner.child.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
        let race_winner = ide_race_winner(inner.info.is_some(), inner.owned, existing_alive);
        if race_winner == RaceWinner::Existing {
            let existing = inner.info.clone();
            drop(inner);
            let _ = child.kill();
            let _ = child.wait();
            return existing
                .ok_or_else(|| "ide sidecar race lost but no existing info".to_string());
        }
        if inner.info.is_some() && inner.owned && !existing_alive {
            // Winner's child died before we reacquired the lock: reap the
            // stale state so our fresh child installs cleanly below.
            if let Some(mut stale_child) = inner.child.take() {
                let _ = stale_child.kill();
                let _ = stale_child.wait();
            }
            inner.info = None;
            inner.owned = false;
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

        let unhealthy = exited || !port.map(|p| probe_health(p, &token)).unwrap_or(false);
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
                let info = IdeBridgeInfo {
                    port: new_port,
                    token: token.clone(),
                };
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

    #[test]
    fn ide_race_winner_rejects_stale_info_when_existing_child_died() {
        assert_eq!(ide_race_winner(true, true, false), RaceWinner::New);
    }

    #[test]
    fn ide_race_winner_accepts_existing_when_still_alive() {
        assert_eq!(ide_race_winner(true, true, true), RaceWinner::Existing);
    }

    #[test]
    fn ide_race_winner_new_when_not_owned_or_no_info() {
        assert_eq!(ide_race_winner(false, true, true), RaceWinner::New);
        assert_eq!(ide_race_winner(true, false, true), RaceWinner::New);
    }

    #[test]
    fn generate_token_is_64_hex_chars_and_varies() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn debug_build_always_uses_dev_source_fallback() {
        // Even when a bundled binary path is available, debug builds must
        // keep using the source-tree Bun launch path.
        let command = resolve_sidecar_command(
            true,
            Some(std::path::PathBuf::from("/some/bundled/ide-server")),
            "/repo/sidecar/ide-server",
        );
        assert_eq!(
            command,
            SidecarCommand::DevSource {
                entry: "/repo/sidecar/ide-server/index.ts".to_string()
            }
        );
    }

    #[test]
    fn release_build_resolves_bundled_sidecar_path() {
        let command = resolve_sidecar_command(
            false,
            Some(std::path::PathBuf::from("/App.app/Contents/MacOS/ide-server")),
            "/repo/sidecar/ide-server",
        );
        assert_eq!(
            command,
            SidecarCommand::Bundled {
                binary: std::path::PathBuf::from("/App.app/Contents/MacOS/ide-server")
            }
        );
    }

    #[test]
    fn release_build_with_no_resolvable_binary_still_produces_bundled_variant() {
        // Missing-binary detection (actionable startup error) happens at
        // spawn time via a filesystem existence check, not in this pure
        // decision — but the decision itself must never silently fall back
        // to the dev source tree in release mode.
        let command = resolve_sidecar_command(false, None, "/repo/sidecar/ide-server");
        assert_eq!(
            command,
            SidecarCommand::Bundled {
                binary: std::path::PathBuf::new()
            }
        );
    }
}

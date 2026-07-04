//! Promotion-grade PTY layer (U1.4, promoted from the U0.3 spike) —
//! portable-pty behind a small set of Tauri commands, streaming output over
//! per-session event channels.
//!
//! Decision rationale lives in
//! docs/solutions/best-practices/pty-portable-pty-xterm6-decision-2026-07-04.md.
//!
//! Promoted from spike-grade with two of the three documented gaps closed:
//! - Reader `JoinHandle`s are now tracked per session so shutdown can join
//!   them (best-effort — the loop exits on EOF/emit-failure regardless).
//! - `kill_all` reaps every live session; wired into the app's exit/
//!   window-destroy path in lib.rs so quitting the app never orphans a shell.
//! - Output backpressure/coalescing beyond the OS pipe buffer is still out of
//!   scope (fine for one-or-a-few concurrent terminals; revisit if
//!   dogfooding shows a need).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread::JoinHandle;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct PtyState(pub Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    code: Option<u32>,
}

fn shell_command(cwd: Option<&str>) -> CommandBuilder {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell, matches plan's "spawn $SHELL or /bin/zsh login shell"
    // No cwd previously meant the shell inherited the Tauri process's cwd
    // (home dir / app bundle dir when double-clicked) instead of the
    // workspace the user launched/selected — surprising for a terminal
    // meant to sit alongside that workspace.
    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }
    cmd
}

/// Spawns a new PTY running the user's login shell. Returns the pty_id used
/// by write/resize/kill and to subscribe to `pty://output/{pty_id}` and
/// `pty://exit/{pty_id}`.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let child = pair
        .slave
        .spawn_command(shell_command(cwd.as_deref()))
        .map_err(|e| format!("spawn failed: {e}"))?;

    // Drop our copy of the slave once the child owns it; keeping it open
    // past this point isn't needed for the spike and would hold an fd.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let pty_id = uuid::Uuid::new_v4().to_string();

    // Reader thread: streams raw bytes (utf8-lossy decoded) to the frontend
    // via a per-session event. Exits naturally on EOF (child exit or pipe
    // close), which is when we also emit the exit event. Handle is tracked
    // on the session so shutdown paths can join it.
    let reader_thread = {
        let app = app.clone();
        let pty_id = pty_id.clone();
        std::thread::spawn(move || {
            let output_event = format!("pty://output/{pty_id}");
            let exit_event = format!("pty://exit/{pty_id}");
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — child exited or pipe closed
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        if app.emit(&output_event, chunk).is_err() {
                            // Window/app gone — stop pumping.
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(&exit_event, PtyExitPayload { code: None });
        })
    };

    let session = PtySession {
        master: pair.master,
        writer,
        child,
        reader_thread: Some(reader_thread),
    };

    {
        let mut sessions = state
            .0
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?;
        sessions.insert(pty_id.clone(), session);
    }

    Ok(pty_id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, pty_id: String, data: String) -> Result<(), String> {
    let mut sessions = state
        .0
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?;
    let session = sessions
        .get_mut(&pty_id)
        .ok_or_else(|| format!("no such pty: {pty_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .0
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?;
    let session = sessions
        .get(&pty_id)
        .ok_or_else(|| format!("no such pty: {pty_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

/// Kills the child process and removes the session, joining its reader
/// thread best-effort (bounded — the thread exits promptly once the child
/// dies and the pipe closes).
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, pty_id: String) -> Result<(), String> {
    let mut sessions = state
        .0
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?;
    if let Some(session) = sessions.remove(&pty_id) {
        kill_session(session);
    }
    Ok(())
}

fn kill_session(mut session: PtySession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
    if let Some(handle) = session.reader_thread.take() {
        let _ = handle.join();
    }
}

/// Kills every live PTY session. Called from the app's exit/window-destroy
/// path (lib.rs) so quitting never leaves orphaned shells behind — the
/// previously documented gap (no window-destroy/app-quit cleanup hook).
pub fn kill_all(state: &PtyState) {
    let sessions = {
        let mut guard = match state.0.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        std::mem::take(&mut *guard)
    };
    for (_, session) in sessions {
        kill_session(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// Spawns a PTY, writes a command, and reads output back — no GUI
    /// required since portable-pty is headless. Validates the low-level
    /// mechanism this module wraps.
    #[test]
    fn spawn_write_read_roundtrip() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = shell_command(None);
        cmd.env("PS1", "$ ");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut writer = pair.master.take_writer().expect("writer");
        let mut reader = pair.master.try_clone_reader().expect("reader");

        writer
            .write_all(b"echo hi-from-pty-test\n")
            .expect("write");

        let mut collected = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut buf = [0u8; 4096];
        while Instant::now() < deadline && !collected.contains("hi-from-pty-test") {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => collected.push_str(&String::from_utf8_lossy(&buf[..n])),
                Err(_) => break,
            }
        }

        assert!(
            collected.contains("hi-from-pty-test"),
            "expected echoed output in PTY stream, got: {collected:?}"
        );

        let _ = child.kill();
        let _ = child.wait();
    }
}

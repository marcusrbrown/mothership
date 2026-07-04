// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod pty;
mod workspace_fs;

use pty::PtyState;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            workspace_fs::read_text_file,
            workspace_fs::path_exists,
            workspace_fs::home_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Reap every live PTY on app exit — closes the previously
            // documented "no window-destroy/app-quit cleanup hook" gap.
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<PtyState>();
                pty::kill_all(&state);
            }
        });
}

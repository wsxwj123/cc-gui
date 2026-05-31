// Native shell for Claude GUI.
//
// The web app needs the Express backend (port 6677) alive: it spawns `claude`,
// reads ~/.claude, watches files. So on launch we:
//   1. Check whether 6677 is already up (e.g. `cargo tauri dev` started it via
//      beforeDevCommand, or the user ran `npm start` already) — if so, reuse it.
//   2. Otherwise spawn `node server/index.js` (system node, per the chosen
//      architecture), resolving the script from bundled resources (packaged
//      .app) or the repo layout (cargo run / dev).
//   3. Wait until the port answers, then open the window pointing at it.
//   4. Kill the child we spawned when the window is destroyed.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const BACKEND_ADDR: &str = "127.0.0.1:6677";
const BACKEND_URL: &str = "http://127.0.0.1:6677";

// Holds the backend child IFF we spawned it (None when we reused an existing one).
struct Backend(Mutex<Option<Child>>);

fn port_up() -> bool {
    if let Ok(mut addrs) = BACKEND_ADDR.to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            return TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
        }
    }
    false
}

// Resolve server/index.js: prefer the bundled resource dir, fall back to the
// repo layout used during `cargo run`/`cargo tauri dev`.
fn resolve_server_entry(app: &tauri::App) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        // tauri packs the `../server` resource under an `_up_` subdir; try that
        // first, then the un-prefixed layout as a fallback.
        for prefix in ["_up_", ""] {
            let base = if prefix.is_empty() { res.clone() } else { res.join(prefix) };
            let bundled = base.join("server").join("index.js");
            if bundled.exists() {
                return Some(bundled);
            }
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("server")
        .join("index.js");
    if repo.exists() {
        return Some(repo);
    }
    None
}

fn spawn_backend(app: &tauri::App) -> Option<Child> {
    let entry = resolve_server_entry(app)?;
    // cwd = the directory containing `server/` (so relative paths in the server resolve).
    let cwd = entry.parent().and_then(|p| p.parent()).map(PathBuf::from);
    let mut cmd = Command::new("node");
    cmd.arg(&entry).env("PORT", "6677").env("HOST", "127.0.0.1");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("[tauri] failed to spawn node backend: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            if !port_up() {
                if let Some(child) = spawn_backend(app) {
                    *app.state::<Backend>().0.lock().unwrap() = Some(child);
                }
                // Wait for readiness (≤ 20s) before showing the window so the
                // webview never lands on a "connection refused" error page.
                let start = Instant::now();
                while !port_up() && start.elapsed() < Duration::from_secs(20) {
                    std::thread::sleep(Duration::from_millis(250));
                }
            }

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(BACKEND_URL.parse().unwrap()),
            )
            .title("Claude GUI")
            .inner_size(1320.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(mut child) = window
                    .app_handle()
                    .state::<Backend>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

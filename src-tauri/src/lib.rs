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

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const BACKEND_HOST: &str = "127.0.0.1";
const DEFAULT_BACKEND_PORT: u16 = 6677;
const MAX_BACKEND_PORT: u16 = 6687;

// Holds the backend child IFF we spawned it (None when we reused an existing one).
struct Backend(Mutex<Option<Child>>);

fn log_startup(message: &str) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let dir = PathBuf::from(home).join(".claude-gui");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("tauri-startup.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

fn backend_addr(port: u16) -> String {
    format!("{BACKEND_HOST}:{port}")
}

fn backend_url(port: u16) -> String {
    format!("http://{BACKEND_HOST}:{port}")
}

fn port_accepts_tcp(port: u16) -> bool {
    if let Ok(mut addrs) = backend_addr(port).to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            return TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
        }
    }
    false
}

fn backend_healthy(port: u16) -> bool {
    http_get_contains(port, "/api/health", "\"app\":\"claude-gui\"")
}

fn backend_has_local_routes(port: u16) -> bool {
    http_get_contains(port, "/api/bots/available", "\"available\"")
}

fn http_get_contains(port: u16, path: &str, needle: &str) -> bool {
    if let Ok(mut addrs) = backend_addr(port).to_socket_addrs() {
        if let Some(addr) = addrs.next() {
            if let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
                let req = format!(
                    "GET {path} HTTP/1.1\r\nHost: {BACKEND_HOST}:{port}\r\nConnection: close\r\n\r\n"
                );
                if stream.write_all(req.as_bytes()).is_err() {
                    return false;
                }
                let mut buf = [0_u8; 4096];
                if let Ok(n) = stream.read(&mut buf) {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    return text.starts_with("HTTP/1.1 200") && text.contains(needle);
                }
            }
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

fn bundled_local_routes_present(app: &tauri::App) -> bool {
    if let Ok(res) = app.path().resource_dir() {
        for prefix in ["_up_", ""] {
            let base = if prefix.is_empty() { res.clone() } else { res.join(prefix) };
            if base.join("server").join("routes").join("bots.local.js").exists() {
                return true;
            }
        }
    }
    false
}

// 找 node 可执行文件。macOS Finder 启动 GUI 程序时 PATH=minimal
// (/usr/bin:/bin:/usr/sbin:/sbin),Homebrew 装的 /opt/homebrew/bin/node 或
// /usr/local/bin/node 不在里面 → Command::new("node") 直接 ENOENT → spawn
// 失败 → port 永不 up → webview 加载 6677 一片空白(用户报告 v0.1.x 在
// Mac 上空白屏的根因)。
fn find_node() -> Option<PathBuf> {
    // 1) 走继承的 PATH 找(开发模式 / 命令行启动时管用)
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_var.split(sep) {
            if dir.is_empty() { continue; }
            let exe = if cfg!(windows) { "node.exe" } else { "node" };
            let candidate = PathBuf::from(dir).join(exe);
            if candidate.exists() { return Some(candidate); }
        }
    }
    // 2) fallback 已知安装路径(覆盖 Finder 启动的 minimal PATH)
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/opt/homebrew/bin/node",     // Apple Silicon Homebrew
            "/usr/local/bin/node",        // Intel Homebrew / nvm 默认
            "/usr/bin/node",              // 系统(罕见)
        ]
    } else if cfg!(target_os = "windows") {
        &[
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ]
    } else {
        &["/usr/bin/node", "/usr/local/bin/node"]
    };
    for p in candidates {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    None
}

fn spawn_backend(app: &tauri::App, port: u16) -> Option<Child> {
    let entry = resolve_server_entry(app).or_else(|| {
        log_startup("[tauri] server/index.js not found in bundled resources or repo layout");
        None
    })?;
    let node = find_node().or_else(|| {
        log_startup("[tauri] cannot find node executable in PATH or known locations; install Node.js 20+");
        None
    })?;
    // cwd = the directory containing `server/` (so relative paths in the server resolve).
    let cwd = entry.parent().and_then(|p| p.parent()).map(PathBuf::from);
    let mut cmd = Command::new(&node);
    cmd.arg(&entry)
        .env("PORT", port.to_string())
        .env("HOST", BACKEND_HOST)
        .env("CGUI_TAURI", "1")
        .env("CGUI_ENABLE_LOCAL_ROUTES", "1")
        .env("CGUI_DISABLE_FILE_WATCHER", "1");
    // 把 node 所在目录 + Homebrew/Cellar 常见目录前置到子进程 PATH,
    // 这样 server 之后 spawn `claude` / `git` / `cargo` 等也能找到。
    let extra_dirs: Vec<String> = node.parent().map(|d| d.to_string_lossy().to_string()).into_iter()
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].iter().map(|s| s.to_string()))
        .collect();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let current_path = std::env::var("PATH").unwrap_or_default();
    let merged_path = format!("{}{}{}", extra_dirs.join(&sep.to_string()), sep, current_path);
    cmd.env("PATH", merged_path);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            log_startup(&format!("[tauri] failed to spawn node backend: {e}"));
            None
        }
    }
}

fn wait_until_accepting(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while !port_accepts_tcp(port) && start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(250));
    }
    port_accepts_tcp(port)
}

// 校验 6677 上跑的 server 版本是否与本 app 一致。根治"升级 app 却复用了旧 server
// 进程"——旧进程跑旧代码(如旧 cli-check 检测不到 claude → 误报未装)。health 现在
// 返回 {"version":"x.y.z"};旧版 server 不返回 version 字段 → 不匹配 → 视为 stale。
fn backend_version_matches(port: u16) -> bool {
    let want = format!("\"version\":\"{}\"", env!("CARGO_PKG_VERSION"));
    http_get_contains(port, "/api/health", &want)
}

// 杀掉占用指定端口的进程(尽力而为)。只在已确认该端口是 claude-gui server(backend_healthy)
// 但版本不符时调用,所以杀的就是那个 stale server,不会误伤别的程序。失败则降级:下面的
// spawn 循环会跳过仍被占的 6677,改用 6678…(功能正常,只是端口变)。
fn kill_stale_backend(port: u16) {
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("sh")
        .arg("-c")
        .arg(format!("lsof -ti tcp:{port} | xargs kill -TERM"))
        .status();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .args([
            "/C",
            &format!("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port}') do taskkill /F /PID %a"),
        ])
        .status();
    if let Err(e) = result {
        log_startup(&format!("[tauri] kill_stale_backend({port}) failed: {e}"));
    }
}

// 等端口释放(kill 后 TCP socket 不会立刻关闭)。释放成功返回 true。
fn wait_until_free(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while port_accepts_tcp(port) && start.elapsed() < timeout {
        std::thread::sleep(Duration::from_millis(200));
    }
    !port_accepts_tcp(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // L1: 单例插件 — 双击 app 时不开新进程,把已有窗口前置聚焦,避免每次都开新窗口
        // 且不踩坏 6677 上活着的 server(浏览器 session 不掉)。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            let mut selected_port = None;
            let requires_local_routes = bundled_local_routes_present(app);

            let healthy = backend_healthy(DEFAULT_BACKEND_PORT);
            let version_ok = healthy && backend_version_matches(DEFAULT_BACKEND_PORT);
            let local_ok = !requires_local_routes || backend_has_local_routes(DEFAULT_BACKEND_PORT);

            if healthy && version_ok && local_ok {
                selected_port = Some(DEFAULT_BACKEND_PORT);
                log_startup("[tauri] reused healthy backend on port 6677 (version matched)");
            } else {
                // 6677 上是"旧版本(stale)"或"缺 local routes"的 server,不能复用。stale 是
                // cli-check 等旧代码误判(装了 claude 仍提示未装)的根因:杀掉它、等端口释放,
                // 下面的循环重新 spawn 当前版本到 6677。
                if healthy && !version_ok {
                    log_startup("[tauri] stale backend on 6677 (version mismatch) — killing it to respawn current version");
                    kill_stale_backend(DEFAULT_BACKEND_PORT);
                    wait_until_free(DEFAULT_BACKEND_PORT, Duration::from_secs(5));
                } else if healthy && !local_ok {
                    log_startup("[tauri] backend on 6677 lacks local routes — killing it to respawn the full build");
                    kill_stale_backend(DEFAULT_BACKEND_PORT);
                    wait_until_free(DEFAULT_BACKEND_PORT, Duration::from_secs(5));
                }
                for port in DEFAULT_BACKEND_PORT..=MAX_BACKEND_PORT {
                    if port_accepts_tcp(port) {
                        log_startup(&format!("[tauri] port {port} is occupied but not healthy; trying next port"));
                        continue;
                    }
                    if let Some(mut child) = spawn_backend(app, port) {
                        if wait_until_accepting(port, Duration::from_secs(20)) {
                            *app.state::<Backend>().0.lock().unwrap() = Some(child);
                            selected_port = Some(port);
                            log_startup(&format!("[tauri] spawned backend on port {port}"));
                            break;
                        }
                        let _ = child.kill();
                        log_startup(&format!("[tauri] backend on port {port} did not accept connections"));
                    } else {
                        break;
                    }
                }
            }
            let port = selected_port.ok_or("Claude GUI backend did not become healthy on any port from 6677 to 6687")?;

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(backend_url(port).parse().unwrap()),
            )
            .title("Claude GUI")
            // 默认窗口放大,让顶部会话行与所有按钮在「中」字号下完整一行显示,不再
            // 挤成多行(#8)。仍可手动缩小到 min。
            .inner_size(1480.0, 940.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            let _ = window.show();
            let _ = window.set_focus();

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

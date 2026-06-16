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
// S1: 实际使用的后端端口。退出时按端口补杀 —— 复用的 server(非本实例 spawn,
// Backend state 为空)此前退出时无人杀,是 Windows"完全退出后 cmd 仍在"的根因。
struct BackendPort(Mutex<Option<u16>>);

// P1: 关闭行为配置。~/.claude-gui/close-behavior.json {"behavior":"ask|minimize|quit"}
// GUI 设置页通过 server 端点写同一文件;Rust 侧每次 CloseRequested 时现读(无缓存,改完即生效)。
fn read_close_behavior() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let p = PathBuf::from(home).join(".claude-gui").join("close-behavior.json");
    if let Ok(s) = std::fs::read_to_string(&p) {
        for key in ["\"minimize\"", "\"quit\"", "\"ask\""] {
            if s.contains(&format!("\"behavior\": {key}")) || s.contains(&format!("\"behavior\":{key}")) {
                return key.trim_matches('"').to_string();
            }
        }
    }
    "ask".to_string()
}

// P1: 退出时杀整棵后端进程树。child.kill() 只杀 node 本身,node 再 spawn 的
// claude / 终端(Windows cmd)会变孤儿 —— 用户报告"退出 GUI 后 cmd 还开着"。
// Windows 用 taskkill /T 杀树;unix 上 node 死后 claude 子进程会因管道断开退出,
// 再补杀监听端口的残留进程兜底。
fn kill_backend_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .status();
    }
    let _ = child.kill();
}

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
// macOS/Linux:用用户的登录 shell 解析 node —— 这等价于"用户在终端里 `which node`
// 看到的那个",一举覆盖 nvm/fnm/asdf/volta/n 等所有把 node 挂进 shell 初始化的版本
// 管理器(Finder 启动的 app 拿不到这些 shim,固定路径列表也覆盖不全)。这是"终端里
// node -v 有版本、app 却扫不到"在 macOS 上的根治。
#[cfg(unix)]
fn node_from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = std::process::Command::new(&shell)
        .args(["-lic", "command -v node 2>/dev/null"])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout);
    let p = line.lines().next().map(|s| s.trim()).unwrap_or("");
    if p.is_empty() { return None; }
    let pb = PathBuf::from(p);
    if pb.exists() { Some(pb) } else { None }
}

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
    // 1.5) macOS/Linux:登录 shell 解析(覆盖 nvm/fnm/asdf/volta 等版本管理器)
    #[cfg(unix)]
    { if let Some(p) = node_from_login_shell() { return Some(p); } }
    // 2) fallback 已知安装路径(覆盖 Finder 启动的 minimal PATH)。含常见版本管理器固定路径。
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            "/opt/homebrew/bin/node".into(),     // Apple Silicon Homebrew
            "/usr/local/bin/node".into(),        // Intel Homebrew / nvm 默认
            "/usr/bin/node".into(),              // 系统(罕见)
            format!("{home}/.volta/bin/node"),   // Volta
            format!("{home}/.asdf/shims/node"),  // asdf
            format!("{home}/n/bin/node"),        // n
        ]
    } else if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        let localapp = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
        vec![
            r"C:\Program Files\nodejs\node.exe".into(),
            r"C:\Program Files (x86)\nodejs\node.exe".into(),
            format!(r"{localapp}\Volta\bin\node.exe"),       // Volta
            format!(r"{userprofile}\scoop\shims\node.exe"),  // scoop
            r"C:\ProgramData\chocolatey\bin\node.exe".into(),// chocolatey
            format!(r"{appdata}\nvm\node.exe"),              // nvm-windows(symlink 到当前版本)
        ]
    } else {
        vec![
            "/usr/bin/node".into(), "/usr/local/bin/node".into(),
            format!("{home}/.volta/bin/node"), format!("{home}/.asdf/shims/node"),
        ]
    };
    for p in &candidates {
        let pb = PathBuf::from(p);
        if pb.exists() { return Some(pb); }
    }
    // 3) Windows 兜底:从 Explorer 双击启动的 app 继承的 PATH 可能是"装 node 之前"的
    // 旧值(PATH 改动要重登/重启 Explorer 才传播到已运行的 shell),且官方 node 未必装在
    // C:\Program Files\nodejs(自定义目录/按用户安装/nvm/scoop 等)。这里读注册表里的
    // **实时** PATH(Machine+User,不受进程旧 PATH 影响)逐目录找,再退而用 `where node`。
    // 这是"shell 里 node -v 有版本、app 却报找不到 node"(用户报告)的根治。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x08000000; // CREATE_NO_WINDOW:GUI 进程下不闪黑窗
        if let Ok(out) = std::process::Command::new("powershell")
            .args([
                "-NoProfile", "-NonInteractive", "-Command",
                "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')",
            ])
            .creation_flags(NO_WINDOW)
            .output()
        {
            let path_now = String::from_utf8_lossy(&out.stdout);
            for dir in path_now.split(';') {
                let dir = dir.trim();
                if dir.is_empty() { continue; }
                let candidate = PathBuf::from(dir).join("node.exe");
                if candidate.exists() { return Some(candidate); }
            }
        }
        if let Ok(out) = std::process::Command::new("cmd").args(["/c", "where", "node"]).creation_flags(NO_WINDOW).output() {
            let where_out = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = where_out.lines().next() {
                let pb = PathBuf::from(line.trim());
                if pb.exists() { return Some(pb); }
            }
        }
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
        // 不强制 HOST:让 server 读 ~/.claude-gui/network.json 决定绑定(支持默认局域网
        // 及设置页的局域网开关)。health 探测仍连 127.0.0.1,而 0.0.0.0 含 loopback 故可达。
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
    // P1: Windows 上 node 是 console 程序,不加 CREATE_NO_WINDOW 会弹一个常驻 cmd
    // 窗口(用户报告"退出 GUI 后 cmd 还开着"的来源之一)。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // 关键(Windows 根因):Tauri 是 GUI 子系统进程、无 console,加上 CREATE_NO_WINDOW,
    // 默认继承给 node 的 stdout/stderr 是无效句柄。node 启动写 banner(console.log)时对无效
    // 句柄 WriteFile 会失败/阻塞 → server 起不来("did not accept connections",但单独用
    // node 跑完全正常)。把子进程 stdout 丢 null、stderr 重定向到 ~/.claude-gui/server.log:
    // 句柄有效、写文件不会像管道那样填满阻塞,server 正常启动;且 server 的崩溃/报错留档可查。
    // macOS GUI app 的 stdio 本就连到有效目标,这里改动等价无害,顺带也给 Mac 留 server 日志。
    {
        cmd.stdout(std::process::Stdio::null());
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        let log_dir = PathBuf::from(home).join(".claude-gui");
        let _ = std::fs::create_dir_all(&log_dir);
        match OpenOptions::new().create(true).append(true).open(log_dir.join("server.log")) {
            Ok(f) => { cmd.stderr(std::process::Stdio::from(f)); }
            Err(_) => { cmd.stderr(std::process::Stdio::null()); }
        }
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
    // C6:加 -sTCP:LISTEN —— 不加会列出所有「连着」该端口的进程(含浏览器/curl 等客户端),
    // stale kill 时可能误杀正连着调试的客户端进程。只杀真正 LISTEN 在该端口的 server。
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("sh")
        .arg("-c")
        .arg(format!("lsof -ti tcp:{port} -sTCP:LISTEN | xargs kill -TERM"))
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

// S1: 退出时按端口杀后端整棵树。与 kill_stale_backend 的区别:只匹配 LISTENING
// 行(不误伤恰好连着该端口的客户端进程,如浏览器),Windows 加 /T 杀树 +
// CREATE_NO_WINDOW(退出瞬间不闪 cmd 窗)。
fn kill_port_tree(port: u16) {
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("sh")
        .arg("-c")
        .arg(format!("lsof -ti tcp:{port} -sTCP:LISTEN | xargs kill -9"))
        .status();
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args([
            "/C",
            &format!("for /f \"tokens=5\" %a in ('netstat -ano ^| findstr :{port} ^| findstr LISTENING') do taskkill /F /T /PID %a"),
        ]);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c.status()
    };
    if let Err(e) = result {
        log_startup(&format!("[tauri] kill_port_tree({port}) failed: {e}"));
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
        .manage(BackendPort(Mutex::new(None)))
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
                if (healthy && !version_ok) || (healthy && !local_ok) {
                    log_startup(if !version_ok {
                        "[tauri] stale backend on 6677 (version mismatch) — killing it to respawn current version"
                    } else {
                        "[tauri] backend on 6677 lacks local routes — killing it to respawn the full build"
                    });
                    kill_stale_backend(DEFAULT_BACKEND_PORT);
                    // C6:wait_until_free 返回值要用。若 5s 内没释放,直接换端口会把旧 stale 留在
                    // 6677 当孤儿(BackendPort 记新端口,退出只杀新端口 → 6677 永久残留)。
                    // 没释放就升级到 kill_port_tree(SIGKILL + LISTEN 过滤)再等一次。
                    if !wait_until_free(DEFAULT_BACKEND_PORT, Duration::from_secs(5)) {
                        log_startup("[tauri] 6677 still occupied after TERM — escalating to force kill");
                        kill_port_tree(DEFAULT_BACKEND_PORT);
                        wait_until_free(DEFAULT_BACKEND_PORT, Duration::from_secs(3));
                    }
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
                        let _ = child.wait(); // 回收子进程,避免 unix 僵尸(<defunct>);并确保端口释放
                        wait_until_free(port, Duration::from_secs(3));
                        log_startup(&format!("[tauri] backend on port {port} did not accept connections"));
                    } else {
                        break;
                    }
                }
            }
            // 后端没起来:以前直接 `?` 报错退出 → 窗口在后端就绪后才创建,于是变成
            // "进程在跑但永远不弹窗"的隐形僵尸(用户报告:双击没反应、还占着单实例锁)。
            // 改为先弹原生报错框,让失败可见、可定位,再退出。
            let port = match selected_port {
                Some(p) => p,
                None => {
                    // 区分两种失败:① 根本没找到 node(给"打开下载页"按钮直达安装)
                    // ② node 找到了但 server 没起来(引导看日志,别误导用户去装 node)。
                    let node_missing = find_node().is_none();
                    log_startup(&format!(
                        "[tauri] backend did not become healthy on any port 6677-6687; node_missing={node_missing}; showing error dialog"
                    ));
                    let desc = if node_missing {
                        "后台服务未能启动:未找到 Node.js。\n\n\
                         Claude GUI 需要 Node.js 20+ 运行。点「确定」打开官方下载页,\
                         安装后重新打开本应用即可。\n\n\
                         (若你确信已装 node:重启电脑让 PATH 生效;版本管理器装的 node \
                         请确保已在终端配置好。日志:~/.claude-gui/tauri-startup.log)"
                    } else {
                        "后台服务(端口 6677)未能启动,窗口无法加载。\n\n\
                         Node.js 已找到,但 server 未能启动(非缺 node)。\n\
                         请查看日志定位:~/.claude-gui/tauri-startup.log\
                         (Windows:%USERPROFILE%\\.claude-gui\\tauri-startup.log)"
                    };
                    let res = rfd::MessageDialog::new()
                        .set_title("Claude GUI 无法启动")
                        .set_description(desc)
                        .set_buttons(if node_missing { rfd::MessageButtons::OkCancel } else { rfd::MessageButtons::Ok })
                        .show();
                    if node_missing && res == rfd::MessageDialogResult::Ok {
                        let url = "https://nodejs.org/en/download";
                        #[cfg(target_os = "macos")]
                        { let _ = std::process::Command::new("open").arg(url).spawn(); }
                        #[cfg(target_os = "windows")]
                        {
                            use std::os::windows::process::CommandExt;
                            let _ = std::process::Command::new("cmd")
                                .args(["/c", "start", "", url]).creation_flags(0x08000000).spawn();
                        }
                        #[cfg(all(unix, not(target_os = "macos")))]
                        { let _ = std::process::Command::new("xdg-open").arg(url).spawn(); }
                    }
                    return Err("Claude GUI backend did not become healthy on any port from 6677 to 6687".into());
                }
            };
            *app.state::<BackendPort>().0.lock().unwrap() = Some(port);

            // Q2: 顶层文档 URL 带每次启动不同的 ?b= 时间戳 —— 让 WKWebView/代理等任何
            // 按 URL 作 key 的缓存全部 miss,根治"壳里端出旧 index.html"的整类问题。
            // SPA 不读 query,?b= 无副作用;hash 资源仍按文件名长缓存不受影响。
            let boot_nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let load_url = format!("{}/?b={}", backend_url(port), boot_nonce);
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(load_url.parse().unwrap()),
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
            match event {
                // P1: 点关闭按钮 → 按配置决定 最小化/退出/询问。
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let behavior = read_close_behavior();
                    match behavior.as_str() {
                        "minimize" => {
                            api.prevent_close();
                            let _ = window.minimize();
                        }
                        "quit" => { /* 放行,Destroyed 里杀后端树 */ }
                        _ => {
                            // ask(默认):原生三按钮对话框。"是"=退出,"否"=最小化,"取消"=不动。
                            // 固定选择(不再询问)在 设置→概览→关闭行为 里改。
                            let choice = rfd::MessageDialog::new()
                                .set_title("关闭 Claude GUI")
                                .set_description("退出会结束后台服务(6677)及其子进程。\n\n「是」退出 · 「否」最小化\n\n要固定选择不再询问:设置 → 概览 → 关闭行为")
                                .set_buttons(rfd::MessageButtons::YesNoCancel)
                                .show();
                            match choice {
                                rfd::MessageDialogResult::Yes => { /* 放行退出 */ }
                                rfd::MessageDialogResult::No => {
                                    api.prevent_close();
                                    let _ = window.minimize();
                                }
                                _ => { api.prevent_close(); }
                            }
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(mut child) = window
                        .app_handle()
                        .state::<Backend>()
                        .0
                        .lock()
                        .unwrap()
                        .take()
                    {
                        kill_backend_tree(&mut child);
                    }
                    // S1: 复用的 server(本实例没 spawn,上面 take 不到)按端口补杀,
                    // 否则 Windows 选"完全退出"后旧 server 的 cmd 仍留着。
                    if let Some(port) = *window.app_handle().state::<BackendPort>().0.lock().unwrap() {
                        kill_port_tree(port);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // S1: Destroyed 只覆盖"点关闭按钮"路径;Cmd+Q / AppleScript quit / 系统注销
        // 不经过它(实测退出后 6677 仍在监听)。RunEvent::Exit 是所有退出路径的必经
        // 点,在这里统一杀 —— 与 Destroyed 重复执行无害(杀进程幂等)。
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = app_handle.state::<Backend>().0.lock().unwrap().take() {
                    kill_backend_tree(&mut child);
                }
                if let Some(port) = *app_handle.state::<BackendPort>().0.lock().unwrap() {
                    kill_port_tree(port);
                }
            }
        });
}

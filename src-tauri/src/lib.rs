// Native shell for cc-gui.
//
// The web app needs the Express backend (port 6677) alive: it spawns `claude`,
// reads ~/.claude, watches files. So on launch we:
//   1. Create and show the window IMMEDIATELY on a built-in splash page (data:
//      URL, no backend needed) — backend init used to block window creation
//      (up to 20s), which users saw as "double-click, nothing happens".
//   2. On a background thread: check whether 6677 is already up (e.g. `cargo
//      tauri dev` started it via beforeDevCommand, or the user ran `npm start`
//      already) — if so, reuse it. Otherwise spawn `node server/index.js`
//      (system node), resolving the script from bundled resources (packaged
//      .app) or the repo layout (cargo run / dev).
//   3. Wait until the port answers, then navigate the window to it.
//   4. Kill the child we spawned when the window is destroyed.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

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

// F1 全局热键截图:读 ~/.claude-gui/hotkey.json {"enabled":bool,"accelerator":"CmdOrCtrl+Shift+2"}。
// GUI 设置页经 server 端点写同一文件;Rust 侧 setup 时读一次注册,设置页改键经
// set_screenshot_hotkey 命令实时重注册(不再需要重启)。缺省=启用 + CmdOrCtrl+Shift+2
// (避开系统 Cmd+Shift+3/4/5 截图键)。纯字符串解析、不引 serde,和 read_close_behavior 同风格。
struct HotkeyConfig {
    enabled: bool,
    accelerator: String,
}
fn read_hotkey_config() -> HotkeyConfig {
    const DEFAULT_ACCEL: &str = "CmdOrCtrl+Shift+2";
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let p = PathBuf::from(home).join(".claude-gui").join("hotkey.json");
    let s = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(_) => return HotkeyConfig { enabled: true, accelerator: DEFAULT_ACCEL.to_string() },
    };
    // enabled:显式写 "enabled": false 才禁用,其余(含缺字段)都视为启用。
    let enabled = !(s.contains("\"enabled\": false") || s.contains("\"enabled\":false"));
    // accelerator:取 "accelerator": "..." 双引号内内容;取不到/非法用缺省。
    let accelerator = parse_json_string_field(&s, "accelerator")
        .and_then(|a| sanitize_accel(&a))
        .unwrap_or_else(|| DEFAULT_ACCEL.to_string());
    HotkeyConfig { enabled, accelerator }
}

// accelerator 字符集白名单:字母/数字/'+'/空格,与 server/routes/prefs.js 的 ACCEL_RE
// (/^[A-Za-z0-9+ ]+$/)一致。防把任意字符串塞进 global-shortcut 解析。非法/空 → None。
fn sanitize_accel(a: &str) -> Option<String> {
    let a = a.trim();
    if a.is_empty() {
        return None;
    }
    if a.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == ' ') {
        Some(a.to_string())
    } else {
        None
    }
}

// F1: 注册全局截图热键。先 unregister_all 清旧注册(rebind 幂等、避免重复注册报错),
// 再 on_shortcut 挂新键。回调**不置前主窗口** —— 置前会盖住用户想截的目标窗口,导致每次
// 都截到 GUI 自己(真机反馈)。桌面 WKWebView/WebView2 对非前台窗口的 webview 仍执行
// JS 事件/fetch,后台也能收到该 emit 发起 /api/screenshot;截图完成后前端再经
// focus_main_window 把 GUI 带回前台展示结果。setup 与 set_screenshot_hotkey 命令共用此函数。
fn register_screenshot_hotkey(app: &tauri::AppHandle, accel: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let accel = sanitize_accel(accel).ok_or_else(|| "快捷键含非法字符".to_string())?;
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.on_shortcut(accel.as_str(), move |app, _shortcut, event| {
        // 只在按下沿触发(否则按住会重复 emit)。不置前主窗口(见上)。
        if event.state() != ShortcutState::Pressed {
            return;
        }
        let _ = app.emit("cgui:screenshot-hotkey", ());
    })
    .map_err(|e| e.to_string())
}

// 设置页改键/开关热键:enabled=true 用新 accel 重注册;false 则全部注销。
// 注册失败(键位非法/被系统或其它 app 占用)返回 Err,前端提示并回退旧值。
#[tauri::command]
fn set_screenshot_hotkey(app: tauri::AppHandle, enabled: bool, accel: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if !enabled {
        let _ = app.global_shortcut().unregister_all();
        return Ok(());
    }
    register_screenshot_hotkey(&app, &accel)
}

// 截图完成后由前端调用,把 GUI 主窗带回前台展示已入框的截图(取消/失败不调,不打扰)。
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// 自动更新装好后重启:先回收常驻 node 后端(否则老 node 变孤儿占端口,新实例健康检查/kill_stale
// 竞态可能顶掉,见 memory stale-backend),再 app.restart() 加载 updater 已替换好的新 .app。
// 挪到 Rust 侧做,绕开 process 插件在 remote 上下文(生产 webview = http://127.0.0.1:<port>)的
// ACL 门控:前端 plugin-process 的 relaunch() 若后端端口 fallback 出 capabilities 白名单
// (6677-6687)会被 ACL 拒,且被 catch{console.warn} 静默吞掉 = 用户"点重启没反应"的根因。
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    if let Some(backend) = app.try_state::<Backend>() {
        if let Ok(mut guard) = backend.0.lock() {
            if let Some(mut child) = guard.take() {
                kill_backend_tree(&mut child);
                let _ = child.wait(); // 回收,确保端口释放后新实例才起
            }
        }
    }
    app.restart(); // Tauri: cleanup_before_exit + spawn 新实例 + exit;返回 !
}

// 从 {... "key": "value" ...} 里抠出 value(不引 serde,和本文件既有极简解析同风格)。
// 只处理无转义的简单值(热键串就是 ASCII+ 加号,不含引号/反斜杠),够用。
fn parse_json_string_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let after_key = &json[json.find(&needle)? + needle.len()..];
    let after_colon = &after_key[after_key.find(':')? + 1..];
    let start = after_colon.find('"')? + 1;
    let rest = &after_colon[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

// P1: 退出时杀整棵后端进程树。child.kill() 只杀 node 本身,node 再 spawn 的
// claude / 终端(Windows cmd)会变孤儿 —— 用户报告"退出 GUI 后 cmd 还开着"。
// Windows 用 taskkill /T 杀树;unix 上 node 死后 claude 子进程会因管道断开退出,
// 再补杀监听端口的残留进程兜底。
fn kill_backend_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id();
        // CREATE_NO_WINDOW:GUI 进程下 spawn console 程序不闪黑窗(退出瞬间弹 cmd 窗)
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
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
        // 带 unix 毫秒时间戳:历史日志无时间戳,无法量化"双击→窗口可见"各阶段耗时。
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(file, "[{ts}] {message}");
    }
}

// ── 启动页(splash) ─────────────────────────────────────────────────────
// data: URL 内容里只保留 RFC3986 unreserved 字符,其余按 UTF-8 percent-encode,
// 保证 Url::parse 与各平台 WebView 都能无歧义解析(含中文文案/空格/引号)。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// 内置极简启动页:打包进二进制的 data: URL,不依赖后端与磁盘文件。窗口创建即有
// 内容可见;后端就绪后 navigate 到真实 UI 时整页替换。
fn splash_url() -> String {
    let html = r##"<!doctype html><html><head><meta charset="utf-8"><title>cc-gui</title><style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#faf9f5;color:#3d3929;font:14px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){body{background:#262624;color:#c2c0b6}}
.box{text-align:center}
.spin{width:28px;height:28px;margin:0 auto 14px;border:3px solid rgba(125,125,125,.25);border-top-color:#d97757;border-radius:50%;animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
</style></head><body><div class="box"><div class="spin"></div><div id="st">正在启动后台服务…</div></div></body></html>"##;
    format!("data:text/html;charset=utf-8,{}", percent_encode(html))
}

// 更新启动页状态文案(WebviewWindow::eval 注入固定常量 JS,非执行外部数据)。
// text 为本文件内的常量中文,不含引号/换行,直接拼接安全。
fn set_splash_status(win: &tauri::WebviewWindow, text: &str) {
    let _ = win.eval(format!(
        "(function(){{var e=document.getElementById('st');if(e)e.textContent='{text}';}})()"
    ));
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
// 参数改为 AppHandle:后端初始化已移到后台线程,&App 不能跨线程,AppHandle 可。
fn resolve_server_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
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

// Tauri v2 在 Windows 上 resource_dir() 常返回扩展长度路径(verbatim 前缀 `\\?\<盘符>:\…`,
// 网络盘是 `\\?\UNC\server\share\…`)。把这种路径作为入口脚本传给 node,node 解析主模块
// (resolveMainPath)处理不了 `\\?\` 前缀 → 退化成对裸盘符(如 `D:`)做 lstat →
// `EISDIR: illegal operation on a directory, lstat 'D:'` → 后端在进入 server 代码前就崩,
// 逐端口 "did not accept connections"。**装在任意非 C: 盘(D/E/F/G、外接 U 盘/硬盘)都会中招**
// (C: 盘和 dev 模式恰好不复现)。去掉前缀还原成普通 `X:\…` / `\\server\share\…` 即可。
//
// 纯字符串实现、不按平台 cfg:Mac/Linux 的 POSIX 路径(以 `/` 开头)永远不匹配 `\\?\`,
// 原样返回——所以同一份逻辑在 Windows 修 verbatim、在 Mac 是无害直通(外接盘 /Volumes/… 照常)。
// 这样还能在任意平台 `cargo test` 验证(见下方 tests),不必只在 Windows 上才能测。
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    PathBuf::from(strip_verbatim_str(&p.to_string_lossy()))
}

fn strip_verbatim_str(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.to_string()
}

#[cfg(test)]
mod splash_tests {
    use super::splash_url;
    // setup 里对 splash_url().parse() 用了 unwrap:若编码不合法是"启动即崩",
    // 这里锁死 data: URL 必须可被 Url 解析(含中文文案的 percent-encode)。
    #[test]
    fn splash_data_url_parses() {
        let u = splash_url();
        assert!(u.starts_with("data:text/html;charset=utf-8,"));
        let parsed: tauri::Url = u.parse().expect("splash data url must parse");
        assert_eq!(parsed.scheme(), "data");
    }
}

#[cfg(test)]
mod path_tests {
    use super::strip_verbatim_str;
    #[test]
    fn strips_any_drive_and_unc_keeps_others() {
        // 任意盘符(含外接盘映射成的盘符)都剥成普通绝对路径
        assert_eq!(strip_verbatim_str(r"\\?\C:\a\server\index.js"), r"C:\a\server\index.js");
        assert_eq!(strip_verbatim_str(r"\\?\D:\x"), r"D:\x");
        assert_eq!(strip_verbatim_str(r"\\?\E:\cc-gui\server\index.js"), r"E:\cc-gui\server\index.js");
        assert_eq!(strip_verbatim_str(r"\\?\G:\u\v"), r"G:\u\v");
        // 网络盘(UNC)还原成 \\server\share\…
        assert_eq!(strip_verbatim_str(r"\\?\UNC\srv\share\server\index.js"), r"\\srv\share\server\index.js");
        // 已是普通路径 / Mac POSIX 路径 / 外接盘 /Volumes:原样不动
        assert_eq!(strip_verbatim_str(r"D:\already\clean"), r"D:\already\clean");
        assert_eq!(strip_verbatim_str("/Applications/cc-gui.app/Contents/Resources/_up_/server/index.js"),
                   "/Applications/cc-gui.app/Contents/Resources/_up_/server/index.js");
        assert_eq!(strip_verbatim_str("/Volumes/USB DISK/cc-gui.app/server/index.js"),
                   "/Volumes/USB DISK/cc-gui.app/server/index.js");
    }
}

#[cfg(test)]
mod node_probe_tests {
    use super::{best_nvm_version_dir, nvm_settings_symlink};

    #[test]
    fn picks_highest_nvm_version_numerically() {
        let names: Vec<String> = ["v18.19.1", "v20.9.0", "v20.11.0", "temp", "elevation"]
            .iter().map(|s| s.to_string()).collect();
        // 数字逐段比较:v20.11.0 > v20.9.0(按字符串比较会选错)
        assert_eq!(best_nvm_version_dir(&names).as_deref(), Some("v20.11.0"));
        // 无版本目录 / 空列表 → None
        assert_eq!(best_nvm_version_dir(&["temp".to_string()]), None);
        assert_eq!(best_nvm_version_dir(&[]), None);
        // 非 v 前缀或非数字段不参与
        let mixed: Vec<String> = ["v8", "version-x", "v10.0.0"].iter().map(|s| s.to_string()).collect();
        assert_eq!(best_nvm_version_dir(&mixed).as_deref(), Some("v10.0.0"));
    }

    #[test]
    fn parses_nvm_settings_symlink_path() {
        // nvm-windows settings.txt 实际格式(CRLF,root/path/arch/proxy 各一行)
        let s = "root: C:\\Users\\a\\AppData\\Roaming\\nvm\r\npath: C:\\Program Files\\nodejs\r\narch: 64\r\nproxy: none\r\n";
        assert_eq!(nvm_settings_symlink(s).as_deref(), Some(r"C:\Program Files\nodejs"));
        // 没有 path 行 / path 为空 → None
        assert_eq!(nvm_settings_symlink("root: C:\\x\r\narch: 64\r\n"), None);
        assert_eq!(nvm_settings_symlink("path:\n"), None);
    }
}

#[cfg(test)]
mod hotkey_tests {
    use super::{parse_json_string_field, sanitize_accel};
    #[test]
    fn parses_accelerator_field() {
        let j = r#"{ "enabled": true, "accelerator": "CmdOrCtrl+Shift+2" }"#;
        assert_eq!(parse_json_string_field(j, "accelerator").as_deref(), Some("CmdOrCtrl+Shift+2"));
        // 紧凑写法(无空格)
        assert_eq!(parse_json_string_field(r#"{"accelerator":"Alt+F1"}"#, "accelerator").as_deref(), Some("Alt+F1"));
        // 缺字段 → None
        assert_eq!(parse_json_string_field(r#"{"enabled":false}"#, "accelerator"), None);
        // 空值 → Some("")(调用方再 filter 掉)
        assert_eq!(parse_json_string_field(r#"{"accelerator":""}"#, "accelerator").as_deref(), Some(""));
    }

    #[test]
    fn sanitize_accel_accepts_valid_and_rejects_junk() {
        // 合法键位保留(与前端生成的一致)
        assert_eq!(sanitize_accel("CmdOrCtrl+Shift+2").as_deref(), Some("CmdOrCtrl+Shift+2"));
        assert_eq!(sanitize_accel("Alt+F1").as_deref(), Some("Alt+F1"));
        // 前后空白裁剪
        assert_eq!(sanitize_accel("  CmdOrCtrl+X  ").as_deref(), Some("CmdOrCtrl+X"));
        // 空/纯空白 → None
        assert_eq!(sanitize_accel(""), None);
        assert_eq!(sanitize_accel("   "), None);
        // 非法字符(引号/反斜杠/连字符等)一律拒绝,防注入
        assert_eq!(sanitize_accel("Cmd+\"; rm -rf"), None);
        assert_eq!(sanitize_accel("Ctrl-Alt-Del"), None);
        assert_eq!(sanitize_accel("Cmd+\\"), None);
    }
}

fn bundled_local_routes_present(app: &tauri::AppHandle) -> bool {
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

// nvm-windows 的版本目录名形如 "v20.11.0";按数字逐段比较挑最高版本。
// 纯函数(不碰文件系统),任意平台可单测;字符串比较会把 v20.9.0 排在 v20.11.0 后,必须数字比。
fn best_nvm_version_dir(names: &[String]) -> Option<String> {
    fn ver_key(name: &str) -> Option<Vec<u64>> {
        let parts: Option<Vec<u64>> = name
            .strip_prefix('v')?
            .split('.')
            .map(|p| p.parse::<u64>().ok())
            .collect();
        parts.filter(|v| !v.is_empty())
    }
    names
        .iter()
        .filter_map(|n| ver_key(n).map(|k| (k, n.clone())))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, n)| n)
}

// 解析 nvm-windows settings.txt 的 `path:` 行 —— 那是"当前启用版本"的符号链接目录
// (默认 C:\Program Files\nodejs,可自定义),node.exe 就在它下面。纯函数,可单测。
fn nvm_settings_symlink(settings: &str) -> Option<String> {
    for line in settings.lines() {
        if let Some(rest) = line.trim().strip_prefix("path:") {
            let p = rest.trim();
            if !p.is_empty() {
                return Some(p.to_string());
            }
        }
    }
    None
}

// Windows 常见 node 安装位候选(含各包管理器),返回 (路径, 来源说明) 供探测/日志/报错框共用。
// 背景:Explorer 双击启动的 GUI 进程继承的 PATH 是登录时的快照 —— 用户装完 node 没重启
// (或 node 只写进了用户 PATH 而进程读的是旧值)时 PATH 探测必失败,必须按安装位兜底。
// 用 cfg!() 运行时判断而非 #[cfg] 条件编译,让这段 Windows 逻辑在 mac 上也参与编译与单测。
fn windows_node_candidates() -> Vec<(PathBuf, &'static str)> {
    let env_or = |key: &str, default: &str| std::env::var(key).unwrap_or_else(|_| default.to_string());
    // 用环境变量而非硬编码 C:\ —— 系统盘不是 C: 的机器(或重定向的 Program Files)也能中。
    let program_files = env_or("ProgramFiles", r"C:\Program Files");
    let program_files_x86 = env_or("ProgramFiles(x86)", r"C:\Program Files (x86)");
    let localapp = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let userprofile = std::env::var("USERPROFILE").unwrap_or_default();
    let mut out: Vec<(PathBuf, &'static str)> = vec![
        (PathBuf::from(format!(r"{program_files}\nodejs\node.exe")), "官方安装(所有用户)"),
        (PathBuf::from(format!(r"{program_files_x86}\nodejs\node.exe")), "官方安装(x86)"),
    ];
    if !localapp.is_empty() {
        // 官方安装器选"仅为当前用户安装"时落在 %LOCALAPPDATA%\Programs\nodejs
        out.push((PathBuf::from(format!(r"{localapp}\Programs\nodejs\node.exe")), "官方安装(仅当前用户)"));
        out.push((PathBuf::from(format!(r"{localapp}\Volta\bin\node.exe")), "Volta"));
    }
    // nvm-windows:node.exe 不在 %APPDATA%\nvm 根目录(此前候选写的是根目录,永远探不到)。
    // 先取 settings.txt 里 path: 指向的"当前版本"符号链接,再兜底扫 v* 版本目录取最高版。
    if !appdata.is_empty() {
        let nvm_root = format!(r"{appdata}\nvm");
        if let Ok(settings) = std::fs::read_to_string(format!(r"{nvm_root}\settings.txt")) {
            if let Some(link) = nvm_settings_symlink(&settings) {
                out.push((PathBuf::from(format!(r"{link}\node.exe")), "nvm-windows(当前版本)"));
            }
        }
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            let names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect();
            if let Some(best) = best_nvm_version_dir(&names) {
                out.push((PathBuf::from(format!(r"{nvm_root}\{best}\node.exe")), "nvm-windows(最高版本)"));
            }
        }
    }
    if !userprofile.is_empty() {
        out.push((PathBuf::from(format!(r"{userprofile}\scoop\shims\node.exe")), "scoop(shim)"));
        // scoop 真身:apps\nodejs*\current\node.exe(nodejs / nodejs-lts 两种包名)
        if let Ok(entries) = std::fs::read_dir(format!(r"{userprofile}\scoop\apps")) {
            for e in entries.filter_map(|e| e.ok()) {
                if let Ok(name) = e.file_name().into_string() {
                    if name.to_ascii_lowercase().starts_with("nodejs") {
                        out.push((PathBuf::from(format!(r"{}\current\node.exe", e.path().display())), "scoop(app)"));
                    }
                }
            }
        }
    }
    out.push((PathBuf::from(r"C:\ProgramData\chocolatey\bin\node.exe"), "chocolatey"));
    out
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
    // 2) fallback 已知安装路径(覆盖 Finder 启动的 minimal PATH / Explorer 的旧 PATH 快照)。
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "windows") {
        for (pb, src) in windows_node_candidates() {
            if pb.exists() {
                // 命中固定安装位=PATH 探测失败的兜底成功,记来源便于诊断
                log_startup(&format!("[tauri] find_node: hit fixed candidate [{src}] {}", pb.display()));
                return Some(pb);
            }
        }
    } else {
        let candidates: Vec<String> = if cfg!(target_os = "macos") {
            vec![
                "/opt/homebrew/bin/node".into(),     // Apple Silicon Homebrew
                "/usr/local/bin/node".into(),        // Intel Homebrew / nvm 默认
                "/usr/bin/node".into(),              // 系统(罕见)
                format!("{home}/.volta/bin/node"),   // Volta
                format!("{home}/.asdf/shims/node"),  // asdf
                format!("{home}/n/bin/node"),        // n
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
                if candidate.exists() {
                    log_startup(&format!("[tauri] find_node: hit via registry live PATH {}", candidate.display()));
                    return Some(candidate);
                }
            }
        }
        if let Ok(out) = std::process::Command::new("cmd").args(["/c", "where", "node"]).creation_flags(NO_WINDOW).output() {
            let where_out = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = where_out.lines().next() {
                let pb = PathBuf::from(line.trim());
                if pb.exists() {
                    log_startup(&format!("[tauri] find_node: hit via `where node` {}", pb.display()));
                    return Some(pb);
                }
            }
        }
    }
    // 全部落空:把实际探测过的固定安装位落盘,用户回传日志即可看出差在哪一环。
    if cfg!(target_os = "windows") {
        let probed: Vec<String> = windows_node_candidates()
            .iter()
            .map(|(p, src)| format!("[{src}] {}", p.display()))
            .collect();
        log_startup(&format!(
            "[tauri] find_node: MISS — inherited PATH / registry PATH / where node all failed; fixed candidates probed: {}",
            probed.join(" ; ")
        ));
    }
    None
}

fn spawn_backend(app: &tauri::AppHandle, port: u16) -> Option<Child> {
    let entry = resolve_server_entry(app).or_else(|| {
        log_startup("[tauri] server/index.js not found in bundled resources or repo layout");
        None
    })?;
    // 去掉 Windows verbatim 前缀(\\?\),否则 node 解析入口脚本即崩(见 strip_verbatim_prefix)。
    let entry = strip_verbatim_prefix(entry);
    let node = find_node().or_else(|| {
        log_startup("[tauri] cannot find node executable in PATH or known locations; install Node.js 20+");
        None
    })?;
    log_startup(&format!("[tauri] spawn_backend node={} entry={}", node.display(), entry.display()));
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
        // r29 取证:server.log append-only 无滚动会无限涨 —— spawn 前超 5MB 改名
        // server.log.old 再开新(与 server 侧 crash.log/client.log 同口径)。必须在
        // 打开句柄之前做:Windows 上打开中的文件改名会失败。
        let server_log = log_dir.join("server.log");
        if let Ok(meta) = std::fs::metadata(&server_log) {
            if meta.len() > 5 * 1024 * 1024 {
                let _ = std::fs::rename(&server_log, log_dir.join("server.log.old"));
            }
        }
        match OpenOptions::new().create(true).append(true).open(&server_log) {
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
    // APP_VERSION 由 build.rs 从 package.json 读取(单一真源),避免 Cargo.toml 漂移导致
    // 版本握手拿错版本、把旧 server 误判匹配而复用(Windows 重装爆红根因)。
    let want = format!("\"version\":\"{}\"", env!("APP_VERSION"));
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

// 报错框用:列出本机实际探测过的 node 位置,用户可逐项核对(装在别处/确实没装一眼可辨)。
// Windows 列具体固定安装位(与 find_node 用同一份 windows_node_candidates,不会漂移);
// mac/Linux 探测方式是 PATH+登录 shell+固定列表,概括一行即可。
fn node_probe_report() -> String {
    if cfg!(target_os = "windows") {
        let mut lines = vec!["· 当前进程 PATH、注册表实时 PATH(系统+用户)、where node".to_string()];
        for (p, src) in windows_node_candidates() {
            lines.push(format!("· {}({src})", p.display()));
        }
        lines.join("\n")
    } else {
        "· PATH、登录 shell(command -v node)、Homebrew/Volta/asdf/n 常见安装位".to_string()
    }
}

// 报错框/日志展示用:启动日志的完整绝对路径(Windows 用户不认识 ~,给全路径可直接粘进资源管理器)。
fn gui_log_path_display(file_name: &str) -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let sep = if cfg!(windows) { '\\' } else { '/' };
    format!("{home}{sep}.claude-gui{sep}{file_name}")
}

// ── r29 webview 自愈 ──────────────────────────────────────────────────────
// 背景:用户实测 Windows 上 WebView2 渲染进程 OOM 崩溃,形态为整个窗口消失。
// API 查证(本仓锁定 tauri 2.11.2 / wry 0.55.1,逐文件 grep 过源码而非凭记忆):
//   · tauri 2.11.2 Builder 全部 on_* 钩子(app.rs):on_page_load /
//     on_web_content_process_terminate / on_menu_event / on_tray_icon_event /
//     on_window_event / on_webview_event —— 没有跨平台 on_process_failed;
//   · 唯一等价物 on_web_content_process_terminate 文档明示
//     "Linux / Windows / Android: Unsupported",仅 macOS/iOS 生效;
//   · wry 0.55.1 的 WebView2 后端(webview2/mod.rs)完全没接 WebView2 的
//     ProcessFailed 事件(全仓 grep "ProcessFailed" 零命中)——Windows 上要挂
//     只能经 WebviewWindow::with_webview 拿 ICoreWebView2 再 add_ProcessFailed,
//     那需要直接依赖 webview2-com(本轮禁令:不加新 crate)。故 Windows 渲染
//     进程崩溃的"事件→重载"闭环暂无 API 可挂,是已知遗留(见提交说明)。
// 在此约束下分两层做自愈:
//   ① macOS/iOS:on_web_content_process_terminate —— WKWebView WebContent
//      进程被 jetsam/崩溃杀掉时触发。事件详情落 tauri-startup.log(与后端
//      监护线程同文件同格式)+ stderr,然后 reload 拉起新 content 进程
//      恢复页面(content 进程死后 WKWebView 停在空白页,reload 是标准恢复)。
//      10s 节流:持续 OOM 时不陷入"崩溃→重载→再崩溃"死循环,只记录不重载。
//      绝不 panic:全程 let _ = / match,不用 unwrap/expect,主进程不跟着崩。
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn on_webview_process_terminated(webview: &tauri::Webview) {
    use std::sync::atomic::{AtomicI64, Ordering};
    const MIN_RELOAD_INTERVAL_MS: i64 = 10_000;
    static LAST_RELOAD_MS: AtomicI64 = AtomicI64::new(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let label = webview.label().to_string();
    let msg = format!(
        "[tauri] webview watchdog: '{label}' web content process terminated (renderer crash/OOM)"
    );
    log_startup(&msg);
    eprintln!("{msg}");
    let last = LAST_RELOAD_MS.load(Ordering::Relaxed);
    // 冷启动 now_ms 取不到(0)时 last=0、now-last=0 会误节流;负数同理放行。
    if now_ms > 0 && now_ms - last < MIN_RELOAD_INTERVAL_MS {
        log_startup(&format!(
            "[tauri] webview watchdog: '{label}' not auto-reloading (throttled, last reload {}ms ago)",
            now_ms - last
        ));
        return;
    }
    LAST_RELOAD_MS.store(now_ms, Ordering::Relaxed);
    match webview.reload() {
        Ok(_) => log_startup(&format!(
            "[tauri] webview watchdog: '{label}' reloaded after process termination (self-heal ok)"
        )),
        Err(e) => log_startup(&format!(
            "[tauri] webview watchdog: '{label}' reload after termination failed: {e} (main process stays up)"
        )),
    }
}

// ② Windows:WebView2 浏览器参数,GPU 崩溃形态的自愈。Chromium 默认 GPU 进程
//    崩 ~6 次后永久停用 GPU 合成直到进程重启(页面黑/卡死,用户只能重开 app);
//    --disable-gpu-process-crash-limit 去掉该上限,GPU 进程崩溃后无限自动重启。
//    ⚠ wry 0.55.1(webview2/mod.rs:294)里 additional_browser_args 是整体替换
//    默认参数而非追加,必须原样带上三条默认 --disable-features,否则
//    msSmartScreenProtection 等被改回默认启用(本应用纯本地无遥测,必须保持禁用)。
//    渲染进程崩溃(非 GPU)在 Windows 上无事件可挂,见上方 API 查证注释。
#[cfg(target_os = "windows")]
const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-process-crash-limit";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 诊断①:进程一进来先落一行日志。此前首条日志在窗口创建之后 —— 若窗口创建前就
    // panic/失败,日志文件里什么都没有,真机取证无从下手。现在只要双击过,日志必有此行。
    log_startup(&format!(
        "[tauri] ===== launch v{} ({} {}) =====",
        env!("APP_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    // 诊断②:panic 落盘。GUI 子系统进程的 panic 只写 stderr,双击启动时无人可见
    // (v0.2.98 缺 webview-data-url feature 的启动 panic 就是这样静默闪退、零痕迹)。
    // 钩子写完日志仍调用默认钩子,dev 模式下终端里的 panic 输出不受影响。
    let default_panic_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_startup(&format!("[tauri] PANIC: {info}"));
        default_panic_hook(info);
    }));
    let builder = tauri::Builder::default()
        // 官方对话框插件:前端文件夹选择器走进程内原生对话框(秒开、置前)。
        // 权限见 capabilities/dialog.json(生产 remote 上下文须列全端口)。
        .plugin(tauri_plugin_dialog::init())
        // 自动更新:updater(check/downloadAndInstall)+ process(更新完成后 relaunch)。
        // 权限见 capabilities/updater.json(生产 remote 上下文须列全端口)。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // L2: 系统通知(窗口不在前台时提示有东西在等你)。权限见 capabilities/notification.json。
        // 桌面端只注册 notify/request_permission/is_permission_granted 三个命令,
        // 通知点击回调(onAction)在桌面端不存在 —— 前端不要接,聚焦靠 Dock 角标 + 应用内。
        .plugin(tauri_plugin_notification::init())
        // F1: 全局热键截图。插件在此挂载,具体快捷键在 setup 里按 ~/.claude-gui/hotkey.json 注册。
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
        .manage(BackendPort(Mutex::new(None)));
    // r29 自愈①:挂渲染进程终止钩子(macOS/iOS 生效;Windows 无此 API,见
    // on_webview_process_terminated 注释里的查证)。cfg 门与 tauri 该方法自身的
    // cfg(any(macos, ios)) 一致,其它平台不编译这段。
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    let builder = builder.on_web_content_process_terminate(on_webview_process_terminated);
    builder
        // F1: 设置页实时重注册热键 + 截图完成后置前主窗。app 本地命令无需 capability 授权。
        .invoke_handler(tauri::generate_handler![set_screenshot_hotkey, focus_main_window, restart_app])
        .setup(|app| {
            // ① 启动加速:窗口带内置启动页立即创建并显示。后端初始化(健康检查/杀旧
            // 进程/spawn node + 等端口就绪,常规 1~3s,杀旧/重试路径可达 20s+)以前全部
            // 阻塞在窗口创建之前 —— 用户双击后长时间看不到任何窗口(Mac/Win 同一根因)。
            // 现改为后台线程初始化,就绪后 navigate 到真实 UI;启动语义(复用健康后端、
            // 版本不符先杀旧、逐端口 spawn)不变。
            // 默认尺寸自适应主屏(用户报告:1560 固定宽在大字号 zoom≥1.15 时标题栏必换两行)。
            // 标题栏一行需 ~1210 逻辑宽;1860 = 1210 × 1.25(大字号)+ 余量,覆盖常用档位。
            // 小屏(13" MBP 1440/1512 逻辑点)取屏宽 94%,已是该屏最优;monitor.size 是物理
            // 像素,除 scale_factor 得逻辑点。拿不到 monitor 就回落旧值 1560×960。
            let (win_w, win_h) = match app.primary_monitor() {
                Ok(Some(m)) => {
                    let sf = m.scale_factor().max(0.5);
                    let sw = m.size().width as f64 / sf;
                    let sh = m.size().height as f64 / sf;
                    (1860.0_f64.min(sw * 0.94), 1040.0_f64.min(sh * 0.90))
                }
                _ => (1560.0, 960.0),
            };
            // 诊断③:窗口创建失败不再经 `?` 静默上抛(最终 expect panic,双击的用户什么都
            // 看不到)。先落日志、再弹原生框说清最可能的原因(Windows 上多为 WebView2
            // Runtime 缺失/损坏),setup 在主线程跑,rfd 同步对话框可直接弹。
            let window_builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(splash_url().parse().unwrap()),
            )
            .title("cc-gui")
            .inner_size(win_w, win_h)
            .min_inner_size(900.0, 600.0)
            // 关闭 Tauri 原生文件拖放:默认启用会在 OS 层吃掉拖放事件,webview 的
            // HTML5 ondrop 永远收不到文件(用户报"输入框拖不进 PDF/图片")。关掉后
            // 交给前端 ChatInput 的 handleDrop(HTML5 drag-drop)处理。
            .disable_drag_drop_handler()
            .center();
            // r29 自愈②(Windows):GPU 进程崩溃后自动重启(去掉 Chromium 的崩溃次数
            // 上限),见 WEBVIEW2_BROWSER_ARGS 注释。非 Windows 平台该方法是 no-op,
            // 这里用 cfg 只在 Windows 上接线并把所用参数落日志(取证可查)。
            #[cfg(target_os = "windows")]
            let window_builder = {
                log_startup(&format!("[tauri] WebView2 additional browser args: {WEBVIEW2_BROWSER_ARGS}"));
                window_builder.additional_browser_args(WEBVIEW2_BROWSER_ARGS)
            };
            let window = match window_builder
            .build()
            {
                Ok(w) => w,
                Err(e) => {
                    log_startup(&format!("[tauri] FATAL: webview window creation failed: {e}"));
                    rfd::MessageDialog::new()
                        .set_title("cc-gui 无法启动")
                        .set_description(format!(
                            "窗口创建失败:{e}\n\n\
                             Windows 上常见原因是 WebView2 Runtime 缺失或损坏,\
                             可在微软官网搜索「Evergreen WebView2 Runtime」重新安装后再试。\n\n\
                             启动日志(反馈问题请附上):\n{}",
                            gui_log_path_display("tauri-startup.log")
                        ))
                        .show();
                    return Err(e.into());
                }
            };
            let _ = window.show();
            let _ = window.set_focus();
            log_startup("[tauri] window shown on splash page");
            // 层级修复①:窗口可能晚于 app 激活。若用户启动瞬间点了别的 app,窗口首次
            // 显示会落在其它窗口后面。延迟 600ms 再 set_focus 一次,赢下启动激活竞态;
            // 间隔足够短,不算抢焦点。
            {
                let w2 = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(600));
                    let _ = w2.unminimize();
                    let _ = w2.set_focus();
                });
            }

            // F1: 注册全局截图热键。热键触发 → 仅 emit 事件(不置前主窗口,见
            // register_screenshot_hotkey 注释),前端监听后调 /api/screenshot,完成后回置前。
            // 在后台线程初始化之外单独注册(与端口探测无关,应尽早生效)。注册失败(键位非法/已被
            // 其它 app 占用)只记日志、不阻断启动 —— GUI 其余功能不受影响。
            {
                let cfg = read_hotkey_config();
                if cfg.enabled {
                    match register_screenshot_hotkey(app.handle(), &cfg.accelerator) {
                        Ok(_) => log_startup(&format!("[tauri] registered screenshot hotkey '{}'", cfg.accelerator)),
                        Err(e) => log_startup(&format!("[tauri] failed to register screenshot hotkey '{}': {e}", cfg.accelerator)),
                    }
                } else {
                    log_startup("[tauri] screenshot hotkey disabled by config");
                }
            }

            let handle = app.handle().clone();
            let win = window.clone();
            std::thread::spawn(move || {
            let mut selected_port = None;
            let requires_local_routes = bundled_local_routes_present(&handle);

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
                    // 杀旧重启耗时可达数秒,启动页上给出可见反馈。
                    set_splash_status(&win, "检测到旧版本后台服务,正在替换…");
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
                    if let Some(mut child) = spawn_backend(&handle, port) {
                        if wait_until_accepting(port, Duration::from_secs(20)) {
                            *handle.state::<Backend>().0.lock().unwrap() = Some(child);
                            selected_port = Some(port);
                            log_startup(&format!("[tauri] spawned backend on port {port}"));
                            // r29 取证:server 死了 Tauri 壳无感知无记录(Windows 公开版
                            // "用一段时间整个窗口消失"拿不到证据的根因之一)。起 5s 间隔
                            // try_wait 监护线程:退出即把 时间戳+exit code/signal 追加进
                            // tauri-startup.log 并 eprintln。不做自动重启(本期只取证)。
                            // 正常关停路径 take 走 child 后,监护看到 None 静默退出。
                            {
                                let h = handle.clone();
                                std::thread::spawn(move || loop {
                                    std::thread::sleep(Duration::from_secs(5));
                                    let state = h.state::<Backend>();
                                    let mut guard = state.0.lock().unwrap();
                                    let Some(child) = guard.as_mut() else { break };
                                    match child.try_wait() {
                                        Ok(Some(status)) => {
                                            let msg = format!(
                                                "[tauri] backend watchdog: server child pid={} port={port} exited ({status})",
                                                child.id()
                                            );
                                            log_startup(&msg);
                                            eprintln!("{msg}");
                                            // 已退出并落盘:take 掉避免关停路径再 kill 一次。
                                            let _ = guard.take();
                                            break;
                                        }
                                        Ok(None) => {}
                                        Err(e) => {
                                            let msg = format!("[tauri] backend watchdog try_wait failed: {e}");
                                            log_startup(&msg);
                                            eprintln!("{msg}");
                                            break;
                                        }
                                    }
                                });
                            }
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
            // 后端没起来:弹原生报错框,让失败可见、可定位,再退出。
            // (rfd 同步对话框必须在主线程弹 —— 本段跑在后台线程,经 run_on_main_thread 调度。)
            let port = match selected_port {
                Some(p) => p,
                None => {
                    // 区分两种失败:① 根本没找到 node(给"打开下载页"按钮直达安装)
                    // ② node 找到了但 server 没起来(引导看日志,别误导用户去装 node)。
                    let node_missing = find_node().is_none();
                    log_startup(&format!(
                        "[tauri] backend did not become healthy on any port 6677-6687; node_missing={node_missing}; showing error dialog"
                    ));
                    let h2 = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let desc = if node_missing {
                            format!(
                                "后台服务未能启动:未找到 Node.js。\n\n\
                                 cc-gui 需要 Node.js 20+ 运行。点「确定」打开官方下载页,\
                                 安装后重新打开本应用即可。\n\n\
                                 若已安装 node:请重启系统后再试 —— 安装时写入的 PATH \
                                 不会即时刷新到桌面启动的程序里。\n\n\
                                 已探测过的位置(均未找到 node):\n{}\n\n\
                                 启动日志(反馈问题请附上此文件):\n{}",
                                node_probe_report(),
                                gui_log_path_display("tauri-startup.log")
                            )
                        } else {
                            format!(
                                "后台服务(端口 6677)未能启动,窗口无法加载。\n\n\
                                 Node.js 已找到,但 server 未能启动(非缺 node,无需重装)。\n\n\
                                 请查看以下日志定位(反馈问题请附上两份文件):\n{}\n{}",
                                gui_log_path_display("tauri-startup.log"),
                                gui_log_path_display("server.log")
                            )
                        };
                        let res = rfd::MessageDialog::new()
                            .set_title("cc-gui 无法启动")
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
                        h2.exit(1);
                    });
                    return;
                }
            };
            *handle.state::<BackendPort>().0.lock().unwrap() = Some(port);

            // Q2: 顶层文档 URL 带每次启动不同的 ?b= 时间戳 —— 让 WKWebView/代理等任何
            // 按 URL 作 key 的缓存全部 miss,根治"壳里端出旧 index.html"的整类问题。
            // SPA 不读 query,?b= 无副作用;hash 资源仍按文件名长缓存不受影响。
            let boot_nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let load_url = format!("{}/?b={}", backend_url(port), boot_nonce);
            match load_url.parse() {
                Ok(u) => {
                    let _ = win.navigate(u);
                    log_startup(&format!("[tauri] navigated window to backend on port {port}"));
                }
                Err(e) => log_startup(&format!("[tauri] invalid backend url {load_url}: {e}")),
            }
            });

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
                                .set_title("关闭 cc-gui")
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
            match event {
                tauri::RunEvent::Exit => {
                    if let Some(mut child) = app_handle.state::<Backend>().0.lock().unwrap().take() {
                        kill_backend_tree(&mut child);
                    }
                    if let Some(port) = *app_handle.state::<BackendPort>().0.lock().unwrap() {
                        kill_port_tree(port);
                    }
                }
                // 层级修复②(macOS):点 Dock 图标重开 —— 原来完全没处理,窗口被别的窗口
                // 盖住/最小化时点图标毫无反应,用户感知为"GUI 一直沉在最底层"。标准做法:
                // Reopen 时 unminimize + show + set_focus 把主窗带回最前(普通软件的行为)。
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(w) = app_handle.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                _ => {}
            }
        });
}

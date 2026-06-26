use std::fs;
use std::path::Path;

fn main() {
    // 单一真源:从根 package.json 读版本,经 APP_VERSION 注入,供 lib.rs 的版本握手
    // (backend_version_matches)使用。否则要靠手动同步 Cargo.toml,一旦漂移(实际发生过:
    // Cargo.toml 停在 0.2.75、package.json 已到 0.2.83),版本握手会拿错版本——把 6677 上
    // 残留的旧版本 server 误判为"匹配"而复用,导致前端(新 bundle)与服务端(旧)版本不一致
    // 爆红。读 package.json 后两者永远一致。
    let pkg = Path::new("..").join("package.json");
    let version = fs::read_to_string(&pkg)
        .ok()
        .and_then(|s| {
            s.split("\"version\"")
                .nth(1)
                .and_then(|rest| rest.split('"').nth(1).map(String::from))
        })
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    println!("cargo:rustc-env=APP_VERSION={version}");
    println!("cargo:rerun-if-changed=../package.json");
    tauri_build::build()
}

#!/usr/bin/env node
// 单测:r29 WebView2/WebContent 渲染进程崩溃自愈(src-tauri/src/lib.rs 源码哨兵)。
// 背景:Windows 上 WebView2 渲染进程 OOM 崩溃,用户实测形态=整个窗口消失;
// Tauri2 默认不处理渲染进程死亡。本仓 tauri 2.11.2 / wry 0.55.1 无跨平台
// ProcessFailed API(源码 grep 查证),落地方案两层:
//   ① macOS/iOS:Builder::on_web_content_process_terminate —— 落日志 + reload
//      自愈 + 10s 节流防崩溃-重载死循环 + 绝不 panic。
//   ② Windows:additional_browser_args 加 --disable-gpu-process-crash-limit
//      (GPU 崩溃形态自愈;wry 整体替换默认参数,三条默认 --disable-features 须原样保留)。
// 哨兵断言:
//   t1 handler 挂载点存在且函数定义存在
//   t2 日志写入:与后端监护线程同文件(tauri-startup.log,经 log_startup)同格式
//   t3 自愈:reload 调用 + 节流
//   t4 不 panic/exit:handler 体内无 unwrap/expect/panic!/process::exit/exit(
//   t5 Windows browser args:GPU 旗标 + wry 三条默认 features 原样保留
//   t6 平台 cfg 门:mac 钩子不编进 Windows,Windows args 不编进 mac
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');

// t1 handler 挂载点 + 定义
{
  assert.match(src, /on_web_content_process_terminate\(on_webview_process_terminated\)/,
    't1: Builder 挂 on_web_content_process_terminate 钩子');
  assert.match(src, /fn on_webview_process_terminated\(webview: &tauri::Webview\)/,
    't1: handler 函数定义存在,签名对齐 tauri 2.11.2 的 Fn(&Webview<R>)');
}

// t2 日志写入:同文件同格式(log_startup → tauri-startup.log,与监护线程一致)
{
  assert.match(src, /webview watchdog:.*web content process terminated/,
    't2: 渲染进程终止事件有日志(log_startup 口径与 backend watchdog 一致)');
  // handler 体内必须走 log_startup(既有落盘函数),不得只 eprintln
  const fnBody = src.slice(src.indexOf('fn on_webview_process_terminated'), src.indexOf('// ② Windows:'));
  assert.match(fnBody, /log_startup/, 't2: handler 经 log_startup 落 tauri-startup.log(与监护线程同文件)');
  assert.match(fnBody, /eprintln!/, 't2: handler 同时 eprintln(与监护线程同口径)');
}

// t3 自愈:reload + 节流
{
  const fnBody = src.slice(src.indexOf('fn on_webview_process_terminated'), src.indexOf('// ② Windows:'));
  assert.match(fnBody, /webview\.reload\(\)/, 't3: 终止后 reload 自愈');
  assert.match(fnBody, /MIN_RELOAD_INTERVAL_MS/, 't3: 有重载节流(防持续 OOM 崩溃-重载死循环)');
  assert.match(fnBody, /reload after termination failed/, 't3: reload 失败也落日志而不是崩');
}

// t4 不 panic/exit:handler 体内禁 panic 系语句
{
  const fnBody = src.slice(src.indexOf('fn on_webview_process_terminated'), src.indexOf('// ② Windows:'));
  // 剥掉行注释再断言(注释里出现 "panic" 字样不算)
  const code = fnBody.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.doesNotMatch(code, /unwrap\(\)/, 't4: handler 内无 unwrap()');
  assert.doesNotMatch(code, /expect\(/, 't4: handler 内无 expect()');
  assert.doesNotMatch(code, /panic!/, 't4: handler 内无 panic!');
  assert.doesNotMatch(code, /process::exit|\.exit\(|std::process::abort/, 't4: handler 内无 exit/abort —— 主进程绝不跟着崩');
}

// t5 Windows browser args:GPU 自愈旗标 + wry 默认参数原样保留
{
  assert.match(src, /const WEBVIEW2_BROWSER_ARGS/, 't5: Windows browser args 常量存在');
  const constLine = src.slice(src.indexOf('const WEBVIEW2_BROWSER_ARGS'), src.indexOf('const WEBVIEW2_BROWSER_ARGS') + 300);
  assert.match(constLine, /--disable-gpu-process-crash-limit/, 't5: GPU 进程崩溃自愈旗标');
  // wry 0.55.1 webview2/mod.rs:294 —— additional_browser_args 整体替换默认参数,
  // 三条默认 --disable-features 必须原样带上(否则 SmartScreen 被改回启用)
  assert.match(constLine, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/,
    't5: wry 三条默认 --disable-features 原样保留(整体替换语义)');
  assert.match(src, /additional_browser_args\(WEBVIEW2_BROWSER_ARGS\)/, 't5: 参数接到窗口 builder');
}

// t6 平台 cfg 门
{
  const mountIdx = src.indexOf('on_web_content_process_terminate(on_webview_process_terminated)');
  const before = src.slice(Math.max(0, mountIdx - 200), mountIdx);
  assert.match(before, /#\[cfg\(any\(target_os = "macos", target_os = "ios"\)\)\]/,
    't6: mac/iOS 钩子挂 cfg(any(macos, ios)) 门(与 tauri 该方法自身 cfg 一致)');
  const argsIdx = src.indexOf('additional_browser_args(WEBVIEW2_BROWSER_ARGS)');
  const argsBefore = src.slice(Math.max(0, argsIdx - 300), argsIdx);
  assert.match(argsBefore, /#\[cfg\(target_os = "windows"\)\]/, 't6: Windows browser args 挂 cfg(windows) 门');
}

console.log('check-r29-process-failed: all 6 groups passed');

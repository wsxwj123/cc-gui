# 功能 B 验证报告：内置终端 + 代码块运行

日期：2026-09-09 · 分支：`feat/stream-image`（与 A 同 worktree，B 提交在前者之后）· 环境：macOS 真机，worktree server @6688，playwright + 裸 WS 双通道验证

## 实测记录（命令 + 输出）

### 1. 终端面板交互（playwright，`/tmp/cu-term-test.mjs`）
```
{"step":"echo-42","pass":true}          ← 键入 echo cu-term-test-$((6*7)) → 输出 cu-term-test-42
{"step":"python-print-2","pass":true}   ← python3 -c "print(1+1)" → 输出 2(交互式 pty 正常)
{"step":"server-active-1","pass":true,"active":1}
```
### 2. 面板关闭杀进程（playwright reload）
```
reload 后 GET /api/terminal/status → {"active":0}   ← ws 断开钩子即时杀 pty
```
### 3. 代码块 ▶ 全流程（playwright，`/tmp/cu-term-test3.mjs`，新会话由 GLM 产出 bash 块）
```
{"step":"model-codeblock-run-btn","pass":true}   ← bash 围栏出现 ▶ 运行按钮
{"step":"confirm-dialog-appeared","pass":true}   ← 首次点击弹确认框(含命令预览+记住勾选)
{"step":"terminal-executed-command","pass":true} ← 确认后终端面板自动打开并执行,输出 run-btn-test-25
{"step":"server-active-after-run","pass":true,"active":1}
```
截图：`docs/validation/feature-b-terminal.png`（代码块▶ + 右侧终端面板运行态）。

### 4. server 退出兜底（裸 WS 驱动，`/tmp/cu-ws-test.mjs`，证据 `feature-b-ws-probe.log`）
```
终端运行中: ps → 17498 /bin/zsh -l
WS 往返: term-open → term-opened → term-in "echo ws-probe-$((7*6))" → term-out 含 ws-probe-42 ✓
kill server(SIGTERM) → killAll 触发 → 残留 shell 进程 0 个 ✓
```

### 5. Windows 路径走查（代码级，真机为 mac）
- `terminal.js` win32 分支照抄 remote-control.js:162-170 手法：cmd.exe 用 SystemRoot 绝对路径（winpty 回退不搜 PATH）、交互式无参数故不涉及 verbatim 字符串形态。
- POSIX 分支 `$SHELL -l`（本机实测起的 /bin/zsh -l）。

## 构建
```
$ npm run build:local   # eslint(含新文件) + vite build → ✓ built in 6.94s
```

## LEARNINGS #53 说明
本功能**未新增任何 Tauri command**（纯 HTTP/WS，走既有 express + wss），不涉及 remote 上下文 ACL 坑；打包真机验证随发版流程统一做。

## 已知边界
- 单终端实例（TERM_ID='main'），协议已按 id 多路设计，要多开放约束即可。
- 终端不跨面板关闭持久（关面板=杀进程，属目标要求的行为）。

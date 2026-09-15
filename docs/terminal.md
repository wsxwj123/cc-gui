# 内置终端 + 代码块运行（功能 B）

## 怎么用

1. **打开终端**：顶栏 ⛁ 坞按钮 → 「终端」图标（`data-tour="panel-term"`，或 Cmd/Ctrl+数字直达）。右侧面板停靠打开，自动起一个登录 shell（mac `$SHELL -l`，Windows `cmd.exe`）。
2. **代码块 ▶ 运行**：AI 回复里的 `bash/sh/shell/zsh/console/terminal/powershell/pwsh/cmd` 代码块，语言条右上角有「▶ 运行」。点击 → **首次必弹确认框**（显示将要执行的命令全文）→ 可勾「本次会话记住，不再询问」→ 执行。终端面板没开时自动打开。
3. **生命周期**：关面板 / 刷新页面 = **只分离显示**（`term-detach` / ws 断开），shell 与最近 200KiB 输出保留，重新打开面板凭 `resumeToken` 重连回同一进程；只有标签 ✕ 才真正结束该 shell（`term-close`）。shell 自然退出（`exit`）后留只读记录，点「重新连接」发 `term-restart` 在同一标签上开新 shell（新 generation/新 pid）；记录过期时提示新建终端。分离满 6h 过期清理。cc-gui 后端退出时兜底全杀（killAll），不留孤儿 shell。并发上限 4 个存活终端（含分离，不含已退出）。
   `resumeToken` 是 shell 控制凭据，只存在本页 sessionStorage，不进 localStorage / DOM / 日志 / URL；新标签页与复制标签页会丢弃继承的凭据。

## 架构

- **零新增服务端依赖**：PTY 复用 `node-pty`（remote-control.js 同一个惰性加载器 `loadPty()`，导出共用；失败不缓存可重试，ABI 不匹配只废终端不崩后端，见 LEARNINGS #68）。
- **WS 桥**：复用现有 `/ws` 通道（`WebSocketServer` 带 path 过滤，第二个 wss 抢不到 upgrade），按 `term-*` 消息前缀分流到 `server/routes/terminal.js`。白捡现有 verifyClient 鉴权（本地免密、远端要 token）。
- 帧协议、生命周期、cwd 校验口径（家目录/已知工作区）见 `server/routes/terminal.js` 顶部注释。
- 前端：`client/src/components/TerminalPanel.jsx`（xterm.js + FitAddon，独立 ws 连接）；确认门与请求总线在 `client/src/utils/terminalBus.js`（任何"送命令进终端"的入口都必须过 `requestTerminalRun()`，不许绕过确认）。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板显示"终端不可用 + node-pty 加载失败" | node-pty 原生模块与当前 Node ABI 不匹配 | 升级/重装 node-pty（`npm rebuild node-pty`）；其余功能不受影响 |
| 终端白屏无提示符 | shell 启动脚本卡住 | 关面板重开只是重连（同一进程），要换新 shell 请点标签 ✕ 关闭后新建；查 `~/.zshrc` 是否有交互前的阻塞命令 |
| ▶ 按钮不出现 | 非命令类语言（python/javascript 等不显示，防误执行任意不可读代码） | 属预期；需要跑就复制进终端 |
| 点 ▶ 无反应 | WKWebView 禁用原生 confirm——本项目用自研 confirmDialog，不应发生；若复现请提 bug | — |
| 粘贴多行文本丢失 | 理论不会（入站帧上限 1MB）；超大文本建议走文件 | — |

## 安全边界（有意设计）

- 终端是**完整的本机 shell**，权限与用户手动开终端一致；门禁只有两道：本地/鉴权后的 ws 连接（服务端强制）+ 代码块 ▶ 的首次确认框（前端，可被"记住"跳过）。
- `term-in` / `term-resize` / `term-close` 只接受该终端**当前附着**的那条 ws 连接；别的连接要接管必须带 `resumeToken`（跨连接不带 token 一律 `TERM_TOKEN_REQUIRED`，且拒绝不杀原进程）。接管后旧连接收到 `takeover` 立即失去写入权，token 在该存活代际内不轮换。
- cwd 只允许家目录内或 Claude 用过的项目目录（与 remote-control 同判据）。

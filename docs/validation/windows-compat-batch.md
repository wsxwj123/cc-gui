# Windows 兼容性审查报告 —— 三功能批次（A 流式图片 / B 内置终端 / C computer use）

日期：2026-09-09 · 审查对象：`feat/stream-image`（A+B）与 `feat/computer-use`（C）相对 master 的 diff
方法：platform-compat-review 五步（定范围 → scan.mjs 双 worktree 扫描 → checkpoints 逐条核对 → 报告 → 回写）

## 裁决：**可发**（Windows 维度 0 必修；4 条扫描提醒全部核对为"已核对无问题"）

## 问题清单

致命 0 / 必修 0 / 建议 3（见"建议"节，均不阻塞）。

## 扫描命中核对表（8 条 hint → 逐条判据核实）

| ID | 位置 | 核对结论 |
|---|---|---|
| W-B1 | markdownImages.js:51/56 | **无问题**。`${baseDir}/${rel}` 与 `split('/')` 之前已 `replace(/\\/g,'/')` 归一化反斜杠，`isAbs` 认 `C:/`，prefix 认盘符——Windows 路径在进入切分前已统一为正斜杠。边界：`C:relative\path`（盘符相对路径，无分隔符）会被当相对路径拼 baseDir——AI 输出中罕见，属已接受边界 |
| W-A6 | terminal.js:75 `SHELL \|\| '/bin/bash'` | **无问题**。该行在 `else` 分支，win32 走上方 cmd.exe 分支（照抄 remote-control.js 结构），Windows 不可达 |
| W-A10 | mcp-server.js:76 `spawnSync python3 --version` | **无问题（附预警）**。`bootstrapRuntime()` 首行 `if (!IS_MAC) throw` —— Windows 不可达；mac 上仅在 MCP server 进程生命周期内跑一次（单飞 promise），不在 cc-gui 后端请求路径。预警见 G-1 |
| W-A12 | mcp-server.js:232 `readdirSync(SHOT_DIR)` | **无问题**。目录为应用私有 `~/.claude-gui/cu-runtime/shots`，仅自身 PNG 且清理保 5 张，不可能扫到 PATH 目录/断盘 |
| W-B5 | mcp-server.js:111、computer-use.js:57 `split('\n')` | **无问题**。①两条路径 Windows 不可达（IS_MAC 门在前 / helper 仅 venv 内 spawn）；②即便带 `\r`，`JSON.parse` 容忍尾随空白，解析不炸 |

## 逐类核对（checklist A–E，只列新增代码相关项）

- **A 进程与命令行**：terminal.js win32 分支用 `SystemRoot` 绝对路径 cmd.exe + 空参数数组（不经 cmd.exe /c 字符串拼接，无 verbatim 引号问题——与 remote-control.js:162-170 同款）；未新增任何"经 cmd.exe /c 拼字符串"的代码，**crt-roundtrip 模拟器不适用**（无新拼接点）。computer-use 的 node 路径取 `process.execPath` 绝对路径（.exe 直 spawn，不走 .cmd/.bat 包装），MCPPanel 拼的 `"node" "脚本"` 双引号形态由仓库 parseCommandLine 正确拆分（含空格路径已验）。
- **B 路径与文件系统**：A 的 Windows 图片路径（`C:\...` 反斜杠+空格）覆盖见上表 W-B1；`~/.claude-gui/cu-runtime` 为 mac-only 路径（Windows 上 status.supported=false，安装卡整体隐藏）。
- **C 原生模块与运行时**：B 复用既有 node-pty（postinstall chmod 已覆盖 Windows prebuilds）；C 零 Node 新依赖；Python 依赖仅 mac 安装。
- **D 渲染引擎**：A 的 `<img>` 渲染与预处理为纯字符串/DOM，无 zoom/portal 坐标类 WKWebView/WebView2 分叉；xterm.js 为 WebView2 兼容的标准组件。
- **E 分发/签名/网络**：xterm.js 进 client bundle（+约 300KB gzip，构建已验证）；无安装器/签名改动；pip 清华镜像兜底仅 mac 生效。

## 建议（不阻塞，顺手可改）

1. `cu_helper.py` 的 mss 用法命中上游弃用警告（`mss.mss()` → `mss.MSS`，stderr 噪音）——升级依赖大版本时顺手改。
2. `resolveImageSrc` 对盘符相对路径（`C:foo.png`）会拼出错误绝对路径——罕见，接受；若后续报错再按 embedded 规则扩。
3. `docs/computer-use.md` 已写明 Windows helper 待办（pywin32/SendInput），C 的 Windows 化时记得同步 `mcp-server.js` 的 `IS_MAC` 门。

## 预警（G 类，未踩实）

- **G-1**：`findPython3()` 是同步 spawn×3 候选。当前在 MCP server 进程内一次性执行、Windows 不可达，安全；**若未来把它挪进 cc-gui 后端请求路径或开放 Windows**，必须按 W-A10 改异步+缓存口径（Defender 首扫可拖数秒）。

## 真机验证单（Windows 机器上执行；本机 mac 验不了）

1. 终端面板：坞图标 → 终端 → cmd.exe 起来（窗口可见提示符）→ `dir` / `cls` 正常 → 关面板后 `tasklist | findstr cmd.exe` 确认该 cmd 消失
2. 代码块 ▶：bash 块显示 ▶ → 点击 → 确认框出现 → 执行后终端面板自动打开
3. computer-use 卡：工具面板应**不出现**桌面操控卡（supported:false 隐藏逻辑）
4. 功能 A：让 AI 输出 `![图](C:\Users\xx\图 片.png)` 与裸 `C:\Users\xx\a.png` 独立行，确认渲染与点击无异常
5. 终端中文：终端里 `echo 中文` 回显不乱码（xterm.js + ConPTY 编码）

## 回写排查点

本轮无新增排查点（8 条命中全部落入既有条目；"`computer-use` 保留名"属 MCP 注册域非平台兼容域，已记入 LEARNINGS）。

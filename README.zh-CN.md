# Claude GUI

[English](README.md)

Claude GUI 是 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的本地图形外壳：一个 Tauri 桌面应用 + 浏览器界面 + 手机友好布局。跑起来后可以用图形界面浏览并继续 Claude Code 会话、发消息、分屏对比，还能通过 Tailscale 等私有网络在手机上访问。

> 纯本地工具，不收集任何数据，所有会话都走你自己机器上的 `claude` CLI。

---

## 一、前置要求（必看）

GUI 只是 `claude` CLI 的外壳，**必须先装好并登录 Claude Code**：

1. 安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/setup)，确保终端里 `claude` 命令可用。
2. 终端跑一次 `claude`，确认能正常对话（已登录订阅或配好 API Key）。

没有这一步，GUI 打开后无法发消息。

---

## 二、安装使用（两种方式，任选其一）

### 方式 A：下载安装包（开箱即用）

到 [Releases 页面](https://github.com/wsxwj123/claude-gui/releases/latest) 下载对应平台：

| 平台 | 文件 |
|---|---|
| Windows 安装程序 | `Claude GUI_*_x64-setup.exe` |
| Windows MSI | `Claude GUI_*_x64_en-US.msi` |
| macOS（Apple Silicon） | `Claude GUI_*_aarch64.dmg` |

> 安装包未签名 / 未公证：
> - **macOS**：首次打开「右键图标 → 打开」绕过 Gatekeeper（仅支持 Apple Silicon，Intel Mac 需自行用 `x86_64-apple-darwin` target 构建）。
> - **Windows**：弹 SmartScreen 时点「更多信息 → 仍要运行」。

### 方式 B：从源码运行（拿到最新功能，推荐）

**1. 装环境**

- [Node.js](https://nodejs.org) 20 或更高（自带 npm）
- 仅「打包桌面 App」才需要：Rust stable + [Tauri 各平台依赖](https://v2.tauri.app/start/prerequisites/)

**2. 克隆**

```bash
git clone https://github.com/wsxwj123/claude-gui.git
cd claude-gui
```

**3. 启动（首次自动装依赖并构建）**

**双击启动脚本**即可——首次会自动安装依赖、构建前端（约几分钟），随后打开浏览器到 `http://localhost:6677`（关掉窗口即停止）：

- **macOS**：双击 `gui.command`（首次若被拦，「右键 → 打开」一次）
- **Windows**：双击 `gui.bat`

或者用命令行手动来一遍：

```bash
npm install                  # 根依赖
npm --prefix client install  # 前端依赖
npm run build                # 构建前端
npm start                    # 启动服务，默认 6677 端口
```

然后浏览器打开 **http://localhost:6677**。

---

## 三、在手机上使用

1. 在电脑上按「方式 B」把 GUI 跑起来。
2. 用 [Tailscale](https://tailscale.com)（或其他私有网络）把这台电脑接入你的私有网。
3. 手机浏览器打开 `http://<电脑的Tailscale地址>:6677`。
4. 用浏览器的「添加到主屏幕」，获得接近原生 App 的全屏体验。

> ⚠️ **只在私有网络里用**，并自行设置访问密码。**绝不要**把 Claude Code 控制面直接暴露到公网。

---

## 四、打包成桌面 App（可选）

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/`（macOS 的 `.dmg` / Windows 的 `.exe`、`.msi`）。交互式桌面开发用 `npm run tauri:dev`。

---

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 端口 6677 被占用 | `npm run stop` 释放端口，或关掉占用它的进程 |
| 构建报 `Cannot find native binding` / `different Team IDs` | 你的 `node` 多半被某 App 自带的 node 抢了 PATH（带 macOS 库签名校验，拒绝第三方原生模块）。改用官方/Homebrew/nvm 的 node：`brew install node` 或 [nodejs.org](https://nodejs.org)，确认 `which node` 不指向某个 `.app` 内部，删掉 `node_modules` 和 `client/node_modules` 后重试 |
| 打开白屏 / 发不了消息 | 确认 `claude` CLI 能用、Node ≥ 20；删掉 `client/dist` 后重新 `npm run build` |
| 改了代码不生效 | 源码方式下需重新 `npm run build`（或重新双击 `gui.command` / `gui.bat`） |
| macOS 双击 `gui.command` 没反应 | 「右键 → 打开」授权一次；或终端 `chmod +x gui.command` |
| **macOS 提示「Claude GUI.app 已损坏，无法打开」**（且「隐私与安全性」里没有「仍要打开」按钮，macOS 15 后常见） | 这不是真损坏，是 Gatekeeper 给未签名 app 加的 quarantine 标记。终端跑一次：`sudo xattr -rd com.apple.quarantine "/Applications/Claude GUI.app"` 输入登录密码后再双击即可 |

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

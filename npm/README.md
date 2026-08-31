# CC-GUI

Claude Code 桌面客户端（[项目主页](https://github.com/wsxwj123/claude-gui)）。本包是 npm 分发通道：安装包字节随平台分包一起下载，安装与启动全程不联网，适合无法顺畅访问 GitHub 的网络环境（npm 镜像源即可安装）。

## 安装

```sh
npx @wsxwj123/cc-gui
```

一条命令完成下载、安装并打开应用。`cc-gui` 是安装器而非日常命令，只在装应用与升级时运行，推荐用 npx：无需全局安装，也不受 npm 全局目录权限影响。备选：全局安装（适合用 Homebrew / nvm 装 node 的人，其全局目录归当前用户）——

```sh
npm i -g @wsxwj123/cc-gui
cc-gui
```

安装完成后应用的落点：

- **macOS（Apple Silicon）**：应用安置到 `~/Applications/CC-GUI.app`。npm 安装的文件不带隔离标记，无需 `xattr` 放行。
- **Windows（x64）**：静默运行包内官方 NSIS 安装器（用户级安装，无管理员弹窗），带开始菜单项、可正常卸载，与官网 exe 安装完全一致。

其它系统/架构暂不支持（会给出明确提示）。运行 CC-GUI 需要本机已安装 Node.js 20+ 与 Claude Code CLI。

## 升级

```sh
npx @wsxwj123/cc-gui@latest
```

先完全退出 CC-GUI（macOS 按 Cmd+Q，注意关闭窗口只是最小化到托盘）再执行，即自动换到新版并打开。启动器只升不降：若应用内自动更新已装到更高版本，该命令只会打开应用，不会降级。全局安装方式对应执行 `npm i -g @wsxwj123/cc-gui@latest` 后再跑一次 `cc-gui`。

- macOS 升级后若读不到会话记录：到 系统设置 → 隐私与安全性 → 完全磁盘访问，把 CC-GUI 重新勾选一次（macOS 对未签名应用的既有行为，从官网下载覆盖升级同样如此）。
- 镜像源（npmmirror 等）按需同步，新版本的平台分包可能滞后甚至暂缺；若报「没找到当前平台的安装包」，用官方源装一次即可：`npx --registry=https://registry.npmjs.org @wsxwj123/cc-gui@latest`，或到 [GitHub Release](https://github.com/wsxwj123/claude-gui/releases) 手动下载。

## 说明

- `npm i -g` 报 `EACCES: permission denied`：官方 .pkg 装的 node 全局目录（`/usr/local/lib/node_modules`）属 root，装任何全局包都报此错，与本包无关。解法二选一：① 用 `npx @wsxwj123/cc-gui`（推荐，无需任何配置）；② 改 npm 前缀：`npm config set prefix ~/.npm-global`，再把 `~/.npm-global/bin` 加进 PATH。不要用 `sudo npm i -g`：能装上，但会把 `~/.npm` 缓存目录属主变成 root，之后普通 npm 命令开始报别的权限错，越修越乱。
- 若 `cc-gui` 命令与本机其它工具重名，可用 `npx @wsxwj123/cc-gui` 执行同一逻辑。
- GitHub Release 始终是一等下载渠道，npm 通道不可用时请直接下载安装包。

## 卸载

分两步，只做第一步删不掉应用（npx 方式没装全局包，直接做第二步）：

```sh
npm rm -g @wsxwj123/cc-gui
```

这一步删掉启动器和安装包字节（平台分包一并删除），但**不会动已经装好的应用**——npm 包只是安装器。第二步删应用本体：

- **macOS**：完全退出 CC-GUI（Cmd+Q），把 `~/Applications/CC-GUI.app` 拖进废纸篓。
- **Windows**：设置 → 应用 → 已安装的应用 → 找到 **CC-GUI** → 卸载（或到安装目录 `%LOCALAPPDATA%\CC-GUI` 运行卸载程序）。

个人数据默认保留：

- `~/.claude-gui/`（Windows `%USERPROFILE%\.claude-gui`）是 CC-GUI 自己的配置（Provider、皮肤、网络设置等），不想留就删掉。
- `~/.claude/` 是 **Claude Code CLI 的目录**（会话记录、技能、settings），**卸载 CC-GUI 时不要删** —— 删了终端里的 `claude` 一起受影响。

# CC-GUI

Claude Code 桌面客户端（[项目主页](https://github.com/wsxwj123/claude-gui)）。本包是 npm 分发通道：安装包字节随平台分包一起下载，安装与启动全程不联网，适合无法顺畅访问 GitHub 的网络环境（npm 镜像源即可安装）。

## 安装

```sh
npm i -g @wsxwj123/cc-gui
cc-gui
```

首次运行 `cc-gui` 会完成安装并打开应用：

- **macOS（Apple Silicon）**：应用安置到 `~/Applications/CC-GUI.app`。npm 安装的文件不带隔离标记，无需 `xattr` 放行。
- **Windows（x64）**：静默运行包内官方 NSIS 安装器（用户级安装，无管理员弹窗），带开始菜单项、可正常卸载，与官网 exe 安装完全一致。

其它系统/架构暂不支持（会给出明确提示）。运行 CC-GUI 需要本机已安装 Node.js 20+ 与 Claude Code CLI。

## 升级

```sh
npm i -g @wsxwj123/cc-gui@latest
```

之后完全退出 CC-GUI（macOS 按 Cmd+Q，注意关闭窗口只是最小化到托盘），再执行 `cc-gui` 即自动换到新版并打开。启动器只升不降：若应用内自动更新已装到更高版本，`cc-gui` 只会打开应用，不会降级。

- macOS 升级后若读不到会话记录：到 系统设置 → 隐私与安全性 → 完全磁盘访问，把 CC-GUI 重新勾选一次（macOS 对未签名应用的既有行为，从官网下载覆盖升级同样如此）。
- 刚发版的十几分钟内国内镜像可能尚未同步，稍后再试，或到 [GitHub Release](https://github.com/wsxwj123/claude-gui/releases) 手动下载。

## 说明

- 若 `cc-gui` 命令与本机其它工具重名，可用 `npx @wsxwj123/cc-gui` 执行同一逻辑。
- GitHub Release 始终是一等下载渠道，npm 通道不可用时请直接下载安装包。
- 卸载：`npm rm -g @wsxwj123/cc-gui`；macOS 应用本体删除 `~/Applications/CC-GUI.app` 即可，Windows 在系统卸载列表中卸载 CC-GUI。

# Claude GUI

[English](README.md)

Claude GUI 是 Claude Code CLI 的本地桌面 / 移动端友好型 Web 外壳。它提供一个 Tauri
桌面应用、用于本地访问的浏览器界面，以及在通过 Tailscale 等私有网络暴露并添加到手机主
屏后体验良好的手机布局。

## 下载

预构建安装包见 [Releases 页面](https://github.com/wsxwj123/claude-gui/releases/latest)：

| 平台 | 文件 |
|---|---|
| Windows（安装程序） | `Claude GUI_*_x64-setup.exe` |
| Windows（MSI） | `Claude GUI_*_x64_en-US.msi` |
| macOS（Apple Silicon） | `Claude GUI_*_aarch64.dmg` |

> **macOS 仅支持 Apple Silicon（aarch64）。** 暂不覆盖 Intel Mac，需自行用
> `x86_64-apple-darwin` target 构建。
>
> **安装包未签名 / 未公证。** macOS 首次打开请「右键 → 打开」绕过 Gatekeeper；
> Windows 会弹 SmartScreen 警告，点「更多信息 → 仍要运行」。

## 功能

- 从图形界面浏览并继续 Claude Code 的项目会话。
- 通过本地 Claude Code CLI 工作流发送消息。
- 管理常用的本地 GUI 设置，不提交与机器相关的状态。
- 提供移动优先的 PWA 风格布局，便于经局域网或 Tailscale 在手机访问。
- 用 Tauri 构建原生桌面外壳。
- 将仅限本地的私有扩展排除在公开构建之外。

## 公开构建策略

本仓库只发布可复用的外壳。机器私有的扩展会被刻意忽略，并在公开构建前审计：

- `AGENTS.md`
- `.claude/`
- `client/dist/`
- `server/routes/*.local.js`
- `client/src/components/*.local.jsx`

仅限本地的模块可以存在于你的机器上，但不会被 Git 跟踪，并由 `npm run build` 和
`npm run tauri:build` 排除在公开 Web 与 Tauri 构建之外。

## 环境要求

- Node.js LTS，已在 Node.js 20+ 测试
- npm
- Rust stable
- Tauri v2 所需的各平台依赖

各操作系统的具体配置参见 Tauri 官方先决条件页面：
<https://v2.tauri.app/start/prerequisites/>

在仅做 macOS 桌面开发时，Tauri 可使用 Xcode 命令行工具：

```bash
xcode-select --install
```

## 安装

```bash
git clone https://github.com/wsxwj123/claude-gui.git
cd claude-gui
npm install
cd client
npm install
cd ..
```

## 开发

同时启动本地服务器与 Vite 客户端：

```bash
npm run dev
```

后端默认监听 `6677` 端口。本地生产模式：

```bash
npm run build
npm run start
```

## 通过 Tailscale 在手机使用

1. 在你的 Mac 或工作站上运行本地服务器。
2. 通过 Tailscale 或其他私有网络暴露该机器。
3. 在手机上打开 GUI 地址。
4. 将页面添加到主屏。

请使用私有网络与你自己的本地鉴权方案。**不要**将 Claude Code 控制面直接暴露到公网。

## Tauri 桌面构建

构建公开前端并打包桌面应用：

```bash
npm run tauri:build
```

该命令会在 Tauri 打包前运行公开构建守卫。Tauri 源码位于 `src-tauri/`；`src-tauri/target/`
下生成的构建产物不会被提交。

交互式桌面开发：

```bash
npm run tauri:dev
```

## 公开审计

提交或发布前运行：

```bash
npm run audit:public
```

如果私有本地模块、`AGENTS.md`、`.claude/` 或生成的客户端构建产物被 Git 跟踪，或公开构建产
物中出现仅限本地的 bot 控制代码，审计将失败。

## 许可证

MIT，见 [LICENSE](LICENSE)。

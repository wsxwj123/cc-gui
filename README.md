# CC-GUI

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/wsxwj123/claude-gui/releases/latest"><img src="https://img.shields.io/github/v/release/wsxwj123/claude-gui" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@wsxwj123/cc-gui"><img src="https://img.shields.io/npm/v/%40wsxwj123%2Fcc-gui" alt="npm"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platform">
  <a href="https://github.com/wsxwj123/claude-gui/stargazers"><img src="https://img.shields.io/github/stars/wsxwj123/claude-gui?style=social" alt="Stars"></a>
</p>

<p align="center"><a href="README.en.md">English</a> | 中文</p>

**CC-GUI 是 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的本地图形外壳**:一个 Tauri 桌面应用 + 浏览器界面 + 手机友好布局。浏览并续接会话、分屏对比、图形化批准权限与计划,还能经 Tailscale 等私有网络在手机上接管正在跑的会话。

> **English**: CC-GUI is a fully local graphical shell for the Claude Code CLI — a Tauri desktop app, a browser UI, and a mobile-friendly layout. Zero telemetry: every session runs through the `claude` CLI on your own machine. Split-screen sessions with per-pane model/permission, third-party provider switching, graphical permission & plan-review cards, subagent visualization, skills marketplace, and phone takeover over a private network.

<p align="center">
  <img src="docs/screenshots/hero.png" alt="CC-GUI 主界面" width="880"><br>
  <em>主界面:顶栏一排即全部能力——模型 / 思考强度 / 权限模式 / Provider 切换,以及分屏、文件、审查、监控、Agent、用量、技能、MCP 工具等面板入口</em>
</p>

---

## 为什么是 CC-GUI

- **纯本地、零遥测** —— 不收集任何数据,所有会话都走你自己机器上的 `claude` 进程,没有云、没有账号、没有中间人
- **分屏多会话** —— 多窗格并排,每个窗格独立的模型 / 权限模式 / 思考强度
- **任意 Provider** —— 官方订阅 + DeepSeek、通义 Qwen、Kimi、GLM、Grok、OpenAI 兼容等第三方中转一键切换
- **图形化权限与计划审查** —— 权限请求、`ExitPlanMode` 计划卡、`AskUserQuestion` 选项卡全部可视化批准
- **子代理与后台任务可视化** —— Task 子代理运行流、后台任务、`claude` 进程一屏监控
- **技能与插件生态** —— 多源技能市场、从任意 GitHub/Gitee 仓库导入、MCP 管理精确到单工具
- **手机也能用** —— 私有网络 + 访问密码,浏览器加到主屏幕即近原生体验

---

## 功能一览

`claude` CLI 能做的都做成可视化,再加上终端天生没有的外壳体验。

**对话与会话**
- 浏览、续接、新建会话,富文本渲染(Markdown / LaTeX / 代码高亮)
- **分屏对比** —— 多窗格并排跑不同会话,各自独立模型 / 权限模式 / 思考强度
- 工具调用卡片(Bash / Read / Edit / Web / Task / Skill,可折叠带 diff)、子代理运行可视化
- **计划审查卡 & 问题选择卡** —— 图形化批准计划、选择选项(`ExitPlanMode` / `AskUserQuestion`)
- `@` 引用选择器(插入文件,或把别的会话摘要引进来)、斜杠命令补全(内置 + 项目级)、输入预测、消息排队 / 停止 / 召回、微信式紧凑聊天模式

**模型与 Provider**
- 每窗格独立切换模型与思考强度;切换 Provider(官方订阅 + 大量第三方中转:DeepSeek、通义 Qwen、Kimi、GLM、Grok、OpenAI 兼容等)
- 自定义 Provider 增删改(拉取模型列表、测连接);1M 上下文默认;上下文占用徽章实时显示

**权限与规划**
- 五档权限模式(default / acceptEdits / plan / bypass / 不打扰)可中途切换;图形化权限弹卡;权限规则页
- **不打扰档** —— 只读操作与已勾选自动执行的 MCP 直接执行,其余一律拒绝且不弹窗
- 权限卡显示判定理由;操作被拒时在消息流留下说明行(含被拒工具与原因)
- **MCP 表单卡** —— MCP 服务器请求输入时弹出表单(文本 / 单选 / 开关 / 数字),提交后原样回传
- **拒答重试卡** —— 模型拒绝请求时提供"换备用模型重试 / 修改提问"两个选项

**MCP 与插件**
- MCP 服务器管理(增删、连通性测试、OAuth 登录、启停、编辑)+ **单工具级启用 / 禁用 + 查看工具列表**
- 官方插件一键安装(启停 / 更新 / 删除),自动同步进所有 agent

**技能(Skills)**
- 技能市场(多源)+ 从任意 GitHub / Gitee 仓库导入;本机技能添加 / 归档 / 删除

**生图**
- 生图配置与文本 Provider **完全分开**,独立增删改,存 `~/.claude-gui/image-providers.json`,**不写入 `settings.json`**
- 支持三种上游形态:OpenAI 图像接口、Gemini 图像接口,以及以 chat 接口返回图片的中转
- 每个生图 Provider 各自填写接口地址、密钥、模型、尺寸与保存目录。保存目录必须是已存在且可写的绝对路径
- 出图后自动落盘到该目录并在界面内预览;可在系统文件管理器中定位该文件

**皮肤**
- 导入 zip / `.cguiskin` 皮肤包,或直接粘贴 `skin.json` 文本导入;可随时删除
- 两种层级:**T1 声明层**只含 `skin.json` 与图片资源(颜色、圆角、阴影等 41 个变量 + 明暗两套背景图);**T2** 允许附带脚本,载入前经静态校验
- 皮肤经 `data-cgui` 语义锚点定位界面元素(首批 40 个,承诺跨版本稳定,不挂随重构变动的类名)
- 面板内可**复制 AI 提示词**:把可用变量、图标语义名与锚点清单生成为一段提示词,交给 AI 直接产出皮肤包
- 安全限制:解包前按清单拒绝符号链接、硬链接与路径穿越,并限制条目数与体积;SVG 按白名单清洗(拒 `script` 与外链);带脚本的皮肤经黑名单静态校验后才载入

**文件与代码**
- 文件浏览器(浏览 / 编辑 / 删除可撤销 / 用默认 App 打开;**PDF、HTML 预览**)
- 回滚与审查(checkpoint 快照、按文件或整会话还原)、Diff 查看、上传、Git 集成、Worktree

**会话管理**
- 会话列表(置顶 / 自定义标题 / 归档)、自动标题、会话分叉、定向压缩与 trim、单轮花费上限
- 自定义标题写入会话记录,终端 `claude --resume` 的选择器同步显示
- **目标(`/goal`)状态可见** —— 会话头显示"目标进行中",自动续跑与目标达成在消息流中留痕
- 定时任务(`/loop`)进入命令表;建过定时任务的会话进程保活,不被闲置回收

**监控与用量**
- 监控面板(当前对话 Task / 后台任务 / 后台代理 / 本机 Claude 进程)、用量统计与 `/insights` 报告、进程面板
- **等待原因细分** —— 后台代理阻塞时显示等待类型(等待授权 / 等待输入 / 弹窗 / 沙箱 / 队友)与具体需求
- **后台代理权限应答** —— 派发时可选权限档;选逐项确认时,代理的授权请求以权限卡形式送到界面,应答后代理继续执行
- **子代理实时正文** —— 子代理的思考与回复实时进入监控面板;长任务附 AI 进度摘要

**等待提醒**
- 系统通知(窗口不在前台时,权限请求与后台代理等待会发系统通知;含去重与频率上限,可在设置关闭)
- Dock 角标与窗口标题计数(仅统计等待处理的事项)

**远程访问**
- 经私有网络(Tailscale 等)用手机访问,需访问密码;手机端接管某个会话

**更新与环境**
- GUI 自更新(实时进度);GUI 内更新 / 安装 / 切换 Claude CLI;环境检查(node / claude / python / uv / git)

**界面体验**
- 使用指引浮层、自定义背景与主题(深浅色及更多)、字体缩放、Prompt 模板
- **称呼** —— 首页问候使用的名字(如「下午好,张三」)。最多 20 字符,置空则显示默认文案;存服务端,所有设备共享

---

## 一、前置要求(必看)

GUI 只是 `claude` CLI 的外壳,**唯一硬性前置是装好 Claude Code CLI**:

1. 安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/setup),确保终端里 `claude` 命令可用(没有它,GUI 打开后无法发消息)。
2. 认证方式**二选一**:
   - **官方订阅 / 官方 API**:终端跑一次 `claude` 完成登录;或
   - **不登录官方,直接用第三方**:打开 GUI → 设置 → Provider,填好任意第三方中转的 API 地址与 Key 即可直接对话。**无需登录 Anthropic 账号,也无需手动创建 `~/.claude` 目录**(首次启动自动创建,macOS 与 Windows 相同)。

---

## 二、安装使用(三种方式,任选其一)

### 方式 A:npm 一键安装(网络受限时首选)

安装包字节随 npm 平台分包一起下载,**全程只连 npm,不需要访问 GitHub**;国内配好 npm 镜像源即可正常安装。需要本机已有 Node.js 20+。

```bash
npm i -g @wsxwj123/cc-gui
cc-gui
```

首次运行 `cc-gui` 完成安装并打开应用:

- **macOS(Apple Silicon)**:应用装到 `~/Applications/CC-GUI.app`。npm 解包不带隔离标记,**无需 `xattr` 放行,也不会弹「已损坏」**。
- **Windows(x64)**:静默运行包内官方安装器(用户级,无管理员弹窗),带开始菜单项、可正常卸载。

升级 `npm i -g @wsxwj123/cc-gui@latest`,完全退出 CC-GUI 后再跑一次 `cc-gui` 即换到新版(只升不降)。卸载 `npm rm -g @wsxwj123/cc-gui`。其它系统 / 架构暂不支持,会给出明确提示。

> 镜像源(npmmirror 等)是按需同步的,新版本可能滞后甚至暂缺。若报「没找到当前平台的安装包」,加 `--registry=https://registry.npmjs.org` 用官方源装一次即可。

### 方式 B:下载安装包(开箱即用)

到 [Releases 页面](https://github.com/wsxwj123/claude-gui/releases/latest) 下载对应平台:

| 平台 | 文件 |
|---|---|
| Windows 安装程序 | `CC-GUI_*_x64-setup.exe` |
| Windows MSI | `CC-GUI_*_x64_en-US.msi` |
| macOS(Apple Silicon) | `CC-GUI_*_aarch64.dmg` |

> 安装包未签名 / 未公证:
> - **macOS**:首次打开「右键图标 → 打开」绕过 Gatekeeper(仅支持 Apple Silicon,Intel Mac 需自行用 `x86_64-apple-darwin` target 构建)。
> - **Windows**:弹 SmartScreen 时点「更多信息 → 仍要运行」。

### 方式 C:从源码运行(拿到最新功能)

**1. 装环境**

- [Node.js](https://nodejs.org) 20 或更高(自带 npm)
- 仅「打包桌面 App」才需要:Rust stable + [Tauri 各平台依赖](https://v2.tauri.app/start/prerequisites/)

**2. 克隆**

```bash
git clone https://github.com/wsxwj123/claude-gui.git
cd claude-gui
```

**3. 启动(首次自动装依赖并构建)**

**双击启动脚本**即可——首次会自动安装依赖、构建前端(约几分钟),随后打开浏览器到 `http://localhost:6677`(关掉窗口即停止):

- **macOS**:双击 `gui.command`(首次若被拦,「右键 → 打开」一次)
- **Windows**:双击 `gui.bat`

或者用命令行手动来一遍:

```bash
npm install                  # 根依赖
npm --prefix client install  # 前端依赖
npm run build                # 构建前端
npm start                    # 启动服务,默认 6677 端口
```

然后浏览器打开 **http://localhost:6677**。

---

## 三、在手机上使用

1. 在电脑上按「方式 C」把 GUI 跑起来。
2. 用 [Tailscale](https://tailscale.com)(或其他私有网络)把这台电脑接入你的私有网。
3. 手机浏览器打开 `http://<电脑的Tailscale地址>:6677`。
4. 用浏览器的「添加到主屏幕」,获得接近原生 App 的全屏体验。

> ⚠️ **只在私有网络里用**,并自行设置访问密码。**绝不要**把 Claude Code 控制面直接暴露到公网。

---

## 四、打包成桌面 App(可选)

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/`(macOS 的 `.dmg` / Windows 的 `.exe`、`.msi`)。交互式桌面开发用 `npm run tauri:dev`。

---

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 端口 6677 被占用 | `npm run stop` 释放端口,或关掉占用它的进程 |
| 构建报 `Cannot find native binding` / `different Team IDs` | 你的 `node` 多半被某 App 自带的 node 抢了 PATH(带 macOS 库签名校验,拒绝第三方原生模块)。改用官方/Homebrew/nvm 的 node:`brew install node` 或 [nodejs.org](https://nodejs.org),确认 `which node` 不指向某个 `.app` 内部,删掉 `node_modules` 和 `client/node_modules` 后重试 |
| 打开白屏 / 发不了消息 | 确认 `claude` CLI 能用、Node ≥ 20;删掉 `client/dist` 后重新 `npm run build` |
| 改了代码不生效 | 源码方式下需重新 `npm run build`(或重新双击 `gui.command` / `gui.bat`) |
| macOS 双击 `gui.command` 没反应 | 「右键 → 打开」授权一次;或终端 `chmod +x gui.command` |
| **`.dmg` 双击报「已损坏」**(少数情况,经非浏览器渠道传输时更易出现;从 GitHub 直接下载通常不会) | 对 dmg 文件本身解除隔离(路径换成实际下载位置,不需要 sudo):`/usr/bin/xattr -dr com.apple.quarantine ~/Downloads/CC-GUI_*.dmg`,然后即可双击挂载 |
| **macOS 提示「CC-GUI.app 已损坏,无法打开」**(且「隐私与安全性」里没有「仍要打开」按钮,macOS 15 后常见) | 同上,是 Gatekeeper 给未公证 app 加的 quarantine 标记,不是真损坏。装进「应用程序」后终端跑一次:`/usr/bin/xattr -dr com.apple.quarantine "/Applications/CC-GUI.app"` 再双击即可(不需要 sudo) |
| 跑 xattr 报 `option -r not recognized` | 系统的 `xattr` 被 Python 版同名命令(pyenv / conda 自带)抢了 PATH。写绝对路径 `/usr/bin/xattr -dr ...` 即可 |
| `npm i -g @wsxwj123/cc-gui` 报「没找到当前平台的安装包」 | 镜像源按需同步,平台分包可能滞后或暂缺。用官方源装一次:`npm i -g @wsxwj123/cc-gui@latest --registry=https://registry.npmjs.org`,也可直接走方式 B 下载 |
| `cc-gui` 命令与本机其它工具重名 | 改用 `npx @wsxwj123/cc-gui`,逻辑完全相同 |

---

## 致谢

- **[cc-switch](https://github.com/farion1231/cc-switch)**(作者 [farion1231](https://github.com/farion1231))—— 优秀的 Claude Code 多 Provider 配置管理工具。CC-GUI 的「从 cc-switch 一键导入 Provider」功能与它对接,Provider 管理的设计也从中受益良多,特此感谢。

---

## 许可证

MIT,见 [LICENSE](LICENSE)。

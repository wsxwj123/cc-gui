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
- 首页新建会话的输入框与会话内输入框同一套能力:同样支持 `/` 斜杠命令与 `@` 文件引用
- 上游返回 `400 Content Exists Risk`(DeepSeek 的内容审核拒绝)时,错误气泡下给出说明与两个动作:「回退到该工具输出之前并继续」与「新开会话」

**模型与 Provider**
- 每窗格独立切换模型与思考强度;切换 Provider(官方订阅 + 大量第三方中转:DeepSeek、通义 Qwen、Kimi、GLM、Grok、OpenAI 兼容等)
- 自定义 Provider 增删改(拉取模型列表、测连接);1M 上下文默认;上下文占用徽章实时显示
- 思考强度档位按各模型实测表判定;模型 id 不在表内时,按去掉尾段的基名回退,并在思考强度下拉里注明按哪个基名判定
- 上下文徽章的分母优先取 GUI 侧设置的窗口,弹层显示该分母的来源(手填 / 实抓 / 规则表 / 联动 / CLI 自报)

**缓存命中**
- 设置 → 缓存优化(静态系统提示快照、关闭 ToolSearch、MCP 阻塞连接)对第三方 Provider 默认开启;Anthropic 兼容与 OpenAI 兼容两条通道实测第 2 轮起命中率在 97% 以上
- 会话标题行、手机顶栏与每条回复末尾显示本轮命中率;上下文徽章弹层显示平均命中率

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
- **Midjourney 通用层** —— 风格化 / 混乱度 / 种子 / Raw / Draft / 参考权重等参数统一编译成提示词末尾的 `--flag`,按所选版本显隐;支持 apimart 与 midjourney-proxy 两种协议;垫图、角色参考、风格参考三类参考图随请求发送;放大层用 ←/→ 在已完成的图之间切换;8.x 提供高清(HD)选项

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
- Windows 上用 npm 安装的 `claude` 是批处理壳,应用自动解析到包内真实的可执行文件再运行
- MCP 命令不在 PATH 里时,按 `%USERPROFILE%\.local\bin`、`%APPDATA%\npm`、Python `Scripts` 等常见安装目录查找;仍找不到时报出命令名并提示改填绝对路径

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
# macOS / Linux
npx @wsxwj123/cc-gui

# Windows(PowerShell 把 npx 解析成 npx.ps1,默认执行策略禁止运行脚本,故用 .cmd;
# 在 cmd.exe 里两种写法都可用)
npx.cmd @wsxwj123/cc-gui
```

一条命令完成下载、安装并打开应用。`cc-gui` 是安装器而非日常命令,只在装应用与升级时运行,故推荐 npx:无需全局安装,也不受 npm 全局目录权限影响(官方 .pkg 装的 node 用 `npm i -g` 会报 `EACCES`,见常见问题):

- **macOS(Apple Silicon)**:应用装到 `~/Applications/CC-GUI.app`。npm 解包不带隔离标记,**无需 `xattr` 放行,也不会弹「已损坏」**。
- **Windows(x64)**:静默运行包内官方安装器(用户级,无管理员弹窗),带开始菜单项、可正常卸载。

**升级**:`npx @wsxwj123/cc-gui@latest`(Windows 用 `npx.cmd @wsxwj123/cc-gui@latest`)→ 先完全退出 CC-GUI 再执行(只升不降:应用内自动更新已装到更高版本时,该命令只打开不降级)。

**备选:全局安装**(适合用 Homebrew / nvm 装 node 的人 —— 其全局目录归当前用户,无权限问题):

```bash
npm i -g @wsxwj123/cc-gui
cc-gui
```

升级用 `npm i -g @wsxwj123/cc-gui@latest`,退出应用后再跑一次 `cc-gui`。不要用 `sudo npm i -g`:能装上,但会把 `~/.npm` 缓存目录属主变成 root,之后普通 npm 命令开始报别的权限错,越修越乱。

**卸载**分两步,只做第一步删不掉应用(npx 方式没装全局包,直接做第 2 步):

**第 1 步 —— 删 npm 包**(启动器 + 安装包字节,平台分包一并删除):

```bash
npm rm -g @wsxwj123/cc-gui
```

**第 2 步 —— 删应用本体**。npm 包只是安装器,删掉它不会动已经装好的应用:

- **macOS**:完全退出 CC-GUI(Cmd+Q),把 `~/Applications/CC-GUI.app` 拖进废纸篓
- **Windows**:设置 → 应用 → 已安装的应用 → 找到 **CC-GUI** → 卸载(或到安装目录 `%LOCALAPPDATA%\CC-GUI` 运行卸载程序)

个人数据默认保留:

| 目录 | 是什么 | 卸载时 |
|---|---|---|
| `~/.claude-gui/`(Windows `%USERPROFILE%\.claude-gui`) | CC-GUI 自己的配置(Provider、皮肤、网络设置等) | 不想留就删 |
| `~/.claude/` | **Claude Code CLI 的目录**(会话记录、技能、settings) | **别删** —— 那是 CLI 的家,删了终端里的 `claude` 一起遭殃 |

其它系统 / 架构暂不支持,会给出明确提示。

> 镜像源(npmmirror 等)是按需同步的,新版本可能滞后甚至暂缺。若报「没找到当前平台的安装包」,用官方源装一次即可:`npx --registry=https://registry.npmjs.org @wsxwj123/cc-gui@latest`。

### 方式 B:下载安装包(开箱即用)

到 [Releases 页面](https://github.com/wsxwj123/claude-gui/releases/latest) 下载对应平台:

| 平台 | 文件 |
|---|---|
| Windows 安装程序 | `CC-GUI_*_x64-setup.exe` |
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
| `npm i -g` 报 `EACCES: permission denied` | 官方 .pkg 装的 node 全局目录(`/usr/local/lib/node_modules`)属 root,装任何全局包都报此错,与本项目无关。解法二选一:① 用 `npx @wsxwj123/cc-gui`(推荐,无需任何配置);② 改 npm 前缀:`npm config set prefix ~/.npm-global`,再把 `~/.npm-global/bin` 加进 PATH。不要用 `sudo npm i -g`:能装上,但会把 `~/.npm` 缓存目录属主变成 root,之后普通 npm 命令开始报别的权限错,越修越乱 |
| 安装时报「没找到当前平台的安装包」 | 镜像源按需同步,平台分包可能滞后或暂缺。用官方源装一次:`npx --registry=https://registry.npmjs.org @wsxwj123/cc-gui@latest`,也可直接走方式 B 下载 |
| `cc-gui` 命令与本机其它工具重名 | 改用 `npx @wsxwj123/cc-gui`,逻辑完全相同 |
| PowerShell 报「无法加载文件 npx.ps1 / npm.ps1,禁止运行脚本」(about_Execution_Policies) | Windows 默认执行策略为 Restricted,拦的是 `.ps1` 脚本文件,而 npm / npx 在 PowerShell 里正是 `.ps1` 形态。改用 `npx.cmd @wsxwj123/cc-gui`,或在 cmd.exe 里运行原命令。无需修改执行策略 |

---

## 六、更新记录

每个版本默认折叠,需要看某一版的改动时点击展开。完整条目见 [CHANGELOG.md](CHANGELOG.md);已公开发布的版本号可点进对应的 GitHub Release。本段由 `npm run gen:readme-changelog` 从 CHANGELOG.md 生成,不要手改。

<!-- CHANGELOG:START -->

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.375">v0.2.375</a></b>(2026-09-03)· 修复 1 条 · 优化 1 条</summary>

**修复**

<details><summary>Windows 上添加 paper-search 等命令参数含 `&lt;` 的 MCP 报 "The system cannot find the file specified." 且无任何提示</summary>

用 npm 安装的 claude 是 `claude.cmd` 批处理壳,应用经 `cmd.exe /c` 调用它执行 `claude mcp add` 时,`mcp<2` 这类参数未加引号,`<2` 被 cmd.exe 当成"从文件 2 读取输入",文件不存在即报错,claude 本身没有执行(用官方原生安装器的 claude.exe 不受影响,故表现为"有时会报错")。现在所有经 cmd.exe 调用 claude.cmd 的位置(添加 / 编辑 MCP、标题生成、版本与能力探测)统一改为逐参数加引号的写法,`<`、`>`、`|`、`&`、`^` 等字符原样传给 claude。0.2.374 只修了应用自行探测 MCP 那一条路径。参数以反斜杠结尾(如 `ROOT=D:\data\`、盘根 `D:\`)或反斜杠紧邻引号(如 `{\"k\":\"v\"}`)时按 Windows 命令行规则把这些反斜杠翻倍,后续参数不再被并进同一个字符串。

</details>

**优化**

<details><summary>README 新增「更新记录」</summary>

全部版本默认折叠,点击展开;已公开发布的版本号可点进对应 GitHub Release。发版时 GitHub Release 正文自动带上该版本的更新记录。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.374">v0.2.374</a></b>(2026-09-03)· 优化 1 条 · 修复 6 条</summary>

**优化**

<details><summary>设置里的两个缓存开关合并成一个「缓存优化」</summary>

原「缓存优化」(把工作目录、auto-memory、git 状态等每轮变化的动态段移出系统提示、改注入首条用户消息)经真机 A/B 证实单独开无效 —— DeepSeek 官方端点、每轮冷启动且轮次之间改动 git 状态的条件下,第 2 轮命中率:都不开 0.0%,只开静态系统提示快照 99.0%,只开旧「缓存优化」0.0%,两者同开 99.0%(第 3 轮四种组合均为 99.4–99.6%,无差别)。动态段挪进首条用户消息后,冷启动重算使这条消息本身逐轮变化,其后的内容照样全部未命中,故该开关既无收益又多占一项常驻进程复用键。现移除该开关及其接线,原「静态系统提示快照」条目更名为「缓存优化」并保留全部行为(三态自动/开/关、静态快照 + 关闭 ToolSearch + MCP 阻塞连接、实际值显示与 CLI 支持提示)。旧客户端或旧偏好里残留的该字段一律忽略,不影响使用。

</details>

**修复**

<details><summary>上下文徽章分母不再被 claude code 自报的 200k 覆盖</summary>

第三方 provider 手填或按模型联动得到的窗口(如 1M)此前在第一轮结束后被 CLI 模型表里的默认 200k 顶掉(CLI 实际压缩线按联动值走,只是显示错);现在 GUI 侧窗口优先,用户显式设置的压缩窗口在官方模型上取与 CLI 自报的较小值,徽章弹层显示分母来源(手填 / 实抓 / 规则表 / 联动 / CLI 自报 / [1m])。

</details>

<details><summary>Windows 上用 npm 安装的 claude 未被识别,导致缓存命中忽高忽低</summary>

npm 装出来的 `claude.cmd` 是批处理壳,此前应用认不出真正的可执行文件,聊天改走 SDK 自带的旧版 claude(2.1.191,不支持静态系统提示快照),每次冷启动那一轮命中率 0.5% 左右、进程复用的轮次 70–90%;设置里的「缓存优化」也一直提示"当前经 SDK 自带的 claude 运行"。现在从壳所在目录解析到 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`(校验为 Windows 可执行文件)并直接以它运行;解析不到(scoop / pnpm 安装)时行为与之前相同,设置面板改为给出该 exe 的预期路径与重装 / 改用官方原生安装器的指引。启动日志记录实际使用的 claude 路径与版本。

</details>

<details><summary>Windows 添加 MCP 报 "The system cannot find the file specified"</summary>

MCP 命令(`uvx` / `npx` / `python` 等)只在应用启动时的 PATH 快照里查找,装在 `%USERPROFILE%\.local\bin`、`%APPDATA%\npm`、Python `Scripts` 等常见目录但未进 PATH 的命令找不到。现按注册表里当前 PATH 与这些常见目录逐个查找(同目录内 .exe 优先于 .cmd/.bat,大小写不敏感),仍找不到时报错改为写明命令名并提示改用绝对路径,MCP 表单保存后同时显示该提示。

</details>

<details><summary>思考档位按模型变体回退</summary>

此前只有模型 id 与实测表完全一致才取到该模型的档位(如 `deepseek-v4-flash-vision-exp` 查不到就退回默认五档)。现在查不到时按去掉尾段的基名逐级回退(最多三级、同命名空间、不跨家族,如 `gpt-5-codex-x` 不会取 `gpt-5` 的档位;查到"不支持思考"的判定不沿变体传播,维持全档),思考力度下拉在这种情况下提示按哪个基名判定。DeepSeek 在售三个模型(`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`)按官方文档改为 low / high / max 三档;实测表升级到 pi-ai 0.84.4,新增 194 个模型 id(只增不删,旧条目档位不缩)。

</details>

<details><summary>三处命中率口径统一</summary>

会话标题行与手机顶栏为「本轮命中」(黑色字),每条回复末尾为「本轮命中率」,上下文徽章弹层里原「命中率」改为「平均命中率」(累计缓存读取 ÷ 累计输入),本轮命中率一项不变。

</details>

<details><summary>Windows 兼容审查三处必修(与上面 Windows 两条同源)</summary>

①识别到 npm 包内 claude.exe 后,「缓存优化」的版本探测改为应用启动后异步预热,不再在打开设置页或发送第一条消息时同步执行(此前 80MB 程序首次被安全软件扫描时会让后端无响应最长 5 秒),同步兜底探测超时降到 2 秒;②MCP 命令按目录查找改为直接判断文件是否存在,Windows 上不再逐个枚举 PATH 里的目录(此前包含 System32 与断开的网络盘时会同步阻塞数秒到数十秒),查找结果缓存 30 秒,保存 MCP 时的提示探测最多等 1.5 秒;③.cmd/.bat 命令经 cmd.exe 执行时改为整行外层加引号、每个参数单独加引号的写法,修正"命令路径带空格加参数带空格"时被截成 `'C:\Program' 不是内部或外部命令`(只影响 GUI 面板的连通性检测与工具列表)。另:实际使用的 claude 路径与版本日志改走 stderr(装机版可在 server.log 看到);包内 claude.exe 小于 5MB(下载中断留下的残缺文件)时不交给 SDK 而回落自带 CLI;注册表 PATH 里带引号的条目正确去引号;已填绝对路径但文件不存在时的报错改为"该路径不存在或不可执行"。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.372">v0.2.372</a></b>(2026-09-03)· 修复 3 条</summary>

**修复**

<details><summary>OpenAI 兼容通道的缓存命中(所有走该通道的官方预设:DeepSeek 官方 / Kimi / GLM / MiniMax / 千问 / 豆包 等)</summary>

0.2.370 把 claude code 每轮携带的元消息(`<total_tokens>` 提醒等)在翻译时统一成了会话中途的 `system` 角色;真机实测 DeepSeek 会把中途 system 消息并入系统段,其内容一变整个前缀(含系统提示与全部工具定义)作废,表现为每轮只有系统提示正文约 11k 命中、其余全部未命中、命中率停在 25% 左右。现改为一律映射为 `user`(与 Anthropic 直连口一致)。真机复核第 2、3 轮命中率:DeepSeek 97.0% / 98.9%,GLM 99.5% / 99.4%;Anthropic 兼容通道同步复核:DeepSeek 99.4% / 99.8%,GLM 99.9% / 99.9%,Anthropic 官方 99.5% / 99.5%。

</details>

<details><summary>生图面板「清空」</summary>

此前只清提示词与参考图,现在同时收起上一轮的图片预览;受理新任务或在任务列表重新选图时恢复显示。

</details>

- 0.2.371(仅本机安装)的内容一并包含:应用启动时对已激活的第三方 provider 自动补齐三个缓存开关;设置面板显示开关实际值。

</details>

<details>
<summary><b>v0.2.371</b>(2026-09-03)· 修复 1 条</summary>

**修复**

<details><summary>升级后缓存修复不生效</summary>

前缀缓存相关的三个开关(静态系统提示快照、关闭 ToolSearch、MCP 阻塞连接)此前只在切换 provider 时写入 `~/.claude/settings.json`;升级前已选定第三方 provider 的用户升级后一直拿不到修复,表现为缓存命中数逐轮不变、命中率停在 20–30%。现改为应用启动时对当前激活的第三方 provider 自动补齐(幂等:已是目标值不写文件、不改修改时间;官方 provider 或已关闭该功能时不写),并修正备忘记录只在真正改写时记录原值。设置→静态系统提示快照 新增显示 settings.json 里三个开关的实际值与 claude 版本是否支持快照,不一致时提示"重新选择一次 provider 或重启应用"。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.370">v0.2.370</a></b>(2026-09-03)· 新增 7 条 · 修复 8 条 · 已知限制 2 条</summary>

**新增**

<details><summary>Midjourney 通用层</summary>

生图面板的 Midjourney 参数改为统一编译成提示词末尾的 `--flag`(风格化 / 混乱度 / 怪异度 / 种子 / Stop / 画质 / 平铺 / Raw / Draft / 负向提示词 / 参考权重 / 角色·风格参考 / 重复生成 / 个性化 / 附加 flag),按版本显隐与禁用(8.x 下 `--q` 不可用;8.1/8.2 的 turbo 禁选,存量配置在下发时强制改为 fast 并在任务条目注明——实测 turbo 在 8.x 按 2.2 倍计费且不更快;`--draft` 仅 v7+;v6 用角色参考 `--cref`、v7 用 `--oref`);8.x 新增「高清(HD,2 倍像素,不额外计费)」控件。未经官方文档证实的参数不再给独立控件,统一走「附加 flag」。

</details>

<details><summary>第二种 Midjourney 协议 `mj-proxy`</summary>

支持 midjourney-proxy 形态的中转站(`/mj/submit/imagine`、`/mj/task/{id}/fetch`、`/mj/submit/action`,`mj-api-secret` 鉴权,参考图以 base64 随请求提交);plus 版按任务返回的按钮列表给出取出单图 / 变体 / 真放大等动作,原版按 U/V 序号退化。

</details>

<details><summary>参考图三类</summary>

垫图、角色参考、风格参考可从本地文件或 URL 提供,随每次请求发送(不再存进 provider);apimart 的垫图传法可在 provider 里选「先上传换链接 / base64 直传 / 只给公网 URL」(直传实测 2026-09-02 可用,但官方公告称不再支持,可能随时失效)。上传换链接每张单独计费,链接 72 小时有效(应用按此自算并提示)。

</details>

<details><summary>首页新建会话输入框支持 `/` 斜杠命令与 `@` 文件引用</summary>

与会话内输入框同一套命令来源、过滤与键盘操作(↑↓ 选择、Tab/Enter 填入、Esc 关闭;菜单打开时 Enter 不发送);首页菜单向下弹出。

</details>

<details><summary>生图放大层方向键切图</summary>

任务列表点开任意一张图后,←/→ 或两侧翻页按钮在全部已完成的图之间切换(顺序与列表一致),左上角显示「第 k / 共 N」,到头停住;关闭后预览区与单图操作指向刚看的那张。放大层新增像素尺寸显示与 1:1 原始像素查看。

</details>

<details><summary>DeepSeek「400 Content Exists Risk」处理</summary>

该错误是服务商的内容审核拒绝,通常由最近一条工具输出或消息里的敏感内容触发,且内容留在上下文里会让之后每一轮都被拒。现在错误气泡下给出说明与两个动作:「回退到该工具输出之前并继续」(纯截断、写 .bak、不压缩;回退后让模型换一种方式继续,不重跑同一工具;同一会话只自动回退一次)与「新开会话」(带上最后一条消息)。

</details>

<details><summary>本轮缓存命中率显示</summary>

会话标题行与手机顶栏显示「本轮命中」(最近一次 API 调用),每条回复末尾的用量行显示这一轮的命中率;上下文徽章弹层的本轮 / 累计不变。

</details>

**修复**

<details><summary>OpenAI 兼容通道的缓存命中</summary>

本地翻译代理把 claude code 的同一条元消息(`# Environment`、`<total_tokens>` 提醒)在"本轮"与"变成历史"两种形态下翻译成不同的 role,每轮都打穿上游前缀缓存(首次续接只有 78% 前缀相同);现统一 role,零费用假上游三轮前缀相同率 100%。usage 缓存字段换算补齐五种形态(DeepSeek `prompt_cache_hit_tokens`、OpenAI `prompt_tokens_details.cached_tokens`、Kimi 顶层 `cached_tokens`、Anthropic 命名的顶层与嵌套),此前 Kimi 等上游的命中在徽章里恒显示 0。该通道不发送 user 字段(DeepSeek 按该字段隔离缓存,不发是净收益)。

</details>

<details><summary>「始终允许」不再让常驻进程冷启动</summary>

claude code 把权限规则写进用户级 settings.json 后,应用此前按文件修改时间判定配置变化而重开进程(前缀缓存整段作废);现改为按"排除权限规则后的内容摘要 + 外部权限改动代数"判定,自写的权限规则不触发冷启(权限规则在进程内热更新),provider 切换与环境变量改动仍照常重开。

</details>

<details><summary>开始生图后预览区仍显示上一轮的图</summary>

点「生成」或对已完成任务发起取出单图 / 变体受理成功的一瞬,预览区改为显示该任务的状态行,完成后显示新图;失败 / 取消只显示原因。

</details>

<details><summary>中转站模型名带前缀时参数控件消失</summary>

能力表按"以 gpt-image-2 开头"匹配,`openai/gpt-5.4-image-2` 这类写法被当未知模型,张数 / 画质等控件整块消失且不下发;现按前缀分隔符容忍匹配,官方语义下未登记的模型放开通用控件、候选值不过滤。

</details>

<details><summary>生图 provider 编辑页「模型」输入框被「浏览」按钮挤扁</summary>

模型名看不见。

</details>

<details><summary>「放大」按钮改名「取出单图」</summary>

该动作只是把四宫格里的那张单独取出,像素不变(实测 1456×816 → 1456×816);apimart 当前没有真放大动作,面板改为如实说明并引导 8.x 开 HD;有真放大按钮的站点(mj-proxy plus)按按钮列表出现。

</details>

- 单窗格会话容器不再做内缩圆角卡片(标题栏此前看起来像气泡),与左侧会话列表同款贴边平面;分屏多窗格仍为卡片。

- 生图 mj-proxy 提交失败的上游文案经脱敏与截长后才写入历史;动作端点在 8.x 同样强制 turbo 降级;非 Midjourney 协议下的 URL 参考图改为提交前拒绝并提示(此前被静默丢弃仍计费)。

**已知限制**

- Windows 上若代理软件工作在"系统代理"模式,应用后端进程不走代理,拉取模型 / 测试连接可能报"连不上";切换为 TUN 模式即可。后续版本计划让后端读取系统代理。

- 切换模型后的第一轮必然重建一次缓存(不同模型是不同缓存桶),从第二轮起恢复命中。

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.369">v0.2.369</a></b>(2026-09-02)· 新增 4 条 · 修复 1 条 · 优化 2 条 · 修复 2 条</summary>

**新增**

<details><summary>OpenAI 系生图参数面板</summary>

provider 编辑页按上游自动识别「方言」（apimart / OpenAI 官方，可手改）。apimart 下提供分辨率（1k/2k/4k）、宽高比预设、输出格式、背景、审核强度、图像数量、质量与「提交前预审」；官方下提供像素尺寸、质量、输出格式、背景、审核强度、图像数量。字段按模型能力显示，且请求只包含该模型支持的参数（换模型后不再残留旧参数）；高级项默认折叠；附加参数仍可覆盖任一字段。

</details>

<details><summary>生图费用显示</summary>

任务完成后条目上显示上游返回的实付金额；apimart 方言下生成前显示预估（按其公开报价接口与张数计算，数据不全时不显示，以实付为准）。

</details>

<details><summary>一次生成多张图</summary>

OpenAI 系模型可选图像数量（1–4），同步返回的多张图全部保存并在条目里逐张切换（此前只保存第一张）。

</details>

<details><summary>模型「浏览」按钮</summary>

生图 provider 编辑页模型框旁新增浏览按钮，弹出已拉取的全部模型（带搜索），不再受输入框已填文字过滤影响。

</details>

**修复**

<details><summary>apimart 上 gpt-image-2 尺寸候选为空</summary>

能力表此前只按模型名判断，把比例与 1k/2k/4k 全部过滤，对 apimart 恰好相反；现按（上游方言，模型）判定。

</details>

**优化**

<details><summary>权限 / 计划 / 提问卡片可折叠</summary>

卡片标题行新增折叠按钮，折叠后只收起正文、保留标题与允许 / 拒绝等操作按钮（约 380px → 75px），Enter / Esc 与按钮行为不变，折叠时已填写的内容不丢失；每张新卡片都默认展开，折叠只对当前卡片生效、不记忆偏好；手机端同样生效。

</details>

<details><summary>第三方模型的提示词缓存命中率</summary>

排查发现 claude code 进程每次冷启动都会重算 git 状态并放在提示词最前面，之后的内容整段未命中；同时 GUI 传入自定义系统提示会关闭 CLI 的「系统提示冻结快照」。现新增设置「静态系统提示快照」（第三方 provider 默认开、官方默认关），切换到第三方时自动关闭会中途改写工具列表的 ToolSearch（切回官方自动还原原设置），并在回环代理中把每个会话不同的用户标识归一（DeepSeek 按该标识隔离缓存，此前每个新会话都从零缓存）。上下文徽章与用量面板新增每轮 / 会话累计命中率。同一开关下另有三项：MCP 服务改为连上后再发首条消息（此前启动慢于 2 秒的 MCP 会让每次冷启动的前两条请求整段未命中，代价是首条消息略等）；新会话自动起标题改为先等待 claude 原生标题写入，未写入时再由应用起一次与原生同形态的轻量调用（不带工具与 MCP，整条兜底路径约 1.2k token；此前约 2.2 万 token 全价未命中，且续接的会话原生不起标题必然触发；小快档模型不可用时自动改用会话模型重试一次）；「提示建议」在第三方 provider 下默认关闭（每回合少打一次模型，可在设置里重新打开）。实测同一场景（进程冷启且 git 状态变化）共享前缀由约 13% 提升到 99%。设置会写入 ~/.claude/settings.json，终端 claude 与机器人同样受影响，可在设置里关闭。较旧的 claude 版本（2.1.252 及更早）不支持快照参数，应用会自动探测，不支持时仅关闭 ToolSearch 生效，面板会提示。

</details>

**修复**

<details><summary>新建第三方文本 provider 时「测试连接」报 max_tokens must be greater than 2</summary>

连接探针此前把 max_tokens 设为 1，部分中转站（如 apimart）要求大于 2 而拒收，被误报为连接失败；现改为 8，成本仍可忽略。

</details>

<details><summary>内置「Paper Search」MCP 预设添加后连不上</summary>

该服务的 Python 包尚未适配 2026-07-28 发布的 mcp 2.x（FastMCP 已改名），而预设命令每次都会解析到最新的 mcp，导致启动即报错。现预设命令固定使用 mcp 1.x（`--with mcp<2`），待上游适配后再放开。已按此预设添加过且连不上的用户，删除后重新添加即可。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.368">v0.2.368</a></b>(2026-09-01)· 修复 3 条</summary>

**修复**

<details><summary>Windows 上通过 npm 安装 Claude Code 报「禁止运行脚本」</summary>

全新 Windows 的 PowerShell 默认禁止运行 `.ps1` 脚本，安装步骤里写入 PATH 的那段命令调用 `npm` 时被解析成 `npm.ps1` 而被拦下，表现为 Claude 已装好但窗口报错、随后检测不到。现改为直接调用 `npm.cmd` 并为该步骤显式放行（仅作用于本次安装进程，不修改系统执行策略），与原生安装器路径一致。

</details>

<details><summary>README 与应用内升级命令补充 Windows 写法</summary>

Windows 下请使用 `npx.cmd @wsxwj123/cc-gui`（PowerShell 会拦截 `npx` 的 `.ps1` 启动器），或在 cmd.exe 中运行原命令；常见问题新增对应条目。macOS / Linux 命令不变。

</details>

<details><summary>provider 头像选择器只显示少数几个内置图标</summary>

内置图标共 56 个，此前网格高度过小且不显示滚动条，看起来只有几个常见厂商。现网格加高并在标签上标明总数与可滚动。

</details>

</details>

<details>
<summary><b>v0.2.367</b>(2026-09-01)· 新增 3 条 · 优化 1 条 · 修复 3 条</summary>

**新增**

<details><summary>Midjourney 放大与变体</summary>

任务列表中的 Midjourney 结果以四格缩略图显示，选中任一张可执行放大、变体、高变体、低变体，或对整组重绘；结果作为新条目进入历史，并标注来源任务与序号。放大结果为单张图。2x/4x 高清放大暂不支持（需上游额外标识，后续版本补）。

</details>

<details><summary>Midjourney 参数面板</summary>

provider 编辑页在 mj 协议下改为比例预设（1:1 头像、3:2 文章配图、3:4 社交媒体、4:3 公众号配图、9:16 海报图、16:9 电脑壁纸）与自定义宽高比；新增写实 / 动漫（niji）切换、版本下拉（8.2、8.1、7、6.1、5.2、5.1；niji 7、niji 6）与速度档（relax / fast / turbo）；高级参数默认折叠，附加参数框旁给出可直接填入的示例与字段范围。

</details>

<details><summary>生成页「清空」按钮</summary>

一键清空提示词（含自动保存的草稿）与全部参考图，可用 ⌘Z 撤回。

</details>

**优化**

<details><summary>provider 头像改为简约风格</summary>

去掉品牌渐变底，改为表面色圆角底加细边框，标识保留品牌色；深浅色模式各自适配。内置图标从 10 个扩充到 56 个（覆盖主流模型厂商与中转站，来源为 MIT / CC0 授权的公开图标集），头像选择器新增搜索。用量面板中的分组名保持 Kimi / Llama 不变。

</details>

**修复**

<details><summary>多图任务只能预览第一张</summary>

Midjourney 一次生成的 4 张图此前只有第一张可在任务列表预览，其余需到保存目录查看；现网格视图、列表视图与生成页均可逐张查看与放大，「以此图修改」「在文件夹中显示」作用于当前选中的那一张。

</details>

<details><summary>Midjourney 尺寸设置不生效</summary>

此前 mj 协议不下发尺寸，宽高比只能写在提示词或附加参数里；现表单中的比例直接生效。旧配置中遗留的像素尺寸（如 1024x1024）会被忽略而不再当作比例发出。

</details>

<details><summary>手机上 provider 头像可能不显示</summary>

内联图标缺少显式尺寸时在 WKWebView 下渲染为 0×0，已统一修正。

</details>

</details>

<details>
<summary><b>v0.2.366</b>(2026-09-01)· 修复 1 条</summary>

**修复**

<details><summary>生成式界面的 3D 场景与流程图在加载失败时一直转圈</summary>

这两类图形的渲染代码是用到时才临时下载的，若下载失败（断网、或应用更新后旧文件已失效），界面会永远停在「加载中」。现在下载失败会如实显示「渲染失败」，流程图则退回显示源码。

</details>

</details>

<details>
<summary><b>v0.2.365</b>(2026-09-01)· 新增 1 条</summary>

**新增**

<details><summary>生图支持任务制接口（Midjourney 等）</summary>

生图 provider 新增「mj」协议，可接入 Midjourney 类的异步接口——提交后面板显示生成进度，完成后把该次生成的多张图全部下载保存（Midjourney 一次出 4 张），条目上标注张数。同时，标准生图接口若返回的是任务号而非图片（部分中转站对 flux / gpt-image / imagen 等模型即如此），也会自动进入同一套等待流程，不再报「取不到图」。单次任务最多接受 16 张图，超出部分丢弃，避免异常上游拖垮后端。已知边界：mj 协议当前不支持参考图与尺寸参数；中途停止只停本地等待，上游任务可能仍在生成并计费。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.364">v0.2.364</a></b>(2026-09-01)· 新增 1 条 · 修复 2 条</summary>

**新增**

<details><summary>provider 自定义头像</summary>

每个 provider 可设置独立头像，消息头、模型选择器、provider 列表同步显示（与署名同源归属）。支持两种方式：上传本地图片，或填入图片链接（抓取一次落地本地，之后永不外呼、不热链）。仅接受 png/jpeg/webp，1MB 上限；删除 provider 或更换头像时自动清理旧文件。

</details>

**修复**

<details><summary>首页选的模型重启后变回全局默认</summary>

在首页（未进入具体会话）顶栏选的模型此前不落盘，重启应用必然回到全局默认模型。现落入待发草稿，发出第一条消息后自动跟随到该会话并持久保存；重启前刷新页面也不再丢失。

</details>

<details><summary>切换过 provider 后，老会话一律显示/发送全局默认模型</summary>

此前切换 provider 会永久性地不信任所有更早会话的历史模型，官方订阅下连完全合法的 claude 模型也被判无效。现官方 Anthropic 下取消该判死（模型合法性仍有白名单把关）；第三方 provider 下防串模型的门控保持不变。

</details>

</details>

<details>
<summary><b>v0.2.363</b>(2026-09-01)· 新增 1 条 · 优化 2 条</summary>

**新增**

<details><summary>助手消息署名跟随 provider</summary>

使用第三方中转时，消息头显示该 provider 的名称（此前固定显示 Claude）。按消息的模型 id 归属：能在已配置 provider 的模型清单中唯一认领的历史消息，跨 provider 切换保持原名；官方订阅恒显 Claude。已知边界：claude- 系模型的历史消息在第三方激活期间按当前 provider 署名（会话记录不含 provider 信息，无法区分），切回官方即恢复。

</details>

**优化**

<details><summary>市场与原面板分工互链</summary>

扩展市场页签行新增「管理已装 →」直达对应管理面板；技能面板导入页与工具面板新增「见扩展市场 →」指路。分工明确：市场管发现，原面板管已装。

</details>

<details><summary>市场技能页布局</summary>

多选/刷新按钮不再单独占一行，并入「全部源」行右端。

</details>

</details>

<details>
<summary><b>v0.2.362</b>(2026-09-01)· 新增 1 条 · 修复 1 条</summary>

**新增**

<details><summary>统一「扩展市场」</summary>

设置里新增「扩展市场」入口，技能 / 插件 / MCP 三类一站浏览。插件页展示官方市场 279 个插件并按真实安装量排序；MCP 页接入官方注册表（4000+ 条），支持首页浏览、翻页、按类型（远程/npm/pypi）筛选与搜索——此前必须先知道名字才能搜到；点「添加」自动预填 MCP 配置表单，不会自动连接。技能页与原技能市场同源。原有三个分散入口全部保留。安装安全模型不变：技能为纯文本落盘，插件走官方 claude 命令行，MCP 仅预填表单；市场不引入任何「点击即执行」通道。

</details>

**修复**

<details><summary>生成式界面的单选/选择组件点了没反应</summary>

模型此前可能把普通单选写成「试卷聚合模式」（选择只在本地记录、需配提交按钮），且不带回传动作，导致点选后对话无法继续。现内置教学明确回传写法，实测模型产出的选项点选后立即回传所选值并继续对话。

</details>

</details>

<details>
<summary><b>v0.2.361</b>(2026-09-01)· 新增 2 条 · 修复 3 条</summary>

**新增**

<details><summary>生成式界面图表一键导出</summary>

图表悬停右上角出现工具条——复制数据、下载 CSV（带 BOM，Excel 打开中文不乱码）、导出 PNG（2 倍清晰度，深浅主题颜色与屏幕一致）。覆盖柱状/折线/环形图、ECharts、函数图、mermaid、架构图与表格（表格仅数据导出）；导出为纯本地操作，不产生模型往返、不外发任何请求。

</details>

<details><summary>技能市场分面浏览</summary>

市场支持搜索（含按标识符搜索）、来源筛选（带条目计数）、名称/来源排序与「只看未安装」；千条级列表流畅滚动。

</details>

**修复**

<details><summary>流式回复中切走再切回，已输出的正文消失</summary>

此前切回后只剩状态行动画，要等整条回复完成才一次性显示。现切回立即显示已输出的全部正文并继续增长，等待耗时不再从 0 重计；超长回合缓冲溢出等极端情况自动退回原行为，不会丢字。

</details>

<details><summary>技能市场经常加载为空</summary>

市场此前使用未认证 GitHub 接口，配额极低（走共享代理出口时几乎必然限流返回空列表）。现自动复用本机 gh 登录态，或在导入页填写访问令牌（新增设置项），六个源可完整加载。

</details>

<details><summary>技能市场「全部源」视图装错来源</summary>

从合并视图安装时此前固定从第一个源安装，跨源同名技能会装错仓库；现按条目自身来源安装，并在合并视图停用「一键导入全部」。

</details>

</details>

<details>
<summary><b>v0.2.360</b>(2026-08-31)· 修复 3 条</summary>

**修复**

<details><summary>生成式界面「N 个不支持的组件已忽略」高频出现</summary>

根因是内置教学只列组件类型名、未给字段定义，模型靠猜写字段（如把代码块字段写成 `language`/`content`，正确为 `lang`/`code`），猜错即整节点被过滤。现内置教学补充全部组件的字段速查（可直接照抄的 JSON 签名），同类问题真机复验为零忽略。

</details>

<details><summary>图表渲染成只有网格线的空框</summary>

模型字段写错导致图表/表格/列表的内容数据全部被过滤时，此前节点以空壳形式渲染为误导性空框；现此类节点整体计入「已忽略」提示，不再显示空框。

</details>

- 设置里「界面输出技能」说明与实际行为对齐：应用已内置基础教学（未安装技能模型也会输出界面），该技能为可选的完整字段规范，安装后复杂组件字段更准确。

</details>

<details>
<summary><b>v0.2.359</b>(2026-08-31)· 优化 1 条</summary>

**优化**

<details><summary>生成式界面开箱即用</summary>

不再需要先安装 cgui-ui 技能——应用在会话开始时自动告知模型这套界面语法，模型在适合结构化呈现的场合会主动输出界面。仅 GUI 会话生效，不影响终端 claude 与机器人；不改动 `~/.claude` 下任何文件。cgui-ui 技能仍可安装，作为完整字段规范供模型按需查阅。设置里关闭「生成式界面」后不再告知，模型恢复纯文本回答。

</details>

</details>

<details>
<summary><b>v0.2.358</b>(2026-08-31)· 新增 2 条 · 修复 1 条</summary>

**新增**

<details><summary>生成式界面（genui）</summary>

模型可以在回答正文中间直接输出可交互界面——图表（柱状/折线/环形/ECharts 全功能）、函数曲线、表格、表单、选择题、时间线、流程图（mermaid）、架构图、3D 场景等 44 种组件，写到哪渲染到哪，流式输出边写边成形。点按钮、提交表单等操作会折叠成一条可展开的「界面操作」消息回传给模型继续对话；若模型尚在输出，操作先排队、本回合结束后自动发出。表格排序、选择题判卷、折叠展开等纯界面操作在本地完成，不产生模型往返。带界面的消息统一显示「模型生成界面」标识。渲染失败时保留原始代码块不留空白；组件树只认白名单类型，模型提供的脚本、外部媒体地址、危险表达式一律拦截；全部图表引擎打包在应用内，不联网加载。设置里可整体关闭；同时识别 `cgui-ui` 与上游规范的 `dsh-ui` 两种围栏标记。交互状态（输入值、选中项、页签位置等）按会话持久保存，刷新后仍在；密码类输入框的内容不落盘、不回传。

</details>

<details><summary>界面手机端适配</summary>

窄屏下多列网格转单列、表格横向滚动、图表宽度自适应、按钮与输入框放大到触控尺寸。

</details>

**修复**

<details><summary>切走再切回时连接状态丢失</summary>

发消息后模型尚未输出任何内容时切到别的会话再切回，状态行此前显示与「正在思考」相同的循环动词，无法分辨是否已连上。现该状态下显示 Connecting，任何输出到达后自动恢复为原有显示；本回合等待耗时不再从 0 重新计。

</details>

</details>

<details>
<summary><b>v0.2.357</b>(2026-08-31)· 修复 3 条</summary>

**修复**

<details><summary>npm 通道安装命令全面改为 npx 形态</summary>

macOS 用官方安装包装的 Node.js，其全局目录归系统所有，`npm i -g` 一律报 `EACCES` 权限错误（与本项目无关，装任何全局包都一样）。`cc-gui` 是安装器而非日常命令，npx 是这类工具的标准用法：`npx @wsxwj123/cc-gui` 一条命令完成安装，不受全局目录权限影响。三份说明文档同步改写并补充 `EACCES` 常见问题；启动器与应用内更新面板给出的重装/升级命令同步改为 npx 形态。

</details>

<details><summary>git 状态横幅认出「命令行开发者工具未安装」</summary>

全新 Mac 上 git 由 Xcode 命令行工具提供，未安装时执行 git 会输出 `xcode-select` 系统提示。此前该情况被归入未知错误、横幅原样显示系统报错；现在显示说明文字与可复制的修复命令（`xcode-select --install`），不再显示原始报错。

</details>

<details><summary>环境扫描补充 git 官网安装包落点</summary>

从 git 官网安装包装的 git 位于 `/usr/local/git/bin`，该路径靠登录 shell 配置生效，桌面应用启动的后端读不到；此前即使正确安装了 git 也可能检测不到。现启动时与环境扫描均补充该路径（仅 macOS）。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.356">v0.2.356</a></b>(2026-08-26)· 修复 1 条 · 说明 1 条</summary>

**修复**

<details><summary>npm 安装：应用装在非默认位置时误报失败</summary>

若当初把 CC-GUI 装到了 `%LOCALAPPDATA%` 以外的地方（例如 D 盘），`cc-gui` 其实已安装成功，却仍提示「没找到安装目录」。现在改为先读注册表里记录的实际安装位置——这也是 Windows 安装器自己升级时认的位置——固定目录仅作兜底；读不到注册表时行为不变，不会因此拦住安装。

</details>

**说明**

<details><summary>Windows 更新装到哪</summary>

应用内「自动下载并安装」与 `cc-gui` 命令都不指定安装目录，安装器会沿用上一次的安装位置（记录在注册表里），原地覆盖升级。只有从未安装过的机器才会用默认位置 `%LOCALAPPDATA%\CC-GUI`。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.355">v0.2.355</a></b>(2026-08-26)· 修复 3 条</summary>

**修复**

<details><summary>npm 通道在 Windows 上装完误报失败根治</summary>

Windows 用 `npm i -g @wsxwj123/cc-gui` 安装，应用其实已经装好，却提示「安装器已退出但没找到安装目录」且不会自动打开。原因是安装目录与主程序名沿用了 macOS 的布局假设，与 Windows 实际结构不符。现已按实际布局修正，装完自动启动；升级前的「应用是否正在运行」检测同步修正——此前该检测恒判「未运行」，可能在你正用着的时候被安装器强制关闭。

</details>

<details><summary>Windows 覆盖安装偶发「无法 write」</summary>

安装器在覆盖前清理残留进程时，用的进程名并不存在，清理一直是空转。现按真实主程序名清理，覆盖安装更稳。

</details>

<details><summary>镜像源缺包时的提示改为可执行指引</summary>

npm 镜像按需同步，新版本的平台安装包可能滞后甚至一直缺失。此前提示「通常十几分钟内完成」会让人干等；现直接给出换官方源安装的完整命令。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.354">v0.2.354</a></b>(2026-08-26)· 新增 1 条</summary>

**新增**

<details><summary>npm 安装通道上线（国内无需代理）</summary>

`npm i -g @wsxwj123/cc-gui --registry=https://registry.npmmirror.com` 安装后，终端运行 `cc-gui` 即可（macOS 装入 ~/Applications；Windows 静默运行官方安装器，产物与官网下载版一致，含开始菜单与卸载项）。升级：重新执行安装命令后重开应用。应用内「检查更新」对 npm 装法显示可复制的升级命令，并在 GitHub 不可达时自动改走 npm 镜像查询最新版本。安装通道经安全审计：不联网下载可执行文件（安装字节全在包内）、升级前检测应用是否运行、失败保留旧版可恢复。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.353">v0.2.353</a></b>(2026-08-26)· 修复 2 条</summary>

**修复**

<details><summary>第三方中转视觉模型识图失效根治</summary>

经 OpenAI 协议中转使用视觉模型（DeepSeek 系等）时，图片在协议转换环节被压平丢失，模型收不到图并回复"不支持视觉输入"。现图片完整转换传给上游；"是否支持视觉"按当前会话实际选择的模型判定（此前误读 provider 模型列表的第一个）；输入框上方的识图能力提示同步修正（此前该提示的场景不提示、不该提示的场景误报）。

</details>

<details><summary>回滚重发丢附件根治</summary>

含图片/文件的消息在「仅回滚消息」「回滚消息和文件」「重做整轮」后重发时附件全部丢失，纯附件消息甚至整条消失。现三个入口重发均完整携带附件并显示缩略图卡片；编辑重发时可在输入框删除单个附件后再发；附件文件已被 7 天自动清理删除的旧消息，重发时明确提示而非静默发出失效引用。

</details>

</details>

<details>
<summary><b>v0.2.352</b>(2026-08-25)· 修复 1 条</summary>

**修复**

<details><summary>更新面板"更新失败:Load failed"假失败根治</summary>

原生安装器下载大包长时间无输出时，进度流会被系统内核的 60 秒无活动超时切断，界面误报失败而实际更新已成功。现进度流每 15 秒发保活心跳；即使连接中断也会自动续看进度并核对真实结果，确认失败才提示。

</details>

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.351">v0.2.351</a></b>(2026-08-25)· 本版说明 1 条 · 🎨 生图工作台（入口：右侧面板 →「生图」） 7 条 · 🧩 模型勾选白名单（文本与生图通用） 1 条 · ⌨️ 全局撤销 1 条 · 🛡️ 权限 2 条 · 🖼️ 皮肤系统（入口：顶栏「主题」→ 皮肤） 1 条 · 👤 称呼与其他 5 条</summary>

**本版说明**

- 本版把 0.2.320 以来的全部新功能整理成下方导览，方便一次看全。逐版细节仍见后续各版本块。

**🎨 生图工作台（入口：右侧面板 →「生图」）**

<details><summary>配置</summary>

＋ 新增 provider → 填协议（OpenAI 系/Gemini 系/对话接口）、接口地址、密钥、保存目录。点「拉取模型」弹窗勾选要用的模型（支持搜索/全选/已添加灰标），成功显示「连接正常」兼作免费连通测试。

</details>

<details><summary>尺寸</summary>

候选按模型自动过滤——gpt-image-2 的 4K 选 3840x2160（横）/2160x3840（竖）；Seedream 系直接选 4K；手动输入不受限。

</details>

<details><summary>代理</summary>

直连境外服务报 fetch failed 时，「代理地址」填本机代理（如 http://127.0.0.1:7897），该 provider 的生成/拉模型/下载全走代理。

</details>

<details><summary>质量</summary>

附加参数填 {"quality": "high"}（gpt-image 系认 low/medium/high/auto，默认 auto）。

</details>

<details><summary>文生图</summary>

写提示词（输入框自动增高、内容自动存草稿）→ 生成。生成在后台运行：关面板不中断，重开可见进度；最多 3 张并行。

</details>

<details><summary>图生图</summary>

提示词框上方「添加参考图」上传（png/jpg/webp 最多 6 张），或在任务列表对已生成图点「以此图修改」图标；Seedream/方舟系把 provider 的「图生图形态」切到方舟形态。

</details>

<details><summary>任务列表</summary>

（第二选项卡）：网格/列表视图可切换；生成中可取消；出错原因显示在图块内；点图放大预览；图标操作＝以此图修改/在文件夹中显示/恢复提示词/删除；「选择」开关批量删除，可勾选连本地文件一起删；历史保留 100 条。

</details>

**🧩 模型勾选白名单（文本与生图通用）**

- Provider 编辑页「拉取模型」→ 勾选 → 确认。默认模型下拉与聊天模型选择器只显示勾选过的；重新拉取只增不减，删除在模型列表框删行即可。

**⌨️ 全局撤销**

- 任何输入框 Cmd/Ctrl+Z 撤销、Cmd/Ctrl+Shift+Z 重做（每框独立 200 步）。此前被系统菜单拦截长期失效，已根治；可退到输入前，自动填入的内容（勾选合并/恢复提示词）也可一键撤回。

**🛡️ 权限**

- 「始终允许」不再跨卡片粘滞（此前会不知不觉攒下几十条永久规则）；允许按钮明示本次点击效果。已有规则在 设置 → 通用 → 权限 查看删除。

- 档位切换被 CLI 拒绝时如实回滚并显示原因；会话启动核对实际生效档位。

**🖼️ 皮肤系统（入口：顶栏「主题」→ 皮肤）**

- 内置 Windows XP/初音未来/QQ2008/鲸歌等，试穿/应用/停用；「AI 生成」页可翻阅完整提示词交给任意 AI 产出皮肤包；导入支持 zip/.cguiskin/文件夹。本批根治了 XP 皮肤冻死、标题栏对齐、停用残留等问题。

**👤 称呼与其他**

- 设置 → 通用 →「称呼」：首页问候显示你的名字，多端共享。

- DeepSeek 识图模型（deepseek-v4-flash-vision-exp 等）经中转使用图片不再被剥除。

- 更新渠道：选定 npm/原生后，提醒与更新只按该渠道比较，双装不再互相误报。

- Windows：更新失败不再清掉已装 claude；删除被占用图片如实提示可重试；多处路径修复。

- Node 20 生图兼容修复；版本不足时明确提示升级。

</details>

<details>
<summary><b>v0.2.350</b>(2026-08-25)· 本版说明 1 条</summary>

**本版说明**

- 累计新功能导览见 0.2.351。

</details>

<details>
<summary><b>v0.2.349</b>(2026-08-25)· 本版说明 1 条</summary>

**本版说明**

- 累计新功能导览见 0.2.350。

</details>

<details>
<summary><b>v0.2.348</b>(2026-08-25)· 本版说明 1 条</summary>

**本版说明**

- 累计新功能导览见 0.2.349。

</details>

<details>
<summary><b><a href="https://github.com/wsxwj123/claude-gui/releases/tag/v0.2.347">v0.2.347</a></b>(2026-08-25)· 修复 1 条</summary>

**修复**

- 生图任务列表的操作按钮（以此图修改/在文件夹中显示/恢复/删除/取消）改为纯图标，不再因文字过长竖排换行；完整说明保留在悬停提示中。

</details>

<details>
<summary><b>v0.2.346</b>(2026-08-25)· 修复 1 条</summary>

**修复**

<details><summary>Cmd/Ctrl+Z 撤销两处实测缺陷</summary>

①任何输入框撤销后残留第一个字母——撤销历史此前从"打完第一个字母之后"才开始记录，现在从聚焦输入框的瞬间开始，可完整退到输入前；②模型列表等由"勾选确认/恢复按钮"程序化填入的内容无法撤销——此类写入现已进入撤销历史，勾选合并、提示词恢复后可直接 Cmd+Z 整体退回（Cmd+Shift+Z 重做），写入后焦点自动落在该输入框。

</details>

</details>

<details>
<summary><b>v0.2.345</b>(2026-08-25)· 新增 6 条 · 修复 5 条</summary>

**新增**

<details><summary>图生图</summary>

生图页新增「参考图」——可上传本地图片（png/jpg/webp，单张 ≤15MB、最多 6 张），或在任务列表对任意已生成图片点「以此图修改」；提示词描述修改内容后生成。支持 OpenAI 官方 edits 形态与 Seedream/方舟形态（openai 协议的 provider 表单可选「图生图形态」），Gemini 与对话接口协议同步支持。历史条目标注「图生图」。

</details>

<details><summary>取消生成中任务</summary>

任务列表的"生成中"条目新增「取消」按钮，点击即中止并释放并发名额；已完成的任务不受影响。Esc 键不绑定取消，关闭面板也不会中断生成。

</details>

<details><summary>任务删除</summary>

任务列表支持单条删除与批量选择删除，确认弹窗内可勾选「同时删除本地图片文件」（默认不勾）；文件删除严格限定在保存目录内。

</details>

<details><summary>按 provider 生图代理</summary>

生图 provider 可选填「代理地址」（如 http://127.0.0.1:7897），该 provider 的生成、拉取模型、图片下载均经此代理——解决直连境外生图服务失败（fetch failed）的问题；留空保持直连。

</details>

<details><summary>尺寸候选按模型过滤</summary>

模型框填入已知家族（gpt-image 系/DALL·E/Seedream）时，尺寸下拉只显示该模型官方支持的取值（如 gpt-image-2 不再显示它不支持的 4096x4096）；未知模型显示全量候选，手动输入始终不受限制。

</details>

- 拉取模型成功的提示补充「连接正常」，兼作免费的连通性测试。

**修复**

<details><summary>权限规则批量泄漏根治</summary>

权限卡的「记住」选择此前会在卡片之间保持——选过一次「始终允许」后，后续每次放行都会静默写入一条永久规则（可累积数十条）。现在每张新卡一律回到「仅此次」，且允许按钮会明示本次点击的实际效果（允许 / 允许并本会话记住 / 允许并写入规则）。

</details>

<details><summary>Node 兼容</summary>

修复 Node 20 用户生图功能不可用且报错误导（显示为网络问题）的兼容缺陷；若未来再遇 Node 版本不足，将明确提示「当前 Node 版本过低，请升级」。

</details>

<details><summary>Windows 删除占用文件</summary>

删除图片时若文件正被其他程序占用，历史记录会保留以便重试，并如实提示「文件可能正被其他程序占用」（此前会误报为路径配置问题且留下无记录的孤儿文件）。

</details>

- 生图代理连接失败时错误信息带上具体原因（如 ECONNREFUSED），不再只显示 fetch failed。

- 参考图预览的内存占用大幅降低；图片类型识别在系统缺少类型注册时按扩展名兜底。

</details>

<details>
<summary><b>v0.2.344</b>(2026-08-25)· 新增 4 条 · 修复 1 条</summary>

**新增**

<details><summary>模型勾选（文本与生图 provider 通用）</summary>

「拉取模型」不再把全量列表直接灌入，而是打开勾选弹窗——搜索过滤、整行点选、已添加项灰标提示、全选/全不选（仅作用于当前搜索结果且跳过已添加）、右上角实时计数。勾选结果即该 provider 的模型清单：默认模型下拉与聊天界面的模型选择器只显示勾选过的；重新拉取只增不减，已勾选的不会被重置，删除仍由手动完成。

</details>

- 生图 provider 的模型候选列表随 provider 持久保存（此前拉取结果仅当次有效）。

- 聊天模型选择器：自定义 provider 的列表不再自动并入服务端全量目录（只显示勾选的）；「拉取最新」改为打开勾选弹窗，确认后持久生效。官方 Anthropic 行为不变。

- 拉取候选自动过滤嵌入/语音/重排等非对话模型；生图侧口径单独放行 FLUX、视频类生图模型。

**修复**

- 任务列表点「恢复」后自动切回「生图」选项卡（此前停留在任务列表）。

</details>

<details>
<summary><b>v0.2.343</b>(2026-08-25)· 新增 3 条 · 修复 3 条</summary>

**新增**

<details><summary>生图后台任务化</summary>

点「生成」立即开始后台任务，关闭右侧面板不影响生成；重新打开能看到"生成中"或已完成的图片，提示词留在输入框（本机草稿自动保存）。多张图可并行/先后生成（同时上限 3 个），历史保留最近 100 条并持久保存。

</details>

<details><summary>生图面板双选项卡</summary>

「生图」｜「任务列表」。任务列表支持网格/列表两种展开形态可切换；生成中显示转圈与已用时长，出错的把错误原因直接显示在图块内；点击任意已完成图片全屏放大预览，可「在文件夹中显示」（macOS 访达 / Windows 资源管理器通用）；每条历史带「恢复」按钮一键回填提示词。

</details>

<details><summary>提示词输入框随内容自动增高</summary>

（上限内自适应，超出框内滚动）。

</details>

**修复**

<details><summary>所有输入框 Cmd/Ctrl+Z 撤销输入恢复可用</summary>

此前 macOS 系统菜单的「编辑→撤销」在按键到达界面前将其拦截，导致任何输入框按 Cmd+Z 均无反应；现调整应用菜单（保留剪切/复制/粘贴/全选与键盘全屏），撤销/重做由界面内建的逐框撤销历史接管（每框独立 200 步，Cmd+Shift+Z 重做）。

</details>

<details><summary>生图"Load failed"假失败根治</summary>

慢速生成（如 4K）超过约 60 秒时，此前界面会先报错而实际图片已在后台生成完成；任务化后不再存在该长连接，生成多久都不会误报。

</details>

- 生成图片下方不再重复显示提示词全文。

</details>

<details>
<summary><b>v0.2.342</b>(2026-08-25)· 新增 2 条 · 修复 3 条</summary>

**新增**

<details><summary>权限档位切换失败如实反馈</summary>

切换档位被 Claude CLI 拒绝时（如「自动」档受账户/模型限制），界面立即回滚到原档位并显示 CLI 的原始错误说明，不再停留在未生效的档位上造成误解；切换等待期间再次改选新档位时，以最后一次选择为准。

</details>

<details><summary>档位生效对账</summary>

会话启动时核对 CLI 实际生效的权限档位，与所选不一致（如「自动」被静默降级）会在消息流中提示，并提供「改用实际档位」一键按钮。

</details>

**修复**

<details><summary>Windows 兼容加固</summary>

皮肤 zip/文件夹内夹带 Thumbs.db、desktop.ini 等系统隐藏文件不再导致导入失败（两种导入方式判定完全一致）；插件安装在企业代理网络下不再误判代理不可用；草稿附件恢复在 Windows 大小写不敏感路径下不再失配。

</details>

<details><summary>「放任」档位说明纠正</summary>

该档位跳过的是权限确认卡（工具直接执行），AI 的提问卡（AskUserQuestion）仍会正常弹出——此前的文字表述有歧义。

</details>

- 「改用终端更新」通道同步清除失效代理设置，与应用内更新链路一致。

</details>

<details>
<summary><b>v0.2.341</b>(2026-08-25)· 修复 2 条</summary>

**修复**

<details><summary>皮肤标题栏改为顶格靠左（终版）</summary>

按最终确认的验收标准，Windows XP／初音未来／QQ2008 的标题栏图标与标题贴左边缘显示（经典窗口形态，左边距 5-8 像素），不再与下方 CC-GUI 图标做位置联动；此前四个版本的自动对齐机制随之停用。

</details>

- QQ2008 皮肤停用后在页面残留标题栏文字：卸载流程中的一处脚本错误导致清理中断，已修复（导入皮肤即时生效）。

</details>

<details>
<summary><b>v0.2.340</b>(2026-08-25)· 修复 2 条</summary>

**修复**

<details><summary>皮肤标题栏对齐第三版（根治）</summary>

此前的自动校准在部分系统 WebView 的界面缩放下仍偏移——不同引擎版本报告坐标的口径不一致。现改为运行时实测换算系数（不再对任何引擎口径做假设），并加固触发时机（字体加载完成、界面结构变化、装载后三秒内定时复查均会重校）；校准结果写入本机诊断日志，便于后续核对。三套内置皮肤与导入的 QQ2008 同步更新。

</details>

<details><summary>导入不合规皮肤时给出可行动的原因</summary>

如导入 dsh 皮肤库格式的文件夹，会明确说明该格式与本应用不通用及可行路径（AI 生成器产出 / 移植改写），不再只报「skin.json 校验失败」。

</details>

</details>

<details>
<summary><b>v0.2.339</b>(2026-08-25)· 新增 2 条 · 修复 1 条</summary>

**新增**

<details><summary>皮肤支持文件夹导入</summary>

「导入皮肤」新增「导入文件夹…」，直接选中 AI 产出或自己整理的皮肤目录（须含 skin.json，≤30MB），与 zip 导入走完全相同的三道安全校验；仅在支持目录选择的系统上显示该按钮。

</details>

<details><summary>AI 提示词生成器页面内显示全文</summary>

不再只有复制按钮，页面下方可直接翻阅完整提示词内容。

</details>

**修复**

<details><summary>皮肤标题栏与 CC-GUI 图标对齐改为自动校准</summary>

此前按固定数值对齐，在不同界面缩放、窗口布局下仍会偏移（缩放 1.2 实报）；现改为运行时测量实际位置自动校正，任何缩放与布局下均对齐，窗口变化时自动重校。导入的 QQ2008 皮肤同步处理，并换用官方经典企鹅标志（个人本地使用）。

</details>

</details>

<details>
<summary><b>v0.2.338</b>(2026-08-25)· 修复 2 条</summary>

**修复**

<details><summary>皮肤卡片恢复一行两个的整齐排列</summary>

此前内置皮肤与导入皮肤是两个独立网格，各自留下单卡孤行；现合并为同一个两列网格，卡片上的「T2 内置 / T2 代码」徽标继续区分来源。

</details>

<details><summary>皮肤标题栏图标与下方 CC-GUI 图标对齐</summary>

（Windows XP、初音未来）：按实际测量校准左边距（原偏右 19 像素）。导入的 QQ2008 皮肤同步对齐，并把企鹅图标重绘为经典样式（黑身白肚红围巾黄嘴脚）——导入皮肤的改动即时生效，无需更新版本。

</details>

</details>

<details>
<summary><b>v0.2.337</b>(2026-08-24)· 修复 1 条</summary>

**修复**

<details><summary>Windows XP 皮肤点「试穿」后整个界面冻死（必须强退）根治</summary>

0.2.336 的诊断记录 + 冻结现场的引擎调用栈快照锁定真凶——皮肤的「选中行高亮同步」在页面变化监听回调里执行无效的样式类移除，部分版本的系统 WebView 对这种无效移除也会重写属性，从而反复触发同一监听器形成无限循环（Chrome 与新版 WebView 无此行为，故此前难以复现）。现改为状态一致时零写入，循环无从形成。其他内置皮肤经排查无同类模式。

</details>

</details>

<details>
<summary><b>v0.2.336</b>(2026-08-24)· 修复 2 条</summary>

**修复**

- 皮肤加载失败不再静默：试穿/应用失败时界面直接说明原因（如需先开启开发者皮肤开关、脚本未通过安全校验）。

- 为排查「Windows XP 皮肤点试穿后整个界面卡死」新增皮肤加载全程诊断记录（仅记录在本机日志，加载每一步与三项界面响应探针，皮肤停用即清理）。复现一次即可定位卡死环节。

</details>

<details>
<summary><b>v0.2.335</b>(2026-08-24)· 修复 3 条</summary>

**修复**

<details><summary>Windows XP 皮肤会把界面卡死</summary>

皮肤脚本此前监听整个页面的任何变动并每次全页扫描，长会话流式输出时主线程被吃满、点什么都没反应。现改为平时零开销、只在侧栏被重建时工作，标题栏/任务栏/状态栏等效果不变。

</details>

<details><summary>Windows XP 皮肤下「主题与外观」弹层白底白字不可读</summary>

顶栏的白字规则连带刷到了弹层。现弹层配 XP 米灰底深字（明暗两态齐），分屏数量弹层一并修复。

</details>

- 顶栏「远程」按钮与「主题」「设置」不同高：改为同款竖排图标加文字，禁用与激活两态都对齐；手机端菜单里的样式不受影响。

</details>

<details>
<summary><b>v0.2.334</b>(2026-08-24)· 修复 2 条 · 优化 2 条</summary>

**修复**

<details><summary>同时装有原生版与 npm 版 claude 时，更新提醒不再被"没在用的那份"误触发</summary>

提醒改为只按当前在用的 claude 自己的渠道比较版本（原生装的只跟原生渠道比，npm 装的只跟 npm 仓库比）。此前显式选过更新渠道后，会拿另一条渠道的最新版来比，两边发版有时间差就一直亮红点。

</details>

<details><summary>DeepSeek 识图模型的图片不再被剥除</summary>

deepseek-v4-flash-vision-exp 等识图模型经 openai 协议的中转/聚合商使用时，图片此前会按"DeepSeek 全系不识图"的旧结论被替换成文字占位（该结论已实测过时，官方两种接口现均支持识图）；聚合商 `deepseek/模型名` 的命名空间形态同样放行。非识图的 DeepSeek 模型维持原有保护。

</details>

**优化**

<details><summary>选择更新渠道 = 同时切换 GUI 使用的 claude</summary>

在设置里选定 npm 或原生渠道后，GUI 起会话、版本检查、执行更新都使用该渠道的安装；所选渠道未安装时提示并继续使用现有安装；清除渠道选择不影响手动指定的安装。

</details>

- 设置页更新区显示当前检测对象（安装方式与路径），两份安装并存时可直接看出提醒说的是哪一份。

</details>

<details>
<summary><b>v0.2.333</b>(2026-08-24)· 修复 4 条 · 优化 1 条</summary>

**修复**

<details><summary>GUI 内更新失败不再清掉已装的 claude</summary>

（Windows 实报：更新中断或网络慢时，npm 与原生安装的 claude 被清空，需要整个重新下载）：更新超过 8 分钟只提示「仍在下载，可能是网络较慢」，不再强行终止安装进程——强行终止正是把安装目录留成半成品的来源；60 分钟仍未完成才停止，并给出两条出口（重跑一次更新即可补齐 / 确认代理已开或改用终端更新）；更新期间可随时手动取消；检测到已失效的代理配置时不再传给安装进程（此前会让下载必然失败进而触发超时强杀）。

</details>

<details><summary>0.2.332 三处未完全生效的修复补齐</summary>

计划卡在部分路径仍会重复叠加；回合进行中发送大图仍可能被拒收；目标条的 ×N 次数徽标丢失。均已修复。

</details>

<details><summary>插件错误提示的密钥遮盖补齐两类遗漏形态</summary>

全小写/全大写连写键名（如 apikey=、ACCESSTOKEN=）与夹不可见字符（零宽空格、变体选择符等）的键名此前会明文透出，现在一律遮盖为 [REDACTED]；monkey 等以 key 结尾的普通单词不受影响。超长错误输出被截断时不再可能把密钥劈在切口上露出尾巴。

</details>

- 插件输出中超长且无终止符的终端控制序列此前可能让后端卡住几十秒（期间界面整体无响应），现已限界处理，2MB 级输入毫秒内完成。

**优化**

- 开发模式下 dev 服务器的文件访问范围收窄到必要目录；附件与草稿的本地存储目录权限收紧为仅当前用户可访问（均不影响安装版使用）。

</details>

<details>
<summary><b>v0.2.332</b>(2026-08-24)· 新增 1 条 · 修复 6 条</summary>

**新增**

<details><summary>首页新建会话支持附件</summary>

附件按钮与权限模式、项目文件夹并列，支持多文件、仅附件发送、失败重试，并在首条消息中显示附件卡片。

</details>

**修复**

<details><summary>目标条、已批准计划和待办跨会话串显</summary>

状态按会话与内容身份隔离；目标条或计划卡隐藏后切走再切回仍保持隐藏，不同计划不再重复叠加，已批准计划可正常展开与收起。

</details>

<details><summary>工具页默认插件全部安装失败</summary>

插件安装与市场刷新统一采用 Claude CLI 的 120 秒预算，自动剔除失效代理、保留可用代理并优先使用本地缓存；失败提示经过脱敏、限长并给出可重试状态。

</details>

<details><summary>附件卡片刷新后丢失</summary>

附件元数据加入持久恢复队列与服务端原子写入，断网、重启和并发发送后会安全重试。

</details>

<details><summary>计划卡在输入框上方越叠越多</summary>

输入框上方只保留已批准的计划。待审查的计划由审批弹窗负责，被驳回的不再留卡，同一轮反复修改计划不会堆出多张卡片。

</details>

<details><summary>回合进行中发送大图被拒收</summary>

排队消息只保存有界的附件预览，超出本地存储预算的图片改为记录文件信息，界面预览不受影响。

</details>

<details><summary>目标提示不再进消息流</summary>

目标钩子的「未达成，已自动继续」改在目标条上显示 ×N 次数徽标，不再逐轮刷屏。

</details>

</details>

<details>
<summary><b>v0.2.331</b>(2026-08-22)· 修复 1 条</summary>

**修复**

<details><summary>隐藏计划卡后切会话再切回又出现</summary>

计划卡隐藏状态改为按“会话 + 计划全文”持久化，切走再切回保持隐藏；批准新计划时自动恢复显示。

</details>

</details>

<details>
<summary><b>v0.2.330</b>(2026-08-22)· 修复 2 条</summary>

**修复**

<details><summary>计划卡/目标条互相影响、点击无法展开</summary>

根因是 TodoPanel 与 GoalBar 作为兄弟节点使用了相同 React key，导致 React 错误复用/重挂。现在改为唯一 key；并移除客户端计划卡全局单例，只保留服务端同计划折叠作为去重层，计划卡恢复可点击展开。

</details>

<details><summary>目标条隐藏后切会话仍出现</summary>

隐藏状态按会话持久化并显式同步，切走再切回保持隐藏；新目标出现自动显示。

</details>

</details>

<details>
<summary><b>v0.2.329</b>(2026-08-22)· 修复 2 条</summary>

**修复**

<details><summary>目标条隐藏状态跨会话失效</summary>

隐藏状态按会话持久化并绑定具体目标，切走再切回仍保持隐藏；新目标出现自动恢复显示，并提供“显示目标条”恢复入口。

</details>

<details><summary>计划卡展开/可见性</summary>

计划卡只让当前活动窗格持有，避免非活动窗格抢走渲染权导致不可见或不可点击。

</details>

</details>

<details>
<summary><b>v0.2.328</b>(2026-08-22)· 修复 2 条</summary>

**修复**

<details><summary>两个会话计划卡串显</summary>

计划卡全局单例改为按“会话/窗格标识 + 计划全文”隔离，不同会话的同名计划不再互相串。

</details>

<details><summary>目标条完成后无隐藏入口</summary>

目标已达成/已清除时增加隐藏按钮，可手动收起常驻目标条；新目标出现时自动恢复显示。

</details>

</details>

<details>
<summary><b>v0.2.327</b>(2026-08-22)· 修复 2 条</summary>

**修复**

<details><summary>目标条/计划卡流式中途消失</summary>

目标条在历史未落定前继续使用乐观态，避免回复正文阶段消失；计划卡增加流式工具调用扫描，批准后尽早显示在输入框上方。

</details>

<details><summary>计划卡展开恢复</summary>

计划卡单例改为只让当前活动窗格持有，修复点击无法展开的问题。

</details>

</details>

<details>
<summary><b>v0.2.326</b>(2026-08-22)· 修复 1 条</summary>

**修复**

<details><summary>新建会话页面缺少权限模式选择</summary>

首页新建会话输入区补回权限模式按钮，新建会话时会把你选的模式带到新会话。

</details>

</details>

<details>
<summary><b>v0.2.325</b>(2026-08-22)· 修复 1 条</summary>

**修复**

<details><summary>计划卡重复叠加再次出现</summary>

改为按“计划全文”全局单例，同一份已批准计划无论来自哪个渲染路径都只保留一张可交互卡，避免多张计划卡叠在输入框上方。

</details>

</details>

<details>
<summary><b>v0.2.324</b>(2026-08-22)· 修复 4 条</summary>

**修复**

<details><summary>目标条/计划卡/待办卡在输入框上方常驻叠加</summary>

目标条现在吸附在输入框上方，像已批准计划和待办一样不会因滚动消失；达成、清除后也会保留最近状态，方便随时回看。

</details>

<details><summary>目标完成结果不再重复刷在消息流末尾</summary>

目标状态只由输入框上方的常驻目标条展示，会话流里不再插入“目标达成/未达成”提示，避免重复占屏。

</details>

<details><summary>计划卡展开恢复</summary>

修复点击“已批准的计划”无法展开的问题。

</details>

- 同计划只保留一张“已批准的计划”卡，避免计划卡重复叠加。

</details>

<details>
<summary><b>v0.2.323</b>(2026-08-21)· 修复 2 条</summary>

**修复**

<details><summary>/goal 目标模式 + 规划模式组合下消息区被刷屏</summary>

目标未达成被强制续跑的每一轮都会重复产生同一份「已批准的计划」卡和一条「目标未达成」提示，按停止后一次性全部冒出，重启也消不掉。现在同一份计划只保留一张卡，连续的未达成提示折叠成一条并带次数徽标（如「×12」），达成的最后一条始终单独显示。

</details>

- 待办事项同族问题：目标强制续跑多轮时，同一个任务可能被重复创建出很多条，现在按任务主题去重。

</details>

<details>
<summary><b>v0.2.322</b>(2026-08-21)· 修复（第二轮交叉审查发现的回归，含四条严重项） 10 条 · 优化 1 条</summary>

**修复（第二轮交叉审查发现的回归，含四条严重项）**

<details><summary>手机端权限弹窗死循环</summary>

手机刷新后点「允许」卡片消失、25 秒后又冒出来反复无常——补拉接口不给局域网设备下发一次性凭据，应答必被拒。现在已认证设备一律下发凭据（该凭据本来就通过实时推送下发给所有已认证连接，旧限制挡不住攻击者只打合法用户）。

</details>

<details><summary>「官方兼容清理」可能吃掉最后几条对话</summary>

修复会话文件时基准快照在拍摄前就已被读取，读取期间写入的新内容会被旧内容覆盖且备份也救不回。现在先拍基准再读取，期间有写入则放弃并提示重试。

</details>

<details><summary>导入皮肤会误删名字是前缀关系的另一套</summary>

（如导入「Whale」删掉已装的「Whale Song」）：同名覆盖的判定收窄为精确匹配或「名字+6 位随机后缀」形态。

</details>

<details><summary>Windows 上「精确计算上下文」永远失败</summary>

路径比对一侧小写一侧保留原样，Windows 必带大写盘符所以必不等；macOS 从 /tmp 打开的项目也中招。现在双侧同口径归一。

</details>

- 老 iPhone/iPad（iOS 16.4 以下）打开即白屏：皮肤脚本校验用了老浏览器不认识的正则语法，模块加载即炸，已换成等价兼容写法。

- 快速切换皮肤后重启会回到旧皮；「停用皮肤」可能顺手摘掉你自己换的主题设置；皮肤在激活期间你改的主题/字体不再被误回滚。

- 新建会话不再继承上一个会话的思考强度；draft 窗格里「添加到上下文」点了没反应（两处键名没跟上队列键改造）。

- 断网时本地缓存里已有的插件装不上（上一版把刷新市场放到了安装前且失败即中止）；现在先直接装，只有「找不到插件」时才刷新市场重试。

- 手机隐藏项目后桌面侧栏仍显示，且桌面再操作会覆盖手机刚做的隐藏：隐藏状态双轨合一，以服务端为准实时同步。

- 第三方 Provider 的上下文占用数字是估算时，界面如实标「估算」而非「精确」。

**优化**

- 设定 /goal 目标后常驻条立即出现（此前要等首个回合结束）。

</details>

<details>
<summary><b>v0.2.321</b>(2026-08-21)· 新增 2 条 · 优化 1 条</summary>

**新增**

<details><summary>目标常驻条</summary>

会话设有 /goal 目标时，输入框上方常驻一条「目标进行中」胶囊，可直接点「编辑」改写目标条件、或「清除」移除目标（此前只能在顶栏看、改目标要手打命令）。顶栏的小徽章随之退役。

</details>

- 目标条与任务清单、已批准的计划同时在时，在输入框上方上下叠加显示，互不覆盖。

**优化**

- 任务清单栏的展开/折叠选择记住本设备：手动展开后换会话、刷新、分屏都保持你的选择（默认仍是折叠）。

</details>

<details>
<summary><b>v0.2.320</b>(2026-08-21)· 近期新功能回顾（公开版用户可见的第一版） 5 条 · 修复 8 条 · 优化 2 条</summary>

**近期新功能回顾（公开版用户可见的第一版）**

<details><summary>皮肤系统</summary>

导入 zip/.cguiskin 皮肤包或粘贴皮肤 JSON，三道安全校验（解包/SVG/脚本）；皮肤面板可直接复制「让 AI 生成皮肤」的提示词。本版起内置三套移植自 dsh 皮肤库的完整皮肤：初音未来、Windows XP、鲸歌（皮肤面板顶部「内置皮肤」区，T2 带界面改造，需开启开发者皮肤开关）。

</details>

<details><summary>自定义称呼</summary>

设置 → 通用里的「称呼」，首页问候会变成「下午好，{你的名字}」；皮肤的问候语模板也能引用它。多端共享。

</details>

<details><summary>自定义生图</summary>

与文本 Provider 完全分开的独立配置（设置坞 → 生图），支持 OpenAI 图像接口 / Gemini 图像接口 / 以 chat 接口返回图片的中转三种形态；出图自动落盘并在界面预览。

</details>

<details><summary>第三方 Provider 余额显示</summary>

用量面板自动探测各家额度，余额偏低时入口标红点；OpenRouter 等可单独填「额度查询密钥」。

</details>

<details><summary>思考强度按模型自适应</summary>

每个模型可选的思考档位以实测数据表为准，不再一刀切。

</details>

**修复**

- 新建会话后，项目文件夹的会话列表里看不到这条新会话（要手动折叠再展开或等很久）；现在转正后立即刷新，展开已加载过的项目组也会重新拉取。

- 在会话里使用 /clear 后：会话列表不再冒出标题为「/clear」的空会话；界面恢复显示「会话已清空」而不是 "(no content)"。并适配 Claude Code 2.1.x 的 /clear 语义（实际是轮换一个新会话）：窗格会跟随绑定到新会话，不会再把旧上下文带回去。

- 分屏时，聚焦一个没有会话的空白窗格，点侧栏项目的「+」现在会在该窗格打开新建会话页（此前毫无反应）。

- 有会话正在窗格中打开的项目不允许隐藏，会弹窗提示先关闭窗格（此前隐藏后窗格里还挂着会话）。

- Windows 安装插件全部报 "not found in marketplace"：根因是插件市场刷新失败被静默吞掉（git 不读 Windows 系统代理设置）。现在自动检测系统代理并注入刷新过程，失败时展示真实原因与手动修复指引，安装前自动先刷新一次再重试。

- QQ2008 等 T2 皮肤只剩配色、界面改造丢失：脚本静态校验误杀了正常的 function 写法，已修正（`prefetch(` 等也不再误伤）。

- 皮肤快速切换不再串皮；停用皮肤不再把期间换过的主题/字体改回去；macOS Finder「压缩」的 zip 包可以正常导入皮肤。

- Windows 覆盖安装时安装器现在能正确结束旧版进程。

**优化**

- Windows 崩溃取证：server 进程异常退出、前端 JS 报错现在都会写入日志文件（`~/.claude-gui/` 下的 tauri-startup.log / crash.log / client.log，超 5MB 自动滚动）；macOS 上渲染进程崩溃会自动重载恢复。下次遇到闪退，把这些日志发给我们即可定位。

- 回合刻度簇限高居中：回合再多也不会顶着标题行。

</details>

<details>
<summary><b>v0.2.319</b>(2026-08-21)· 优化 3 条 · 修复 10 条</summary>

**优化**

- 侧栏冷启动后立即加载全部已展开项目的会话组。此前只加载上次聚焦的项目，其余展开组要等有文件变动、或手动折叠再展开才显示。

- 回合刻度簇限高居中：回合再多也不会顶着标题行，始终在标题行与输入框之间居中、上下留白。

- 启动预热的注释与实现对齐（并发 4 路），隐藏项目的展开组不再被后台轮询反复拉取。

**修复**

- 队列与发送：首页发送后立即刷新或关页时，残留的排队消息不再被下一个同项目新会话继承并自动发出；「取回为新消息」留下的占位槽不再卡死整条队列；切走再切回会话不再把「已并入」误报成「无法确认」而暂停队列。

- 侧栏：拖拽排序不再丢失已隐藏项目的手动排位；隐藏项目状态多端实时同步；全局搜索不再命中已隐藏项目；平铺模式置顶会话前置且列表不再持续整体重渲；命令行改的会话标题即时刷新；关页时的待删会话能真正删除；撤销删除恢复到正确窗格。

- 更新：原生安装选 npm 渠道会先说明并确认，不再"更新成功但没生效"；失效的系统代理设置不再拖死更新；镜像兜底源的版本号与下载链接一致并给出指引；渠道可恢复"跟随安装方式"；新版安装包的自动清理恢复生效（改名后一度失效）；关闭面板再打开能拿到更新结论。

- 权限提示：仓库所有权存疑、磁盘满等不再误报为"系统拒绝访问"；单个项目拒访不再染红其他项目；整个会话目录被拒时明确说明原因而非显示"没有找到项目"；日文/繁中 Windows 的拒绝访问也能正确识别。

- 皮肤：快速切换两个皮肤不再串皮；停用皮肤不再把激活期间换过的主题/字体改回去；Finder"压缩"产出的 zip 可正常导入；重复导入同名皮肤改为覆盖而非产生重复条目；他端删除皮肤后本端自动卸下；支持直接粘贴 skin.json 文本导入。

- 生图与额度：生图请求不再跟随重定向；上游超大响应限量读取；同名图片并发保存不再互相覆盖；OpenRouter 未设花费上限时如实说明而非显示"无限"；修改接口地址后额度缓存立即失效；额度查询失败显示错误卡而不是整卡消失；低额度红点不再抖动。

- 模型与思考强度：切换 Provider 后徽章不再残留旧 Provider 的模型；手机端的模型与力度显示与桌面同一条解析链；手机端也会记住每个模型的力度选择；非思考模型在边界情况下不再被下发思考档位。

- 安全：界面授权弹窗的应答需一次性凭证，本机其他进程无法仿冒"允许"；局域网监听模式下不能清空访问密码；Provider 配置文件落盘权限收紧为仅本人可读；额度查询与生图强制 https（本机回环除外）；T2 皮肤脚本的静态校验补上三种绕过形态。

- 会话修复与翻译：修复会话文件期间若有新消息写入，修复会放弃并提示重试而不是覆盖新内容；并行工具调用的历史切到 OpenAI 协议中转时不再被插入假桩；上下文"精确计算"回落为估算时如实标注，含图片会话的估算不再虚高数十倍；DeepSeek 思考模型的思考过程在界面正常显示；修复备份只保留最近 5 份。

- 其他：称呼里的 emoji 不再被截成乱码；问候语时段随时间自动刷新；Windows 安装器在覆盖安装前能正确结束旧版进程。

</details>

<details>
<summary><b>v0.2.318</b>(2026-08-20)· 优化 2 条 · 修复 8 条</summary>

**优化**

- 启动变快：此前应用启动时会在后台预读最近 16 个项目的会话列表，其中包含用户已在侧栏隐藏、界面上并不显示的项目。同时读取文件的并发数与系统后台线程数相同，导致该过程占满通道，用户正在等待的那次加载反而被排到后面。现在只预读可见项目（上限 8 个），实测预热耗时由 2596 毫秒降至 379 毫秒。

- 新建会话的默认工作目录跟随当前聚焦的窗格：分屏时在一个窗格中打开某项目的会话、于另一窗格新建，默认目录取前者所属项目。正在窗格中打开的项目即使已被隐藏也照常作为默认目录（与侧栏"正在使用的项目始终可见"一致）。

**修复**

- 平铺显示模式下会列出已隐藏项目的会话：隐藏操作不清除已加载的数据，而平铺列表此前不做隐藏过滤。现在拉取与显示使用同一份可见项目集合。

- 系统拒绝访问会话目录时，侧栏持续显示"加载会话…"且不出现任何说明；平铺模式下则显示为"暂无会话"，与真的没有会话无法区分。现在两种显示模式都明确说明原因，并提供打开系统设置的按钮（仅 macOS 提供该面板；Windows 与 Linux 显示对应的处理步骤）。

- 生图下载的地址校验放行了全部环回地址：上游返回指向本机任意端口的图片链接时，服务端会主动请求。现在仅当该链接与用户填写的接口地址同源时才放行，接入本机图像服务不受影响。

- 生图配置文件（含明文密钥）未列入受保护文件名单，可经通用文件接口读取与改写。已列入。

- 打开"更新 Claude Code"面板时可能在无确认的情况下启动一次全局安装；多端同时打开或连续点击会并发启动两次安装。现在续看进度与启动安装分为两个入口，并在解析安装方式前先占位。

- 网络不可达、使用旧缓存时，Claude Code 更新检查仍显示"已是最新版本"。现在明确说明本次未查询成功及缓存时间。

- 所有项目均被隐藏时，平铺模式的空白提示与分组模式不一致。

- 启动时从本地存储恢复的窗格焦点未按当前窗格数量夹紧，可能指向不存在的窗格。

</details>

<details>
<summary><b>v0.2.317</b>(2026-08-20)· 生图（设置坞 → 生图） 5 条 · 皮肤（主题与外观 → 皮肤） 6 条 · 称呼（设置 → 通用 → 称呼） 3 条 · 修复 1 条</summary>

**生图（设置坞 → 生图）**

- 与文本 Provider 完全分开，独立增删改；配置存 `~/.claude-gui/image-providers.json`，不写入 `settings.json`。

- 支持三种上游形态：OpenAI 图像接口、Gemini 图像接口，以及以 chat 接口返回图片的中转。

- 每个生图 Provider 各自填写接口地址、密钥、模型、尺寸与保存目录。保存目录必须是已存在且可写的绝对路径，三种不合规情况分别提示。

- 出图后自动落盘到该目录并在界面内预览，可在系统文件管理器中定位该文件。密钥不回显。

- 本功能在 0.2.313 落地，此前更新说明中只有一行概述。

**皮肤（主题与外观 → 皮肤）**

- 导入 zip / `.cguiskin` 皮肤包，或直接粘贴 `skin.json` 文本导入；可随时删除。

- 两种层级：T1 声明层只含 `skin.json` 与图片资源（颜色、圆角、阴影等 41 个变量，明暗各一套背景图）；T2 允许附带脚本，载入前经静态校验。

- 皮肤经 `data-cgui` 语义锚点定位界面元素（首批 40 个）。锚点承诺跨版本稳定，不依赖会随重构变动的类名。

- 面板内可复制 AI 提示词：把可用变量、图标语义名与锚点清单生成为一段提示词，交给 AI 直接产出皮肤包。

- 安全限制：解包前按清单拒绝符号链接、硬链接与路径穿越，并限制条目数与体积；SVG 按白名单清洗，拒 `script` 与外链；带脚本的皮肤经静态校验后才载入。

- 本功能在 0.2.289 落地。更新说明自 0.2.309 起才开始记录，因此此前从未介绍过。

**称呼（设置 → 通用 → 称呼）**

- 首页问候使用的名字，如「下午好，张三」。最多 20 字符，置空则显示默认文案。

- 存于服务端，所有设备共享。皮肤的问候模板可用 `{name}` 占位符引用它。

- 本功能在 0.2.289 落地，此前从未在更新说明中介绍过。

**修复**

- Windows 上「系统拒绝访问该文件夹」既认不出也指错地方：git 在 Windows 报的是 `Access is denied`（中文版「拒绝访问」），此前的判据一条都不匹配，会落进「未知错误」并显示无法据以操作的原始报错；即使匹配，给出的也是 macOS 的「完全磁盘访问」路径，而该设置面板在 Windows 上不存在。现在按平台分别给出处理步骤（Windows 指向「受控文件夹访问」与文件夹权限，Linux 指向属主与挂载状态），「打开系统设置」按钮仅在确有面板可跳转时显示。涉及 git 初始化、git 状态检测、会话列表三处。

</details>

<details>
<summary><b>v0.2.316</b>(2026-08-20)· 移除 1 条 · 修复 1 条</summary>

**移除**

- 上下文注入显示（0.2.314 引入）：实际使用中每一项各占一行堆在输入框上方，且不随回合结束消失；其中多数条目是 hook 输出而非有意义的注入内容。已整块移除。

**修复**

- 初始化 git 仓库失败时只显示 `Command failed`：超时、未安装 git、系统拒绝访问三种情况的原始错误信息完全相同，无法据此判断该做什么。现在分别说明原因，并给出对应的处理方式。

</details>

<details>
<summary><b>v0.2.315</b>(2026-08-20)· 修复 3 条</summary>

**修复**

- 在未安装代理的机器上切换 provider 报「无法解析 baseURL 主机名」：切换 provider 是纯本地操作，不应因一次 DNS 解析失败而被拒绝。解析不到的主机名后续请求本就发不出去，不构成安全风险；指向内网地址的仍然拒绝。

- 未提交 git 仓库的提示横幅在侧栏中被挤成竖排一列：改为文字与按钮分行显示，完整说明移至悬停提示。

- 系统拒绝磁盘访问时，会话列表显示为「暂无会话」，与真的没有会话无法区分：现在明确提示无法读取会话目录、会话文件没有丢失，并给出开启「完全磁盘访问」的路径。

</details>

<details>
<summary><b>v0.2.314</b>(2026-08-19)· 新增 4 条 · 修复 3 条</summary>

**新增**

- 上下文注入显示：每回合列出本次注入了哪些内容（CLAUDE.md / skills / agents）。数据取自本机代理层的真实请求，只显示分类不显示正文；使用官方订阅时请求不经过本机代理，因此不显示。

- 更新说明弹窗：安装新版打开后展示本次更新内容，完全离线（说明随安装包一起打包，不联网获取）。同时存在 Claude Code 更新提示时，本弹窗在其上层，关闭后再显示下层提示。设置 → 通用 → 「查看更新说明」可随时翻阅历史版本。

- Provider 额度查询密钥（可选）：OpenRouter 填入 management key 后可读取账户余额，不填时仅能读取该密钥的花费上限；MiniMax 的套餐额度接口可能要求订阅密钥。其余 provider 无需填写。

- 工具面板改为选项卡：MCP 服务器 / 插件 / 外部项目分页显示，不再纵向堆叠。页签选择记录在本设备。

**修复**

- 额度卡片在更换密钥后最长两分钟才生效：缓存与失败冷却此前只按 provider 区分，不识别密钥变化。现在换任一把密钥立即失效重查。

- 额度查询密钥超长时静默截断，导致该密钥永远认证失败且不提示原因。现在明确报错。

- 上下文注入的未知分类曾以首行内容作为标签，可能带出文件路径或消息正文。现在仅保留符合样板句特征的英文片段，其余显示为固定标签。

</details>

<details>
<summary><b>v0.2.313</b>(2026-08-19)· 新增 2 条 · 修复 1 条</summary>

**新增**

- 自定义生图面板：支持 OpenAI / Gemini / chat 三种同步协议；逐 Provider 填写接口地址、密钥、模型、尺寸与保存目录，出图自动落盘并在界面内预览，可在文件管理器中定位；生图配置独立存放于 `~/.claude-gui/image-providers.json`，不写入 `settings.json`。完整说明见 0.2.317 的「功能介绍」

- 第三方 provider 的余额与额度显示：探测式查询，结果进用量面板新卡片，额度偏低时在入口标红点

**修复**

- 生图与额度两条新链路的守卫补齐：出站地址加 SSRF 校验、OpenRouter 返回空条目不再被当成「额度为 0」、鉴权头透传的盲区补齐

</details>

<details>
<summary><b>v0.2.312</b>(2026-08-19)· 修复 1 条</summary>

**修复**

- 切换 provider 后模型徽章仍显示旧 provider 的模型，点开列表里却找不到这个模型

</details>

<details>
<summary><b>v0.2.311</b>(2026-08-19)· 优化 1 条</summary>

**优化**

- `max` 档折算改为按模型实测档位。原先一刀切降到 `xhigh`，使 `max` 档在多数中转站白给

</details>

<details>
<summary><b>v0.2.310</b>(2026-08-19)· 新增 1 条 · 修复 5 条</summary>

**新增**

- 思考强度按模型自适应：档位来源从家族正则换成与 dsh 同源的实测数据表

**修复**

- 思考强度自适应对真实用户零生效：读侧补上兜底预填，目录查询剥掉命名空间前缀

- 档位编辑器保存时不再清空用户手写的声明；能力表变化时自动回落

- 补齐数据表快照之后发布的模型档位（glm-5.3 / qwen3.8-max）

- Windows 兼容：生成脚本的动态 import 改用 file URL；数据表加载失败不再静默吞掉

- 手机端接上档位过滤，此前该问题在手机上原样存在

</details>

<details>
<summary><b>v0.2.309</b>(2026-08-19)· 修复 1 条 · 优化 1 条</summary>

**修复**

- 回合刻度指针在装机版（WKWebView）里位置偏移：按两内核的混合坐标口径重新换算，真机取证定案

**优化**

- README 主图更新到 CC-GUI 现状，改为展开设置坞的形态，面板一览无余

</details>

<!-- CHANGELOG:END -->

---

## 致谢

- **[cc-switch](https://github.com/farion1231/cc-switch)**(作者 [farion1231](https://github.com/farion1231))—— 优秀的 Claude Code 多 Provider 配置管理工具。CC-GUI 的「从 cc-switch 一键导入 Provider」功能与它对接,Provider 管理的设计也从中受益良多,特此感谢。

---

## 许可证

MIT,见 [LICENSE](LICENSE)。

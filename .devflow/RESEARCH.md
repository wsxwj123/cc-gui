# RESEARCH — 已完成调研结论(4 份独立代理 + 主会话代码核查)

方案代理据此出方案,不必重复调研已定论的根因;可自行复核代码。

## #1 ⋮ 菜单真机无反应(根因确定级)
- **根因**:文件浏览器面板挂在 `App.jsx:934` 的 `animate-glass-rise` 容器,该动画 `fill-mode:both` 收尾残留 `transform: translateY(0) scale(1)`(`index.css:1218-1226`)。非 none 的 transform 使该容器成为后代 `position:fixed` 的**包含块** → ⋮ 菜单的 `fixed inset-0` 遮罩被困在窄面板内、`absolute left:clientX` 用视口坐标叠加面板偏移 → 菜单飞出屏幕右界,看着"没反应"。
- **证据**:`FileExplorerPanel.jsx:386-422`(菜单块)、`:193-195`(onCtx 用 clientX/Y)。`App.jsx:6037-6038` 注释已写明"fixed inset-0 trick is trapped inside header's transform context";同项目 `App.jsx:6518` 上下文菜单已用 `createPortal(menu, document.body)` 逃逸——这是**已验证范式**,文件树 ⋮ 是漏网的一个。
- **修法**:`ctxMenu && createPortal(<遮罩+菜单>, document.body)` + `import { createPortal } from 'react-dom'`。改动不依赖 dev 能否复现(有无 transform 祖先都正确)。
- **注意**:dev Chromium 看着能弹是布局巧合(面板宽度/位置不同使坐标恰好落屏内),不是 Chromium 无此 CSS 行为。**真机验证是硬门**。
- **值得记 LEARNINGS**:任何 fixed/全屏遮罩弹层挂在 animate-glass-rise(或 fill:both 收尾非 identity 的动画)容器内,一律 portal 到 body。这是第三次踩(上下文菜单、模型菜单、文件树 ⋮)。

## #3 停靠预览冻结(根因确定级)
- **根因**:点停靠时把当前 code 字符串**按值拷进 store**(`ArtifactPreview.jsx:156-159` openDock → `sessionStore.js:761` openArtifactDock 整包存),停靠面板 `ArtifactDock`(`ArtifactPreview.jsx:249-257`)只读这份死快照;流式 token 只更新内联块(`MarkdownRenderer.jsx:104` 每 token 重渲),从不回写 store → dock 永久冻结。
- **现有可复用**:`useDebounced(code,300)`(`ArtifactPreview.jsx:70-77`)已实现"代码文本实时/iframe 渲染 300ms 节流"双节奏——正是用户要的。html/svg/mermaid 走 sandbox iframe srcDoc(`:136-143`)。可预览白名单 `PREVIEWABLE`(`:16`)= html/svg/mermaid。
- **推荐修法(方案 A)**:内联 ArtifactPreview 用 `useId()` 给自己稳定 id;openDock 时 payload 带 artifactId;store 加 `updateArtifactDockCode(id,code)`(id 匹配才浅合并);内联块 useEffect 在"自己被停靠"期间每次 code 变即回写 store。dock 读的 code 随之实时跟流。改 2 文件约 15 行。备选 B(用 messageId+blockIndex 当稳定身份,免组件重挂断链)留作 A 实测断链时的升级路径。
- **#2 内联折叠(与 #3 同区)**:`isDocked = store.artifactDock?.artifactId===本 id`;isDocked && !coexist 时内联主体切成折叠代码块,保留 toolbar 预览/代码/停靠按钮。coexist=true(文件浏览器停靠,静态)不折叠。
- **风险**:流式频繁 setState 性能(回写可加短路 code===prev 不 set);dock 是全局单例非 per-pane(`sessionStore.js:760`,分屏用 tabIndex 门控,`App.jsx:844-856`),沿用单例。

## #2 思考/工具折叠现状
- 思考块 `MessageBubble.jsx:330` showThinking 默认 false(已折叠),折叠头只显示通用"思考过程"+Brain 图标;展开显示全文。
- 工具卡 `ToolCallCard.jsx:48` expanded 默认 false(已折叠),折叠头已显示"工具名 + formatInput(input) 预览"(如 Read 某文件)。
- **缺口**:①思考折叠头无内容摘要(要显示思考首句/摘要);②无流式动态状态(要"正在思考…/正在读取 X")。方案代理定:摘要取 thinking 首行/前 N 字;动态状态需判断 message 是否流式中(streaming 标志来源方案代理查)。

## #4 项目/子代理会话涌入
- **根因**:GUI 与 Desktop/CLI 共用 `~/.claude/projects/<cwd哈希>/`(`session-reader.js:102` listProjects 扫全目录),Desktop 发消息即落 jsonl → GUI 列出。设计使然。
- 标题:GUI 用首条真实用户消息(`session-reader.js:835`),Desktop 用生成摘要。
- 一会话多条:子代理各写 jsonl。`session-reader.js` 已有 `isSidechain===true` 过滤(listSessions 循环内)+ subagents/ 子目录天然扫不到,但"某些编排工具写的辅助 jsonl 形态"可能漏网。
- **可做项(低优先)**:方案代理评估是否收紧过滤/是否用 Desktop 侧标题。谨慎:别误杀真会话。

## #5 worktree 可见性
- worktree 按钮=列出已有+新建二合一(`App.jsx:1976-1983` 按钮→openWorktreePicker `:1903`→`GET /api/worktree?cwd=项目path` `:1818-1832`;后端 `worktree.js:70-113` findGitRoot 向上找 .git 后 `git worktree list --porcelain`)。AI 建的 worktree 记在主仓 .git/worktrees/,list 位置无关必列全。**已能看到**。
- **唯一缺口**:弹层只在打开那刻拉一次(`App.jsx:1821-1827`),无实时刷新。修法:弹层加刷新按钮(复用 openWorktreePicker,前端一行)或 open 期间轮询。
- 副作用解释(非 bug):AI 在 worktree cwd 跑的会话因哈希不同,会作为独立项目出现在项目列表,不嵌主项目下(`App.jsx:1844` enterWorktree projectHash 用 worktree path 哈希)。

## #6 settings 外部改动同步
- 功能层:chatCompatKey 含 settings.json mtime → 下条消息自动生效(无需刷新)。
- 显示层:设置面板 `SettingsPanel.jsx:74` 仅 mount 时 fetch,有手动"重新加载"按钮(`:161`),无实时监听。
- 修法:后端 fs.watch(~/.claude/settings.json) → WS 广播"settings-changed" → 前端设置面板收到即重拉。注意去抖(编辑器保存可能多次触发)。已有 WS 基础设施(broadcast.js)。

## #7 图片放大预览(需方案代理补查现状)
- 待查:①输入框附件图片渲染在哪(ChatInput.jsx 附件卡片区);②已发送消息图片渲染在哪(MessageBubble.jsx 附件卡片 ~357 行,当前双击是"用默认 App 打开");③是否已有 lightbox 组件可复用。
- 需求:点击图片(输入框内 + 已发送)→ 放大预览(lightbox 覆盖层,点击关闭)。文件不预览(保持双击默认 App 打开)。注意:已发送消息附件当前是 onDoubleClick 打开默认 App——图片改成单击放大?还是保留双击打开+单击放大?方案代理给交互定义,卡点1 由用户拍板。

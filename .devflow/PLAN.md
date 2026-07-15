# PLAN — 第 221 轮实现方案(7 项)

起点 HEAD d94d5d1 · master · 仅前端为主,#6 后端已就绪。原则:最小改动、复用现有范式(createPortal / confirmDialog / useDebounced / broadcast WS),p5/three 本轮不做。

---

## #1 文件树 ⋮ 菜单真机无反应 — portal 逃逸

**改动文件**
- `client/src/components/FileExplorerPanel.jsx`
  - 顶部 import 加 `import { createPortal } from 'react-dom';`(该文件当前未 import)。
  - `:386-421` 的 `{ctxMenu && (<div className="fixed inset-0 …">…</div>)}` 整块用 `createPortal(<…>, document.body)` 包一层。

**实现要点**
- 根因已定论:面板挂在 `App.jsx:934` 的 `animate-glass-rise`,`fill:both` 收尾残留非 identity 的 `transform`,使该容器成为后代 `position:fixed` 的包含块 → `fixed inset-0` 遮罩被困在窄面板内,`absolute left:clientX`(视口坐标)叠加面板偏移飞出屏幕。
- 修法就是把遮罩+菜单渲染到 `document.body`,脱离 transform 包含块 → `fixed`/`clientX` 恢复视口语义。**这是本项目已验证范式**:`MessageBubble.jsx:259`、`App.jsx:6518`、`ArtifactPreview.jsx:225/332` 都这么做。
- `onCtx`(`:189-195`)已用 `clientX/Y` 且已做贴边收敛(`:193-194`),坐标逻辑无需动,只改渲染出口。
- 注意 `⋮` 按钮的触发入口(左键点击开菜单)已存在,本项只改菜单容器的挂载位置,不动触发逻辑。

**成本** ~5 行(1 行 import + 包一层)。

**风险/边界**
- WKWebView(真机)是唯一能真复现的环境;dev Chromium 看着能弹是坐标巧合,**不足以验收**。
- portal 到 body 后,菜单的 `z-40` 要确保高于同期可能存在的其他遮罩;现有其他 portal 菜单用更高 z(如 dock z-[200]),本菜单是瞬态点击态,z-40 够用但若真机被别的层压住需提到 z-50。
- 分屏:菜单坐标用全局 clientX/clientY,与哪个 pane 无关,portal 到 body 不影响 per-pane。

**验收要点**
- 真机(打包 app)文件树点某行 ⋮ → 菜单出现在 ⋮ 按钮附近(不飞出屏幕),含"添加到上下文 / 用默认 App 打开 / 删除"三项;点遮罩关闭。
- 根目录行 ⋮ 出"删除项目文件夹…"(危险确认流不变)。

---

## #2 思考块折叠增强(摘要 + 流式动态状态)

**改动文件**
- `client/src/components/TurnBubble.jsx`(主目标 — AI 回复的真实渲染器)
  - 有序 blocks 路径思考块 `:575-590`。
  - legacy 路径思考块 `:674-690`。
  - 流式指示器 `:718-724`(呼吸点)。
- `client/src/components/MessageBubble.jsx:398-413`(次目标 — 非 turn 类消息的思考块,历史/简单路径;为一致性同步改摘要,不涉及流式)。

**背景(核实结论)**
- `msg.type === 'turn'` → `TurnBubble`;user 及其他 → `MessageBubble`(`App.jsx:2644-2648`)。AI 流式回复走 **TurnBubble**,这才是 #2 主战场。
- 流式判据现成:`isLiveStream = turn.uuid === 'streaming'`(`TurnBubble.jsx:485`)。有序 blocks 数组在流式期间逐块累积,可读"最后一个 block"判断当前动作。

**实现要点**
1. **折叠摘要(替换通用"思考过程")**:抽一个纯函数 `thinkingSummary(text)` = 取思考正文首个非空行 / 首句,截断到约 60 字,去 markdown 标记。折叠 summary 从固定"思考过程"改为 `已思考 · {摘要}`(思考完成态);无摘要时回退"思考过程"。三处思考块(TurnBubble 两处 + MessageBubble 一处)共用该函数。
2. **流式动态状态**:仅 `isLiveStream` 期间,在气泡底部(替换/增强 `:718` 呼吸点)显示一行动态状态文字,由**流式 turn 的最后一个 block** 推导:
   - 最后 block 是 thinking 且仍在增长 → `正在思考…`
   - 最后 block 是 tool_use → 按工具名+入参映射:`正在读取 {file}` / `正在运行命令…` / `正在搜索 {pattern}` / `正在编辑 {file}` 等。**复用 `ToolCallCard.jsx:34 formatInput`** 取入参预览,配一个 `Read→正在读取 / Bash→正在运行 / Grep→正在搜索 / Edit,Write→正在编辑 / WebFetch,WebSearch→正在检索 / Task,Agent→正在派发子代理` 的动词映射表。
   - 最后 block 是 text → `正在回复…`
   - 无 block(刚连接) → 保留现有呼吸点(`isStreaming` 分支不动)。
   - 呼吸点保留,状态文字放其右侧(动画不变,只加文字)。
3. 折叠态思考块本身仍默认收起(`showThinking`/`<details>` 现状不动),只改 summary 文案。

**成本** ~40-60 行(1 个 summary 纯函数 + 1 个动词映射 + 状态行 JSX,三处接线)。

**风险/边界**
- 流式性能:动态状态每 token 重算"最后 block"。TurnBubble 已是 `React.memo`(`:424`),但流式 turn(uuid='streaming')本就每 token 重渲(它不在 memo 化的历史数组里),故 summary/状态计算搭车在既有重渲上,不新增渲染压力。摘要函数保持 O(取首行) 廉价,勿全文 scan。
- WKWebView/移动端:纯文字+现有动画,无新平台面。
- per-pane:状态挂在各自 turn 内,天然隔离。
- 边界:思考正文可能为空/极短/纯符号 → 摘要回退"思考过程";动态状态在 block 缺失时回退呼吸点,不得崩。

**验收要点**
- 折叠态思考条显示"已思考 · <首句摘要>"而非通用"思考过程";点开仍是全文。
- 流式进行中,气泡底部随当前动作切换文字:读文件时"正在读取 xxx"、思考时"正在思考…"、跑命令时"正在运行命令…";回复结束后状态行消失。
- 历史(非流式)turn 不显示动态状态行。

---

## #3 停靠预览冻结 + 内联折叠(与 #2 同区但不共享状态)

**改动文件**
- `client/src/components/ArtifactPreview.jsx`
  - `ArtifactPreview`(`:147-244`):内联组件加稳定 id + 停靠期间回写 code + isDocked 时主体折叠为代码块。
  - `openDock`(`:156-159`):payload 带 `artifactId`。
- `client/src/stores/sessionStore.js:760-762`:加 `updateArtifactDockCode(id, code)`。

**冲突澄清**:#2 改 TurnBubble/MessageBubble 的思考渲染;#3 改 ArtifactPreview/store 的 dock。**两者不共享任何 state**,同为"渲染层"但落在不同组件,无冲突。#3 的"内联折叠为代码块"是 BRIEF #3 需求本体,不是 #2 的延伸(#2 是思考块折叠),两条独立实现。

**实现要点(RESEARCH 方案 A)**
1. **稳定身份**:内联 `ArtifactPreview` 用 `useId()`(该文件已 import,`:1`)生成自身 `artifactId`。
2. **openDock 带 id**:`st.openArtifactDock({ lang, code, tabIndex, coexist, artifactId })`。
3. **store 加回写**:`updateArtifactDockCode: (id, code) => set((s) => (s.artifactDock?.artifactId === id && s.artifactDock.code !== code ? { artifactDock: { ...s.artifactDock, code } } : s))`。id 不匹配或 code 未变则不 set(短路,防流式每 token 空 setState)。
4. **内联回写**:内联组件 `useEffect(() => { if 自己正被停靠 (store.artifactDock?.artifactId === 本 id) updateArtifactDockCode(本 id, code); }, [code])`。这样内联块每 token 拿到的新 code 实时同步进 dock,`ArtifactDock`(读 store.code + 自身 `useDebounced(code,300)`,`:259`)随之实时刷新——iframe 300ms 节流已现成。
5. **内联折叠为代码块**:内联计算 `isDocked = store.artifactDock?.artifactId === 本 id`;`isDocked && !coexist` 时,`PreviewBody` 的 mode 强制走折叠代码块显示(或整块替换为一个"已停靠,内容见右侧面板"的紧凑代码预览),**但 toolbar 的 预览/代码/停靠 三按钮保留**(用户明确要保留)。`coexist=true`(文件浏览器停靠,静态)不折叠。

**成本** ~15-20 行,2 文件。

**风险/边界**
- 流式频繁 setState:靠 `updateArtifactDockCode` 内 `code !== prev` 短路 + id 匹配双闸,只有"正被停靠的那个 artifact"且"code 真变了"才 set,dock 单例全局唯一,压力可控。
- dock 是**全局单例非 per-pane**(`sessionStore.js:760`,分屏用 tabIndex 门控,`App.jsx:844-856`)。沿用单例,不改这个架构。
- 组件重挂断链风险:流式期间内联 ArtifactPreview 若因父列表重排卸载重挂,`useId` 会变 → 断链。RESEARCH 已备:若实测断链,升级为备选 B(用 messageId+blockIndex 当稳定身份)。**先按 A 实现并实测流式全程 dock 是否持续跟新**,断了再上 B。
- p5/three:本轮不做,PREVIEWABLE 仍 html/svg/mermaid(`:16`)不动。

**验收要点**
- 流式生成一段 html/svg/mermaid 时点"停靠",右侧 dock 随后续 token 实时更新代码 + 预览(iframe 约 300ms 节流刷新),不再冻结在点击瞬间快照。
- 点停靠后,该内联块主体折叠成代码块(占位小),但仍保留 预览/代码/停靠 三个 toolbar 按钮。
- 文件浏览器停靠(coexist)保持原样不折叠。

---

## #4 收紧子代理 transcript 过滤 — 建议:基本不做,仅加零风险兜底

**结论:不值得做主动收紧。可选一行零 IO 兜底,风险为零。**

**现状核实**(`server/services/session-reader.js:283-329`,head 窗口 = 40 行):
- 已有过滤链:`sidecarCwd/realCwd` 不符跳(`:302`)、标题生成串跳(`:312`)、**无 user 记录跳**(`:318`,覆盖 agent-setting/queue-operation 等无对话的编排辅助 jsonl)、**head 内 isSidechain:true 跳**(`:323`)、空会话跳(`:329`)。子代理真身在 `<sid>/subagents/` 子目录,顶层天然扫不到。

**为何不主动收紧**:
- 剩余"漏网"只可能是:带 user 记录、但 isSidechain:true 不在前 40 行、写在顶层的编排 jsonl。这类极罕见。
- 任何进一步启发式(如按文件名模式、按 parentUuid 指向另一 session、按 type 白名单)都有**误杀真实会话**风险,收益(去掉偶发重复条目)远小于代价(用户真会话消失)。违背 BRIEF"别误杀真会话"红线。

**可选零风险兜底(1 行)**:`isSidechain` 检查从只扫 `head` 扩到也扫 `tail`(两者已读入内存,零额外 IO):`if ([...head, ...tail].some((r) => r?.isSidechain === true)) continue;`。`isSidechain:true` 是 CLI 显式写的可靠标记,扫 tail 不会产生任何假阳性,只多兜住"标记在文件尾部"的形态。

**成本** 0(不做)或 1 行(兜底)。**验收**:兜底版——构造一条 isSidechain 仅出现在末尾的 jsonl,确认不再列出;正常会话仍全部列出。

---

## #5 worktree 列表实时刷新 — 加刷新按钮

**改动文件**
- `client/src/App.jsx`:worktree picker 弹层(`openWorktreePicker` 定义 `:1818-1832`,弹层 JSX 需定位到 `worktreeOpen &&` 渲染块)。

**实现要点**
- 后端 `git worktree list --porcelain` 位置无关必列全,已能看到(RESEARCH #5)。唯一缺口=弹层只在打开那刻拉一次。
- 弹层标题栏加一个刷新按钮,onClick 复用 `openWorktreePicker`(它已做 `setWorktreeList(null)` + 重拉)。**优先刷新按钮,不做轮询**(ponytail:AI 建 worktree 是低频事件,轮询是过度优化)。
- 图标复用 lucide `RefreshCw`。

**成本** ~5 行。

**风险/边界**:纯前端,重入 openWorktreePicker 已有 loading(`setWorktreeList(null)`)与错误态(`:1828`)处理,无并发问题。

**验收要点**:worktree 弹层开着时,AI 在别处新建了 worktree → 点刷新按钮,新 worktree 出现在列表。

---

## #6 外部改 settings.json 同步显示 — 后端已就绪,仅补前端监听

**核实:后端已完成。** `server/index.js:786-801` 的 file-watcher 在 `~/.claude/settings.json` 变化时已 `broadcast({ type: 'provider-change', … })`(对**任何** settings.json 改动都发,不止换 provider)。`useWebSocket.js:43-58` 收到后已 `window.dispatchEvent('cgui:provider-change')`。**缺口纯前端**:SettingsPanel 没监听这个事件重拉。

**改动文件**
- `client/src/components/SettingsPanel.jsx`:`fetchSettings`(`:62`)、`useEffect mount 拉一次`(`:74`)。

**实现要点**
- 加一个 `useEffect`:`window.addEventListener('cgui:provider-change', fetchSettings)`,卸载时移除。settings.json 任意外部改动 → WS 已推 → 事件已 dispatch → 面板自动重拉显示。
- 去抖:file-watcher 用 polling `interval:2500`(`file-watcher.js:22`),编辑器多次保存被 2.5s 采样合并,前端无需再去抖;稳妥可加一个 300ms `useDebounced` 包一层 fetch,防极端连发。**优先不加,实测抖再加**(ponytail)。
- 若 `env`(settings-env)也要同步,同一事件里一并重拉 env 显示。

**成本** ~5 行前端。后端 0(已就绪)。

**风险/边界**:SettingsPanel 未打开时事件无害(无监听者);打开时收到即重拉,不影响用户正在编辑的未保存草稿?——注意:若用户正在面板里编辑未提交,外部改动重拉会覆盖草稿。**边界处理**:仅当面板无 dirty(无未保存编辑)时才自动重拉;有 dirty 则忽略或提示。查 SettingsPanel 是否有 dirty 态,无则最简做法=只重拉展示型字段不覆盖输入焦点中的字段。开发时确认。

**验收要点**:设置面板打开着,终端/编辑器改 `~/.claude/settings.json`(如 `cc switch` 或手改 model)→ 面板显示在约 2.5s 内自动更新为新值,无需手点"重新加载"。

---

## #7 图片点击放大预览(lightbox)

**改动文件**
- 新增 `client/src/components/ImageLightbox.jsx`(共享 lightbox,~40 行)。
- `client/src/components/ChatInput.jsx:924-929`(输入框图片附件 `<img>`)。
- `client/src/components/MessageBubble.jsx:357-372`(已发送消息图片附件卡片)。

**新组件 ImageLightbox**(复用现有 portal 范式)
- `createPortal(<div fixed inset-0 z-[200] bg-black/80 点击关闭><img 居中 max-w/max-h 92vw/92vh />, document.body)`。
- Esc 关闭 + 锁 body 滚动(照抄 `ArtifactPreview.jsx:162-169` 的 effect)。
- lightbox 内放一个"用默认 App 打开"按钮(POST /api/files/open),让"打开原图/文件"入口不丢。
- 无预览 data-url 时(理论上图片都有 preview)不弹。用 2 处以上、且已有全屏遮罩范式 → 抽组件是合理复用,不算过度设计。

**交互定义(卡点1 由用户拍板)**
- **输入框图片**(ChatInput):当前无点击行为 → **单击 `<img>` 放大**。无歧义,直接做。
- **已发送消息图片**(MessageBubble):当前整卡 `onDoubleClick` → 用默认 App 打开。
  - **推荐方案**:图片缩略图 **单击 → lightbox**;lightbox 内提供"用默认 App 打开"按钮承接原"打开原图"需求;**移除图片卡的双击打开**(避免同元素 单击/双击 冲突——双击会先触发两次单击,导致先弹 lightbox 再开 app 的抖动)。**文件(非图片)卡片保持 `onDoubleClick` 打开默认 App 不变**(BRIEF:文件不预览)。理由:图片的第一诉求是"看大图",与 Claude Desktop 一致;打开原文件是次要动作,收进 lightbox 不丢失。
  - **备选方案**:保留卡片双击打开 + 图片单击放大并存,需 click/dblclick 去抖(单击延时 ~250ms,期间来 dblclick 则取消 lightbox)。更复杂,WKWebView 下双击还易误触文本选中,边界多。
  - 实现上二者都要:图片单击 handler 挂在 `<img>` 上并 `e.stopPropagation()`,避免冒泡到卡片的双击/其他 handler。

**成本** ~40 行(新组件) + 各 ~3 行接线,共 3 文件。

**风险/边界**
- WKWebView/移动端:portal + fixed 全屏遮罩是本项目验证过的范式(ArtifactPreview 全屏同款),移动端点击关闭同样可用。
- data-url 图片(`a.preview` / `attachments[].preview` 是 base64 dataURL)直接进 `<img src>`,无跨域/CSP 问题。
- 单击/双击冲突:推荐方案通过"移除图片双击"根除;若走备选务必做去抖。
- per-pane/流式:lightbox 是模态全局态,与 pane 无关。

**验收要点**
- 输入框里贴的图片,单击 → 全屏 lightbox,点背景/Esc 关闭。
- 已发送消息里的图片,单击 → lightbox(含"用默认 App 打开"按钮);文件附件仍双击打开默认 App。
- lightbox 图片按 92vw/92vh 等比放大不溢出。

---

## 实现批次与顺序

**建议单分支串行**(多为同前端文件小改,worktree 并行的合并开销 > 收益;#2 与 #7 都碰 MessageBubble 不同区,并行反增冲突)。dev-flow 开发阶段一条 master 特性分支即可。

| 批次 | 项 | 依赖 | 说明 |
|---|---|---|---|
| 1 | #1 | 无 | 独立、最快、真机硬验先落地 |
| 1 | #5 | 无 | 独立一行级 |
| 1 | #6 | 无 | 后端已就绪,仅前端监听 |
| 2 | #3 | 无 | ArtifactPreview+store,独立区 |
| 2 | #2 | 无 | TurnBubble/MessageBubble 思考区;与 #3 无共享 state |
| 3 | #7 | 无 | 新 lightbox + ChatInput/MessageBubble;#7 碰 MessageBubble 附件区,与 #2 思考区不重叠,放 #2 之后避免同文件编辑打架 |
| — | #4 | — | 不做(或 1 行兜底),随手可搭在批次 1 |

无跨项强依赖,顺序仅为降低同文件编辑摩擦。#1 因真机验证是硬门,优先完成以便尽早上真机验。

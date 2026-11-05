# r154-ui-live-line · 生成中底部状态行的验收套件

判据全部来自接口文件 `.devflow/r154-ui-live-line-接口.md` 的「行为清单」L1–L15（每条一个测试，标题以 `L1`…`L15` 开头）。
只断言**用户看得见的行为**：接口文件列出的 `data-*` 锚点、公开文案、role、计算样式；不读产品源码、不读 React state。

## 怎么跑（一条命令）

```sh
bash tests/acceptance/r154-ui-live-line/run-isolated.sh                 # 全量（约 6~10 分钟，其中 L2 要真等 60 多秒才能看到「1m 5s」）
bash tests/acceptance/r154-ui-live-line/run-isolated.sh --grep 'L3 '   # 只跑某一条（额外参数原样转给 playwright）
R154_BROWSERS=webkit,chromium bash .../run-isolated.sh                  # 默认只跑 webkit（与桌面应用同引擎）；加 chromium 对照
R154_MODE=dist bash .../run-isolated.sh                                 # 默认是 Vite 源码直出（改完前端不用 build）；dist = 后端直接托管 client/dist
R154_PORT=6781 bash .../run-isolated.sh                                 # 指定后端端口（只许 6700–6999）
R154_HOLD=1 bash .../run-isolated.sh                                    # 只起实例不跑用例（调试用）；收尾：kill 本脚本进程（trap 会按记录的 pid 收子进程）
```

脚本自己做的事：建夹具 → 起隔离后端 → 起 Vite（源码直出；`/api`、`/ws` 只代理到本套件自己的后端端口）→ 预检 + 热身 → 跑用例 → **只按 `.artifacts/pids` 里记录的 pid** 收尾（不 pkill、不按端口或进程名杀）。

## 隔离

- 端口只用 6700–6999 里 `lsof` 查过空闲的；硬拒 6677 / 6689 / 6710 / 8798 / 8799（脚本、Vite 配置、`helpers/runtime.mjs` 三处各拦一次）。
- 后端的 `HOME` 与 `USERPROFILE` 都指到 `.artifacts/runtime-data/home`；`CGUI_DISABLE_FILE_WATCHER=1`；PATH 最前面挂**假 claude**（`helpers/fake-claude.mjs`）；`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN` 剥掉；任何 `CU_ALLOW_*` 一律 unset。
- 不碰真实 `~/.claude-gui`、`~/.claude`；Vite 的缓存目录也放在 `.artifacts/vite-cache`（不写主仓 node_modules）。
- `vite.isolated.config.mjs` 只 import 产品自己的 `client/vite.config.js` 再覆盖「代理目标 / 监听地址 / 缓存目录」，不改产品配置。

## 怎么造"生成中的回合"

场景写进 `CTL/scenario.json`（`helpers/runtime.mjs` 的 `writeScenario`），假命令行每个回合开始时读一次。事件种类：

| 事件 | 作用 |
|---|---|
| `thinking` / `text` | 发一块思考 / 正文 |
| `tool` + `pending:'dN'` | 只发工具调用、不发结果；`touchCtl('dN')` 才补结果（并行工具、"最后一个未返回"靠它） |
| `tool` + `isError:true` | 工具结果带 `is_error`（造"出错"的条目 / 子代理卡） |
| `wait` + `file:'gN'` | 事件流停在这里，直到 `touchCtl('gN')`（造「连接中 → 思考 → 输出」的逐段推进） |
| `raw` + `payload` | 原样发一行 stream-json（造 `compacting`：`{type:"system",subtype:"status",status:"compacting"}`） |
| `holdBeforeResult` | 发完事件后停住，`releaseRound()` 才收尾（回合保持"生成中"） |

每个用例独占一条夹具会话（`l1`…`l15`，各带一个历史回合），互不共用，可任意顺序跑；用例失败时 `afterEach` 会放开所有闸门让假命令行自己收尾。

## 用到的锚点

- 接口文件列出的：`[data-live-line]`（`data-live-phase` / `role`）、`[data-live-indicator]`（`data-style` / `data-speed` / `<i>`）、`[data-live-elapsed]`、`[data-live-sep]`、`[data-live-text]`（`[data-live-verb]` / `[data-live-object]`）、`.live-shine`、`[data-strip="head"]`（`data-strip-live` / `data-strip-dots` / `data-strip-elapsed`）、`[data-entry-state]`、`[data-entry-live]`、`[data-agent-icon="matrix"]`、`[data-agent-beam]`（`[data-beam-layer]`）、`[data-loading-option="…"]`、`[data-loading-speed="…"]`、`role="radiogroup"` / `radio`、`localStorage` 的 `cgui-loading-style` / `cgui-loading-speed`。
- **接口文件没列、取自改动前页面上已有的公开入口**（探针里从界面上摸到的，不是读源码）：主题按钮 `[data-cgui="theme-btn"]`、弹层里的 `tab「界面」`、停止键的名字「停止生成」、过程条条目 `[data-strip-item="group|task|text"]` 与 `[data-strip-root]`、子代理卡上的按钮 `title="在子代理会话窗口打开"`、子代理视图 `[data-cgui="subagent-view"]`、消息列表 `[data-cgui="message-list"]`。这些若被产品改名，会表现为用例前置自证失败，而不是产品缺陷。

## 判据口径里要留意的几处

- 状态词按接口文件逐字比较：`[data-live-text]` 的文字（空白折叠后）必须恰为 `verb` 或 `verb object`（中间一个空格），**末尾不带省略号**。
- 「截 50 字符」只校验"以前 50 个字符开头、不含第 51 个字符、总长 ≤ 51"（容许末尾带 1 个省略号）。
- 「在动」取指示器及其 `<i>` 点的 `transform`，600 毫秒内每 100 毫秒采一次，出现 ≥ 2 种取值才算在动；减弱动画（`emulateMedia({ reducedMotion: 'reduce' })`）下必须只有 1 种。
- 「运行中的动画元素」= 动画名非 `none` 且 `animation-iteration-count` 含 `infinite`（一次性入场淡入不算），再加任何 SMIL 动画元素。
- 主题强调色变化 = 往根元素写 `--color-accent`（内联样式）；指示器颜色与「把 `var(--color-accent)` 算成 rgb」的值比较。
- `compacting` 用 Agent SDK 公开的 `system/status:compacting` 事件造；10 秒内状态行没变成 `compacting` 就把这一小段标 `ENVIRONMENT_BLOCKED`（annotation + 控制台一行），其余断言照测。

## 没覆盖的

- `data-entry-state="stopped"`（被停止的工具条目）与子代理卡的"被停止"只在 L11 里间接覆盖到卡片层面；条目层面的 `stopped` 没单测。
- 非 orbit 样式（ring / cli 等）自身长什么样不测，只测它们被选中后 `data-style` 保持。
- 分屏（多个窗格同时生成）下"每个窗格各 1 个状态行 / 各 ≤ 1 个流光"没测。
- 真实 CLI 的流式事件顺序、真实子代理转写内容没测（全是假命令行说的 stream-json）；L15 里子代理视图没有真实转写，只能验版式与"phase 与状态词一致"。
- 性能（状态行每秒走字是否拖慢长会话）没测。

## 实测补充（修前跑出来的，写在这里免得后人再踩）

- 子代理卡在回合进行中**不会**因为 tool_result 到达而切走「运行中」（改动前的页面实测：结果到达 3 分钟后卡片仍标「运行中」）。所以 L11 的"完成 / 出错 / 已停止后没有九宫格与边框光"只验**回合结束后的终态**；回合中途的切换没法用假命令行验证。L4 也因此把 Task 放在并行链条的第 1 个（最后才检查，不依赖它的结果被页面认作"已返回"）。
- 主回合的停止键用 `[data-cgui="stop-btn"]` 定位：它的可见文字只有「停止」（title 才是「停止生成」）；按角色名 `/停止/` 还会误中子代理卡上的「停止该子代理/teammate」。
- 过程条里「思考 · N 次工具调用」这一组默认是收起的，`openStripEntries` 在找不到 `[data-entry-state]` 时会把它点开。
- `--grep` 匹配的是"项目名 + 文件名 + 标题"的整串，所以写 `--grep 'L3 '`（带结尾空格），不要写 `^L3`。

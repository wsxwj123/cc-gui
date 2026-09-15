# Pricing accuracy acceptance suite (PA-*) — 2026-09-11

Scope: **B** 计价准确性（分时段 / 长上下文档 / 缓存写 TTL / 币种与单位 / 价源层级 / 失败原因闭集）、
**A** 子代理花费（数据面 PA-5xx + **真浏览器呈现面 PA-514…PA-520**）、**D** 套餐余量文案与身份判定、
**E** baseURL 撞内置预设。
Contract source: `.devflow/INTERFACE-20260911-pricing.md`（本次接口约定，§0–§10）+
`.devflow/INTERFACE.md`（现行约定，用于理解既有入口）。
判词词汇表：`.devflow/TEST-PLAN-20260911-pricing.md`。

本套件**只依据接口约定写死预期**，不读实现代码；每个用例的期望值都能在契约里指出出处。

## How to run（一条命令）

```bash
tests/acceptance/pricing-accuracy-20260911/run-isolated.sh
```

脚本自己起隔离实例（数据根 = 本套件 `.artifacts/runtime-data`，随机空闲回环端口）、跑完杀掉进程；
额外参数原样转给 playwright，例如 `./run-isolated.sh --grep 'PA-3'`、`PA_PORT=57301 ./run-isolated.sh`。

已经有实例在跑时也可以直接用 BASE_URL（脚本只是省事，不是唯一入口）：

```bash
BASE_URL=http://127.0.0.1:<隔离端口> PA_ALLOW_UI=1 \
  npx playwright test -c tests/acceptance/pricing-accuracy-20260911/playwright.config.mjs
```

**开跑前有一次实例身份预检**（`global-setup.mjs`）：它拿本套件数据根里的派生夹具会话去问实例，
读不到就一句话报错并停下 —— 指错实例（复用了别套件/别轮次留下的实例）时，宁可这样停，也不要跑出
一堆像产品缺陷的红。预检不碰契约字段，所以不会把产品问题伪装成环境问题。

列用例不连服务器：`npx playwright test -c tests/acceptance/pricing-accuracy-20260911/playwright.config.mjs --list`

只跑某一组：加 `-g 'PA-(1|2)'`（时间/阈值/缓存写）`-g 'PA-4'`（HTTP）`-g 'PA-6'`（余量+预设）等。

`usage-byperiod-e2e.spec.mjs`（PA-423…425）**不需要 `BASE_URL`**：它自己按契约 §10.11④ 造一个隔离 HOME
并起一次性实例（随机空闲回环端口，跑完即杀），所以单独跑也可以：
`npx playwright test -c tests/acceptance/pricing-accuracy-20260911/playwright.config.mjs usage-byperiod-e2e.spec.mjs`

## Safety and setup

1. 隔离实例：未占用的回环端口（**不要**用 6677/6689 —— helper 会拒绝），数据根在
   `tests/acceptance/pricing-accuracy-20260911/.artifacts/runtime-data`。
2. `BASE_URL` 指向它；helper 拒绝非回环地址与那两个用户端口。
3. 用例只改本套件隔离实例的状态（建/切自定义 provider、触发一次 refresh），不碰用户 profile。
4. Trace/screenshot/video 全关；不打印私有 payload。

```bash
SUITE=tests/acceptance/pricing-accuracy-20260911
ROOT=$PWD/$SUITE/.artifacts/runtime-data
PORT=57295                      # 任意空闲回环端口
mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
cd "$ROOT" && env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  HOME="$ROOT/home" PORT=$PORT CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 CGUI_TAURI=1 \
  nohup node "/absolute/path/to/worktree/server/index.js" > "$ROOT/server.log" 2>&1 &
```

> 脚本路径必须写**绝对路径**（历史稿这里写的相对 `../../../../server/index.js` 少一层，会启动失败）。
> 两个坑：① `HOME` 必须是本套件数据根的 `home`（写成别套件的 HOME，会话夹具与状态全不对）；
> ② 别复用早就跑着的实例（进程可能比你手里的源码旧）。两条都由上面的预检兜底。

## Fixture preparation

### 会话转写夹具（`transcripts`）

`helpers/pa-fixtures.mjs` 启动时自己扫数据根，挑出需要的会话并派生一个分片会话，然后把结果写进
`fixture-manifest.local.json`（gitignored，可 `node helpers/pa-fixtures.mjs` 单跑重建）：

| 夹具 | 用例 | 说明 |
| --- | --- | --- |
| `transcripts.sessionId` | PA-413/414/415/420 | 数据根里任意一个带 usage 的真实会话转写 |
| `transcripts.ttl` / `bigInput` | PA-414/415 | 带 `cache_creation.ephemeral_5m/1h` 分档 / 输入 > 200k 的会话 |
| `transcripts.fragmented` | PA-416 | **派生**自上面某个会话：把它第一条带 usage 的 assistant 记录复制到文件末尾，`input_tokens + 111111`、`timestamp + 60s`。合理解「首次出现为准」与「取末条」会给出不同数字 |

> 当前数据根里的转写是从 `tests/acceptance/pricing-batch5-20260911/.artifacts/runtime-data/home/.claude/projects`
> 复制过来的真实会话（内容只有 `Reply with exactly: …` 这类测试提示词，无用户数据）。

### 子代理夹具（A 项 PA-509…PA-513 数据面 + PA-514…PA-520 UI 面，契约 §10.1 / §10.3 / §10.7）

`helpers/pa-fixtures.mjs` 现场**合成**五份「父会话 + 子代理转写」，落在数据根的
`<HOME>/.claude/projects/-pa-subagent-fixtures/`（清单的 `subagents` 段记位置与 id）：

| 夹具 | 用例 | 内容（都是本文件合成的测试提示词，零用户数据） |
| --- | --- | --- |
| `subagents.task` | PA-509 / PA-510 / PA-514 / PA-517 / PA-518 / PA-519 | 父会话里一次 `Agent` 调用（`tool_use.id` 与该 agent 的 `meta.json.toolUseId` 对上）；同轮另放一个 `toolUseId` **不在**父 jsonl 里的孤儿 agent（负例）。转写里含同一 `message.id` 的**分片**（第二片 `input_tokens` 改成 999999 → 取首次还是取末条可区分），`meta.json.model` 故意写成别名 `opus`（真 id 只在转写里） |
| `subagents.background` | PA-515 | 同一次 `Agent` 调用但 `run_in_background: true`，`tool_result` 是 `async_launched`（键集合照抄 2026-09-12 本机实测的真实后台子代理记录：`isAsync/status/agentId/description/resolvedModel/prompt/outputFile/canReadOutputFile`）；agent 转写与 meta（带 `toolUseId`）与前台那份同形 —— 真实后台子代理的 meta 实测同样带 `toolUseId` |
| `subagents.workflow` | PA-511 | `subagents/workflows/<runId>/agent-*.jsonl`（meta 只有 `agentType`/`spawnDepth`）+ 父 jsonl 里带 `toolUseResult{taskType,runId}` 的 `tool_result` → 归属只能靠 runId |
| `subagents.resume` | PA-512 | 同一 runId 挂**两条** `tool_result`（记录时间 t1 < t2 = 6s / 46s），三个 agent 的首条记录分别在 1s（早于全部调用）、20s（t1 与 t2 之间）、50s（晚于 t2） |
| `subagents.ambiguous` | PA-513 | 同一 runId 两条 `tool_result` 的 `timestamp` **逐字相同**（分不开）→ 契约列在「不可归属」里，一个都不该出现 |

- 记录字段形状照抄真实转写（键集合取自本机测试会话的快照）；`agent id` 用 16 位小写十六进制、`runId` 用
  `wf_<8 位十六进制>-<3 位>` —— 这是照真实命名写的，产品侧按这两种形态扫转写。
- 夹具不成立（文件被清掉、清单过期）时用例报 `ENVIRONMENT_BLOCKED` 并指出缺哪个文件；
  `node helpers/pa-fixtures.mjs` 可一键重建（会重扫会话并重写清单）。
- 每份夹具在用例里都有**自证**：父 jsonl 里得有对应的 `tool_use`／`tool_result`、转写得在场 ——
  自证通过后判据才生效（不成立就是环境不成立，而不是"跑过了"）。

### A 项 UI 呈现（PA-514…PA-520，`subagent-cost-ui.spec.mjs`，需要 `PA_ALLOW_UI=1`）

验的是「金额显示在**各自的位置**上」：前台子代理的 Task 卡片 + 监控面板两处同数、后台子代理只在监控面板、
workflow 卡片显示内部全部 agent 的合计而监控面板逐条各显示、归属不上的位置只显示小标「未能计价」、
以及轮末花费与三处命中率口径未变（安全边界）。

| 步骤 | 依据 | 钩子 |
| --- | --- | --- |
| 打开会话 | 既有 UI 习惯 | 侧栏搜索框（可访问名「搜索项目」，`data-cgui="sidebar-search"`）→ 结果行按钮 |
| 打开监控面板 | 既有 UI | 顶栏按钮「监控」（面板里渲染出「子代理 (N)」区才算开成） |
| 对话流窗格 | 既有 hook | `[data-testid="pane"]`（监控面板在它之外 —— 这是「位置」判据的基座） |
| 注入报价 | 契约 §3.1 | `page.route('**/api/pricing**')` 拦 GET，回一份合成 catalog（同 E 项拦保存请求的手法）；金额期望值由契约 §5.2/§5.3 现算（用量 × 报价 × 7.2），不在用例里写死 |
| 非套餐档前置 | §10.5 | `beforeAll` 经公开 HTTP 建/切一个 `type:'openai'`、带 `apiKey`、**不带 `modelPrices`** 的 provider（否则 claude-* 走 `PLAN_BILLING`，金额一处都不显示，那是环境问题） |

**契约没有公布的定位钩子（本组用例的脆点，产品改文案/结构即红）**：金额与小标没有 `data-testid`，
用例只能按夹具自带文字锚定 —— agent 描述（卡片）、`toolUseId`（面板行）、内层 agent 短 id（`#6011`，
workflow 行）。另外「轮末费用位」靠「父容器里带『整轮命中率』」识别、「对话流卡片」靠「金额在最近的
`<button>` 里」识别。

**需要产品补的钩子（建议，加了之后本组可去掉三处文字锚点）**：
① 金额元素 `data-testid="agent-cost"`（可带 `data-cost-usd` / `data-cost-state="unpriced"`）；
② 对话流工具卡片根 `data-testid="tool-card"` + `data-tool-use-id="<tool_use.id>"`；
③ 监控面板行 `data-testid="agent-row"` + `data-agent-session-id="<agentSessionId>"`。
有了 ②③，「哪张卡片 / 哪一行的金额」就不再依赖文案；有了 ①，「未能计价 vs 金额」也不再靠正则。

### 自定义 provider 夹具（D 项）

`quota-preset.spec.mjs` 的 `beforeAll` 经公开接口 `POST /api/custom-providers` 建 4 个 provider
（未登记 host / 名单内 host / 不可达回环 / OpenAI 预设 host），并在每个用例里 `POST /api/provider/switch`
切到它。重复跑不会重复建（按名字复用）。

### `byPeriod` 端到端夹具（PA-423…425，契约 §10.11④）

`usage-byperiod-e2e.spec.mjs` 每次跑都重建 `.artifacts/usage-e2e/`：写死 5 条 assistant 记录（每条一个独立
`message.id` = 一次调用）到 `<HOME>/.claude/projects/-pa-byperiod-e2e/<sid>.jsonl`，再起隔离实例读
`GET /api/usage`。记录的时段归属按契约 §1 的**北京时间**口径：

| 记录 | 时间戳 | 期望桶 | input |
| --- | --- | --- | --- |
| `msg_pa_bp_peak` | `2026-09-11T02:00:00.000Z`（周五北京 10:00） | `peak` | 100 |
| `msg_pa_bp_weekend` | `2026-09-12T02:00:00.000Z`（周六北京 10:00） | `offPeak` | 200 |
| `msg_pa_bp_evening` | `2026-09-11T12:00:00.000Z`（周五北京 20:00） | `offPeak` | 300 |
| `msg_pa_bp_unknown` | 无 `timestamp` | `unknown` | 400 |
| `msg_pa_bp_tz` | `2026-09-11T17:00:00.000Z`（北京周六 01:00，UTC 还是周五 17:00） | `offPeak` | 500 |

期望：`peak {calls:1,input:100}`、`offPeak {calls:3,input:1000}`、`unknown {calls:1,input:400}`，
行合计 `input:1500 / output:150 / cacheRead:15 / cacheWrite:30 / calls:5`。
先写夹具、后起实例（§10.11④ 的缓存注意：`getUsageStats` 有进程内缓存 + 文件签名）。

### E 项 UI 夹具

`preset-save-ui.spec.mjs` 走真浏览器，入口与弹窗钩子全部按契约取（桌面端设置里**没有** Provider 入口）：

| 步骤 | 依据 | 钩子 |
| --- | --- | --- |
| 打开管理弹窗 | §10.12⑤ 路径 A | `window.dispatchEvent(new CustomEvent('cgui:open-provider-manager'))` |
| 管理弹窗根 / 添加 / 表单根 / Base URL / 保存 | §10.12⑤ 路径 B | `data-testid` = `provider-manager` / `provider-add` / `provider-form` / `provider-baseurl` / `provider-save`（编辑态同一个 `provider-save`，文字是「更新」） |
| 弹窗根 / 两键 | §10.11⑥ | `preset-suggest` / `preset-suggest-confirm` / `preset-suggest-cancel` |

保存请求一律被 `page.route` 截下（**新建 = POST、编辑 = PUT `/api/custom-providers/<id>`，两条都截**）并回一个假 200，
不真的落盘；只有 `GET` 放行给实例（管理弹窗要靠它渲染已有 provider 行）。
PA-704（抑制①）走编辑态，夹具 provider 由用例自己经 `POST /api/custom-providers` 建（按名字复用，重复跑不重复建）。

**契约没公布钩子的控件**（脆点，产品改文案/结构就会红）：名称输入框、`API Key`、模型 textarea、内置模板
`<select>`（选项文本 = 预设 `name`）、行内的「编辑」键（只有 `title="编辑"`）。找不到时报 `ENVIRONMENT_BLOCKED`
并点名缺哪个。

**「本次更新 vX」弹层**：数据根还没读过当前版本时它盖住整页（卡片是 `pointer-events-auto`，会 intercept 点击），
与本组要验的事无关 —— `openApp` 里会先关掉它（卡片标题栏的 `title="关闭"`），关不掉则报错。不关的话，
本文件**第一条**跑到的用例必然红（实测：全新数据根上 PA-701 超时 60s，后面的用例反而绿）。

**需要 `PA_ALLOW_UI=1`**；没有该变量时这些用例报 `ENVIRONMENT_BLOCKED`（不算产品结论）。

## Environment guards

| flag | 门控 | 为什么 |
| --- | --- | --- |
| `PA_ALLOW_UI=1` | PA-701…PA-707、PA-514…PA-519 | 需要真浏览器（自定义 provider 表单 / 子代理花费的呈现面） |
| 自建实例（**不需要** `BASE_URL`） | PA-423…PA-425 | 按 §10.11④ 起隔离 HOME 的一次性实例 |
| 无 flag 但需要夹具的用例 | PA-609、PA-610 | 夹具不存在时报 `ENVIRONMENT_BLOCKED` 并点名缺什么，**不静默跳过**（A 项 PA-509…PA-513 的夹具由本套件现场合成，见「子代理夹具」） |

## 当前构建下的结果（2026-09-12，第八稿）

对着本 worktree 的源码（`/api/health` 报 `0.2.379`）用 `./run-isolated.sh` 跑两遍全量（另加一次锁定提交后的复跑）：
**153 条 = 通过 150 + 失败 3**（0 skip、0 flaky；失败集逐条相同，见 TEST-PLAN §4.8）。三条红：

- `ENVIRONMENT_BLOCKED` **2 条**：PA-609/610（缺真智谱密钥与出口抓包夹具）—— **不是产品结论**；
- **红 1 条**：**PA-515**（新增）—— 后台子代理（`run_in_background: true`）的金额**同时**渲染在对话流那张卡片
  和监控面板上；需求书口径是「后台子代理只在监控面板显示」。**注意这条红是口径冲突**：契约 §10.3 的卡片规则
  与 §10.6 #15 都不区分前台/后台（「每个子代理显示在各自位置：对话流 Task 卡片 + 监控面板」），
  需协调者裁定改产品还是改口径（详见 TEST-PLAN §5.1-G）。**裁定前不要为了转绿放宽这条断言。**

第七稿的 🟢/🔴 见本节文末（留作追溯）。**第八稿只动测试**：新增 `subagent-cost-ui.spec.mjs`（PA-514…PA-520
七条真浏览器用例）、`helpers/pa-fixtures.mjs` 新增 `subagents.background` 夹具、本 README 与 TEST-PLAN；
**产品代码零改动，既有 146 条一字未改、没有一条断言被放宽**。**PA-513 已转 🟢**（产品在 commit `1fc225dc`
的 `pickWorkflowCall` 里补了「两条调用时间戳相同时不归属」，实测通过）。

<details>
<summary>第七稿（2026-09-12，留作追溯）</summary>

对着本 worktree 的源码（`/api/health` 报 `0.2.379`）用 `./run-isolated.sh` 跑两遍：**146 条 = 通过 143 + 失败 3**
（0 skip、0 flaky，两遍失败集逐条相同，见 TEST-PLAN §4.7）。三条红：

- `ENVIRONMENT_BLOCKED` **2 条**：PA-609/610（缺真智谱密钥与出口抓包夹具）—— **不是产品结论**；
- **红 1 条**：**PA-513** —— 夹具成立（同一 runId 两条 `tool_result`、记录时间戳逐字相同），
  产品仍把该 agent 归到后一条调用，与契约 §10.1 的「多命中且时间戳分不开 → 不可归属」冲突。
  这是第七稿**新报出来**的缺口（此前该条没有夹具，跑不到）。

A 项五条（PA-509…PA-513）第七稿起都有真夹具：Task 归属 / 孤儿不摊派 / Workflow 归属 / resume 就近全绿，
只有上面那条"分不开"是红的。

同日另有一次 125/20 的全量跑：那次的 `BASE_URL` 指向一个 **9 月 11 日 15:07 起、HOME 是别套件数据根的旧实例**。
20 条红 = **15 条**（PA-701 + 14 条契约字段类）**全是这个原因** + 5 条 `ENVIRONMENT_BLOCKED`（本套件已知的夹具缺口）。
一条产品缺陷都没有；对着本套件自己的实例重跑即全绿（两遍见 TEST-PLAN §4.6）。
为免再踩：加了实例身份预检（`global-setup.mjs`）与 `run-isolated.sh`，`preset-save-ui` 也会自己关掉
挡住整页的「本次更新」弹层（详见 README「How to run」与 TEST-PLAN §4.6）。

更早的稿次对着**尚未实现**契约的构建跑出过大量红，那些失败全部是「契约要求的东西不存在」，不是脚本问题
（模块/导出缺失、`byPeriod` 与 `usageCalls` 字段缺失、D 项文案未换）。逐稿条数见
`.devflow/TEST-PLAN-20260911-pricing.md` 的「实跑记录」。

</details>

## Not preparable in this environment

| 用例 | 为什么跑不了 | 之后怎么补 |
| --- | --- | --- |
| PA-609 智谱双候选 | 需要一把真实智谱 CN 密钥；且候选清单本身没有对外可观察字段 | 用真 key + 抓包 |
| PA-610 域族隔离 | 需要能记录出站请求的代理夹具 | 搭 stub/代理 |
| ~~PA-608 缓存回放 degraded~~ | **已解决（2026-09-12）**：原先记的「当前构建没标 `degraded`」是拿**旧实例**测出来的 —— 对着本套件实例与当前源码，第二次请求确实标 `degraded`，用例通过 | — |
| ~~PA-701…PA-707~~ | **已解决（2026-09-12）**：原写法走的「设置 → Provider 管理」在桌面端不存在；§10.12⑤ 给了入口（全局事件 + `data-testid`）后这批改成真用例，7/7 通过 | — |

## Limits of this suite

覆盖了：契约 §1–§5 的纯函数口径（时段、阈值、TTL、层级、命中精确性、原因闭集）、§3 的 HTTP 契约与错误码、
§10.1/§10.3 的子代理计价、§10.4 的余量文案与身份判定、§10.8 的 baseURL 比对与保存弹窗，
以及 §10.11 澄清后的七条（套餐档/手填单价的构造、官方层三条候选条件、`matchedExactly` 新定义、
`byPeriod` 端到端分桶、`detail` 逐字表、E 项弹窗 `data-testid`）。**133 → 144 条**。

**第三稿（2026-09-11 更深夜）**：按 **§10.12③** 补 PA-347（手填单价只填部分维度 → 未填的缓存读写维度必须是 `null`（未知），
不回落内置/compat/官方层、不用 `in×0.1`/`in×1.25` 猜数，且该维度不计费），**144 → 145 条**；其余用例一字未改。

**第四稿（2026-09-12）**：E 项 7 条（PA-701…PA-707）改用 §10.12⑤ 的入口与 `data-testid`、期望值改由 §10.8 的
`matchPresetByBaseURL` 推导（原写法走的「设置 → Provider 管理」在桌面端不存在，且期望值用了与表单不符的协议），
**条数仍 145**；其余用例一字未改。

**第七稿（2026-09-12）**：A 项补夹具并把 PA-509/510/511/512 改成真用例（每条先自证夹具再判），
新增 PA-513（契约 §10.1「多命中且时间戳分不开 → 不可归属」），**145 → 146 条**；其余用例一字未改。
A 项现在的覆盖：Task 归属、孤儿不摊派、Workflow（runId）归属、resume 三种时间关系、分片去重、
`model`/`timestamp` 取转写而非 meta 别名。PA-513 实测红（产品未实现"分不开就不归属"）
→ **第八稿已转 🟢**（产品在 `1fc225dc` 的 `pickWorkflowCall` 里补了「两条调用时间戳相同时不归属」）。

**第八稿（2026-09-12）**：A 项补**真浏览器呈现面** —— 新增 `subagent-cost-ui.spec.mjs`（PA-514…PA-520，7 条）与
`subagents.background` 夹具，**146 → 153 条**；其余 146 条一字未改。
A 项现在的覆盖：归属与字段（数据面 PA-509…PA-513）+ 呈现位置与数字（UI 面 PA-514…PA-520：前台两处同数 /
后台只在监控面板 / workflow 卡片合计 + 面板逐条 / 归属不上只有小标 / 母会话未打开的行不渲染金额 /
轮末与命中率口径未变）。

没覆盖：真实模型回合的金额端到端（需要凭证）、真实上游抓取的数据正确性（那属于 collector 的验收，不在本次契约范围）、
Windows/Tauri 环境、以及 §10.11② 第③类「用哪个 host 构造」的判据本身（见 TEST-PLAN §5 含糊处 2）。

**A 项 UI 面仍未覆盖的**（第八稿如实清点，见 TEST-PLAN §5.1-G/H）：
① 契约 §10.3 表里的「**实时流式中的卡片**：金额与小标都不渲染」—— 夹具都是历史会话，造不出真实流式中的卡片；
② 「**名下 0 个记录 / 有记录但全部 `costUsd === null`**」两种情形的 title 之别：前者已覆盖（PA-517，逐字 title），
后者需要一个**没有任何价源**的 agent 型号（现有夹具型号都能从内置表算出来）；
③ workflow **部分成功**时的「另有 N 个未能计价」小标（同上，需要不可计价的 agent）。
④ ~~「未打开母会话的历史行不渲染任何金额元素」~~ **已覆盖**（PA-520）。

E 项另有三处**已知缺口**（TEST-PLAN §5.1-F）：建议目标 **type 翻转**（表单协议与建议目标不同型，只有 host 无同型预设时才会发生）
未覆盖；「切到该预设」在**编辑态**的效果未覆盖（PA-704 只验了抑制①）；弹窗 Esc / 点遮罩 = 保持不变（§10.8 边界表）未覆盖。

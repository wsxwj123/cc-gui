# TEST-PLAN r113 —— 0.2.375 审查必修三项(人话版测试清单)

> 谁都能看懂版:每条一行 = 测什么场景 / 怎么操作 / 预期看到什么。
> 标注含义:**[修前红]** = 复现用例,现在(未修)必须是红的,修完必须变绿;
> **[修前绿]** = 回归用例("这件事不许被改坏"),现在绿,修完还得绿。
>
> 一条命令跑全部:
> ```sh
> cd "/Users/wsxwj/Desktop/claude/claude gui-worktrees/r113-audit-fixes"
> for f in tests/unit/check-r113-*.mjs tests/unit/check-r108-windows-review.mjs \
>          tests/unit/check-r111-win-review-375.mjs tests/unit/check-badge-cli-window.mjs \
>          tests/unit/check-r103-dev-badge-window.mjs tests/unit/check-r103-window-denominator.mjs; do
>   node "$f" >/dev/null 2>&1 && echo "GREEN $f" || echo "RED   $f"; done
> ```
> 单看某个文件的逐条明细:`node tests/unit/check-r113-server.mjs`(每条自带 ✓/✗ 与标签)。
>
> 测试文件:
> - `tests/unit/check-r113-server.mjs` —— Bug 1(help 缓存)+ Bug 2(--bg 长度守卫),67 条
> - `tests/unit/check-r113-client.mjs` —— Bug 3(徽章分母钳位),45 条
> - 另按 INTERFACE §5.4 改写了 5 个既有测试里点名的断言(见本文件第 5 节)

---

## 1. 复现用例(修前必须红)—— 行为层

### Bug 1:Windows 冷启动第一条消息,把「快照参数」关了一整个进程

| 编号 | 场景(用户会遇到什么) | 怎么操作(测试怎么模拟) | 预期看到什么 |
|---|---|---|---|
| P1 | 失败结论要有保质期 | 读 `HELP_MISS_TTL_MS` 这个新常量 | 是个正整数(测试里一律读它算时间,不写死 60000) |
| P2 | **本轮 bug 本体**:冷启动时同步探测超时,随后的后台预热必须能把结论救回来 | ① 同步探测抛错 ② 后台预热拿到正常 help 正文 ③ 再问一次支不支持快照参数 | ① false ② 预热真的探了 1 次并返回 true ③ **true**(现在是永远 false) |
| P5 | 一次失败后别把机器探爆 | 失败后过了 TTL-1 毫秒再预热一次 | 返回 false,且**没有**重新探测 |
| P6 | 但也不能一失败就判死刑 | 失败后正好到 TTL 再预热 | 真的重探一次,拿到正文,返回 true |
| P7 | 已经拿到正文后不再浪费进程 | 有正文之后再预热第三次 | 返回 true,探测次数停在 2 |
| P9 | 同一时刻两处同时预热(启动预热 + 发消息触发) | 并发发起两次预热,探测函数故意慢 20ms | 只探 1 次(第二次被占位短路),第一次返回 true |
| P9b | 并发时第二次的返回值口径 | 同上,看第二个返回值 | false(它返回的那一刻正文还没写进表) |
| P10 | 同步探测失败不挡后台预热(契约 v2) | 同步探测失败(注入时钟 t0)→ t0+TTL-1 时预热 | 预热照样探 1 次并返回 true;同步侧此后不再自行探测(靠预热结果恢复) |
| P16b | 探测函数返回了个数字/空值(第三方壳子怪返回) | 预热的探测返回 undefined / null / 42 | 一律 false,且**不得**被当成 help 正文缓存 |

### Bug 2:Windows 上后台代理长任务,该拒的没拒、不该拒的全拒

| 编号 | 场景 | 怎么操作 | 预期看到什么 |
|---|---|---|---|
| W1 | 判"这次是不是真经 cmd.exe" | `spawnViaCmdExe('C:\npm\claude.cmd','win32')`、`.BAT` 大写 | 都是 true |
| W2 | 官方安装器 / Volta / bun 的装法 | `.exe`、无扩展名 shim、裸名 `claude` + win32 | 都是 false(它们直执行,不经 cmd) |
| W3 | mac / Linux | `.cmd` 路径 + darwin、普通路径 + linux | 一律 false |
| W4 | 路径没解析出来 | 传 null / undefined / 空串 / 数字 / 对象 / 数组 | 一律 false,且不抛异常 |
| W5 | 不传平台参数时的默认值 | 只传路径 | 等于"当前系统是不是 Windows" |
| W6 | cmd.exe 的命令行上限常量 | 读 `WIN_CMD_LINE_MAX` | 8191 |
| W7 | mac 上不受任何长度限制 | 5 万字符的 prompt + darwin | `{viaCmd:false, length:0, over:false}` |
| W8 | **回归本体**:Windows + `.exe` 装法派 7001 字符任务 | `.exe` 路径 + 7001 字符、3 万字符 | `over:false`(v0.2.375 在这里错拒 400) |
| W9 | Windows + 无扩展名 shim / 路径没解析到 | 9000 字符 | `over:false`,不按长度拒 |
| W10 | `.cmd` 装法的基线长度 | 空 prompt | 展开后 107 字符,不超 |
| W11 | 旧守卫错拒的那个点 | 7000 个 a | 7107 字符,不超 |
| W12 | 旧守卫错拒的那个点(+1) | 7001 个 a | 7108 字符,不超 |
| W13 | **旧守卫错放的那个点** | 6999 个引号(prompt.length 才 6999) | 展开成 14105 字符,**判超**(引号在 cmd 里会翻倍) |
| W14 | 上限边界 | 8085 个 a / 8084 个 a | 8192 判超 / 8191 不超(等于上限不算超) |
| W15 | 上限可注入 | 传 `max:100` | limit 跟着变,over 按新上限判 |
| W16 | 脏入参 | args 传 null / 字符串 / 数字 / 对象;三个参数全传 null | 当成空数组,永不抛 |
| W17 | 长度口径 | 与 `winCmdSpawnSpec` 拼出的整条命令行比对 | 逐字符相等(即 CreateProcess 真正收到的那条) |
| W18 | 两个"要不要走 cmd"的判据故意不同,不许统一 | `claudeExecSpec('C:\npm\claude',…,'win32')` 与 `spawnViaCmdExe` 同一路径 | 前者仍返回 `cmd.exe`,后者返回 false,两者同时成立 |
| G1 | 守卫按真实 claude 路径判,不是按平台 | 读 dispatch 路由源码 | 调用 `winCmdLineBudget`,附近能看到 `resolveClaude` |
| G2 | 报错文案说的是"展开后多长" | 找含「改用会话内发送」的那行 | 有插值(算出来的长度),**不再**出现 `prompt.length` |
| G4 | 被拒时不留垃圾文件 | 比较守卫与 `writeBgHookSettings` 的先后 | 长度判定在写 hook 设置文件**之前** |

### Bug 3:官方账号 + 自动压缩窗口选 1M,整回合徽章分母被抬到 1M

| 编号 | 场景 | 怎么操作 | 预期看到什么 |
|---|---|---|---|
| R1 | **本轮 bug 本体**:官方 200K 模型,设置里选 1M,刚发消息(还没有 result) | init 下发 `{linked:1M, linkedSource:'explicit'}` | 分母 **200,000**(现在显示 1M,压缩横幅和 80% 红色告警会被压住) |
| R2 | 回合结束 result 到达 | 在 R1 基础上补 `{cli:200000}` | 仍是 200,000 且来源仍标 explicit(不退回 cli) |
| R3 | 同一个 init 重复送达(SSE 重连) | R2 之后再送一次 init | 结果逐字段不变(幂等) |
| R4 | 顺序颠倒:先 result 后 init | 先 `{cli:200000}` 再 init | 与 R2 完全一致(顺序不影响结果) |
| R5 | **方向别反**:官方 200K 模型,用户选 100K | 已有 cli=200K,再来显式 100K | 分母 100,000(CLI 实际在 100K 压缩,显示 200K 会漏报) |
| R6 | 显式值与 CLI 自报相等 | 显式 200K + cli 200K | 200,000 |
| R7 | 第三方 provider 的联动窗口**不钳位**(r103 语义) | `linkedSource:'linked'` 1M + cli 200K | 1,000,000,来源 linked,细分来源 rules |
| R8 | provider 手填窗口不钳位 | provider 500K + cli 200K | 500,000,来源 provider,细分 manual |
| R9 | 官方账号、GUI 侧没有任何来源 | provider 解析为 null + cli 200K | 200,000,来源 cli |
| R10 | provider 解析不出来时别把已有值清掉 | R9 之后再来一次 `provider:null` | 仍是 200,000 |
| R11 | `[1m]` 模型压过一切 | `k3[1m]` + 显式 500K + cli 200K | 1,000,000,来源 1m |
| R12 | 第三方模型 + 显式 1M,还没有 result | model `deepseek-chat` | 200,000(CLI 对不认识的模型名自报恒 200K) |
| R13 | 未知模型名 + 显式 500K | model `some-unknown-model` | 200,000 |
| R13b | 未知模型名 + 显式 100K | 同上,值改 100K | 100,000(取小的那个) |
| R13c | Anthropic 原生 1M 模型 + 显式 500K | model `claude-opus-4-8` | 500,000(对 Anthropic 家族用该模型原生窗口兜底,不是恒 200K) |
| R14 | 什么来源都没有 | 空 patch | 分母/来源/细分来源都是 null |
| R15 | 脏入参(回调里抛错会吞掉整条 result 处理) | prevMeta/patch/model 各种非法值全排列 | 永不抛,一律返回合法结构,分母 null |
| R16 | 非法槽值 | 字符串 `'1000000'`、0、NaN | 三个槽全归 null,分母 null |
| R17 | `undefined` 不清槽 | R2 之后送 `{cli: undefined}` | 与 R2 逐字段相同 |
| R18 | `null` 显式清槽 | R2 之后送 `{cli: null}` | cli 槽清空,分母回落到原生 200K 兜底 |
| R19 | 返回结构 | 看返回对象的键 | 十个键齐全,`at` 是数字(其值不参与任何判定) |
| R20 | 原始输入要存下来供后续重算 | 一次性送满六个槽 | 六个槽都存**未钳位的原值** |
| R21 | 来源细分规则 | 1m / cli / provider 缺 providerOrigin 三种 | 分别是 `1m` / `cli` / `provider` |

---

## 2. 回归用例(修前必须绿,修完还得绿)

### help 缓存周边(prompt-cache-env.js)

| 编号 | 这件事不许被改坏 | 怎么验 | 预期 |
|---|---|---|---|
| P3 | 预热探到空串时,启动日志该打 miss 不打 ok | 预热返回值 | false |
| P4 | 首次预热探到空串 | 注入时钟 t0 | false,探测 1 次 |
| P8 | 已有正文的路径不重复起进程 | 连续预热两次 | 两次都 true,只探 1 次 |
| P11 | 有正文后问任何 flag 都不再起进程 | 第二次问别的 flag,探测函数一碰就抛 | true,且探测函数没被调用 |
| P12 | 每条路径整个进程内最多同步探一次(r90 哨兵) | 同步失败后再问别的 flag(注入时钟已超 TTL) | false,且不再同步探测 |
| P13 | 探测返回空/非字符串 | 五种脏返回 | 一律 false,不抛 |
| P14 | claude 路径是脏值 | null/undefined/0/数组/对象/字符串数字 | 返回布尔,不抛 |
| P15 | 预热遇到脏路径 | 空串/null/undefined/数字/对象/数组 | 一律 false,探测 0 次 |
| P16 | 探测函数抛错(同步/异步) | 两种抛法 | 永不 reject,返回 false |
| P17 | 单测用的清缓存函数要两张表一起清 | 造一条正文 + 一条失败记录后清空 | 两条都会重新探测 |
| P18 | `--system-prompt` 不该被 `--system-prompt-snapshot` 前缀命中 | help 里只有 snapshot 那行 | false |
| P19 | 描述正文里提到的 flag 不算支持 | help 描述里出现 `--system-prompt or` | false |
| P20 | 带别名的选项行仍认得 | `  -c, --continue` 里探 `--continue` | true |
| P21 | 空路径恒不支持 | `snapshotFlagOn('', true)` | false |
| P22 | 六个既有导出没被挪走 | 逐个查类型 | 都是函数 |
| P23 | 同步探测 2s、异步探测 8s、都经统一 exec 规格 | 读源码 | `execFileSync` + `timeout: 2000` + `timeout: 8000` + `claudeExecSpec(` |

### --bg 守卫周边(win-cmd.js / agents.js)

| 编号 | 这件事不许被改坏 | 怎么验 | 预期 |
|---|---|---|---|
| W19 | cmd.exe 的起法(`/d /s /c` + verbatim) | 看 `winCmdSpawnSpec` 返回值 | file=cmd.exe,前三个参数 `/d /s /c`,`windowsVerbatimArguments:true` |
| W20 | 不许就地改写调用方传进来的 opts | 传一个 opts 进去再比对 | 原对象逐字段不变 |
| W21 | 引号规则两条(r110/r111 的命根子) | `D:\` 与 `a\"b` 两个 token | 尾部反斜杠翻倍、内嵌引号前的反斜杠也翻倍 |
| G3 | 超长时仍是 400 + JSON `error` 字段 + 含「上限」(前端只读 error) | 读文案附近源码 | `status(400).json({ error …})`,文案含「上限」「改用会话内发送」 |
| G6 | agents.js 不自带 cmd/bat 正则 | grep | 找不到 |
| G8 | prompt 空/非字符串仍 400「prompt 必填」 | grep | 判据与文案都在 |
| G9 | 单词里含 `& \| < > ^` 的注入守卫**逐字**未改 | grep 文案与判据 | 一字不差 |
| G10 | 派发的仍是 `prompt.trim()`,白名单/模型参数仍在 | grep | 三项都在 |
| L3 | `.cmd` 分支体一字不改 | grep `claudeSpawn` 函数体 | 仍是 `const s = winCmdSpawnSpec(resolved, finalArgs, opts);` + `spawn(s.file, s.args, s.opts)` |
| L8 | `claudeExecSpec` 的口径故意与新函数不同,禁止统一(r106) | grep 其函数体 | 不含 `spawnViaCmdExe`,仍是 `!/\.exe$/i` |
| L9 | 空串永不写进"正文表" | grep | 找不到 `_helpCache.set(key, '')` 形态 |

### 徽章分母周边(contextWindow.js / App.jsx / chat.js)

| 编号 | 这件事不许被改坏 | 怎么验 | 预期 |
|---|---|---|---|
| N1 | 四个既有导出还在 | 逐个查类型 | 都是函数 |
| N2 | 既有仲裁函数行为一字不改 | explicit 取小 / linked 不钳 / `[1m]` 压过一切 / 非对象入参 | 四种结果与 r103 逐字相同 |
| N3 | 模型原生窗口兜底表没被顺手改 | 抽样 4 个模型 | 200K / 1M / 1M / 131072 |
| N4 | CLI 自报值的非法值纪律 | 0 / 负 / NaN / Infinity / 字符串数字 | 一律不采纳 |
| C6 | 不许把 CLI 自报值原样写进分母缓存 | grep App.jsx | 找不到该形态 |
| C12 | init 的前置门(0/负数/缺失不触发写入)保留 | grep | `Number.isFinite(event.linkedContextWindow)` 还在 |
| C13 | 徽章广播事件还在 | grep | `cgui:model-window-cli` |
| C14 | 两张缓存仍是模块级 Map,切 provider 仍清空 | grep | 两个 `new Map()` + `cgui:provider-change` |
| C15 | 分母优先级链一字不改 | grep | `resolvedWindow \|\| measuredCtx?.windowTokens \|\| nativeContextWindow(currentModel)` |
| C16 | 弹层来源文案两条逐字保留 | grep | 「按 CLI 实际窗口取小」「压缩联动同源」 |
| C17 | **服务端零改动** | grep chat.js | 三个 `linkedContextWindow*` 字段名、`subtype: 'context_window'`、`resolveLinkedWindowInfo` 都在 |

---

## 3. 源码锁(grep 断言:光看行为看不出来的"结构要求")

> 为什么要有:这三个 bug 的共同病根是"同一件事在多处各写一份"。锁的是结构,不是行为。
> 所有匹配都在**去掉注释后**的源码上做(否则实现方写一行注释就能骗过锁)。

| 编号 | 锁什么 | 红/绿 |
|---|---|---|
| L1 | win-cmd.js 导出 `spawnViaCmdExe` / `winCmdLineBudget` / `WIN_CMD_LINE_MAX` | [修前红] |
| L2 | chat.js 的 `claudeSpawn` 体内调 `spawnViaCmdExe(` | [修前红] |
| L4 | `claudeSpawn` 体内不再有裸的 `/\.(cmd\|bat)$/i` 正则 | [修前红] |
| L5 | prompt-cache-env.js 导出 `HELP_MISS_TTL_MS` | [修前红] |
| L6 | chat.js 有 `primeHelpCache(` 恢复触发点,且**没被 await**(await 会拖住发送) | [修前红] |
| L7 | 该触发点与 `snapshotFlagOn(claudePath …)` 在同一处(相隔 <1500 字符) | [修前红] |
| L10 | `primeHelpCache` 入口不得再用 `_helpCache.has(` 短路(空串被当成"已探过"就是本轮 bug) | [修前红] |
| G5 | agents.js 里没有 `7000` 字面量 | [修前红] |
| G7 | agents.js 里没有 `prompt.length >` 形态的长度守卫 | [修前红] |
| C1 | contextWindow.js 导出 `reconcileBadgeWindow` | [修前红] |
| C2 | 它内部复用 `resolveBadgeWindow(` 与 `nativeContextWindow(`(不许另写一套优先级) | [修前红] |
| C3 | App.jsx 里 `reconcileBadgeWindow(` 恰好 3 次(三个写入点) | [修前红] |
| C4 | `resolvedWindowMeta.set(` 次数 == `reconcileBadgeWindow(` 次数(没有绕过仲裁的写入) | [修前红] |
| C5 | 不得出现 init 直写 `resolvedWindowCache.set(…, event.linkedContextWindow)` | [修前红] |
| C7 | App.jsx 不得直接调用 `resolveBadgeWindow(`(必须经包装) | [修前红] |
| C8 | 每个 `resolvedWindowCache.set(` 写的都是仲裁结果 `picked.window` | [修前红] |
| C9 | init 写入点送 `linked / linkedSource / linkedOrigin` 三个槽 | [修前红] |
| C10 | result 写入点只送 `{ cli: cliWin.window }` | [修前红] |
| C11 | `/api/model-window` 回写送 `provider` + `providerOrigin` 两个槽 | [修前红] |

---

## 4. 必须真机验证(这批自动化测试**测不到**的)

自动化只能在 mac 上用注入的平台/路径/时钟模拟 Windows,以下四件事必须在真 Windows 机器上人工过一遍:

| 编号 | 真机场景 | 怎么操作 | 预期看到什么 |
|---|---|---|---|
| M1 | **`.exe` 装法能派发超长任务**(Bug 2 回归本体) | Windows + 官方安装器(`%USERPROFILE%\.local\bin\claude.exe`),在后台代理面板派发一个 7001 字符的任务 | 正常派发,不再弹「长度上限」报错 |
| M2 | **`.cmd` 装法的引号炸弹被拦** | Windows + npm 装法(`claude.cmd`),派发一个含约 7000 个英文双引号的 prompt | 400 报错,文案里的长度是**展开后的**(约 14105),不是 6999;且没有留下孤儿 hook 设置文件 |
| M3 | **Windows 冷启动首条消息之后,快照参数真的加上了** | 冷启动 GUI(claude 未预热,`resolveClaudeAsync` 要数秒),立刻发第一条消息;等约 1 分钟后再发一条 | 第二条消息起,发给 CLI 的参数里带上 `--system-prompt-snapshot`;第三方缓存命中率从个位数回到九成 |
| M4 | 超长命令行到底是截断还是报错 | INTERFACE §9 未验证假设 1:cmd.exe 超 8191 的真实行为 | 本轮不阻塞发版;只影响"为什么给 cmd 加门不给 CreateProcess 加门"的论证强度 |

### 明确**没有**覆盖的(别以为测过了)

1. **HTTP 层**:`POST /api/agents/background/dispatch` 没有真起服务打请求(本轮约定不起服务)。守卫的接线、顺序、文案都是**读源码文本**验证的 —— 能保证"代码长这样",不能保证"运行时真的返回了 400"。M1/M2 真机验收补这一段。
2. **React 渲染**:徽章分母只测了纯函数 + App.jsx 源码结构。"用户眼睛看到的那个 `xx/200K`"没有渲染测试(项目无前端测试框架),靠 M3 与日常 dogfood。
3. **真实 CLI 进程**:help 探测全部用注入函数,没有真的 spawn 过 `claude --help`;2s/8s 超时是否够用不在测试范围。
4. **并发/时序的真实性**:P9/P9b 用的是同一 tick 内的并发,不是真实的"启动预热 vs 用户发消息"跨事件循环竞争。
5. **`isBareClaudeAlias`**:只锁了"导出还在",没锁行为(本轮 INTERFACE 未给出它的行为契约,由 `check-context-window` 覆盖)。
6. **Windows 真机的路径解析**:`resolveClaude()` 在真 Windows 上解析出什么路径没有覆盖,测试里是直接喂的路径字符串。

---

## 5. 按 INTERFACE §5.4 改写的既有测试(只改点名的断言)

| 文件 | 改了什么 | 改完的状态 |
|---|---|---|
| `check-r108-windows-review.mjs` | **A7**:第二次预热的期望值 `true` → `false`(空串写的是失败表,不是"已有该 key");`calls === 1` 保留;补一条「TTL 到点后第三次预热会重探且返回 true」 | 修前 1 红(A7),其余 86 条全绿 |
| `check-r111-win-review-375.mjs` | **E1**:两条 7000 字面量断言 → 改为「守卫走 `winCmdLineBudget`、无 `prompt.length >`、无 7000、无自带 cmd/bat 正则、文案含展开长度」 | 修前 1 红(E1),其余 22 条全绿 |
| `check-badge-cli-window.mjs` | ⑤ 段内联接线改调 `reconcileBadgeWindow`(prevMeta + patch);⑥ 段两条源码锁改为「`reconcileBadgeWindow(` 出现 3 次 + 不得直接调 `resolveBadgeWindow`」与「result 送 `{ cli: cliWin.window }`」;顶部改命名空间 import(缺导出时只红一条,不整文件炸) | 修前红(卡在 ⑤ 段那条"缺导出"断言),①–④ 仍绿 |
| `check-r103-dev-badge-window.mjs` | ⑥ 段四条:`resolveBadgeWindow(` → `reconcileBadgeWindow(` + 全局不得直调;`source:'linked'` → `linkedSource: event.linkedContextWindowSource`;`Origin \|\| Source` → `linked:` 与 `linkedOrigin:` 两槽;`linkedSource: prevMeta?.origin` → 「3 次 + meta.set 次数相等」 | 修前红(卡在第一条) |
| `check-r103-window-denominator.mjs` | **C7** 改为「R8-6 块经 `reconcileBadgeWindow` 且只送 `{ cli: cliWin.window }`」;**C8** 改为「不得直写 CLI 自报值 + 必须写 `picked.window`」(去掉原来"有直写就退查 if 守卫"的软分支);顺带删掉因此没人用的 `GUI_SRC` 常量 | 修前 1 红(C7),其余 64 条全绿 |

**明确没动**(修完必须原样全绿):`check-r90-cache-followups`、`check-r108-dev-wiring`、
`check-r110-claude-cmd-quoting`、`check-r106-windows-npm-sdk-exe`、`check-context-window`、
`check-compact-window-linkage`、`check-context-session`、`check-compat-key-model`、
`check-r89-prompt-cache`、`tests/acceptance/**`;
以及 `node ~/.claude/skills/platform-compat-review/scripts/crt-roundtrip.mjs server/utils/win-cmd.js` 必须 15/15。

> 2026-09-05 契约 v2 修订(§1 同步失败不挡预热;预热自身失败才按 TTL 挡;并发预热用在飞标记):P10 改写为「T0 同步失败 → T0+TTL-1 预热探 1 次返回 true」,新增 P9c(在飞期间同步探测照常可探、第二次预热不 spawn)、P10b(sync 记录不挡预热 / prime 记录挡 TTL 两方向);check-r108-dev-wiring W16 由「恰好一张 Map」改为「正文表共用」语义锁。

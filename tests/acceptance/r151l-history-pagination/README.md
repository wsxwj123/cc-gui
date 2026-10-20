# r151l 历史消息分页 + 前端按需加载 · 验收

依据 `.devflow/r151l-history-pagination-接口.md` 的 7 条行为清单。新套件，不改产品代码、不改其它套件。

## 跑法

```sh
# 全量(自带共享实例 + dev server;A 组另起一次性实例)
tests/acceptance/r151l-history-pagination/run.sh

# 单跑某条
tests/acceptance/r151l-history-pagination/run.sh -g 'B1'

# 交付要求的落盘方式
R151L_PW_JSON="$PWD/.devflow/pw-r151l-step1.json" \
  tests/acceptance/r151l-history-pagination/run.sh 2>&1 | tee .devflow/test-output-r151l-step1.txt
```

端口只从 6700–6999 挑,硬拒 6677 / 6689 / 6710;收尾只按自己记录的 pid 收进程。

## 用例与基线(HEAD 64be2d15 未修复时)

| 用例 | 断言要点 | 未修复基线 |
|---|---|---|
| A1 | 不传 limit:300 条、hasMore=false、beforeCursor=0、total=300 | 红:三字段缺失 |
| A2 | limit=120:180..299、hasMore=true、beforeCursor=180 | 红:limit 被忽略,返回 300 |
| A3 | limit=120&before=180 → 60..179;before=60 → 0..59、hasMore=false | 红:同上 |
| A4 | 分页与全量的 usageTotals 逐值相等;且分页必须真的生效 | 红在“分页形状”断言(未修复时 usage 相等本来就成立) |
| A5 | 8 个非法 limit/before → 400 + HISTORY_INVALID_INPUT,不返回消息 | 红:全部 200 + 300 条 |
| A6 | 不传 limit 的旧行为:300 条、首尾、usageTotals 精确值 | 绿 |
| B1 | 首屏请求 limit=120、DOM 消息行≈120(±20)、顶部有含“更早”入口 | 红:无 limit、DOM 30、无入口 |
| B2 | 点两次:第一次 +≈120 且入口仍在;第二次到 300、入口消失、最早一条出现 | 红:无加载入口 |
| B3 | 20 条短会话:无加载入口、DOM=20 | 绿 |
| B4 | 首屏后追加文件并派发 `cgui:sessions-changed`:已加载数不减少、刷新请求 limit ≥ 已加载数 | 红:无 limit、DOM 30 |
| B4b | 补判官缺口1:先加载到 240 再追加+刷新;limit≥240、DOM 不减、第 181 条与第二批最旧一条仍在、追加可见 | 对空转版(刷新仍取 120)红在 limit;对丢旧前缀版红在旧消息消失 |
| B5 | 补判官缺口2:600 条连点四次;每页 120/游标对;>400 后 DOM 回落到渐进挂载、顶部有“更早的 N 条”提示、入口最终消失 | 对全量挂载 600 行版红在 `trimmedBelowFull`;对入口不消失版红在 `entryGoneAtEnd` |
| B6 | 补判官缺口3(可选):加载更早请求在飞时切会话,旧响应不混入 B;切回 A 从 120 重开且不串 | 对无旧响应守卫版红在 A 消息混入 B |
| B7 | 第三轮窄复审:切会话不泄漏 loading。A 的「加载更早」在飞时切到 B,B 的入口不得显示 loading/disabled、B 60 行不被 A 混入;旧响应落地后仍干净;切回 A 首屏 120、入口可点并正常加载(200) | 对把 A 的 `paging.loading` 抄进 B 新账的版本红在 B 入口「正在加载更早的消息…」disabled=true |

## 夹具

- `helpers/fixtures.mjs` 从 r151b 复制并裁剪:临时 HOME、工作区、`seedHistory()` 直写 jsonl。
- 300 条 = 150 个 user/assistant 来回;正文 `R151L-<tag>-H000..299`,tag 唯一防串。
- 每条 assistant 固定 usage(100 in / 20 out),`usageTotals` 可精确预期(150 apiCalls、input 15000、output 3000)。
- `appendUserRecord()` 往文件末尾追加一条合法 user 记录,用于 B4/B4b 静默刷新。
- `helpers/paging.mjs` 是补验收新增:点一次“加载更早”并等到这一次请求的 200 应答落地、入口退出 loading;只被 B4b/B5/B6 使用。
- A 组每个用例一个一次性实例(`helpers/instance.mjs`),自己 stop;B 组用 `run.sh` 的共享实例 + dev server。

## 界面定位口径

- 打开会话走侧栏搜索的“消息匹配”(搜首条消息正文,与 r151b x23 同一做法)。**不要搜 summary 标题**:
  启动时 `sessionsByProject` 尚未加载,标题匹配不到项目行。
- 消息行 = `[data-cgui="message-list"] [data-turn-uuid]`。
- “加载更早”入口 = 消息区里含“更早”的文字,**排除**既有渐进挂载的
  “更早的 N 条消息尚未加载,向上滚动继续加载”提示(`data-turn-placeholder`,不可点击)。
- 点击用 `dispatchEvent('click')`,不把入口滚进视口,避免滚动触发的自动补齐干扰计数。

## 已知规格冲突(交开发决策)

当前 `client/src/App.jsx` 已有渐进挂载 `MOUNT_WINDOW_K = 30`(0.2.383:只保留最近 30 轮,向上滚补)。因此 300 条会话打开时 DOM 只有 30 行,与接口文件行为 5 / 本套件 B1 的“DOM≈120、B2 两次后 300”不一致。要让 B1/B2 变绿,开发需要让“已加载的消息”全部渲染(或把窗口调到 120 起步),这会改变既有的 30 行窗口行为。测试按接口文件严格写,未擅自放宽。

## 补验收(B4b/B5/B6 判官缺口 + B7 窄复审)

- 判官指出 B4 空转:首屏 120 时刷新 limit=120,“limit ≥ 已加载”恒真。B4b 改为先加载到 240 再触发刷新。
- >400 条切回既有 30 行渐进挂载原来没有界面用例:B5 用 600 条连点四次覆盖(DOM 从 120→240→360→30,入口消失,`data-turn-placeholder` 出现)。
- 切会话旧响应丢弃:B6 用 `page.route` 只延迟 A 的“加载更早”请求,切到 B 后再让旧响应落地,断言不串会话、切回 A 的首次请求仍是 limit=120。
- 第三轮窄复审的 loading 泄漏:B7 用 `page.route` **扣住**A 的“加载更早”请求不返回(比固定 sleep 确定),切到 B 后先断言 B 的入口无 loading/disabled 文案,再放行旧响应并复查;切回 A 后点击入口必须正常 200。只看 DOM/网络,不读内部 store。
- 2000 条上限不做 UI 用例(要加载 17 页,太慢):由 `tests/unit/check-r151l-history-page.mjs` 的 `historyFetchLimit` / `trimRecentMessages` 单测覆盖。
- 原“已知规格冲突”一节写于 HEAD 64be2d15;接口文件勘误(≤400 全量挂载、>400 才渐进挂载)落地后,B1/B2/B5 按新规则断言,该冲突已消解。

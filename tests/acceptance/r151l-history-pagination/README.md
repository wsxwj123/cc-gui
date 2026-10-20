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

## 夹具

- `helpers/fixtures.mjs` 从 r151b 复制并裁剪:临时 HOME、工作区、`seedHistory()` 直写 jsonl。
- 300 条 = 150 个 user/assistant 来回;正文 `R151L-<tag>-H000..299`,tag 唯一防串。
- 每条 assistant 固定 usage(100 in / 20 out),`usageTotals` 可精确预期(150 apiCalls、input 15000、output 3000)。
- `appendUserRecord()` 往文件末尾追加一条合法 user 记录,用于 B4 静默刷新。
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

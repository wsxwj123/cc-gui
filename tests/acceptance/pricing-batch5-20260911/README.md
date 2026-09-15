# Pricing batch 5 acceptance tests (PR-*) — 2026-09-11

Scope: **R20**（内建 provider 官网自动价格）、**R21**（分时/分档/币种/生效时间）、**R22**（OpenAI 缓存写量）、
**R23**（Anthropic 混合 TTL 与旧倍率回退）、**R24**（价格来源与命中口径）。
Contract source: `.devflow/INTERFACE.md`「官方价格、用量和展示（R20–R24）」+「公共规则、身份与错误」+ 补充边界矩阵
pricing/usage 行；判词词汇表见 `.devflow/TEST-PLAN-pricing-batch5.md`。

## Safety and setup

1. Run against a dedicated worktree instance on an unused loopback port (never 6677/6689) whose data root
   lives under some `tests/acceptance/.../.artifacts` directory. The helper refuses non-loopback hosts and the
   two protected user ports, and refuses a manifest whose `dataRoot` is not under `tests/acceptance/.../.artifacts`.
2. `BASE_URL` points at that instance; `WORKTREE` is this worktree.
3. Copy `fixture-manifest.example.json` to `fixture-manifest.local.json` (gitignored) and fill it through the
   public UI/API only. No cookies, keys or tokens; the loader rejects credential-looking field names.
4. Observation is limited to the contract's published surface: `GET /api/pricing`, `POST /api/pricing/refresh`,
   `GET /api/sessions/:sid/messages` (usageTotals), the three hit-rate labels, 「刷新价格」, the top-bar `用量`
   panel, `[data-cgui=provider-selector|model-selector|home-input|topbar]`, `[data-testid=home-send]`, and the
   sidebar search box. No internal store, no private JSONL, no injection.
5. Trace/screenshots/video are off; no test prints private payloads.

```bash
# list without contacting a server
npx playwright test -c tests/acceptance/pricing-batch5-20260911/playwright.config.mjs --list

# ① 价目/展示组 + 模型组（PR-01…PR-28、PR-43）：跑在批次指定的隔离实例上
BASE_URL=http://127.0.0.1:57280 npx playwright test -c tests/acceptance/pricing-batch5-20260911/playwright.config.mjs

# ② stub 组（PR-29…PR-42）：跑在本套件自己的隔离实例上（夹具与它同源，见「Stub upstream fixture」）
BASE_URL=http://127.0.0.1:57290 PRICING_ALLOW_STUB=1 \
  npx playwright test -c tests/acceptance/pricing-batch5-20260911/playwright.config.mjs -g 'PR-(29|3[0-9]|4[0-2])'
# 只要某个用例：
BASE_URL=http://127.0.0.1:57290 PRICING_ALLOW_STUB=1 \
  npx playwright test -c tests/acceptance/pricing-batch5-20260911/playwright.config.mjs -g 'PR-33 '
```

两组分开跑的原因：stub 组要往隔离实例里加两个自定义 provider（openai 协议段 + anthropic 协议段），而批次指定实例
（57280）的 provider 列表被另一个批次占着，不能动；本套件因此带自己的数据根与端口。

## Environment guards

| flag | gates | why |
| --- | --- | --- |
| `PRICING_ALLOW_MODEL=1` | PR-26, PR-27, PR-28, PR-29, PR-43 | needs one finished real model run in the fixture session (hit-rate / cost / usage fields) |
| `PRICING_ALLOW_STUB=1` | PR-30 … PR-42 | needs the operator-prepared stub provider below |

Without the flag the case throws `ENVIRONMENT_BLOCKED` — a non-pass, never a product verdict. Nothing is
silently skipped; a missing fixture section is also `ENVIRONMENT_BLOCKED`.

By design this suite is **red on a build that has not implemented R20–R24 yet**: on 0.2.378 `GET /api/pricing`
returns only `{source,fetchedAt,prices}`, `POST /api/pricing/refresh` is a 404 HTML, `?refreshId=` is ignored,
the hit-rate labels are 「本轮命中/本轮命中率/平均…」 and cost shows a single ¥ figure. Those are the failures the
cases exist to surface.

## Fixture preparation

### already prepared in this worktree (`fixture-manifest.local.json`)

| section | cases | how it was made (public UI only) |
| --- | --- | --- |
| `sessionFlow` | PR-26…PR-29, PR-43 | 首页输入框发一条 `Reply with exactly: PR5_FIXTURE_1` → 真实模型回合结束 → 侧栏搜索该标记能命中结果行；`sessionId`/`projectHash` 取自应用自己的 `GET /api/sessions/:sid/messages?projectHash=…` 请求。**属于批次指定实例（57280）**，跑这一组时用它的 BASE_URL |
| `stubProvider` / `stubProviderClaude` | PR-30…PR-42 | 本套件自己的隔离实例（数据根 `tests/acceptance/pricing-batch5-20260911/.artifacts/runtime-data`，端口 57290），制备步骤见下节。`dataRoot` 字段指的就是这个数据根（只做"别指向真实用户 profile"的守卫用） |

### Stub upstream fixture ( R22/R23 需要控制 usage 数值 )

R22/R23 的核心是"给定上游 usage 字段后如何归一/计价"。真实供应商不会按需返回 `cache_write_tokens` 或
`ephemeral_5m/1h_input_tokens`，所以这一组用协议 fixture（INTERFACE 允许 fixture 用于边界/异常）。
stub 见 `helpers/stub-upstream.mjs`，监听 `127.0.0.1:57881`（用例自己在 beforeAll 起，端口已占用则复用常驻的那个）。

#### 场景 ↔ 协议映射（必须两段都配）

同一个 stub 同时实现 `/v1/chat/completions` 与 `/v1/messages`，但 **协议决定哪条产品代码路径被验证**，
所以 manifest 分两段、用例逐条声明协议（`usage-normalize.spec.mjs` 的 `SCENARIO_PROTOCOL`）：

| manifest 段 | provider type | 场景 | 为什么必须是这一段 |
| --- | --- | --- | --- |
| `stubProvider` | `openai` | `chat_write`、`negative`、`overflow`、`inconsistent` | R22 的口径就发生在 Anthropic↔OpenAI 转换处（`server/utils/openai-usage.js`）：`prompt_tokens` 含读写要减出普通 input；负数/非有限标 USAGE_INVALID；`read+creation > prompt_tokens` 标 USAGE_INCONSISTENT（后者需要 `prompt_tokens` 这个 Anthropic 口径里没有的总量字段） |
| `stubProviderClaude` | `anthropic` | `mixed_ttl`、`no_ttl_split`、`unknown_model`、`cum_a`、`cum_b`、`zero` | `cache_creation.ephemeral_5m/1h_input_tokens` 只存在于 Anthropic Messages 响应；其余几条与协议无关，放直连段少一层回环代理 |

缺哪一段，该组用例就报 `ENVIRONMENT_BLOCKED`（点名缺的段），**不换协议凑数**：`chat_write` 若用 anthropic 段跑，
上游报的本来就是归一后的数，断言会空转。

#### 制备步骤（本套件自己的隔离实例，数据根 `tests/acceptance/pricing-batch5-20260911/.artifacts/runtime-data`）

```bash
SUITE=tests/acceptance/pricing-batch5-20260911
ROOT=$PWD/$SUITE/.artifacts/runtime-data
PORT=57290                      # 任意空闲回环端口，别用 6677/6689

# 1) 建数据根与 settings.json：CLI 要打的地址先写死到 stub（anthropic 直连段）
mkdir -p "$ROOT/home/.claude" "$ROOT/home/.claude-gui" "$ROOT/fixture-workspace"
#    settings.json 的 env 至少含：
#      ANTHROPIC_BASE_URL=http://127.0.0.1:57881  ANTHROPIC_AUTH_TOKEN=<占位串>
#      ANTHROPIC_MODEL=pr5-stub-model             ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL=pr5-stub-model
#      CLAUDE_CODE_CARVED_SLATE=1  CLAUDE_CODE_ATTRIBUTION_HEADER=0  DISABLE_AUTOUPDATER=1

# 2) 起实例（独立 HOME = 数据根，避免碰用户 profile）
cd "$ROOT" && env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  HOME="$ROOT/home" PORT=$PORT CGUI_DISABLE_FILE_WATCHER=1 CGUI_ENABLE_LOCAL_ROUTES=1 CGUI_TAURI=1 \
  nohup node "$PWD/../../../../server/index.js" > "$ROOT/server.log" 2>&1 &

# 3) 两个协议段各建一个自定义 provider（公开 HTTP 接口，与 GUI「管理 Provider」同一个）
curl -s -X POST http://127.0.0.1:$PORT/api/custom-providers -H 'content-type: application/json' \
  -d '{"name":"PR5 Stub Claude","type":"anthropic","baseURL":"http://127.0.0.1:57881","apiKey":"pr5-stub-placeholder","models":["pr5-stub-model"]}'
curl -s -X POST http://127.0.0.1:$PORT/api/custom-providers -H 'content-type: application/json' \
  -d '{"name":"PR5 Stub","type":"openai","baseURL":"http://127.0.0.1:57881","apiKey":"pr5-stub-placeholder","models":["pr5-stub-model"]}'

# 4) 让项目出现：在 fixture-workspace 里跑一次 CLI 会话（同一 HOME，会打到 stub）
cd "$ROOT/fixture-workspace" && HOME="$ROOT/home" \
  claude -p "Reply with exactly: PR5_FIXTURE_1" --model pr5-stub-model --output-format json

# 5) 切到 openai 段一次，记下【本实例进程内 openai 代理】端口（实例重启会变）
curl -s -X POST http://127.0.0.1:$PORT/api/provider/switch -H 'content-type: application/json' \
  -d "{\"id\":\"$(curl -s http://127.0.0.1:$PORT/api/custom-providers | python3 -c '
import json,sys;print([p["id"] for p in json.load(sys.stdin)["providers"] if p["type"]=="openai"][0])')\"}"
lsof -nP -iTCP -sTCP:LISTEN -a -p "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t)" | grep -v ":$PORT\b"
#   → 除 $PORT 外那个监听端口就是它；写进 manifest 的 stubProvider.cliBaseURL

# 6) 写 manifest（fixture-manifest.local.json，gitignored）：
#    stubProvider        { displayName:"PR5 Stub",        modelId:"pr5-stub-model", protocol:"openai",
#                          baseURL:"http://127.0.0.1:57881", cliBaseURL:"http://127.0.0.1:<第5步的端口>" }
#    stubProviderClaude  { displayName:"PR5 Stub Claude", modelId:"pr5-stub-model", protocol:"anthropic",
#                          baseURL:"http://127.0.0.1:57881", cliBaseURL:"http://127.0.0.1:57881" }
```

场景由提示词里的 `PR5SCEN=<name>` 选择（用例自动拼进 prompt；同一会话的第二回合按**最后一个**标记走）。

#### 上行走到了哪儿（夹具自检 + 一处修复）

切换 provider 时产品会把 `ANTHROPIC_BASE_URL` 指向回环代理；**本机若装着常驻代理 daemon（8798/8799）**，
产品按设计改写成 daemon 端口（`App.jsx`「原理(协议路由)」），而 daemon 只认用户 profile 里的 provider，
不认隔离实例的自定义 provider → CLI 503 `OpenAI upstream not configured`。公开版没有这个 daemon，所以这是
本机部署件的产物，不是产品缺陷。用例因此做两件事（都只动本隔离实例）：

- **自检**：`GET /api/provider` 报的 `protocol`/`model` 必须与该场景声明的协议段一致，否则直接说切换没生效；
- **修复**：只在「看到的地址是回环」时，用公开 `PUT /api/settings-env` 把 `ANTHROPIC_BASE_URL` 指回 manifest 的
  `cliBaseURL`（anthropic 段 = stub 直连；openai 段 = 本实例进程内 openai 代理，协议翻译仍走产品自己的代理），
  并在报告的 annotation 里写明这次改写。`cliBaseURL` 没人听（实例重启过）时报 `ENVIRONMENT_BLOCKED`，
  不会变成莫名其妙的回合超时。

**未验证**：provider/model 下拉的精确交互只在设计轮观测到控件存在（`[data-cgui=provider-selector]`、
`[data-cgui=model-selector]`）；实现轮实测:弹层是 portal 到 body 的 `div.glass-popover`，行文本形如
`PR5 Stub1 模型openai自定义`（相邻 span 之间没有空白）。`selectFromControl` 因此按「弹层内、按钮、含与名字精确
相等的节点」定位，找不到时抛 `ENVIRONMENT_BLOCKED` 并列出弹层里现有的行。注意弹层开着时点弹层外会立即关闭它
（`AnchoredPopover` 的 outside 判定），所以 dismissOverlays 必须在开弹层**之前**做。

### Not preparable in this environment

| case/clause | why | how to re-verify later |
| --- | --- | --- |
| `SOURCE_TIMEOUT`（单源 15 秒） | 没有公开开关能把某个官方源变慢/挂起 | 对可注入延迟的测试代理跑同一用例 |
| `SOURCE_INVALID_CONTENT`（200 首页/空表/币种不明） | 需要让官方源返回错误内容 | 用本地反相代理替换某一源再跑 |
| `MODEL_UNRESOLVED` / `PRICE_DIMENSION_UNKNOWN` 的触发 | 同上，需在源内容里制造未解析模型/缺维度 | 同一条反相代理路径 |
| refreshId 24h 过期 `PRICING_REFRESH_EXPIRED`、重启后 `404` | 需要等 24 小时或重启实例 | 等待窗口到期 / 重启该隔离实例后重跑 PR-19 的未知 id 分支 |
| 「24 小时自动刷新」冷启动半程 | 需要空缓存实例 | 用全新 data root 起一个新实例后重跑 PR-20 |
| 峰谷/未来价按请求时点计价（R21） | 需要一个在特定北京时间跑向 deepseek 官方源的真实请求 | 在高峰与空闲时段各跑一次同模型请求比对费用 |
| 真实上游返回 `cache_write_tokens`/混合 TTL 并计价 | 需要官方账号与真实响应；本轮用 stub 覆盖计算路径 | 官方源真实发送后重跑 PR-30…PR-34 |
| Tauri/WKWebView 与 Windows 面 | 本批只在 Chromium/macOS 跑 | 在真桌面应用重跑 UI 组 |

## Design-time observations (0.2.378, isolated instance 57280)

- `GET /api/pricing` → `{source:'litellm',fetchedAt,prices{model:{input,output,cacheRead,cacheWrite}}}`；无
  `schemaVersion/providers/quotes/refresh`。`POST /api/pricing/refresh` → 404 HTML（Express 兜底）。
  `GET /api/pricing?refreshId=x` 忽略参数、照常 200。
- `GET /api/sessions/:sid/messages` 的 `usageTotals` = `{input,output,cacheRead,cacheCreation,apiCalls}`（无 TTL 分项）。
- 会话视图命中率文案：顶部徽章「本轮命中 90.5%」、轮末「本轮命中率 90.5%」、面板「缓存命中率 95.1%」；费用 `¥0.034`；
  用量面板有「第三方计费合计 · Anthropic 走订阅 ¥7.96」（固定汇率折算）。三处合同名称均不存在。
- `用量` 面板里可见按钮：`刷新`、`导出 CSV`（无「刷新价格」），标题「用量统计」「总览」「按 PROVIDER · 模型」「最近用量」。

## Limits of this suite

Covered: pricing API schema/枚举/覆盖分母/来源主机/币种/quoteId 稳定性/未知维度 null/多档不覆盖/刷新 202 与终态语义/
逐家成败/非法输入 400/refreshId 生命周期/缓存窗口不重复抓取/刷新期间旧结果标 stale；UI 口径名、可展开来源、
币种分离、逐家刷新结果；用量五类字段、重放去重、缓存写归一、混合 TTL 不重复相加、加权命中率 90%、分母 0「—」、
USAGE_INVALID/USAGE_INCONSISTENT、未知型号不套旧价、read=0 不伪造。

Not covered: 上表 not-preparable 各项；「与官方源逐字一致」只能靠 PR-04 的主机白名单与 PR-10 的派生一致性间接保证，
不逐条比对官网数字（那会写成会随调价失效的断言）；`modelCount` 是否含未解析条目的精确口径（合同未逐字说明，
只断言双向自洽）；「302ai 未经官方补证不得标 USD」是人工判据，机器只能保证"有价必有币种+官方源主机"。

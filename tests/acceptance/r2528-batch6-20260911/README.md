# Batch 6 acceptance tests (R25–R28) — 2026-09-11

Scope: **R25**（思考签名与历史处理兼容：历史变换 dry-run/提交合同）、**R26**（claudebotlife worker
历史处理与外部 worker 入口）、**R27**（HDSI/Brain 兼容边界）、**R28**（CLI 外订阅凭证辅助请求）。
合同来源：`.devflow/INTERFACE.md`「官方辅助能力、历史与外部项目（R25–R28）」+「公共规则、身份与错误」
+ 补充边界矩阵 history/official-query 行。人话判定口径见 `.devflow/TEST-PLAN-r2528-batch6.md`。

黑盒：只走公开 UI（role/text）与公开 HTTP（`/api/*`）；不读 store、不读私有 JSONL、不注入。
观测只使用合同公布的东西：响应字段、`data-*`、可见文案。

## 跑法

```bash
# 只列用例（不连服务）
npx playwright test -c tests/acceptance/r2528-batch6-20260911/playwright.config.mjs --list

# 全量（隔离实例；BASE_URL 必填）
BASE_URL=http://127.0.0.1:57280 WORKTREE="$PWD" R2528_ALLOW_LIVE_CLI=1 \
  npx playwright test -c tests/acceptance/r2528-batch6-20260911/playwright.config.mjs

# 单条
BASE_URL=http://127.0.0.1:57280 WORKTREE="$PWD" \
  npx playwright test -c tests/acceptance/r2528-batch6-20260911/playwright.config.mjs -g 'R28-15'
```

`R2528_ALLOW_LIVE_CLI=1` 只在需要"会话里有已存用户消息"的 R25 用例上必需：夹具会话由
`POST /api/chat` 现建（会起一次本地 CLI 回合，隔离实例上 provider 是自建代理/桩，不产生模型输出）。
不设它时这些用例报 `ENVIRONMENT_BLOCKED`，不算通过。

## 环境守卫

| 变量 | 作用 | 不设时的行为 |
| --- | --- | --- |
| `R2528_ALLOW_LIVE_CLI=1` | 允许用 `POST /api/chat` 现建夹具会话（起本地 CLI 回合） | 相关用例 `ENVIRONMENT_BLOCKED` |
| `R2528_ALLOW_MODEL=1` | 允许真正需要模型产出的用例（R25-17 压缩摘要） | `ENVIRONMENT_BLOCKED` |
| `R2528_ALLOW_EXTERNAL=1` | 允许触碰仓库外工程（R26/R27 白名单命令/桥地址） | `ENVIRONMENT_BLOCKED` |
| `R2528_FIXTURES=/abs/path.json` | 换一份夹具清单（默认 `fixture-manifest.local.json`） | 用默认路径 |

`BASE_URL` 只接受回环地址；helper 直接拒绝 6677/6689（用户实例）。夹具清单里不允许出现
secret/password/cookie/authorization/api-key/resume-token/access-token 之类字段名（加载即报错）。

## 夹具

本套件在本次设计轮**实际制备**的（都在隔离实例上、只经公开入口）：

| 夹具 | 怎么制备 | 谁在用 |
| --- | --- | --- |
| `historyWorkspace.path` | 目录由 `createFixtureSession` 自动创建（隔离实例数据根下） | 所有现建夹具会话的 cwd |
| `historySession` | 侧栏搜索能搜到的既有会话（`R2528_TRIM_A_1`，2 条消息） | R28 UI 用（开一个会话让面板坞出现） |
| `stubProvider` | 实例上已有的非官方 provider（"PR5 Stub"，`http://127.0.0.1:57881`） | R28-15（用例自己在该端口起协议桩） |

发起历史操作本身的 UI 入口**合同没有固定**，所以 `historyUi.opEntryName` 由操作者填；
未填时 R25-26/27 报 `ENVIRONMENT_BLOCKED`（不是跳过、不是假过）。

## 不可制备（本环境实测）

| 用例 | 为什么 | 复验条件 |
| --- | --- | --- |
| R25-13 运行中 → 409 SESSION_RUNNING | 需要"回合正在跑"的会话；隔离实例的回合秒级结束 | 把一个 provider 指向只接受 TCP 不答的端点后发一条消息，在挂起期间跑该用例（填 `runningSession`） |
| R25-17 压缩摘要 | 摘要要真实模型产出 | 设 `R2528_ALLOW_MODEL=1` + 有真实模型 |
| R25-24 越权 403 | 回环实例只有一个完全授权主体 | 第二主体 + `secondPrincipal`（含 `backupViewPathTemplate`，合同未固定读备份路由） |
| R25-25 兼容性未验证 409 | 需要一个"服务端判定无法验证签名兼容"的会话 | 用旧账号/跨模型历史，填 `incompatibleSession` |
| R25-26/27 查看备份 UI | 合同没固定发起历史操作的 UI 入口 | 填 `historyUi.opEntryName`（可加 `confirmNames`） |
| R26-01/02 | 入口是仓库外脚本（`spawn-worker.sh`），跑起来会动用户的常驻 worker | `workerEntry.readonlyCommand`（只读，如该脚本的 `--help`）/ `workerDuplicateStart`（可丢弃目标） |
| R27-01/02 | HDSI/Brain 是仓库外部署 | `bridge.baseURL` + 变更前记录的 `/health` 形状基线 |
| R28-17 超时 504/200 | 需要停滞依赖 | `stalledDependency`（kind/providerId） |
| R28-18 stale | 需要先有一次成功 + 之后失败的同账户 | `staleAccount.mode` |
| R28-19 切账户失效 | 两个官方账户 | `twoAccounts.switchPath/switchBody` |
| R28-20 不自行读 token | 需要出站请求录制 | `outboundRecording.observedRequestsPath` |

## 设计轮实测（2026-09-11，隔离实例 127.0.0.1:57280，worktree 构建 0.2.378）

- 全量结果：**54 条，5 通过，49 失败**（14 条是 `ENVIRONMENT_BLOCKED`，35 条是断言失败＝合同未实现）。
  原始日志：`.artifacts/design-run.log`。
- 通过的 5 条：R25-23（正常发送原样追加）、R28-01（非官方 provider 不冒官方）、R28-07（查询不改
  provider）、R28-08（查询不写会话）、R28-21（额度区仍存在）。
- 该构建上的行为（设计期观测，非结论）：
  - `GET /api/subscription-usage` 无 probe 返回 `{"official":false}`；`?probe=1` 返回
    `{"official":true,"error":"未找到 Claude 登录凭证（请在 Claude Code 中登录）"}`——没有
    status/source/fetchedAt/accountScope/三段额度字段，也没有稳定 `code`。
  - `POST /api/provider/fetch-models` 省略 id 返回 `{"models":[],"note":"..."}`；`{id}` 已存在的
    非官方 provider 会真的读上游 `/v1/models`；官方分支（`builtin-official`）返回
    404 `{"error":"provider 不存在或非 OpenAI 格式"}`。
  - 历史路由存在但是旧形态：`{error:"..."}`（无 `ok/code`），**没有 dry-run 概念**——给
    `dryRun:true` 或缺 `dryRun` 都会真的执行截断（R25-01/02/09 因此红）；未知预览 token 也直接执行
    （R25-09 收到 `{"trimmed":true,...}`）。
  - 一次被执行的 trim 之后，该会话的本地 CLI 进程从 `/api/processes` 里消失（R25-22 观测到）——
    与"预览/操作不停止任务"的合同相反。
  - `POST /api/sessions/:sid/repair-official-compat` 对一个回合已结束的会话返回 409
    `{"error":"会话正在运行,请先停止再清理"}`：该路径把常驻的本地 CLI 进程也算"运行中"（口径歧义，见下）。
  - R28-15 观测到：读取非官方（OpenAI 形态）provider 的 `/v1/models` 时，请求带了
    `anthropic-version` 头——与"非官方分支不注入 Claude 专用参数"相抵（待裁决的候选发现）。
  - UI：用量面板里有「额度 · PR5 STUB」区（第三方 provider 额度，失败时显示"额度接口请求失败"）；
    全页没有"额度暂不可用"、也没有 `/usage` 入口。

## 合同歧义（原样交回主裁决，未自行定夺）

1. `GET /api/subscription-usage` 不带 probe、且当前是非官方 provider 时，`status/source/fetchedAt/
   accountScope/session/weekAll/weekScoped` 是否也必须在 200 里出现？本合同按"必须出现（可 null）"写测试
   （R28-02），若本意是"只在 probe 时给"需改。
2. "运行中"（409 SESSION_RUNNING）指回合在跑，还是把常驻的本地 CLI 进程也算？本套件的夹具会话是
   "回合已到终态"，若实现按后者判定，R25 多条用例会以 409 收场（用例会指名这条歧义）。
3. 历史操作的路由（`POST /api/sessions/:sid/<op>`）与业务参数名按合同表实现；但**备份查看**的路由合同没有
   固定，R25-24 用夹具的 `backupViewPathTemplate`，R25-26/27 走 UI。
4. `detached` 之外的"结果 unknown"（已达提交点后响应丢失）无法在黑盒里稳定制造，未写用例（见缺口）。

## 本套件覆盖不到

- R25 里"实际继续发送"那半（变换后真的发给官方模型且不报签名错）——需要真实 Claude 账号与目标模型条件；
  本套件只覆盖到"变换与拒绝的行为面"，按合同这半未通过前 R25 不算完成。
- 跨重启 exactly-once、5 分钟预览过期的真实等待、备份清理、第二主体越权、客户端取消语义。
- R26/R27 的仓库外工程本体（本套件只有守卫式探针，且默认一个都不执行）。
- 真实订阅额度成功路径、账户切换、60 秒 TTL 的过期侧、Tauri/WKWebView 与 Windows 真机。
- 夹具会话会留下产品的常驻（空闲）本地 CLI 进程，这是产品设计行为；跑完请按需关停隔离实例。

## 跑完收尾（设计轮就是这么做的）

夹具会话会让产品保留常驻（空闲）的本地 CLI 进程（回合结束转 idle 复用）。收尾办法：

1. `GET /api/processes` 取 `sessionProcesses`，**按每行的 `cwd`** 过滤出落在本套件
   `.artifacts/runtime-data/fixture-workspace-r2528` 下的行（不要按端口或名字猜）。
2. 对这些 `pid` 用 `ps -o command=` 复核确实是 `claude --output-format stream-json …`，再 `kill -TERM`。
3. 复核 `/api/processes` 的 `sessionProcesses` 归零；用户实例 6677/6689 的进程一个都不碰。

设计轮收尾后：本套件夹具进程 43 个全部终止，实例 `sessionProcesses` 为 0，6677 仍 200。

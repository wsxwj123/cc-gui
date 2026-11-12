# r177-stream-reattach 黑盒验收套件

验什么:发出消息后,命令行要过几秒才开口。这期间切到别的会话再切回,回复正文应当和不切走时一样实时显示、逐片段增长;之后再切换不重复、不缺少;点停止后已显示的内容保留;启动失败后不残留「正在输出」。只通过页面观测(`[data-cgui="message-list"]` 里 `片段\d{4}` 的个数、`[data-cgui="stop-btn"]`、`[data-cgui="session-row"]`),不碰内部模块。

## 怎么跑

```sh
bash tests/acceptance/r177-stream-reattach/run-isolated.sh                     # 全量:WebKit 全部 S1~S11 + Chromium 的 S1/S2/S3
bash tests/acceptance/r177-stream-reattach/run-isolated.sh --project=webkit    # 只跑 WebKit
bash tests/acceptance/r177-stream-reattach/run-isolated.sh --grep 'S6 '        # 额外参数原样转给 playwright
R177_HOLD=1 bash tests/acceptance/r177-stream-reattach/run-isolated.sh         # 只起隔离实例不跑用例(调试用)
```

整套约 10 分钟,输出建议存文件:`... > tests/acceptance/r177-stream-reattach/.artifacts/full.log 2>&1`。
不要同时跑两份,也不要和别的验收套件同时跑。

## 隔离

- 端口:后端 6793、开发服务器 6794(写死,启动前 `lsof` 确认空闲,被占就退出;硬拒 6677 / 6689 / 6710 / 8798 / 8799)。
- `HOME` 与 `USERPROFILE` 都指向 `.artifacts/runtime-data/home`;后端进程带 `tests/unit/q8-helpers/cu-preload.mjs` 预加载并设 `CU_TEST_HOME`;`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`CU_ALLOW_*` 全部清掉;`CGUI_DISABLE_FILE_WATCHER=1`。
- 命令行是假的:PATH 最前面挂 `.artifacts/fakebin/claude`,转交 `helpers/fake-claude.mjs`。
- 收尾只按 `.artifacts/pids` 里记录的 pid 结束进程。

## 夹具

- **工作区放系统临时目录**(`os.tmpdir()` 的真实路径,macOS 上是 `/private/var/folders/…/T/r177-ws-<标记>`),不放 `.artifacts/`:套件所在工作树的路径带 `.claude/worktrees/`,会让工作区被应用判成工作树而不列进侧栏。也不放 `/tmp`、`/private/tmp`(同样不列)。这些目录不会自动清理。
- **每个用例现建一对全新的会话甲、乙**(各带一轮完整历史、标题里带各自独有的标记 `R177J<标记>` / `R177Y<标记>`),并有独立的工作区,避免上一个用例的 1200 片段留在历史里污染计数。甲发过消息后侧栏标题可能被改写:找不到带甲标记的行时取「不是乙」的那一行;S8 的新会话取「既不是甲也不是乙」的那一行。
- 侧栏的工作区分组默认折叠,用例先点 `project-row` 展开才有 `session-row`。
- 关着文件监听(打包应用就是这样)时,新会话不会自己出现在侧栏,S8 刷新页面后才点它的行。

## 假命令行的场景文件

`.artifacts/runtime-data/home/fake-claude/scenario.json`(假命令行每收到一条用户消息读一次;用例开始前写):

| 字段 | 含义 | 默认 |
|---|---|---|
| `startDelayMs` | 收到用户消息后静默多久(不输出事件、不写会话文件,连用户消息也不写) | 8000 |
| `chunkIntervalMs` | 正文相邻片段间隔 | 50 |
| `chunkCount` | 正文片段总数,片段文字 `片段0001。`、`片段0002。`… | 1200(S5、S10 用 400) |
| `mode` | `normal` 或 `startfail`(先等满启动延迟,写退出时刻,stderr 写 `fake start failure`,退出码 3) | `normal` |

一回合:延迟 → 用户消息落盘 → init → 思考(结束后落盘)→ 正文逐片段流式输出 → 全部输出完才整段落盘 → 回合结束。收到 `control_request`/`interrupt` 时立刻停,回成功应答,输出半截正文的助手消息 + `[Request interrupted by user]` 用户消息 + `error_during_execution` 的结束事件,前两条同时落盘。工作目录名含 `cgui-title-` 的调用(起标题)立刻回短标题。

## 状态文件

`.../fake-claude/status-<工作区目录名>.json`(原子替换),按工作区分开,上一个用例遗留的进程不会写乱下一个用例:

`openedAt`(开口时刻,即 T0)、`chunksEmitted`(已输出片段数)、`interruptedAtChunks`(被打断时已输出片段数,否则 null)、`ended`(回合已收尾)、`exitedAt`(启动失败模式下的退出时刻)。

## 用例收场(abort 文件)

每个用例结束后(`afterEach`)往 `.../fake-claude/abort-<工作区目录名>` 放一个文件,假命令行看到就把当前回合尽快正常收尾(不算打断)。原因:上一个用例遗留的长回合不结束时,后端起不来下一个用例的命令行(实测:紧接着的用例 20 秒内夹具不开口)。

## 假命令行的两个实测发现

- 新会话(不是 `--resume` 起的)第一次落盘时,假命令行先写一行 `summary`。没有这一行时,一个正在跑第一回合、会话文件里只有用户消息和思考块的新会话,刷新后侧栏也不列出(实测到 T0+40 秒都不列;回合结束、有了完整助手消息后才列)。加了 summary 行后,T0+3 秒的刷新就能列出。
- 发出消息后一直停在乙(S2 的做法),有时消息要等点回甲才真正送到命令行:S2 偶发「切走 16 秒夹具未开口,点回甲后约 8.2 秒才开口」。S2 把这种情况当作断言失败并打印 `[S2 诊断]`。

## 用例

S1~S11 与接口文件行为清单一一对应,用例名以编号开头。S11(只在 WebKit 跑)验排队中的消息不被打乱:会话甲发 A,发起请求发出 0.3 秒后依次点「入队」入 B、C(各带独有标记),开口前切到乙、2 秒后切回;从点回起到 T0+10 秒,每次读页面排队项都恰好两条且顺序 B、C,全程 `POST /api/chat` 只有 A 那一次,T0 后 6 秒内片段数 ≥ 20。另有只打印不断言的 `[S11 诊断]`:点回后每 2 秒的「排队项顺序/发起对话累计次数/页面片段数」。S5、S10 用 400 片段版(用例名里写明,期望值 400)。S1、S3 另有只打印不参与断言的诊断输出(`[S1 诊断]`、`[S3 诊断]`):S1 是 T0 起每 2 秒的「页面片段数/夹具已输出数」,读到 T0 后 24 秒;S3 是 N、切回后 2 秒时的页面片段数和夹具已输出数。

## 没覆盖

- 只看页面,不查内部状态;假命令行不是真命令行,真实命令行的启动耗时、输出节奏只按接口文件模拟。
- 启动失败的报错文字显不显示不在本轮范围,不断言。
- Chromium 只跑 S1、S2、S3。

# cu-grant-ui-20260913 · computer use「按应用授权 UI」验收(CG-* 29 例)

验的是 `.devflow/INTERFACE-20260913-cu-grant-ui.md`(合同)§F 的用例清单:两个新只读端点
(`GET /api/computer-use/apps`、`GET /api/computer-use/app-info`)、授权面板(CuGrants)、
以及"授权/撤销对 MCP 同一个实例立即生效"。用例按合同的 ID 一条条对号,不另立判据。

## 怎么跑

```sh
cd tests/acceptance/cu-grant-ui-20260913

# 全量(HTTP + 面板 + MCP,约 1 分钟)
CU_ALLOW_GRANT_WRITE=1 CU_ALLOW_FIXTURE=1 CU_ALLOW_INPUT=1 CU_SCREEN_SCOPE_OPTED_IN=1 ./run-isolated.sh

./run-isolated.sh --no-ui -g 'CG-0[1-5]'   # 只跑 HTTP 面(不起 dev server)
./run-isolated.sh --ui -g 'CG-1[0-5]'      # 只跑 UI/MCP 面
```

守卫(缺哪个就在对应用例上报 `ENVIRONMENT_BLOCKED`,不静默跳过):

| flag | 门控什么 | 为什么要它 |
| --- | --- | --- |
| `CU_ALLOW_GRANT_WRITE=1` | 任何写授权的用例 | 授权真源是操作者的真实 `~/.claude-gui/cu-runtime/grants.json`,没有可隔离的环境变量(见下) |
| `CU_SCREEN_SCOPE_OPTED_IN=1` | CG-14/CG-15(主屏范围开关) | 读屏是更高一档权限,必须操作者明确同意 |
| `CU_ALLOW_FIXTURE=1` | CG-03(重复 bundleId)、CG-08/09/12/R07/R12/R13、CG-10/11 | 要在机器上开一个可丢弃的 TextEdit 窗口当靶子 |
| `CU_ALLOW_INPUT=1` | CG-11(向夹具窗口发一次定向动作) | 真实输入;撤销生效时必须零投递,没生效也只落在夹具窗口里 |

端口:6700 起用 **lsof** 挑空闲(不用"自己 bind 一下试试"—— node 的 net 默认带 SO_REUSEADDR,
在 macOS 上对着别人的 `0.0.0.0:6700` 绑定还能成功,探出来是假的,本套件实测踩过一次:
请求全打给了另一个并行套件留在 6700 上的实例),硬拒用户正在用的 6677 / 6689;
起服务后再用 lsof 核一次"端口上的听众就是这个 pid"。杀进程只按记录下来的 pid,没有 `pkill -f`。

## 隔离与副作用(读之前先看这段)

- **授权真源不可隔离**:`cu-common.js` 刻意用 `os.userInfo().homedir` 算运行时目录,好让 GUI 后端与
  CLI 起的 MCP 进程读同一份授权(合同 §I1)。所以写授权的用例只能:① 带 flag;② **前后备份/还原原字节**。
  备份/还原由两条路各做一遍——`run-isolated.sh` 自己(退出时无条件还原,不管 playwright 是绿是红、
  还是根本没起来)+ playwright 的 `globalSetup/globalTeardown`(给直接调 playwright 的人)。
  *第一版只写了钩子却没接进 config,结果把操作者的授权状态留在了测试状态里;两路都留着就是为了不再重犯。*
- **失败路径用例(CG-R03/R04/R05)不碰真实运行时**:把 `server/` 整棵树复制到 `.artifacts/broken/`,
  只改副本里两处环境参数(运行时目录 → 本套件 `.artifacts/controlled-runtime`;helper → 假 helper),
  被测的 `server/routes/computer-use.js` 与工作树**逐字节相同**(beforeAll 里核 sha256)。
  这就是合同 §F CG-R03 允许的"用无 venv 的数据根",但不必挪操作者正在用的那一份。
  CG-R11 的面板用例经 `page.route` 把 `/api/computer-use/**` 改道到这个受控实例,所以它写的授权
  落在受控目录,操作者真实 grants.json 一个字不动。
- **夹具 HOME**:隔离实例的 `$HOME` 指向 `.artifacts/runtime-data/home*`,里面有一份合成的
  `.claude.json`(登记 `ccgui-computer-use`)—— 面板只在 `registered:true` 时渲染,这条前置在隔离实例上
  必须由夹具提供;不代操作者注册、不碰真实 `~/.claude.json`。
- **UI 跑在 dev server 上**(源码直出),不是 `client/dist`:本批明令不许跑统一 `vite build`
  (另有代理在并行动前端)。`vite.dev.config.mjs` 复用 `client/vite.config.js`,把 `/api`、`/ws`
  代理到本套件的隔离实例,cacheDir 也指到 `.artifacts`(不碰别人的 `.vite` 缓存)。
  统一构建做完后,这套用例可以原样再跑在 dist 上。

## 判据与实测(2026-09-14,隔离实例 + webkit)

正用例 16 条:**全绿**。反用例/边界 13 条:**全绿**。合计 **29 passed(约 58 秒)**。

| 组 | 用例 | 实测 |
| --- | --- | --- |
| HTTP | CG-01..05、CG-R01/02/06/10 | 9 passed;`/apps` 响应 13 条、逐条三键;敏感字段零命中;两实例 TextEdit 仍只一条 |
| 失败路径 | CG-R03/04/05 | 3 passed;未就绪 11ms 回 `CU_RUNTIME_UNAVAILABLE` 且运行时目录零写入;假 helper 卡住 15.6s 回 `CU_TIMEOUT` 且无残留进程;非 JSON 输出 error=`"not-json"`(≤300、无堆栈) |
| MCP | CG-10/11 | 2 passed;授权前该应用窗口不出现 → **同一实例**授权后出现(#39993);撤销后同一实例动作回 `CU_APP_NOT_ALLOWED` 且回执不声称投递 |
| 面板 | CG-06..09、CG-12..16、CG-R07/R08/R09/R11/R12/R13 | 15 passed;展开→列表 217ms(阈值 1.5s);确认框取消/确认与服务端逐轮一致;连点撤销只有 1 个写请求 |

### 这套用例**没**证明的东西(如实记)

- **CG-11 的"零投递"少一半证据**:独立判据(夹具文档的 AX 读回)要跑套件的终端有「辅助功能」权限,
  本机没有 → 该用例降级为"回执不声称投递 + `window_list` 不再列出该应用",并在输出里打了
  `[注] AX 读回不可用…`。给终端授权后重跑,那一半会自动补上(用例本身不用改)。
- CG-R09 的"非 ASCII 名字"依赖机器上当前有这类运行中的应用(本次 8 个);一个都没有时报
  `ENVIRONMENT_BLOCKED`,不当产品缺陷。
- 面板用例验的是 **dev 转换后的源码**,不是打包产物。

## 不回归

- 既有 CU 套件(`tests/acceptance/cu-batch-20260911`,67 例,只读不改)在同一个隔离实例上跑:
  **47 passed / 20 failed,20 条全部是 `ENVIRONMENT_BLOCKED`(0 条断言失败)** ——
  10 条守卫拦下(`CU_ALLOW_FOREGROUND` / `CU_ALLOW_SCREEN_READ`,本次没开)、
  9 条缺「辅助功能」权限读不回文档、1 条套件自己记的"不可制备"(CU-R16-06)。
- `node tests/unit/check-cu-{mapping,keys,shots,protocol,actions,helper-u16}.mjs`:全绿。

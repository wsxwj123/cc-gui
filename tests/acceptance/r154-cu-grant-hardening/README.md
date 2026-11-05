# r154-cu-grant-hardening 验收用例(授权写入口加固)

依据:`.devflow/r154-cu-grant-hardening-接口.md`(20 条行为 B1-B10 / M1-M6 / U1-U3 / D1;B8 含"启动清理"与"运行期撤销"两个场景,拆成 B8a/B8b,共 21 条用例)。
只通过公开面验证:HTTP 状态码与响应体、WebSocket 帧、MCP stdio 回执、授权文件、服务日志、面板页面、文档。不 import 产品内部模块。

## 怎么跑(一条命令,在工作树根目录)

    npx playwright test -c tests/acceptance/r154-cu-grant-hardening/playwright.config.mjs

只跑一部分:追加文件名(`r154-http` / `r154-mcp` / `r154-ui` / `r154-doc`)或 `-g 'B6|M5'`。
不需要任何环境变量;不要设置 `CU_ALLOW_INPUT` / `CU_ALLOW_FIXTURE` / `CU_ALLOW_GRANT_WRITE`(即便设了,套件起子进程时也会剔除所有 `CU_ALLOW_*`)。

## 守卫与隔离(套件自带,不靠调用者自觉)

- 仅 macOS(电脑操控只在 macOS 提供;面板用例会断言 `/api/computer-use/status` 的 `supported:true`)。
- 假家目录:被测的后端与 MCP 进程用 `--import helpers/preload.mjs` 起,家目录被指到本目录 `.artifacts/<label>-<随机>/home`;
  预加载在 `R154_FAKE_HOME` 缺失、或路径不在本套件 `.artifacts/` 下时直接抛错。授权文件 `grants.json` 因此落在假目录里,
  真实 `~/.claude-gui`、`~/.claude.json` 不会被写。`global-setup/teardown` 另外对真实 `grants.json` 做前后哈希对比(只读;
  `~/.claude.json` 会被正在运行的真实 app 自己改,对比只告警)。
- 假 helper:venv 里的 `python3` 是个壳,转去执行 `helpers/fake-helper.mjs`;窗口列表、光标命中由用例的剧本给,
  不碰桌面、不投递事件、不开真实应用窗口。"零投递"的判据是假 helper 的调用记录里没有非只读子命令。
- 端口只用 6700-6999,硬拒 6677 / 6689 / 6710,起服务后用 lsof 核对端口听众就是刚起的 pid;杀进程只按记录下来的 pid。
- 面板用例(U1-U3)用本套件自己起的 vite dev server(源码直出,缓存目录在 `.artifacts/vite-cache`),`/api`、`/ws` 代理到隔离实例;浏览器是 webkit。
- 依赖(都已在仓库里,套件不装任何东西):`node_modules/@playwright/test`(含 webkit 浏览器)、`node_modules/ws`、`client/node_modules/vite`。

## 取凭证

`helpers/world.mjs` 的 `getToken(base)`:开 `/ws`、等 `cu:grant-token` 帧;收不到返回 `undefined`,
由用例用具体断言失败("期望收到长度≥32 的字符串,实际 undefined(服务端没发 cu:grant-token 帧)")报告,不是超时或抛错。

## 目录

- `r154-http.spec.mjs` B1-B10 · `r154-mcp.spec.mjs` M1-M6 · `r154-ui.spec.mjs` U1-U3 · `r154-doc.spec.mjs` D1
- `helpers/world.mjs`(假世界、实例、HTTP/WS/MCP 客户端)、`helpers/fake-helper.mjs`、`helpers/preload.mjs`
- `.artifacts/` 是运行产物(日志、假家目录、vite 缓存),每次运行新建子目录,不自动清理,**不提交**。

## 没覆盖的

- "刷新页面后立即授权"(U1)只能近似:UI 步骤本身比凭证帧晚到,没法确定性制造"凭证还没到"的窗口。
- 真实 macOS 窗口列表 / 真实点击(只用假 helper);真实应用打包产物(UI 跑在 dev 源码上)。
- Windows(接口约定仅 macOS)。

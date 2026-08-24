# 锁定验收：GUI 默认插件安装

## 范围与公共契约

本清单锁定 14 条独立黑盒验收结果，目标是修复“GUI 默认插件全部安装失败”，并防止超时、代理、缓存、错误映射和第三方 payload 回归。测试不 import 产品内部模块，只观察真实构建 GUI、公开 HTTP、Claude CLI 2.1.240 和隔离文件系统结果。

- 后端由绝对 `R33_BACKEND_BIN` 启动，参数为 `R33_BACKEND_ARGS`（默认 `["server/index.js"]`），cwd 为目标 worktree，测试注入动态 `PORT`；健康检查为 `GET /api/health`。
- `GET /api/plugins/available?fresh=1` 必须返回 `{total,items,cachedAt}`；`total` 是全集数量，`items` 可分页。每项公开字段为 `{pluginId,name,description,marketplace,installed}`；默认 12 的逐项核验使用 GUI 已公开调用的 `q=<name>` 查询，避免把首屏分页误当全集。
- 唯一身份映射为 `id=name`、`marketplace=marketplace`；GUI 安装请求为 `POST /api/plugins/install`。默认卡公开 body 是合法的 `{name}`，server 负责映射到 `claude-plugins-official`；第三方 body 至少保留 `{name,marketplace}`，若公开 payload 含 `repo` 也必须原样保留。
- 失败目标为顶层 `error:{stage,code,retryable,timeoutMs,message}`；当前顶层 `error` 字符串会被错误用例判红。
- “默认 12 项”不从 available 的虚构标记推断：测试启动真实 `client/dist`，在公开“工具 → 插件 → 添加”弹层中逐一点击 12 张 Anthropic 官方精选卡片，拦截真实 POST payload，再与后端 items 及真实 `claude plugin list --available --json` 逐项交叉核对。名称不手抄。

测试文件：

- `tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs`
- `tests/acceptance/plugin-install/public-host.mjs`
- `tests/acceptance/plugin-install/gui-host.mjs`
- `tests/acceptance/plugin-install/gui-defaults-probe.mjs`

## 强制隔离

- `R33_CLI_BIN` 必须是 Claude CLI 2.1.240 的绝对路径；版本不符记 `TEST_INFRA`。
- 每条用例创建独立临时根，并覆盖 `HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`、`XDG_CACHE_HOME`。
- 临时后端和 GUI 宿主仅监听动态分配的 `127.0.0.1` 端口；GUI 宿主只静态提供真实 `client/dist` 并转发 `/api` 到同一临时后端。
- 子进程使用环境白名单，不继承凭证、token、SSH agent 或宿主代理。
- CLI 外壳只记录 argv、隔离路径、PID 和四个 proxy 键，随后执行真实 CLI；slow 用例只增加等待，不伪造成功。
- GUI 探针对安装 POST 返回公开成功响应，目的仅为连续观察 12 个真实 payload，不执行插件安装；真正的安装用例随后把捕获 payload 提交到真实后端。
- 清理前校验路径必须位于系统临时目录的 `cgui-plugin-r33-*` 下；绝不读取、修改或删除真实 `~/.claude`。

## 14 条行为矩阵

| ID | 档位 | 操作 | 预期 | 修复前分类 |
| --- | --- | --- | --- | --- |
| PLUG-AVAIL-001 | 网络 | 在独立空配置中用真实 CLI 添加官方 HTTPS marketplace；从真实 GUI 点击默认 12 卡并捕获 POST；读取后端与 CLI available JSON | 恰好 12 个唯一 `{name}`；每个 name 在两份真实 available JSON 中唯一对应 `claude-plugins-official` | 预期绿，证明 ID/marketplace 数据源不是根因 |
| PLUG-FRESH-001 | 网络 | 全新临时配置逐个原样重放 GUI 捕获的 12 个 `{name}` | 12 项均成功，真实 CLI list 含每个 `name@claude-plugins-official` | 诊断红 |
| PLUG-CACHE-001 | 网络后离线 | 在线预热后卸载插件，保留缓存；用拒绝代理重启后端再安装 | 直接安装成功；安装阶段无 add/update、无新增代理请求 | 回归门禁，不预判红 |
| PLUG-SLOW-ADD-001 | 离线 | add 前等待 35 秒再执行真实 CLI | `>=35s` 且 `<120s` 成功，不在 30 秒被杀 | 诊断红 |
| PLUG-SLOW-UPDATE-001 | 离线 | smart-HTTP git 源先发布 A 并由真实 CLI 缓存，再发布含新插件的 B；POST 新插件触发真实 stale→update；update 前等待 35 秒 | `>=35s` 且 `<120s` 成功，不在 30 秒被杀 | 诊断红 |
| PLUG-PROXY-001 | 离线 | 仅继承不可连接 `HTTP_PROXY` | 安装成功；死值不进入 CLI 环境 | 诊断红 |
| PLUG-PROXY-002 | 离线 | 仅继承不可连接 `HTTPS_PROXY` | 同上 | 诊断红 |
| PLUG-PROXY-003 | 离线 | 仅继承不可连接 `http_proxy` | 同上 | 诊断红 |
| PLUG-PROXY-004 | 离线 | 仅继承不可连接 `https_proxy` | 同上 | 诊断红 |
| PLUG-PROXY-LIVE-001 | 离线 | 启动回环可达代理后重启后端，再安装真实本地插件 | 探活连接计数增加，且 CLI 环境原样保留该代理 | 反向回归，防止无条件清空代理 |
| PLUG-ERR-ADD-001 | 离线 | 提交不存在的 marketplace payload | 非 2xx；`marketplace-add / CLI_EXIT_NONZERO / false / 120000`；无额外安装 | 诊断红 |
| PLUG-ERR-INSTALL-001 | 离线 | 合法 marketplace 下安装不存在 name | 非 2xx；`plugin-install / CLI_EXIT_NONZERO / false / 120000`；无额外安装 | 诊断红 |
| PLUG-ERR-TIMEOUT-001 | 长时 | 使用同一 smart-HTTP git A→B stale 前置，update 外壳等待 125 秒 | 约 120 秒返回 `marketplace-update / CLI_TIMEOUT / true / 120000`；子进程已终止 | 诊断红 |
| PLUG-THIRD-001 | 离线 | 提交由真实 CLI 自检过的本地第三方 `{name,marketplace,repo}` payload | CLI marketplace argv 原样保留 repo，install argv 与 CLI list 均保留 `name@marketplace` | 回归门禁，不预判红 |

四种 proxy 和 add/update 均保留独立测试结果，不合并报告。

## 公开宿主参数

基础必需：

```text
R33_BACKEND_BIN=/absolute/node
R33_BACKEND_ARGS=["server/index.js"]
R33_BACKEND_CWD=/absolute/worktree
R33_CLI_BIN=/absolute/claude
```

GUI 黑盒宿主默认使用现有全局 Playwright loader 和系统 Chrome；路径不同才覆盖：

```text
R33_PLAYWRIGHT_LOADER=/absolute/playwright-loader.mjs
R33_CHROME_EXECUTABLE=/absolute/chrome
```

本地离线 payload 按公开 POST 契约提供，可使用两个安全 token：`{{TEMP_ROOT}}`、`{{MARKETPLACE_DIR}}`。测试在后者生成并先用真实 CLI 自检 `r33-third-party-plugin@r33-third-party-marketplace`。

```text
R33_LOCAL_VALID_PAYLOAD_JSON
R33_SLOW_ADD_PAYLOAD_JSON
R33_ADD_FAILURE_PAYLOAD_JSON
R33_INSTALL_FAILURE_PAYLOAD_JSON
```

## TEST_INFRA 规则

- 后端/CLI 绝对路径、本地 payload、`client/dist`、Playwright loader、系统 Chrome 或 loopback 权限缺失：`TEST_INFRA`。
- `R33_RUN_NETWORK` 未设为 `1`：三条真实 marketplace 用例记 `TEST_INFRA_NETWORK`。PLUG-AVAIL 的公开准备步骤固定使用真实 CLI 添加 `https://github.com/anthropics/claude-plugins-official.git`；失败同样记网络基础设施缺口。
- `R33_RUN_LONG` 未设为 `1`：120 秒用例记 `TEST_INFRA_LONG`。
- CLI 不是 2.1.240、本地 marketplace fixture 无法被真实 CLI add/install、网络 DNS/TLS/限流失败：均为基础设施问题，不得伪造成产品绿，也不得混入诊断红。
- 缺宿主时，14 条应全部 skip，进程退出码仍为 0；任何语法、fixture 或探针未捕获错误必须令进程非 0。

## 运行命令

仅检查语法和 TEST_INFRA 分类：

```bash
node --check tests/acceptance/plugin-install/public-host.mjs
node --check tests/acceptance/plugin-install/gui-host.mjs
node --check tests/acceptance/plugin-install/gui-defaults-probe.mjs
node --check tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs
node --test tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs
```

运行 10 条无外网用例：设置基础宿主和本地 payload 后执行同一 `node --test` 命令；三条网络和一条长时用例会明确 skip。

加入真实网络用例：

```bash
R33_RUN_NETWORK=1 node --test tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs
```

加入 120 秒用例：

```bash
R33_RUN_LONG=1 node --test --test-name-pattern='PLUG-ERR-TIMEOUT-001' tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs
```

完整 nightly：

```bash
R33_RUN_NETWORK=1 R33_RUN_LONG=1 node --test tests/acceptance/plugin-install/plugin-install.acceptance.test.mjs
```

## 时长与完成条件

- 本地快速项：30–90 秒；两个 35 秒用例串行时约 70–90 秒。
- 默认 12 项真实首装：约 4–12 分钟；缓存回归另需 20–60 秒。
- 长时 timeout：约 125–140 秒；完整 nightly 预计 8–20 分钟。

完成时必须有 14 条独立结果、无真实配置或凭证访问、无遗留后端/GUI/CLI 子进程；网络/长时未跑必须保留明确 TEST_INFRA 标记。

## HEAD ddeb9b2 修复前证据

- 完整默认运行：14 项中 8 红、2 绿、4 skip；红项为 slow add、stale→slow update、四种死 proxy、add/install 两种结构化错误；绿项为可达 proxy 反向门禁和第三方 payload；三条网络与一条 long 按开关明确 skip。
- 单跑 `PLUG-AVAIL-001` 并开放网络：通过，耗时约 19.2 秒；真实 GUI 12 项、后端逐 name 查询、真实 CLI available 三方一致。
- 单跑 `PLUG-ERR-TIMEOUT-001` 并开放 long：约 39.4 秒红，当前仍返回顶层字符串错误，未达到结构化 `marketplace-update / CLI_TIMEOUT / true / 120000`。
- `PLUG-FRESH-001` 与 `PLUG-CACHE-001` 未在本轮执行真实 12 项网络安装；默认运行中保留 `TEST_INFRA_NETWORK`，不得记为产品绿。

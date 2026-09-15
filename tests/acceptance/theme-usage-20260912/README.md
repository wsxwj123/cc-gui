# theme-usage-20260912（TU-* 套件）

批次 7 的验收测试套件，覆盖需求书的 **R38 / R39 / R40 / R41** 四条：

| 需求 | 内容 | 用例 |
|---|---|---|
| R38 | 内置终端配色跟随主题（四种触发实时变色、对比度、ANSI 16 色、字体、反向不触发） | `TU-1xx`（纯逻辑）+ `TU-3xx`（真浏览器真终端） |
| R39 | 终端底部「当前连接不拥有该终端」——单连接自开终端不得出现 | `TU-4xx` |
| R40 | 用量页「本次刷新逐家结果」默认折叠、可展开、计数取本次刷新条目数 | `TU-5xx` |
| R41 | 「订阅额度（官方）」卡按 provider 身份条件显示（含 F2 服务端破例红线） | `TU-5xx` |

R42 / R43 不在本套件范围内（后加，且与既有锁定套件有冲突待裁决）。

## How to run

```sh
cd tests/acceptance/theme-usage-20260912
./run-isolated.sh                       # 一条命令：自起隔离实例 + 跑全量
./run-isolated.sh --grep 'TU-5'         # 只跑某一组
TU_PORT=6712 ./run-isolated.sh          # 指定端口（默认 6700 起挑空闲，绝不碰 6677/6689）
```

- 隔离实例：`HOME` 与数据根都在本套件 `.artifacts/runtime-data` 下，跑完即杀。
- 纯逻辑组（`tu-terminal-theme-pure.spec.mjs`）不需要实例，也可以单跑：
  ```sh
  cd <worktree> && npx playwright test -c tests/acceptance/theme-usage-20260912/playwright.config.mjs tu-terminal-theme-pure.spec.mjs
  ```
- 跑之前套件会做一次实例身份预检（`global-setup.mjs`）：搜不到本套件数据根里的夹具会话就一句话报错，
  不把"实例指错了"报成一堆产品缺陷。

## Fixture preparation

**不需要人工准备**。`helpers/tu-fixtures.mjs` 在本套件数据根里现造一份最小会话
（一个 user 记录 + 一个带 usage 的 assistant 记录，正文带唯一 marker `TU_FIXTURE_SESSION_20260912`），
侧栏搜索这个 marker 就能把会话点开（= 让「用量」「终端」面板坞具备可操作的环境）。
重建：`node helpers/tu-fixtures.mjs --force`。

夹具清单 `fixture-manifest.local.json` 只记定位值（数据根、projectHash、sessionId、marker），不含任何凭据。

## 黑盒取法与已知脆点

1. **只认契约公布的入口**：公开文案、role、`data-cgui` 锚点、原生 `<details>/<summary>` 语义、
   契约 §D 的三个既有 HTTP 接口（响应体用 Playwright route 打桩，不新增接口、不写测试专用属性）。
2. **R38 的配色取证**见 `helpers/tu-runtime.mjs` 的 `probeTerminalPalette()`：读的是 xterm
   **自己的**渲染面（`.xterm-scrollable-element` 行内背景 —— 契约 §F#5 点名；`.xterm-rows` 计算样式；
   xterm 注入 `<style>` 里的 ANSI/光标/选中规则）。**已知脆点**：若 xterm 换渲染器或改类名，探针失效 ——
   失效时报 `ENVIRONMENT_BLOCKED`，不伪装成产品红。
3. **终端输入路径**依赖"打开面板后终端自动获得键盘焦点"（与 first-batch 套件的终端用例同款假设）；
   提示符文本可见即视为就绪。
4. **皮肤触发（R38 触发③）** 需要「皮肤」页签 + 「开发者皮肤」开关 + 内置皮肤的「试穿/应用」按钮；
   任一不可达即 `ENVIRONMENT_BLOCKED`（不伪造成通过，也不伪造成失败）。
5. **用量面板是分段渲染的**：价目/刷新区先出，订阅卡与额度卡要等 `/api/usage`（要扫全部会话）回来才挂载。
   所以 `openUsagePanel()` 会等到慢段（`导出 CSV` 按钮）出现再返回 —— 否则"订阅卡必须不渲染"这类
   **负向断言会在卡片还来得及挂载之前就通过**（恒真，等于没测）。

## 锁定与只读

本套件目录一经锁定对开发代理只读（见 `.devflow/LOCK-theme-usage-20260912`）。

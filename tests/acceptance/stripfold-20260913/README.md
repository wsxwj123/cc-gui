# stripfold-20260913 · 条带折叠 + 渐进挂载的验收套件

判据全部来自 `.devflow/INTERFACE-20260912-stripfold.md`；论证与数字在 `.devflow/PLAN-20260912-stripfold.md`；
逐条用例的"观测手段 / 预期 / 判据来源"在 **`.devflow/TEST-PLAN-20260913-stripfold.md`**（人话版清单就在那里）。

只断言**用户看得见的行为**（公开文案 / role / `data-*` 锚点），不读产品源码，不碰内部变量名。

## 怎么跑

```sh
cd tests/acceptance/stripfold-20260913
./run-isolated.sh                 # 全量（约 8~12 分钟；含 120s 静置 + 60 格拖拽两条慢用例）
./run-isolated.sh --grep 'SF-1'   # 只跑某一组
SF_PORT=6781 ./run-isolated.sh    # 指定端口（默认 6700+ 里挑空闲）
```

脚本自己：建夹具 → 起隔离实例（自有数据根 `.artifacts/runtime-data` + 隔离 HOME
+ PATH 上挂**假 claude**）→ 跑用例 → 杀掉自己起的那条进程（按 pid + 端口两道）。
**绝不碰 6677 / 6689**（用户在用）；连隔离实例的地址都要过 `helpers/runtime.mjs` 的守卫。

## 四组用例

| 组 | 文件 | 测什么 |
|---|---|---|
| A 静态 | `sf-1-strip-static.spec.mjs` | 条带结构、默认收起、摘要逐字、折叠范围（只折 group）、边界文案、legacy 轮 |
| A 真回合 | `sf-2-strip-live.spec.mjs` | 流式首帧展开 / 收官原地收起 / 中断与报错保持展开 / 本地副本→持久化轮的交接 / 权限弹窗不被吞 / 并入切段 |
| B 渐进挂载 | `sf-3-mount-window.spec.mjs` | 只挂最近 K 行、向上补齐不跳视口、吸底与总高真实、进度条跳远、重开会话、搜索期全量、性能、静置 120s |
| C 搜索 | `sf-4-search.spec.mjs` | 命中折叠内容不得把视图顶跑；P9（是否自动展开）**只记事实不写死** |
| D 回归 | `sf-5-regress.spec.mjs` | 复制 / 导出 / 回滚 / 进度条 / 段内自有开合 —— 取值来源必须是数据，不是渲染出的 DOM |

## 夹具（`helpers/fixtures.mjs`，全部落在本套件 `.artifacts/` 下）

- **A 主夹具**：3 轮，每轮 3 思考 + 4 工具（Bash/Read/Edit/Grep）+ 1 中间插话 + 1 最终正文。
  期望值：`usageCalls=9`、被折块 `M=7`、段序 `[group,text,group,text]`、
  摘要行逐字 `思考与工具调用 · 9 轮 7 步 · 改完了，跑一遍测试没有回归。`
- **B 长会话**：320 轮（含 107 轮带工具调用）—— 挂载窗口与性能判据的载体。
- **C 边界 + R114 防线**：Workflow 卡 / Task 卡 / 41 emoji / 换行缩进 / markdown 记号 /
  最后一块非正文 / 纯正文轮 / 空思考块 / 无 blocks 的 legacy 轮。
- **D 破坏性专用**：回滚与导出会就地改写会话文件，单独一条会话，不与 A/B/C 混。
- **假 claude**（`helpers/fake-claude.mjs`）：PATH 上的薄壳，按 `CTL/scenario.json` 说 stream-json，
  **每发一条记录就写进转写** —— 用户中途点停止后磁盘上已经有持久化轮，"交接"那条用例靠它。
  遥控文件：`scenario.json`（这一轮长什么样）、`release`（放行"停在 result 之前"的回合）。

## 已知边界

- 本套件跑的是 `client/dist` 产物，**不 rebuild**。跑之前请确认 dist 是当前源码构建的
  （基线记录见 `.devflow/TEST-PLAN-20260913-stripfold.md` 末节）。
- 性能判据（SF-308）跑在 **WebKit**，夹具是自造 320 轮，与 PLAN §2.3 那份真实会话
  （227 行 / 22,043 节点）**不是同一把尺子**，数字必须标注夹具。
- SF-207（并入切段）依赖"回合进行中再发一条被接纳为并入"，隔离实例里不总能构造出来；
  构造不出来时按 `ENVIRONMENT_BLOCKED` 跳过，不伪装成通过。
- **SF-110**：I-115 想要的"`turn.blocks` 为空的旧 turn"**在本产品下造不出来**（读取器把字符串
  content 规范化成正文块；"什么都没有"的回合被 `flushTurn` 整轮丢掉），这条按 `ENVIRONMENT_BLOCKED`
  跳过。它仍然压"老形态记录（字符串 content）照常渲染成普通轮"+"同会话普通轮必须有条带根"两条，
  且这两条在跳过之前**已经执行**（它们红的话这条会报 failed 而不是 skipped）。详见
  `.devflow/TEST-PLAN-20260913-stripfold.md` §9。
- 跑一次会新建若干条"真回合"会话（每次用例一条），它们留在 `.artifacts/runtime-data` 里
  （`.artifacts/` 已 gitignore），不影响 A/B/C/D 四条夹具会话的断言。

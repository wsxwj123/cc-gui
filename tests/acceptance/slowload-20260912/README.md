# slowload-20260912 · 「打开 app 慢 / 点开项目慢」验收套件

会话画像 + 索引落盘 + 增量读那批改动（0.2.382 起）的验收。判据照
`.devflow/PLAN-20260912-slowload.md` §1.2（G1~G6 门槛）与 §9.3/§9.4（怎么量、反向用例），
可观测面照 `.devflow/INTERFACE-20260912-slowload.md` §D.3（`/api/session-index/stats`）§D.4。

## 怎么跑

```sh
cd tests/acceptance/slowload-20260912
./run-isolated.sh            # 夹具口径（默认；15 条断言，约 1~2 分钟）
./run-isolated.sh --real     # 真实数据口径（只读 ~/.claude/projects，函数级计时，约 1 分钟）
SLOWLOAD_PORT=6750 ./run-isolated.sh
```

结果同时落在 `.artifacts/last-run.json`（口径 / 数字 / 失败原因，机器可读）。

**隔离**：端口从 6700+ 里挑空闲的、硬拒 6677 / 6689；`HOME` 指到本套件
`.artifacts/runtime-data/home`；索引目录每轮换一个全新的空目录（`CGUI_SESSION_INDEX_DIR`）——
所以真实 `~/.claude`、`~/.claude-gui` 一个字节都不碰（`--real` 那档也只读、索引写到系统临时目录）。
杀进程一律按记下来的 pid，不用按名字杀的写法。

## 三种口径（**永远不要混着比**，历史上两套数字打架的根因就是混了口径）

| 口径 | 定义 | 对应门槛 |
|---|---|---|
| **A 冷进程 · 无索引** | 索引目录空 + 新进程 → 全量扫一遍 | 计划 §1.3 **明确不承诺**，只记录 |
| **B 冷进程 · 索引已落盘** | 索引在磁盘上 + 新进程 | G2 / G3 / G5 / G6 |
| **C 进程内第二次** | 同一进程里连续请求 | G1 / G4 |

计时口径：HTTP 全程（连上到响应体读完），3 次取中位。夹具数字与真实数据数字**不跨实例比较**。

## 用例

| # | 断言 |
|---|---|
| 1 | **数据正确性对拍**：同一份数据，旧实现（`git show 177fc632^:server/services/session-reader.js`，全量扫描）与新实现（画像+索引）的 `listProjects` / `listSessions` 响应体**逐字节相同**；再跑一遍旧实现确认索引没改动源数据 |
| 2 | G1 项目列表（进程内第二次起）≤ 100 ms，且两次响应体逐字节相同 |
| 3 | G4 大项目会话列表（进程内第二次起）≤ 200 ms |
| 4 | G2 项目列表（冷进程、索引已落盘）≤ 250 ms |
| 5 | G5 开 app 到「项目列表 + 会话列表」都返回 ≤ 1.2 s |
| 6 | G3 大项目会话列表（索引命中、重启后首次）≤ 600 ms |
| 7 | G3 配套：重启后第一次是**载入索引**而不是重新扫盘（`loaded` 增长、`scanned` 不增） |
| 8 | G6 会话进行中的第二次请求 ≤ 250 ms，且走 `incremental`/`rescanned` 而非首次全扫 |
| 9 | 追加一行：条数 +1、`firstPrompt`/`customTitle` 不变、`lastActivity` 前进 |
| 10 | 尾部追加标题行：立即生效（证明增量确实扫了新区段） |
| 11 | 同名字原子替换（inode 变）：必须返回新内容，不吃旧画像 |
| 12 | 截短到一半（size 回退）：必须扫出新内容，且 `rescanned` 增长 |
| 13 | 索引文件写坏（半截 JSON）：接口仍正确、`indexReadFailed` 增长 |
| 14 | `CGUI_SESSION_INDEX=off`：响应体与开启时逐字节相同、`stats.enabled === false` |
| 15 | 连续 50 次请求后 fd 数不增长（±5 以内） |

夹具规模（INTERFACE §F.0 配方）：大项目 200 个 jsonl、其中 1 条 20 MB；中项目 20 个；
小项目 5 个；一个空目录 + 一个无 sidecar 目录；含子代理（扁平 + `workflows/wf_*/` 深两层）、
归档标记、`compact_boundary`、标题行、sidecar。

## 实测数字

**夹具口径**（2026-09-14 本机，两次连跑数值一致，最后一次）：

| 口径 | 场景 | 耗时 | 门槛 |
|---|---|---|---|
| A 冷进程·无索引 | `GET /api/projects` | 27.2 ms | 不承诺 |
| A 冷进程·无索引 | `GET sessions(大项目)` | 97.4 ms | 不承诺 |
| B 冷进程·索引已落盘 | `GET /api/projects` | 10.0 ms | ≤ 250 ms |
| B 冷进程·索引已落盘 | `GET sessions(大项目)` | 13.9 ms | G5 的一部分 |
| B 冷进程·索引已落盘 | `GET sessions(重启后首次)` | 16.2 ms | ≤ 600 ms |
| B 冷进程·索引已落盘 | `GET sessions(活跃写入中)` | 12.7 ms | ≤ 250 ms |
| C 进程内第二次 | `GET /api/projects` | 5.4 ms | ≤ 100 ms |
| C 进程内第二次 | `GET sessions(大项目)` | 12.7 ms | ≤ 200 ms |

**真实数据口径**（`./run-isolated.sh --real`，同机同份数据：96 个项目 / 约 5.4 GB）：

| 口径 | 场景 | 耗时 | 门槛 |
|---|---|---|---|
| A 冷进程·无索引 | `GET /api/projects`（首次） | 446.7 ms | 不承诺 |
| A 冷进程·无索引 | sessions（469 文件 / 4467 MB） | 8420.4 ms | 不承诺 |
| A 冷进程·无索引 | sessions（315 文件 / 254 MB） | 1741.2 ms | 不承诺 |
| A 冷进程·无索引 | sessions（50 文件 / 218 MB） | 2192.1 ms | 不承诺 |
| B 冷进程·索引已落盘 | `GET /api/projects`（首次） | 78.4 ms | ≤ 250 ms |
| B 冷进程·索引已落盘 | sessions（469 文件 / 4467 MB） | 6.7 ms | ≤ 600 ms |
| B 冷进程·索引已落盘 | sessions（315 文件 / 254 MB） | 12.7 ms | ≤ 600 ms |
| B 冷进程·索引已落盘 | sessions（50 文件 / 218 MB） | 184.7 ms | ≤ 600 ms |
| C 进程内第二次 | `GET /api/projects` | 36.2 ms | ≤ 100 ms |
| C 进程内第二次 | sessions（三档） | 5.1 / 11.7 / 38.6 ms | ≤ 200 ms |

> 真实数据口径里最大的那条（469 文件 / 4.4 GB）：**A 口径 8.4 s → B 口径 6.7 ms**。
> 这就是「同一件事报出好几个不同秒数」的来源 —— 不带口径的毫秒数没有意义，跨口径比较更是错的。

## 不覆盖（明确写出来，免得被当成漏测）

- 前端请求去重（T6）、启动预热删除（T4）本身：那是另外的行为面，本套件只看接口耗时与内容。
- 手机端 / 局域网场景：本套件只连回环。
- Windows 的 `st.ino` 退化路径（INTERFACE §F.2 N11）：无 Windows 真机，未覆盖。

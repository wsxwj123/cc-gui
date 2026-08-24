# r33 验收测试清单

## 运行约束

本批次共有 20 个黑盒用例，只操作公开页面、稳定 `data-testid`、公开可访问按钮/选项，以及用户可观察的 DOM 和 localStorage 契约。测试不读取、导入或复刻产品实现，也不修改产品内部状态。

真实运行需要公开验收宿主提供满足各项前置条件的真实产品页面。上传延迟、失败、离线队列和 quota 可由宿主稳定控制，但宿主不可用另一份测试实现代替产品。环境变量或公开操作 selector 缺失时，对应用例明确记为 `TEST_INFRA` 并 `skip`，不算产品通过或失败。

必需场景变量：

- 持久化/隔离：`R33_GOAL_SESSION_A_URL`、`R33_GOAL_SESSION_B_URL`、`R33_GOAL_IDENTITY_A_URL`、`R33_GOAL_IDENTITY_B_URL`、`R33_GOAL_OTHER_SESSION_URL`、`R33_GOAL_WITH_PLAN_URL`、`R33_PLAN_SESSION_A_URL`、`R33_ISOLATION_SESSION_A_URL`、`R33_ISOLATION_SESSION_B_URL`。
- 目标竞态：`R33_GOAL_OPTIMISTIC_SWITCH_URL`、`R33_GOAL_SWITCH_B_ACTION`、`R33_GOAL_A_SENTINEL`、`R33_GOAL_B_SENTINEL`、`R33_GOAL_B_URL_TOKEN`；`R33_GOAL_DRAFT_SWITCH_URL`、`R33_DRAFT_GOAL_SWITCH_B_ACTION`、`R33_DRAFT_GOAL_A_SENTINEL`、`R33_DRAFT_GOAL_B_SENTINEL`、`R33_DRAFT_GOAL_B_URL_TOKEN`；`R33_GOAL_DRAFT_REAL_HANDOFF_URL`、`R33_DRAFT_REAL_ACTION`、`R33_DRAFT_REAL_GOAL_SENTINEL`、`R33_DRAFT_REAL_SETTLED_TEXT`、`R33_REAL_SESSION_URL_TOKEN`。
- 计划：`R33_REALTIME_PLAN_URL`、`R33_REPEAT_PLAN_ACTION`、`R33_HISTORY_ACTION`、`R33_PLAN_WHITESPACE_EQUIVALENCE_URL`、`R33_PLAN_INTERNAL_MARKDOWN_DIFFERENCE_URL`、`R33_DRAFT_PLAN_URL`、`R33_OTHER_SESSION_PLAN_URL`、`R33_REAL_SESSION_PLAN_URL`。
- 首页附件：`R33_HOME_ATTACHMENTS_URL`、`R33_DELAYED_UPLOAD_URL`、`R33_PARTIAL_UPLOAD_FAILURE_URL`、`R33_HOME_SELECTIONS_URL`、`R33_UPLOAD_FAILURE_URL`、`R33_QUEUE_QUOTA_URL`、`R33_QUEUE_SUCCESS_URL`。
- 公开文案/选项：`R33_TODO_A_TEXT`、`R33_TODO_B_TEXT`、`R33_APPROVAL_VISIBLE_TEXT`、`R33_EQUIVALENT_PLAN_SENTINEL`、`R33_MARKDOWN_VARIANT_A_TEXT`、`R33_MARKDOWN_VARIANT_B_TEXT`、`R33_DRAFT_PLAN_SENTINEL`、`R33_OTHER_SESSION_PLAN_SENTINEL`、`R33_PERMISSION_OPTION`、`R33_PROJECT_OPTION`。

## 行为矩阵

| ID | 类别 | 前置条件 | 用户步骤 | 预期 |
| --- | --- | --- | --- | --- |
| R33-STATE-001 | 持久化 | 会话 A、B 均有目标 | 在 A 隐藏目标，切 B，再回 A 并刷新 | B 目标可见；A 目标切换和刷新后仍隐藏 |
| R33-STATE-002 | 边界 / 身份隔离 | 同一会话先后有目标 A、B，另有其他会话 | 隐藏目标 A，再查看目标 B、其他会话，最后回 A | 只隐藏“该会话的目标 A”，其他目标均可见 |
| R33-STATE-003 | 反向用例 | 同一会话同时有目标和可开合计划 | 隐藏目标，再点击计划开合 | 目标消失；计划仍在且可正常开合 |
| R33-STATE-004 | 正常 | 当前页面有展开后可见内容不同的计划 | 点击一次展开，再点击一次收起 | 第一次可见内容变化，第二次恢复原样；不要求跨会话或刷新保留开合状态 |
| R33-STATE-005 | 持久化 / 类型与会话隔离 | A、B 各有目标、计划、待办 | 在 A 隐藏计划，刷新、切 B、再回 A | A 计划持续隐藏且目标/待办不变；B 三类状态不受影响 |
| R33-GOAL-RACE-001 | Bug 复现 / 首帧竞态 | A 有未落盘或乐观目标，B 有不同目标；切换走真实应用按钮和 SPA URL | 从 A 快速切到 B，用 MutationObserver 记录 B URL 下每次目标 DOM 变化 | B 的任何可观察帧都不含 A，最终显示 B |
| R33-GOAL-RACE-002 | Bug 复现 / 草稿隔离 | draft A、draft B 各有不同目标 | 从 draft A 快速切到 draft B，持续记录目标 DOM | draft B 的任何可观察帧都不含 draft A，最终显示 draft B |
| R33-GOAL-RACE-003 | Bug 复现 / 身份交接 | draft 会话将交接为真实会话，目标身份不变 | 触发交接，持续记录真实会话 URL 下目标 DOM，直到公开完成文案出现 | 交接全过程始终恰好一条正确目标，不闪失、不串入其他目标 |
| R33-PLAN-001 | Bug 复现 / 连续实时与历史 | 实时会话已有计划；公开操作可连续发出等价计划并切历史 | 连续触发 15 次等价计划，再切历史；MutationObserver 记录每次 DOM 变化 | 任一时刻 `plan-card` 数都不大于 1；历史仍为 1；原内容和后续批准信息合并保留 |
| R33-PLAN-002 | 边界 / 等价性 | 同一计划只在 CRLF/LF、首尾空白上不同 | 查看完成来源合并的会话 | 只显示一张含预期内容的计划卡 |
| R33-PLAN-003 | 反向用例 / 等价性 | 两份计划内部 Markdown 不同 | 查看同一会话 | 两张计划卡均保留，各自内容不被错误合并 |
| R33-PLAN-004 | 竞态 / 会话隔离 | 草稿会话转真实会话，同时另有不同计划的会话 | 草稿出现计划后快速切到其他会话再回真实会话 | 真实会话仅一张原计划，不混入其他会话计划 |
| R33-ATTACH-001 | 正常 / 字符边界 / 移除 | 首页可选附件 | 一次选择含中文、空格、emoji 文件名的两个文件，再移除其中一个 | 两个附件独立出现；指定附件可移除，另一个保留 |
| R33-ATTACH-002 | 正常 / 空文本边界 | 首页无文字，有一个上传完成附件 | 直接发送 | 产生首条消息卡并即时正确显示附件 |
| R33-ATTACH-003 | 并发 / 上传竞态 | 宿主故意延迟真实上传 | 选择文件后立刻查看发送入口并等待上传完成 | 上传期间发送禁用；全部完成后才启用 |
| R33-ATTACH-004 | 部分失败 | 同批两个附件，一个成功、一个失败 | 选择两文件，看到失败后移除失败项 | 显示错误；成功附件不丢；移除失败项后可发送成功项 |
| R33-ATTACH-005 | 回归 | 首页有可选权限模式和项目 | 选定两者，添加附件并发送 | 添加前后选择不变；附件按原权限和项目路径发出首条消息 |
| R33-ERROR-001 | 失败 / 恢复 | 宿主让上传失败 | 选择失败文件 | 即时显示上传错误；不产生消息；失败项仍可移除 |
| R33-ERROR-002 | 失败 / quota | 离线待发且 localStorage 写入触发 quota | 选择附件并发送 | 即时显示错误；附件仍在；消息数不增，不改发纯文本，不伪称入队成功 |
| R33-ERROR-003 | 正常 / 离线队列 | 离线待发可正常保存 | 仅附件发送并观察浏览器持久化与首条卡 | 存在 `{text, queuedAt, opts: {meta}}` 信封，且首条消息即时显示附件 |

## 修复前红例与 TEST_INFRA

只预先标记已由诊断确认的红例：`R33-GOAL-RACE-001`、`R33-GOAL-RACE-002`、`R33-GOAL-RACE-003`、`R33-PLAN-001`。首页附件入口/首条附件能力当前缺失，因此直接命中新能力的 `R33-ATTACH-001`、`R33-ATTACH-002` 也预期修复前为红。

其余用例是持久化、等价归一化、反向 Markdown、跨会话、上传失败/竞态、quota、权限和项目的回归门禁，不预先声称修复前必红。缺宿主 URL、公开按钮、可见哨兵文案或故障条件时结果必须记作 `TEST_INFRA`/skip，不能计入产品红绿。

## 当前公开测试基础设施缺口

- `INTERFACE.md` 没有待办稳定 selector，因此待办只按公开可见哨兵文案断言。
- 三项目标竞态没有稳定会话切换 selector；宿主需提供真实应用中的公开按钮文案及 SPA URL token。测试用 DOM `MutationObserver` 捕捉瞬时串显/闪失，不能用两个静态页面快照替代。
- 连续实时计划和实时转历史需要宿主提供公开触发按钮。测试连续触发 15 次，并对全过程每次 DOM 变化记录 `plan-card` 数；没有该触发条件即为 `TEST_INFRA`。
- 上传延迟、部分失败、quota 无法靠任意本地文件稳定触发，必须由真实验收宿主提供可重复的外部故障条件。
- 计划开合没有额外正文 selector，测试以 `plan-card` 可见文本第一次变化、第二次恢复判断展开和收起。

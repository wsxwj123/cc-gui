# Second batch acceptance tests (SB-*) — 2026-09-11

Scope: **R11** (监控找错母会话), **R12** (子代理历史与视图状态缺口), **R13** (旧 POST/SSE 污染新会话).
Contract source: `.devflow/INTERFACE.md`「会话流与子代理（R11–R13）」+「公共规则、身份与错误」+ 补充边界矩阵 chat/agent 行. Judging vocabulary: `.devflow/TEST-PLAN-second-batch.md`.

> Directory note: this directory also carries another suite (`FB2-*`). The SB-* files are
> `*.spec.mjs` (SB-T01…SB-T61), `helpers/sb-runtime.mjs`, and this README. `helpers/runtime.mjs`
> belongs to that other suite — the SB-* specs do not import it. Run this suite with `-g 'SB-T'`.

## Safety and setup

1. Start a dedicated worktree instance (unused loopback port, never 6677/6689) whose session/config/cache data lives under `tests/acceptance/second-batch-20260911/.artifacts/runtime-data`.
2. `BASE_URL` points at that instance; `WORKTREE` is this worktree. The helper rejects non-loopback hosts and the two protected user ports.
3. Copy `fixture-manifest.example.json` to `fixture-manifest.local.json` and fill it through the **public UI/API only**. Keep it free of cookies, keys, tokens and real prompt text (the loader rejects credential-looking field names). The `FB2-*` suite shares this path, so the file must carry **both** section sets (`sessionFlow`, `sessionFlowThird`, `agent*` for SB-*; plus whatever FB2 needs) — or point this suite elsewhere with `SECOND_BATCH_FIXTURES=/abs/path/to/manifest.json`.
4. Fixtures are opened like a real user: sidebar search (`搜索项目 / 会话 / 消息 (≥2 字符)…`) → result row; dock panels via top-bar `设置`; subagent views via the `监控` panel. No deep links, no store injection, no reading private JSONL/DB.
5. Trace/screenshots/video are off and no test prints stream payloads.

```bash
# list without contacting a server
npx playwright test -c tests/acceptance/second-batch-20260911/playwright.config.mjs --list -g 'SB-T'

# run the whole SB suite
BASE_URL=http://127.0.0.1:PORT WORKTREE="$PWD" \
  npx playwright test -c tests/acceptance/second-batch-20260911/playwright.config.mjs -g 'SB-T'

# run one case (model-free ones must pass without SECOND_BATCH_ALLOW_MODEL)
BASE_URL=http://127.0.0.1:PORT WORKTREE="$PWD" \
  npx playwright test -c tests/acceptance/second-batch-20260911/playwright.config.mjs -g 'SB-T01'
```

## Environment guards

`SECOND_BATCH_ALLOW_MODEL=1` gates every case that needs a live CLI/model run. Without it those
cases throw `ENVIRONMENT_BLOCKED` (a non-pass, never a product verdict). Set it only after the
disposable model account and the fixtures below actually exist.

| guarded cases | why a live run is needed |
| --- | --- |
| SB-T10 … SB-T14 | an accepted turn / a real turn record (`TURN_SERVER_CHANGED`, same-id retry, `TURN_CONFLICT`, merged concurrent runs, oversized-body 413) |
| SB-T17 … SB-T24 | a real pid to exercise stream cursors, replay identity and monotonic seq |
| SB-T25 … SB-T27 | stop needs a real (possibly already finished) run |
| SB-T32 … SB-T38 | draft→sid binding, background runs, stop-target isolation, takeover, reconnect |
| SB-T40 … SB-T43, SB-T48, SB-T50 … SB-T61 | subagent fixtures only exist after a real Task run |

Model-free by design (HTTP validation rejects before any CLI starts): **SB-T01–SB-T09, SB-T15,
SB-T16, SB-T28–SB-T31, SB-T39, SB-T44–SB-T47, SB-T49**.
Residual risk, stated plainly: on a build that does not yet validate `clientTurnId` / `createdAt`
/ `serverEpoch` / `afterSeq`, the *request* may reach the CLI and end as an unauthenticated
"No login" turn. That costs nothing and leaves no model output; it is the failure the case is
designed to surface.

## Fixture preparation

### Preparable without model credentials

| cases | fixture | how |
| --- | --- | --- |
| SB-T28–SB-T31 | `sessionFlow` (two ordinary sessions in one project) + `sessionFlowThird` (a third session, any project) | send any message through the public composer; the turn may end as a local "not logged in" notice, the human message is stored. Read `sessionId` / `projectHash` from the app's own messages request (visible in the browser devtools network tab) and record the search markers |
| SB-T01–SB-T09, SB-T15, SB-T16, SB-T49 | none beyond `sessionFlow.sessionAProjectHash` (T49) | — |
| SB-T39 | none | the `监控` panel opens on an empty instance |
| SB-T44–SB-T47 | `agentOrphan` / `agentUnresolvedEntry` / `agentNoPermission` / `agentLoadFailure` — one monitor entry each | see the not-preparable table; each case reports `ENVIRONMENT_BLOCKED` if its section is missing |

### Requires a disposable model account (`SECOND_BATCH_ALLOW_MODEL=1`)

| cases | fixture | how |
| --- | --- | --- |
| SB-T10–SB-T14, SB-T17–SB-T27, SB-T32–SB-T36 | `sessionFlow` | keep the two fixture sessions; use trivial prompts ("Reply with exactly: …") so runs finish inside the 45s test budget |
| SB-T37, SB-T38 | `sessionFlow` | **exception to the trivial-prompt rule**: these two observe the run *while it is alive*, so they send a long turn (the model runs one Bash `sleep 20` before answering — `sustainedPrompt()`; measured life 23.4s), wait for the public `data-run-id` run hook, and wait for the session to have no in-flight turn (`/api/agents/active`) before sending. A trivial prompt finishes in 1–2s, so the second page attached / the link was cut with nothing left to observe. SB-T38 additionally drives the link through this suite's own pass-through TCP proxy (`startCuttableProxy`) because Chromium's `context.setOffline` does **not** break an established streaming fetch (measured: `.devflow/second-batch-evidence/tools/probe-offline-breaks-stream.mjs`); "offline" there means the connection is really destroyed and new connections are refused for the 2s window. See `.devflow/TEST-PLAN-second-batch.md`「第三轮修订」 |
| SB-T40–SB-T43, SB-T48, SB-T55–SB-T58 | `agent` = one parent session whose run produced a subagent (Task) call; record `parentSessionId`, `parentTitle`, `toolUseId`, `agentSessionId`, `parentProjectHash`, `stopTaskPathTemplate`, and `expectedBlockTypes` (the block type order you observe in the source run) | run one real Task turn, then open 监控 → 查看 and copy the identities the UI/API publishes |
| SB-T42, SB-T43 | `agentCrossProject`, `agentBackground` | same, once in a different project and once with the parent's pane closed |
| SB-T51, SB-T52, SB-T59 | `agentRunning` | leave the subagent still running when you hand the suite over (plus `parentPid` from the app's own `POST /api/chat` response) |
| SB-T51, SB-T60 | `agentHistoryOnly` | a finished subagent with nothing running |
| SB-T61 | `agentEnded` | a parent turn whose subagent already finished |
| SB-T53, SB-T54 | `agentFork` | branch (分支会话) the same parent twice so both copies carry the same `toolUseId` |

## Not preparable in this environment

| case | why | how to re-verify later |
| --- | --- | --- |
| SB-T46 无权查看此会话 | a loopback instance is fully authorised; there is no second, less-privileged principal | prepare a remote/second principal, park a monitor entry whose parent it cannot read, then run the case unchanged |
| SB-T47 加载失败，可重试 | needs an induced history-read failure; no public switch exists to produce one | cut the project/agent source mid-read (e.g. unmount the parent's storage) or add the documented failure fixture, then run the case unchanged |
| SB-T44/T45 母会话不存在 / 无法确定母会话 | both need a monitor entry whose parent is gone/ambiguous; whether the public UI can produce one is unconfirmed | archive/delete the parent session after the subagent ran and keep the monitor entry; otherwise mark blocked |
| stream gap UI (`实时记录已截断，正在恢复历史`) | needs >5000 retained events for one run; not reproducible inside a 45s budget | run a long turn (>5000 events) and repeat the cursor-too-old path; the HTTP half (`stream_gap` + `firstSeq/lastSeq`) is also unverified |
| `TURN_CAPACITY` (512 records), `CHAT_START_TIMEOUT` / `RUN_STOP_TIMEOUT` / `AGENT_STOP_TIMEOUT` (504) | need 512 turns or an induced 15s timeout | run against a build with a test hook, or wait the timeout out on a deliberately slow dependency |
| chat `403` 无访问权 / `503` CLI 不可用 | cannot be produced on a local, fully authorised instance with a working CLI | repeat on a remote-auth host / with the CLI removed |
| 24h retention (`TURN_EXPIRED` on a *previously accepted* id) | would need to wait past the retention window | accept a turn, wait 24h, resend with the original `createdAt` |
| Tauri/WKWebView and Windows runs | Chromium on macOS only | re-run SB-T28–SB-T38 (and the agent UI cases) in the real desktop app |

## Observations to confirm

Facts verified on the isolated instance (60094, build 0.2.378) while designing this suite:

- `GET /api/health` currently returns `{ok,app,port,version,localBuild}` — no `serverEpoch`. SB-T09 fails at its first assertion by design.
- Error bodies on this build are old-style `{error}` only (`{"error":"prompt is required"}`, `{"error":"Process not found"}`) — every `expectJsonError` case fails at `ok:false` by design, not at the scaffolding. Smoke evidence: SB-T01 + SB-T15 fail exactly there.
- `data-message-id` and `data-testid` (`pane`, `pane-split`, `message-card`, `task-notice`, `panel-dock-toggle`, `session-actions-btn`) exist; `data-pane-id` / `data-owner-key` / `data-generation` / `data-run-id` / `data-parent-session-id` / `data-tool-use-id` do not yet. SB-T28+ fail on that.
- Dock panels (after top-bar `设置`): `分屏`, `文件`, `审查`, `监控` (Subagent 监控), `Agent`, `用量`, `进程`, `工具`, `技能`, `指令`, `生图`, `市场`, `通用`. The monitor panel shows `SUBAGENT 监控` plus `后台代理 (CLAUDE --BG)` / `本机 CLAUDE 进程` sections.
- Composer placeholder `输入消息... (/ 打开命令)`; send button `发送`; session actions menu `置顶到列表最前 / 重命名 / 分支会话 / 收纳到归档页 / 删除会话`.
- **Confirmed 2026-09-11** (supersedes the earlier "Unconfirmed" note): the pane-creation path is a single step — expand the dock with top-bar `设置`, click `分屏` (`[data-testid=pane-count]`, tooltip `分屏数量（1–6）`), pick N in the popover (`[data-testid=pane-count-N]`, e.g. `[data-testid=pane-count-2]`), and N `[data-testid=pane]` panes exist immediately (no extra step needed to materialise them). `ensurePaneCount` uses exactly this path. A session is then opened into a specific pane by clicking that pane first and then the sidebar search result. (The bullets above are a snapshot of the design-time instance; this one was re-verified on the current build.)
- **Transport drop → the current turn's message card can disappear until the turn ends (2026-09-11, measured while repairing SB-T38's preconditions).** With the run alive and the SSE link really cut (`startCuttableProxy`), the notice `⏳ 连接中断，正在恢复` appears within ~0.3s and the stream reattaches within ~1s. Whether the just-sent message card is still in the list afterwards depends on the race between the CLI writing that user message to the jsonl and the client's post-drop history reconciliation: when reconciliation wins (observed repeatedly), the card is gone until the turn finishes (~25s later, then as the real uuid) — the local `chat-user-<ts>` bubble is the UI's only copy while the turn runs, and the stream-finalize `!producedReply` branch drops it. Evidence: `.devflow/second-batch-evidence/tools/probe-t38-bubble-gone-watch.mjs` (24s+ of absence; the server history already had the message), `.../probe-t38-repeat.mjs`. SB-T38's `idsAfter.length >= idsBefore.length` assertion is what catches it; that is why SB-T38 is not stably green — whether it is a product defect to fix or a window the case should not cover is a product-side ruling (see `.devflow/TEST-PLAN-second-batch.md`「第三轮修订」).
- **Product test hook missing — the non-focused completion notice (2026-09-11, verified on the live instance while re-broadening SB-T33).**The top-centre reminder shown when an *unfocused* session's turn completes (session title + reply summary, ~10 s, click to jump there) publishes **no `data-testid`**. SB-T33 has to assert page-wide that A's marker appears nowhere but inside that notice, so it identifies the notice structurally: the marker text sits inside a native `<button>` (the whole strip is the click-to-jump target), that button hangs under a `position:fixed` layer (`div.fixed.top-[60px].left-1/2`, measured: appears within ~2 s of the off-screen completion, gone after ~10 s), and it is inside no pane and no message card. If the product ever grows a test hook for this strip, replacing the heuristic with it would be strictly better (suggested id: `completion-toast`).
- INTERFACE does not fix the stop-task **route** or its **field spellings** for agents, the `runId` request parameter name for `GET /api/chat/:pid/stream`, nor the delivery-state field of `POST /api/chat`. SB-T23/SB-T25–27 use `runId`/`owner`/`clientTurnId`; SB-T59–T61 take the route from `agent.stopTaskPathTemplate`. Adjust the spellings once the implementation publishes them.

## Limits of this suite

Covered: turn identity and its error codes, cursor validation and replay identity, stop identity and
truthful terminal states, pane/owner identity, late-event isolation, takeover and reconnect,
monitor navigation success and failure texts, agent history shape, fork attribution, and the
"watching must not stop anything" inverse.

Not covered: anything in the not-preparable table, the raw 24h/6h clocks, multi-principal
authorisation, Tauri/Windows surfaces, and the *visual* claim in R12 that history blocks render in
the original order beyond the operator-recorded `expectedBlockTypes` ground truth (SB-T48 compares
types, not text payloads).

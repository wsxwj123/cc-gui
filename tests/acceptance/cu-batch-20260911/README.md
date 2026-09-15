# Computer-use acceptance suite (CU-*) — 2026-09-11

Scope: **R14** (后台点击不得暗中退全局), **R15** (Retina 边界坐标), **R16** (非 BMP 字符输入),
**R17** (key 别名与非法键), **R18** (多进程截图清理互删).
Contract source: `.devflow/INTERFACE.md`「桌面操控与Codex对齐（R14–R19）」第 9、11、13、15–21 段
+ 补充边界矩阵 CU 行. 需求原文: `.devflow/BRIEF.md` R14–R18. 判断口径: `.devflow/TEST-PLAN-cu-batch3.md`.

R19（锁屏）只做"不得含糊"的一半：CU-B03 记录 `lockscreen` 状态与枚举，不声称其能力。锁屏目标
（遮蔽全部显示器、重锁、崩溃/睡眠恢复等）**不在本批**，需要用户单独批准安装授权组件。

## Safety model — read this before running anything

This suite runs on the operator's own machine while they are working. Three rules:

1. **Only the disposable window receives input.** `helpers/cu-fixture.mjs` starts
   `open -g -n -a TextEdit /tmp/cu-batch-fixture-*.txt` — `-g` keeps it out of the front (no focus
   steal), `-n` starts a *separate process* so the operator's own TextEdit documents are never
   touched. Every input case re-resolves the window from `window_list` and compares
   bundleId/pid/windowId immediately before acting; a mismatch ends the case as `ENVIRONMENT_BLOCKED`.
2. **Calls that could reach the user's front app are refused.** Every side-effect case calls
   `requireActionTool()`, which needs **both** the tool schema to declare `actionId/target/snapshotId/
   foreground` **and** `CU_ALLOW_INPUT=1`. The switch exists because the design-round build (0.2.378)
   had input tools that acted on the focused window with no way to name a target: there a
   validation-failure call *cannot* be assumed side-effect free, so the case reports
   `ENVIRONMENT_BLOCKED` instead of risking the operator's front app. The build under test
   (83a1074a) declares the contract fields on every side-effect tool, so the guard now only asserts
   the operator's opt-in. `CU_ALLOW_INPUT=1` also accepts that, in the R14 dispatch cases, a buggy
   build could deliver one stray click.
3. **Reading the desktop is opt-in.** `CU_ALLOW_SCREEN_READ=1` acknowledges that screenshots may
   return the operator's desktop pixels. Screenshots are never written to `.artifacts/`.

Guards (each missing flag = `ENVIRONMENT_BLOCKED`, never a silent skip):

| flag | gates | why it exists |
| --- | --- | --- |
| `CU_ALLOW_FIXTURE=1` | creating the disposable TextEdit window | it opens a window on the operator's machine |
| `CU_ALLOW_INPUT=1` | any click/drag/scroll/type/key call | real input; only the disposable window may receive it |
| `CU_ALLOW_SCREEN_READ=1` | any `screenshot` call | returns the operator's display pixels |
| `CU_ALLOW_FOREGROUND=1` | the `foreground:true` cases (CU-R14-10, CU-R16-07) | those take the front app away by design; **default off, keep it off** |
| `CU_SCREEN_SCOPE_OPTED_IN=1` | CU-R15-13 | states that the operator ticked 「允许主屏全部可见内容」 in this instance |

The suite proves "the operator's desktop did not move" with oracles that belong to the OS, not to the
product: `lsappinfo front` (frontmost app) and a CoreGraphics cursor probe compiled to
`.artifacts/cursor-probe`. An unstable baseline (someone switching apps / moving the mouse) is
reported as `ENVIRONMENT_BLOCKED`; a change that survives a second sample after the call is a
failure. Run the suite while you are not switching apps, and treat a front-app change during a
dispatch call as an R14 failure.

## Running

```bash
# discovery (no server, no side effects)
npx playwright test -c tests/acceptance/cu-batch-20260911/playwright.config.mjs --list

# the whole suite, no guards: every safe case runs, everything else reports ENVIRONMENT_BLOCKED
BASE_URL=http://127.0.0.1:57280 \
  npx playwright test -c tests/acceptance/cu-batch-20260911/playwright.config.mjs

# one case
BASE_URL=http://127.0.0.1:57280 \
  npx playwright test -c tests/acceptance/cu-batch-20260911/playwright.config.mjs -g 'CU-R16-05'

# full run with the disposable window and real input enabled (only after the targeted-tool contract lands)
BASE_URL=http://127.0.0.1:57280 CU_ALLOW_FIXTURE=1 CU_ALLOW_INPUT=1 \
  npx playwright test -c tests/acceptance/cu-batch-20260911/playwright.config.mjs

# screenshot lifecycle cases additionally need the product's own screenshot directory
BASE_URL=http://127.0.0.1:57280 CU_ALLOW_SCREEN_READ=1 CU_SHOTS_DIR="$HOME/.claude-gui/cu-runtime/shots" \
  npx playwright test -c tests/acceptance/cu-batch-20260911/playwright.config.mjs -g 'CU-R18'
```

`BASE_URL` must be loopback and must not be 6677/6689 (reused guard from the first-batch layer).
`globalTeardown` kills the disposable TextEdit pid and deletes its file even when cases fail.

No browser is launched: the suite drives the `ccgui-computer-use` MCP server over stdio JSON-RPC
(path taken from `GET /api/computer-use/status` → `mcpPath`/`nodePath`) and the
`/api/computer-use/*` HTTP surface. Playwright is only the runner/discovery/exit-code layer.

## The R16/R17 effect oracle: the window's text, read through the Accessibility API

The independent half of R16/R17 is `helpers/cu-ax-probe.swift` (compiled into `.artifacts/` on first
use, `swiftc` needed), which reads the text element's value straight from macOS and compares it
**code point by code point** — so NFC/NFD normalisation, surrogate mangling or a half-delivered key
string fails the case even when the tool reports success. `reset` on the same probe empties the
suite's own disposable document before an effect case (fixture preparation, never an assertion).

A file oracle (read the document back from `/tmp/cu-batch-fixture-*.txt`) was the design's first
choice and is **unusable on this machine**: `defaults read -g NSCloseAlwaysConfirmsChanges` is `1`
here (auto-save off), so TextEdit never writes the opened document back on its own — two channels
were watched for 80s and 60s with no write — and a background window cannot be sent the `cmd+s`
menu shortcut either. The AX oracle needs the 辅助功能 permission for the terminal app that runs the
suite; without it every R16/R17 effect case reports `ENVIRONMENT_BLOCKED` (the suite never ticks a
permission box itself).

## Fixture preparation

| fixture | how | cases |
| --- | --- | --- |
| disposable TextEdit window | created by the suite (`CU_ALLOW_FIXTURE=1`), killed by global teardown | all CU-R16-*, CU-R17-*, CU-R15-07/08/09 |
| `CU_SHOTS_DIR` | path of the product's own screenshot directory (operator-supplied; not published by any public endpoint) | CU-R18-01/02/04 |

The window has to be **on the Space the operator is looking at**, otherwise `window_list` does not
report it (measured: Stage Manager on, a fullscreen app in front → every other app's windows are
off-screen and the product lists none). In that state every fixture case reports
`ENVIRONMENT_BLOCKED` with that reason; re-run with the normal desktop in front.

If a run is interrupted (Ctrl-C before teardown), remove the leftovers with the suite's own teardown
(`pkill -f cu-batch-fixture-` does **not** work: the pattern would have to appear in the TextEdit
process' argv, and it never does):

```bash
node -e "import('./helpers/cu-fixture.mjs').then(m => m.disposeFixture())"
rm -f /tmp/cu-batch-fixture-*
```

## Observations (revision run, build 83a1074a, instance 57280)

Facts, not verdicts — each is asserted by a case above. The design-round observations (build 0.2.378)
are kept in `.devflow/TEST-PLAN-cu-batch3.md` together with the revision record.

- `tools/list` carries the 11 original tools plus read-only `action_status`; every side-effect tool
  declares `actionId/target/snapshotId/foreground/instanceId` and `initialize` publishes
  `instanceId` (CU-A07/A08/A09 pass).
- JSON-RPC: unnamed method `-32600`, unknown tool **and** unknown method `-32601`, missing `name`
  `-32602`, malformed line gets a parse-error reply (CU-A01–A06 pass).
- `window_list` lists **only authorised apps' windows** and reports `bundleId`; `frontmost` carries
  a bundleId. It lists only windows on the Space the operator is looking at (see above).
- 目标/授权/快照 checks run in that order: a ghost target answers `CU_TARGET_NOT_FOUND` before any
  snapshot verdict, while a missing snapshot answers `CU_SCREENSHOT_REQUIRED` even with a ghost
  target; argument-shape errors (negative/decimal/non-finite coordinates, over-limit text) answer
  before the target is resolved.
- `type` into a background window reports `verification:"verified"` with a `readback`, and the AX
  oracle confirms the code points; `cmd+a` is the one documented chord that does **not** take effect
  (the tool itself answers `unknown`, and nothing is selected — see the plan's revision record).
- `screenshot` is refused without the main-screen scope; this instance has the scope granted, so the
  screenshot cases need `CU_ALLOW_SCREEN_READ=1` plus `CU_SCREEN_SCOPE_OPTED_IN=1` to be run.

## Not preparable in this environment

| case | why | how to re-verify later |
| --- | --- | --- |
| CU-R16-06 不支持读回 → unknown | needs an app whose text cannot be read back; none is reachable in the allowlisted set | add a target the AX readback cannot serve (e.g. a canvas/GL app), then run the case unchanged |
| CU-R14-10 / CU-R16-07 foreground:true | they take the operator's front app by design; the suite refuses to run them | run on a machine the operator is not using, or accept the focus steal explicitly |
| CU-R18-01/02/03/04 | need real screenshots (see CU_ALLOW_SCREEN_READ) and, for the counters, `CU_SHOTS_DIR` | provide both and re-run |
| CU-R15-05…08 Retina/边界 | need real screenshots; 05/07/08 additionally need the disposable window (`CU_ALLOW_FIXTURE=1` + `CU_ALLOW_INPUT=1`) | set `CU_ALLOW_SCREEN_READ=1` (+ the fixture flags) and re-run |
| 桌面在前台全屏应用/Stage Manager 的另一 stage 时 | `window_list` 只报当前所见 Space 的窗口，自建窗口不可见 → 全部 fixture 用例 `ENVIRONMENT_BLOCKED` | 回到普通桌面 stage 重跑 |
| Windows surface | contract says `supported=false` on Windows; this suite is macOS-only | re-verify the status/doctor shape on Windows |
| 撤销授权后 `CU_APP_NOT_ALLOWED`（执行中撤权取消未投递步骤） | needs the GUI tool panel to revoke mid-flight; not automated here | drive the panel by hand, then run CU-R14-03 unchanged |
| `CU_BUSY`（队列 32 满）、`CU_TIMEOUT`（20s / 155s 上限） | need a saturated queue or an induced stall | run with a test hook that blocks the queue, or drive 33 concurrent actions |

## Limits of this suite

Covered: the MCP envelope and protocol codes, tool schema identity, instance/actionId identity,
background-dispatch failure codes with independent "the desktop did not move" inverses, coordinate
validation and snapshot identity, text length in code points and read-back equality, key aliases and
their real effects, and the screenshot file lifecycle across instances.

Not covered: everything in the "not preparable" table, the lock-screen goal (R19), Windows, the GUI
tool panel itself (registration/authorisation UI), `CU_BUSY`/`CU_TIMEOUT` boundaries, and the
*visual* content of any screenshot (the suite checks sizes, bytes and receivables, never what the
pixels show).

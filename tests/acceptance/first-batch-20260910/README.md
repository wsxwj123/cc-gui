# First batch acceptance tests — 2026-09-10

These tests cover only R01–R10 plus the corresponding R29/R30 evidence duties.

## Safety and setup

1. Build and start a dedicated worktree instance with all session/config/cache data rooted below `tests/acceptance/first-batch-20260910/.artifacts/runtime-data` and an unused loopback port. Do not point it at ports 6677 or 6689.
2. Set `BASE_URL` to that instance and `WORKTREE` to this worktree. The test helper rejects non-loopback hosts and the protected ports.
3. Copy `fixture-manifest.example.json` to `fixture-manifest.local.json` and fill it in. Keep every prepared file inside the isolated data root. Never put cookies, keys, tokens, or real session text in it.
4. Prepare all fixtures through the public application UI (or through the public HTTP endpoints this suite itself locks, for the attachment-metadata cases). The tests never guess private JSONL, database, storage keys, or URL formats.
5. For the tests whose fixtures need real model/task output, enable a disposable low-cost CLI/model account only in this isolated instance and set `FIRST_BATCH_ALLOW_MODEL=1`. No test reads a key. If this prerequisite is absent, every affected test reports `ENVIRONMENT_BLOCKED`: FB-T22, FB-T25, FB-T31, FB-T32, FB-T34, FB-T35. Set the flag only after the fixture preparation described below is actually done.

Run all tests:

```bash
BASE_URL=http://127.0.0.1:PORT WORKTREE="$PWD" \
  npx playwright test -c tests/acceptance/first-batch-20260910/playwright.config.mjs
```

List tests without contacting a server:

```bash
npx playwright test -c tests/acceptance/first-batch-20260910/playwright.config.mjs --list
```

Run one test by ID:

```bash
BASE_URL=http://127.0.0.1:PORT WORKTREE="$PWD" \
  npx playwright test -c tests/acceptance/first-batch-20260910/playwright.config.mjs -g 'FB-T01'
```

Playwright trace, screenshot, and video recording are disabled because terminal resume tokens are shell-control credentials. Test output must not print WebSocket payloads. A missing host, fixture, Windows machine, Tauri build, CLI/model account, or six-hour prerequisite is a blocked/non-passing result, never a pass.

## Fixture navigation (no session-level URL)

The product has **no session/file deep link**: every path renders the home screen. This suite therefore opens
every UI fixture exactly like a real user would, through helpers in `helpers/runtime.mjs`:

| helper | what it does | manifest fields it reads |
| --- | --- | --- |
| `openFixtureSession(page, section [, { markerKey }])` | types `sessionSearchMarker` into the sidebar search box (`搜索项目 / 会话 / 消息 (≥2 字符)…`), clicks the matching result row, waits for the session composer | `projectName`, `sessionSearchMarker` (or the section's alternative marker key) |
| `openFixtureFile(page, section)` | opens the fixture session first (the file panel roots at the *active session's* project), then top bar `设置` → `文件`, then clicks the file-tree node | `projectName`, `sessionSearchMarker`, `fileName` |

Field semantics (all values must be prepared and verified visible by the operator through the public UI):

- `projectName` — fixture project name as shown in the sidebar / file panel. Used as a navigation sanity check only (the opened session's header must show it).
- `sessionSearchMarker` (and `mergeSessionSearchMarker`, `streamingSessionSearchMarker`) — a unique marker planted in one message of that fixture session; the search box finds the session by message content. The search covers projects that are hidden from the sidebar by default (worktree projects), so no settings change is needed.
- `fileName` — markdown fixture file name in the **root** of the fixture project, as shown in the file panel tree.
- `historyMessageId`, `firstImageAlt`, … — unchanged meaning; see the example manifest.

Locator basis (whitelist): `getByRole` / `getByText` / `getByLabel` / `getByAltText` / `page.keyboard` and
product hooks observed on the isolated instance. No third-party component internals (`.xterm-*`), no store
injection, no reading `localStorage`/`sessionStorage`, no invented deep links.
Observed UI anchors the helpers rely on (stable product affordances, re-verified on the isolated instance):
the sidebar search textbox (`搜索项目 / 会话 / 消息 (≥2 字符)…`), the session composer (`输入消息... (/ 打开命令)`),
the header project breadcrumb, the top-bar `设置` button, the panel-dock `文件` button, the markdown file-tree node,
and the transient-overlay dismiss buttons `关闭指引` / `跳过` / `稍后`. Expect occasional guide-card or
update-toast overlays over the sidebar: `clickThroughOverlays` closes them and retries the click.

## Fixture preparation per test

### Prepareable without model credentials

| test | fixture to prepare | how |
| --- | --- | --- |
| FB-T20, FB-T21, FB-T23, FB-T24 | fixture project with a **markdown file** in its root (`markdown.fileName`) containing the fence/inline/runnable-code fixture text, plus **one ordinary session** in the same project whose message contains `markdown.sessionSearchMarker` | create the session through the public composer (any message; the reply may end as a local "not logged in" notice), write the markdown file into the project root, then read the file back in the file panel to confirm it renders. **Coverage limit:** with no model account these tests exercise the *file-preview* markdown surface only (images/copy/run entry points are present there, verified); re-verify the same assertions on a real chat reply once a disposable model account is available |
| FB-T19 | same markdown-file carrier, but the file's images must point at **real Windows paths**, and the test must run on a Windows host/build (`manifest.platform === 'windows'`) | as above, on Windows |
| FB-T26, FB-T27, FB-T28, FB-T29, FB-T30 | one attachments session (`attachments.sessionSearchMarker`) holding a real 2-image + 1-file message with its explanation; plus a preview-less-but-readable image, a missing-image reference, and the two-image message used by the lightbox tests | send the message through the public composer (works without model credentials: the turn ends with the local "not logged in" notice but the human message and attachments are stored), or post the public attachments metadata endpoint this suite already locks (`POST /api/sessions/:sessionId/attachments`, with `attachments.sessionId`) |
| FB-T33, FB-T37 | notifications session (`notifications.sessionSearchMarker`) containing a human-authored XML discussion | send that message through the public composer |
| FB-T36, FB-T37, FB-T01–T18, T38 | no UI fixture | isolated instance / public HTTP+WS |

### Not preparable in the current environment (no model credentials in the isolated instance)

These tests stay exactly as designed; they need the operator to supply a disposable low-cost CLI/model
account in the isolated instance first. All six carry the same environment guard: without
`FIRST_BATCH_ALLOW_MODEL=1` they throw `ENVIRONMENT_BLOCKED`, which is an environment block, never a
product verdict. Set the flag only once the fixture below actually exists.

| test | also guarded by `FIRST_BATCH_ALLOW_MODEL=1` | why | what the operator must do |
| --- | --- | --- | --- |
| FB-T22 | yes (pre-existing guard) | needs a **live** model stream mid-flight (unfinished fence / inline code) | log a disposable CLI/model account into the isolated instance, trigger the stream, set `FIRST_BATCH_ALLOW_MODEL=1`, park a marker message for `markdown.streamingSessionSearchMarker` |
| FB-T25 | yes (pre-existing guard) | needs an **active run** to merge into | same account; keep the session running, park `attachments.mergeSessionSearchMarker`. The merge ("并入") button is only rendered for queued messages while a run is active — with an empty queue the whole block is absent — so the click target cannot be exercised without a model account. In a model-credentialed run, confirm the button's ownership: it must act on the message just queued, not on another queue entry |
| FB-T31, FB-T32 | yes (added this round) | task-notifications (`user` / `queued_command` form) must come from a **real task action**, not hand-edited storage | same account; produce one ordinary-user and one queued-command notification, park them in the notifications session |
| FB-T34, FB-T35 | yes (added this round) | `completed/failed/killed` terminal-state update and a model notification are **real task/model output** | same account; run a task to completion and capture the model notification in the notifications session |

FB-T33 (human-authored XML message) and FB-T37 (message identities) stay unguarded: their fixture is
prepareable without model credentials, so a failure there is a real result.

## Platform / manual boundaries (unchanged)

- Tauri/WKWebView: repeat FB-T36, T23/T24, T27–T30 in the real macOS app; Chromium-only is a blocked result.
- Windows: repeat FB-T19 on a real machine.
- T22/T25 and the notification-family fixtures: see the tables above; a missing account is a blocked/non-passing result.
- 6-hour detach expiry, raw concurrent-read cancellation, validation-failure matrix, cross-project subagent history: see `TEST-PLAN.md`.

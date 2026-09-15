// SB-* suite helper layer (R11–R13).
// Reuses the locked first-batch helpers instead of copying them; only the additions
// this suite needs (own fixture manifest, model guard, chat/SSE/stop contract probes,
// pane-identity observation) live here.
// NOTE: helpers/runtime.mjs is a separately owned file in the same directory (another
// suite writes it); this SB-* layer deliberately does not depend on it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import * as fb from '../../first-batch-20260910/helpers/runtime.mjs';

export const EnvironmentBlocked = fb.EnvironmentBlocked;
export const uniqueId = fb.uniqueId;
export const wsURL = fb.wsURL;
export const openSocket = fb.openSocket;
export const dismissTransientOverlays = fb.dismissTransientOverlays;
export const clickThroughOverlays = fb.clickThroughOverlays;

/**
 * 复用第一层的公开导航（侧栏搜索 → 结果行），只加一层容错：实测偶发"填了搜索词但结果行
 * 一直没渲染"（整套跑动中 2 次；同一序列单独重放和 6/6 探针必过，app 自己的
 * /api/search 也照常返回该夹具）。失败时重载页面重试一次，随后各用例的断言一字未改。
 */
export async function openFixtureSession(page, section, options) {
  try {
    return await fb.openFixtureSession(page, section, options);
  } catch (error) {
    await page.goto('/').catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await dismissTransientOverlays(page).catch(() => {});
    return await fb.openFixtureSession(page, section, options);
  }
}

export const MODEL_FLAG = 'SECOND_BATCH_ALLOW_MODEL';

const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

/** Cases that need a live CLI/model run stay out of the way until the operator says the account exists. */
export function requireModel() {
  if (process.env[MODEL_FLAG] !== '1') {
    throw new EnvironmentBlocked(
      `${MODEL_FLAG}=1 is required: this case needs a live CLI/model run in the isolated instance (see README "Not preparable")`,
    );
  }
}

/**
 * Same environment guards as the first batch (loopback only, 6677/6689 refused, worktree),
 * plus this suite's own fixture manifest rooted under second-batch-20260911/.artifacts.
 */
export function getRuntime({ requireManifest = false } = {}) {
  const base = fb.getRuntime({ requireManifest: false }); // throws EnvironmentBlocked for bad BASE_URL / protected ports
  const manifestPath = path.resolve(
    process.env.SECOND_BATCH_FIXTURES || suitePath('fixture-manifest.local.json'),
  );
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rejectSecretFields(manifest);
    if (!manifest.dataRoot) {
      throw new EnvironmentBlocked('fixture manifest must declare dataRoot for the isolated server');
    }
    const dataRoot = path.resolve(manifest.dataRoot);
    const allowedRoot = suitePath('.artifacts');
    if (dataRoot !== allowedRoot && !dataRoot.startsWith(`${allowedRoot}${path.sep}`)) {
      throw new EnvironmentBlocked('fixture dataRoot must be inside second-batch-20260911/.artifacts');
    }
  } else if (requireManifest) {
    throw new EnvironmentBlocked(`create ${manifestPath} from fixture-manifest.example.json`);
  }
  return { baseURL: base.baseURL, worktree: base.worktree, manifest, manifestPath };
}

function rejectSecretFields(value, prefix = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const at = prefix ? `${prefix}.${key}` : key;
    if (/(secret|password|cookie|authorization|api.?key|resume.?token)/i.test(key)) {
      throw new EnvironmentBlocked(`fixture manifest must not contain credential field ${at}`);
    }
    rejectSecretFields(child, at);
  }
}

export function fixtureSection(name) {
  const { manifest } = getRuntime({ requireManifest: true });
  const section = manifest?.[name];
  if (!section) throw new EnvironmentBlocked(`fixture manifest section ${name} is required`);
  return section;
}

export function requireField(section, key) {
  const value = section?.[key];
  if (typeof value !== 'string' || !value) {
    throw new EnvironmentBlocked(`fixture field ${key} is required and must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP contract probes: POST /api/chat, GET /api/chat/:pid/stream, POST /api/chat/:pid/stop
// ---------------------------------------------------------------------------

export async function jsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { __nonJsonBody__: text.slice(0, 200) }; }
}

/**
 * Contract envelope check for this section of INTERFACE.md:
 * `{ok:false,code,error}` with a stable code, readable short sentence, no credentials,
 * no private text and no stack trace.
 */
export function expectJsonError(result, { status, code = null, mustNotContain = [] }) {
  const label = code || `HTTP ${status}`;
  expect(result.status, `HTTP status for ${label}`).toBe(status);
  expect(result.body, `JSON body for ${label}`).toBeTruthy();
  expect(result.body.ok, `ok:false envelope for ${label}`).toBe(false);
  if (code) {
    expect(result.body.code, `stable error code ${code}`).toBe(code);
  } else {
    // INTERFACE names the HTTP status but no code for this failure; any stable short code passes.
    expect(typeof result.body.code, `stable error code for ${label}`).toBe('string');
    expect(result.body.code.length, `stable error code for ${label}`).toBeGreaterThan(0);
    expect(result.body.code.length, `stable error code for ${label}`).toBeLessThanOrEqual(64);
  }
  expect(typeof result.body.error, `readable error text for ${label}`).toBe('string');
  expect(result.body.error.length, `short error text for ${label}`).toBeLessThanOrEqual(300);
  expect(result.body.error, 'no stack trace in error text').not.toMatch(/\n\s+at\s|Error:\s*\n/);
  for (const needle of mustNotContain) {
    expect(result.body.error, 'error text must not leak request content').not.toContain(needle);
  }
}

export async function getHealth(request, baseURL) {
  const response = await request.get(`${baseURL}/api/health`);
  expect(response.status()).toBe(200);
  return await response.json();
}

/**
 * Baseline /api/chat payload: valid cwd, and the real serverEpoch only when the service
 * publishes one (SB-T09 asserts it must). Tests override only the field they exercise.
 */
export async function chatPayload(request, baseURL, overrides = {}) {
  const { worktree } = getRuntime();
  const health = await getHealth(request, baseURL).catch(() => ({}));
  const payload = { prompt: 'SB_PLACEHOLDER_20260911', cwd: worktree, ...overrides };
  const epoch = health?.serverEpoch;
  if (typeof epoch === 'string' && epoch && !('serverEpoch' in overrides)) payload.serverEpoch = epoch;
  return payload;
}

export async function postChat(request, baseURL, payload) {
  const response = await request.post(`${baseURL}/api/chat`, { data: payload, failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function postStop(request, baseURL, pid, payload) {
  const response = await request.post(`${baseURL}/api/chat/${encodeURIComponent(pid)}/stop`, {
    data: payload,
    failOnStatusCode: false,
  });
  return { status: response.status(), body: await jsonBody(response) };
}

export function streamURL(baseURL, pid, params = {}) {
  const url = new URL(`/api/chat/${encodeURIComponent(pid)}/stream`, baseURL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Reads the SSE endpoint with a hard deadline. Returns the HTTP status plus every parsed
 * event when the response really is an event stream; JSON error bodies come back as `body`.
 */
export async function readStream(baseURL, pid, { params = {}, timeoutMs = 10_000, stopWhen } = {}) {
  const url = streamURL(baseURL, pid, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const result = { status: 0, body: null, events: [], contentType: '', timedOut: false };
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    result.status = response.status;
    result.contentType = response.headers.get('content-type') || '';
    if (!response.ok || !/text\/event-stream/i.test(result.contentType)) {
      result.body = await jsonBody(response);
      return result;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!result.timedOut) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = parseSSEFrame(frame);
        if (parsed) result.events.push(parsed);
      }
      if (stopWhen && result.events.some(stopWhen)) break;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      result.timedOut = true;
      return result;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseSSEFrame(frame) {
  const lines = frame.split('\n');
  const event = { id: null, name: null, data: null, seq: null, runId: null, raw: frame.slice(0, 400) };
  let sawField = false;
  for (const line of lines) {
    if (line.startsWith('id:')) { event.id = line.slice(3).trim(); sawField = true; }
    else if (line.startsWith('event:')) { event.name = line.slice(6).trim(); sawField = true; }
    else if (line.startsWith('data:')) {
      sawField = true;
      const text = line.slice(5).trim();
      try {
        event.data = JSON.parse(text);
        if (event.data && typeof event.data === 'object') {
          if (typeof event.data.seq === 'number') event.seq = event.data.seq;
          if (typeof event.data.runId === 'string') event.runId = event.data.runId;
        }
      } catch { event.data = text; }
    }
  }
  return sawField ? event : null;
}

/** Starts one trivial turn against a fixture session and returns its canonical identities. */
export async function startFixtureRun(request, baseURL, { sessionId, marker = uniqueId('SB_RUN') }) {
  const clientTurnId = uniqueId('sb_turn');
  const payload = await chatPayload(request, baseURL, {
    prompt: `Reply with exactly: ${marker}`,
    sessionId,
    clientTurnId,
  });
  const result = await postChat(request, baseURL, payload);
  expect(result.status, `POST /api/chat must accept a normal turn; body: ${JSON.stringify(result.body).slice(0, 200)}`).toBe(200);
  expect(result.body?.pid, 'an accepted turn must return its run pid').toBeTruthy();
  return { pid: String(result.body.pid), clientTurnId, marker, body: result.body };
}

export async function readMessages(request, baseURL, sessionId, projectHash) {
  const url = `${baseURL}/api/sessions/${encodeURIComponent(sessionId)}/messages?projectHash=${encodeURIComponent(projectHash)}`;
  const response = await request.get(url, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function pollMessages(request, baseURL, sessionId, projectHash, predicate, { timeoutMs = 20_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await readMessages(request, baseURL, sessionId, projectHash);
    if (last.status === 200 && predicate(last.body)) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return last;
}

export function messagesWithMarker(body, marker) {
  return (body?.messages || []).filter(message => JSON.stringify(message).includes(marker));
}

export function isTerminalEvent(event) {
  const name = `${event.name || ''} ${event.data?.type || ''}`;
  return /done|error|finally|terminal|end/i.test(name);
}

// ---------------------------------------------------------------------------
// Public-UI observation helpers (contract hooks only: data-pane-id / data-owner-key /
// data-generation / data-run-id / data-message-id / data-parent-session-id / data-tool-use-id)
// ---------------------------------------------------------------------------

export function paneLocator(page) {
  return page.getByTestId('pane');
}

/**
 * 窗格的"正文"= 消息区（合同在每条消息上公布 `data-message-id`）。
 * 窗格标题栏也会渲染会话标题，夹具标题本身可能含标记，所以正文计数必须限定在消息区。
 */
export function paneBody(pane) {
  return pane.locator('[data-message-id]');
}

export async function paneIdentity(page) {
  return await page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-pane-id]')].map(el => ({
      paneId: el.getAttribute('data-pane-id'),
      ownerKey: el.getAttribute('data-owner-key'),
      generation: el.getAttribute('data-generation'),
    }));
    const flows = [...document.querySelectorAll('[data-generation]')].map(el => ({
      generation: el.getAttribute('data-generation'),
      runId: el.getAttribute('data-run-id'),
    }));
    const agentViews = [...document.querySelectorAll('[data-parent-session-id]')].map(el => ({
      parentSessionId: el.getAttribute('data-parent-session-id'),
      toolUseId: el.getAttribute('data-tool-use-id'),
    }));
    return { panes, flows, agentViews };
  });
}

/**
 * 顶栏/面板坞里的任何公开控件都要先有应用页面才点得到：用例第一步就调本层 helper 时，
 * page 可能还停在 about:blank（没有任何导航）。这里补上"进应用"这一步，等价于
 * 用例先 openFixtureSession 再操作；对任何产品都成立。
 */
export async function ensureAppLoaded(page) {
  if (page.url() === 'about:blank') {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  }
}

/** Opens a top-bar dock panel (文件 / 审查 / 监控 / …); expands the dock first when collapsed. */
export async function openDockPanel(page, name) {
  await ensureAppLoaded(page);
  const panelButton = page.getByRole('button', { name, exact: true }).first();
  if (!(await panelButton.count())) {
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await expect(panelButton).toBeVisible();
  await clickThroughOverlays(page, panelButton);
}

/** 监控面板自己的标题文本（面板收起时不在 DOM 里）。 */
function monitorPanelOpen(page) {
  return page.getByText(/subagent\s*监控/i).first().isVisible().catch(() => false);
}

/**
 * 打开监控面板。顶栏面板按钮是开关语义（再点一次收起），所以"面板已开"时不再点，
 * 否则行列表当场消失；幂等 = 调用后必然处于"面板打开"状态，语义不变。
 */
export async function openMonitorPanel(page) {
  await ensureAppLoaded(page);
  if (await monitorPanelOpen(page)) return;
  await openDockPanel(page, '监控');
}

export function requireArrayField(section, key) {
  const value = section?.[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new EnvironmentBlocked(`fixture field ${key} must be a non-empty array (operator-observed ground truth)`);
  }
  return value;
}

export async function composerLocator(page) {
  return page.getByRole('textbox', { name: /打开命令/ }).first();
}

export async function typePrompt(page, pane, text) {
  const scope = pane ?? page;
  const composer = await composerLocator(scope);
  await composer.click();
  await composer.fill(text);
}

export async function sendPrompt(page, pane, text) {
  await typePrompt(page, pane, text);
  const scope = pane ?? page;
  await scope.getByRole('button', { name: '发送', exact: true }).first().click();
}

/**
 * Sets the 分屏 pane count through the public control, then waits until that many pane
 * elements exist. 实测（0.2.378）：顶栏「设置」展开面板坞后可见 `分屏` 按钮
 * （`[data-testid=pane-count]`），点开是 1–6 个选项（`[data-testid=pane-count-N]`），
 * 选 N 立刻出现 N 个 `[data-testid=pane]`；不需要别的步骤。
 * 若产品换了步骤，这里会明确报错而不是猜（见 README "Observations to confirm"）。
 */
export async function ensurePaneCount(page, count) {
  await ensureAppLoaded(page);
  const dockSplit = page.getByRole('button', { name: /^分屏/ }).first();
  if (!(await dockSplit.count())) {
    // the dock starts collapsed; 设置 expands it and reveals the 分屏 / panel buttons
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  const control = (await dockSplit.count()) ? dockSplit : page.getByTestId('pane-count').first();
  await expect(control, 'the 分屏 control must exist to observe pane identity').toBeVisible();
  await clickThroughOverlays(page, control);
  const byHook = page.getByTestId(`pane-count-${count}`);
  const option = (await byHook.count()) ? byHook : page.getByRole('button', { name: String(count), exact: true });
  if (await option.count()) {
    await clickThroughOverlays(page, option.first());
  } else {
    const item = page.locator('[role=menuitem],[role=option]').filter({ hasText: new RegExp(`^\\s*${count}\\b`) }).first();
    await expect(item, `choosing 分屏=${count} must offer a ${count}-pane option`).toBeVisible();
    await clickThroughOverlays(page, item);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await expect
    .poll(() => paneLocator(page).count(), {
      message: `expected ${count} chat pane(s) after choosing 分屏=${count}; if the product needs another step to create panes, record that step in README "Observations to confirm"`,
      timeout: 8_000,
    })
    .toBe(count);
}

/** Clicks the close affordance of a specific pane and waits for it to disappear. */
export async function closePane(page, pane) {
  const close = pane.getByRole('button', { name: /关闭|×|✕/ }).first();
  await expect(close, 'each pane must expose a close affordance to observe identity remapping').toBeVisible();
  await clickThroughOverlays(page, close);
}

/**
 * Opens the 监控 (subagent monitor) panel and clicks 查看 on the entry that mentions
 * `fragment` (the fixture toolUseId or prompt marker). Row lookup goes through the
 * innermost container that contains the fragment text; no component internals are used.
 */
export async function openAgentViewFromMonitor(page, fragment) {
  await openMonitorPanel(page); // 幂等：面板已开就不再点开关，重复调用不会把行列表关掉
  const entry = page.getByText(fragment, { exact: false }).first();
  await expect(entry, `the monitor panel must list an entry mentioning ${fragment}`).toBeVisible();
  const row = page.locator('div,li,tr,section').filter({ hasText: fragment }).last();
  const viewButton = row.getByRole('button', { name: /查看/ }).first();
  if (await viewButton.count()) {
    await clickThroughOverlays(page, viewButton);
    return;
  }
  const anyView = page.getByRole('button', { name: /查看/ }).first();
  await expect(anyView, `the monitor entry for ${fragment} must offer a 查看 action`).toBeVisible();
  await clickThroughOverlays(page, anyView);
}

/** The subagent view container for one parent+toolUse pair, as published by the contract. */
export function agentViewLocator(page, { parentSessionId, toolUseId }) {
  return page.locator(`[data-parent-session-id="${parentSessionId}"][data-tool-use-id="${toolUseId}"]`);
}

/**
 * Calls the stop-task entry used for agents. INTERFACE does not name the route or field
 * spellings for this entry, so the manifest supplies `agent.stopTaskPathTemplate`
 * (a path containing `{pid}`); tests document the ambiguity instead of guessing.
 */
export async function postAgentStop(request, baseURL, pathTemplate, pid, payload) {
  const path = pathTemplate.replace('{pid}', encodeURIComponent(pid));
  const response = await request.post(`${baseURL}${path}`, { data: payload, failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

/** Makes one split pane the active one before a session is opened into it. */
export async function activatePane(page, index) {
  const pane = paneLocator(page).nth(index);
  await expect(pane).toBeVisible();
  await pane.click({ position: { x: 300, y: 200 } }).catch(() => {}); // pane body, not its header buttons
  await page.waitForTimeout(300);
}

/** Opens a fixture session, optionally into a specific split pane. */
export async function openSessionInPane(page, section, { paneIndex, markerKey } = {}) {
  if (paneIndex !== undefined) await activatePane(page, paneIndex);
  await openFixtureSession(page, section, markerKey ? { markerKey } : undefined);
}

/** Starts a brand-new draft view (home composer) — used for draft→session identity migration. */
export async function openNewDraft(page) {
  const button = page.getByRole('button', { name: '新建会话', exact: true }).first();
  await expect(button, 'the sidebar 新建会话 entry is the public draft entry point').toBeVisible();
  await clickThroughOverlays(page, button);
}

/**
 * 当前活动窗格的模型控件。按控件自己的标签定位（`[data-cgui=model-selector]`，
 * tooltip 为「模型: <名字>（provider: …）」），不按模型名匹配：第三方 provider 下
 * 页面上没有 claude-/gpt- 字样的按钮，按名字找必然超时。
 */
export function modelChoiceControl(page) {
  return page.locator('[data-cgui="model-selector"] button').first();
}

/** Records every request the page issues, so "observation must not stop the run" is provable. */
export function recordRequests(page) {
  const seen = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/chat\/[^/]+\/stop/.test(request.url())) seen.push(request.url());
  });
  return seen;
}

export async function waitForText(page, pattern, timeout = 15_000) {
  await expect(page.getByText(pattern).first()).toBeVisible({ timeout });
}

// ---------------------------------------------------------------------------
// Timing preconditions for the observation-window cases (SB-T37 / SB-T38 / SB-T52).
// All three must observe a run *while it is still alive*; with a finished run they go red for a
// non-product reason (SB-T37/SB-T38 sent trivial prompts that ended in 1–2s before the second
// page attached / the link was cut; SB-T52's fixture window is ≈30–45 min and simply expires).
// Measurements: .devflow/second-batch-evidence/tools/probe-t37-t38-preconditions.mjs
// ---------------------------------------------------------------------------

/**
 * 长回合提示词：让模型先用 Bash 跑一条 `sleep 20` 再回答。实测（0.2.378，隔离实例）这样发出的
 * 回合运行存活 23.4s，两条 `sleep 12` 是 29.0s —— 单条命令时长确定、不会被模型并发跑掉，
 * 够覆盖两个用例的观察窗口（附着第二页 ≈3.5s + 等提示 1s + 保持 3s；断线 2s + 恢复观察 4s），
 * 又不至于让"上一条长回合"把下一条用例的窗口拖到 45s 预算边缘（两条 sleep 12 实测把
 * SB-T37 的一次迭代拖到 42.3s）。标记随提示词进历史，便于事后核对是哪一轮。
 */
export function sustainedPrompt(marker) {
  return 'Run exactly this one command with the Bash tool, then reply DONE: `sleep 20`. '
    + 'Do not skip it. Marker: ' + marker;
}

/**
 * 公开面「运行存活」判据：窗格里的流动内容容器正在消费某次运行时公布 `data-run-id`
 * （合同见 .devflow/INTERFACE.md「公共规则、身份与错误」；收尾/切走即收回）。返回该 runId。
 * 等不到 = 这轮没有在跑（模型秒答 / 没起来 / 钩子没公布）—— 属环境不成立，明确报
 * ENVIRONMENT_BLOCKED，不让用例以"没等到产品文案"收场（那会把环境问题记成产品回归）。
 */
export async function waitForRunLive(page, pane, { timeoutMs = 8_000 } = {}) {
  const scope = pane ?? page;
  const flow = scope.locator('[data-run-id]').first();
  try {
    await expect(flow).toHaveAttribute('data-run-id', /.+/, { timeout: timeoutMs });
  } catch {
    throw new EnvironmentBlocked(
      `no live run observed: [data-run-id] never appeared within ${timeoutMs}ms of sending (the turn may `
      + 'have finished before the observation started, or the pane never published the run hook)',
    );
  }
  return await flow.getAttribute('data-run-id');
}

/**
 * 「这个会话当前没有在跑的回合」—— 读应用自己的 `/api/agents/active`（监控面板的数据源，
 * 侧栏绿点/后台横幅同源）：`kind==='chat-process'` 且 `status` 为 `streaming`/`starting`
 * 才是"正在跑"；`idle`（回合间保活进程）/`done`/`error` 都不算。实测：跑着的时候该条目
 * status='starting'，回合结束翻成 'idle'（探针 probe-idle-surface.mjs）。
 *
 * 为什么两个观察窗口用例需要在开跑前等这条：上一轮的长回合还没结束就往同一会话发，服务端
 * 会把新 prompt 并进那次运行（POST /api/chat 回 `reused:true`，runId 不变），新消息于是
 * 以"引导消息"的身份排队落盘 —— 断线时乐观气泡被清掉、真实 uuid 迟迟不到，用例就在
 * "自己上一条长回合还没结束"上变红。新开的页面看不见别人的后台运行（实测新页面里
 * `data-run-id`/停止按钮/横幅全无），所以只能从应用自己的状态面等。
 */
export async function waitForSessionIdle(request, baseURL, sessionId, { timeoutMs = 30_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let running = [];
    try {
      const body = await (await request.get(`${baseURL}/api/agents/active`)).json();
      const entries = Array.isArray(body?.agents) ? body.agents : [];
      running = entries.filter(entry => entry.kind === 'chat-process'
        && entry.sessionId === sessionId
        && (entry.status === 'streaming' || entry.status === 'starting'));
    } catch (error) {
      throw new EnvironmentBlocked(`could not read /api/agents/active to check whether session ${sessionId} is idle: ${error.message}`);
    }
    if (running.length === 0) return true;
    if (Date.now() > deadline) {
      throw new EnvironmentBlocked(
        `session ${sessionId} still had a running turn after ${timeoutMs}ms (`
        + `${running.map(entry => `${entry.pid}:${entry.status}`).join(', ')}): this case cannot start its own `
        + 'turn while the server would merge the two into one',
      );
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

/**
 * 公开面「这个会话当前没有在跑的运行」判据，两条都要成立：
 *   ① 窗格不公布 `data-run-id`（本窗格没在消费任何运行）；② 窗格里没有 `停止…` 按钮
 *   （前端据服务端的 backgroundPid 渲染，另有「这个会话仍在后台工作中」横幅同一来源）。
 * 为什么两个用例开头要等这条：长回合是"上一轮还没跑完，下一个用例就往同一会话发"的场景，
 * 服务端会把新 prompt 并进那次仍在跑的运行（实测 POST /api/chat 回 `reused:true` 且 runId
 * 不变），于是新消息的乐观气泡在断线时被清掉、又因为那次运行还在 sleep 里迟迟不落盘 ——
 * 净少一张卡，红的是"用例自己上一条长回合还没结束"，不是产品的重连语义。
 * 只看 `data-run-id` 不够：新开的页面不会自动接上别人的后台运行，但 ①② 合起来能看见它
 * （实测停止按钮与横幅随后台运行存在、随它结束消失）。
 */
export async function waitForRunIdle(page, pane, { timeoutMs = 30_000 } = {}) {
  const scope = pane ?? page;
  const isIdle = async () => (await scope.locator('[data-run-id]').count()) === 0
    && (await scope.getByRole('button', { name: /^停止/ }).count()) === 0;
  const deadline = Date.now() + timeoutMs;
  while (!(await isIdle())) {
    if (Date.now() > deadline) {
      throw new EnvironmentBlocked(
        `the session still had a live run after ${timeoutMs}ms (a previous turn never finished): the case `
        + 'cannot start its own run while the server would merge the two into one',
      );
    }
    await page.waitForTimeout(500);
  }
  return true;
}

/**
 * 发一条撑得住的长回合并确认运行仍在跑。先等会话静下来（见 waitForRunIdle），再发；过了
 * `settleMs` 仍不见运行（模型秒答 / 没跑 sleep / 钩子没公布）就重发一次，仍不成立即
 * ENVIRONMENT_BLOCKED。返回 { runId, marker, attempt }。
 */
export async function startSustainedRun(page, pane, marker, { attempts = 2, settleMs = 2_500 } = {}) {
  await waitForRunIdle(page, pane);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await sendPrompt(page, pane, sustainedPrompt(marker));
    try {
      const runId = await waitForRunLive(page, pane);
      // 秒答也有一瞬间是"活"的（首帧就带 runId），所以再等 settleMs 复核一次：这段时间里
      // 运行还活着，说明模型确实在跑那条 sleep，观察窗口才有东西可观察。
      await page.waitForTimeout(settleMs);
      await waitForRunLive(page, pane, { timeoutMs: 1_000 });
      return { runId, marker, attempt };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Same vocabulary as the app's own source-state judgment (client/src/utils/agentView.js
// taskRunEvidence / agentSourceState): a Task|Agent call whose result is not back yet, or whose
// result is this "it keeps running in the background" wording, counts as a running source until a
// terminal task-notification for the same toolUseId arrives. The suite reads the same evidence off
// the app's own history endpoint instead of the client store.
const AGENT_RUNNING_TOOL_NAMES = new Set(['Task', 'Agent']);
const AGENT_TERMINAL_NOTICE_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed']);
const AGENT_ASYNC_LAUNCH_RE = /async agent launched|working in the background|已在后台启动/i;

/**
 * 公开面「这条子代理仍在跑」前置（SB-T52 用）。
 * 读母会话自己的消息（`GET /api/sessions/:id/messages` —— 应用公布的历史面，也是视图判断
 * 「实时/历史」所用的同一份证据）：这条 Task/Agent 调用还没有结果（前台在飞），或结果是
 * "已在后台启动"且此后没有指到它的终态通知 → 仍在跑，返回 { evidence, reason }。
 * 判据不成立 = 夹具的运行窗口已过（agentRunning 硬寿命≈30–45 分钟，见
 * .devflow/second-batch-evidence/agent-fixtures-prep.md §6），此刻"视图显示历史"是夹具过期，
 * 不是产品回归：报 ENVIRONMENT_BLOCKED 并给出重做路径，绝不让环境红冒充产品结论。
 * projectHash 不给时从应用自己的搜索命中里取（夹具身份的唯一来源就是它自己的搜索面）。
 */
export async function requireAgentRunLive(request, baseURL, { marker, parentSessionId, toolUseId, projectHash = null }) {
  let hash = projectHash;
  if (!hash) {
    const search = await request.get(`${baseURL}/api/search?q=${encodeURIComponent(marker)}`);
    const hits = (await jsonBody(search))?.hits || [];
    const hit = hits.find(item => item.sessionId === parentSessionId) || hits[0];
    if (!hit?.projectHash) {
      throw new EnvironmentBlocked(
        `agent fixture ${marker} is not searchable through the app (no /api/search hit): the fixture session `
        + 'is gone and must be re-prepared (see .devflow/second-batch-evidence/agent-fixtures-prep.md §1)',
      );
    }
    hash = hit.projectHash;
  }
  const { status, body } = await readMessages(request, baseURL, parentSessionId, hash);
  if (status !== 200) {
    throw new EnvironmentBlocked(
      `could not read the parent history of ${parentSessionId} (HTTP ${status}) to check whether the source `
      + `subagent ${toolUseId} is still running`,
    );
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const call = messages
    .flatMap(message => (Array.isArray(message?.toolCalls) ? message.toolCalls : []))
    .find(item => item?.id === toolUseId && AGENT_RUNNING_TOOL_NAMES.has(item?.name));
  const terminalNotice = messages.find(message => message?.type === 'task-notice'
    && typeof message.text === 'string' && message.text.includes(toolUseId)
    && AGENT_TERMINAL_NOTICE_STATUSES.has(message.status));
  const resultText = call?.result
    ? (typeof call.result.content === 'string' ? call.result.content : JSON.stringify(call.result.content || ''))
    : '';
  if (call && !terminalNotice) {
    if (!call.result) return { evidence: 'running', reason: 'the Task call has no result yet: the source run is in flight' };
    if (!call.result.isError && AGENT_ASYNC_LAUNCH_RE.test(resultText)) {
      return { evidence: 'running', reason: 'backgrounded launch with no terminal notification yet' };
    }
  }
  const observed = !call
    ? 'the parent history holds no Task/Agent call with that toolUseId'
    : (terminalNotice
      ? `a terminal task-notice (${terminalNotice.status}) is already in the parent history`
      : `the Task result is not the backgrounded launch (head: ${resultText.slice(0, 120)})`);
  throw new EnvironmentBlocked(
    `agentRunning fixture window has lapsed: ${observed}. This case needs the source subagent still running; `
    + 'rebuild it (agent-fixtures-prep.md §1/§6: delete the fixture session, then re-run '
    + 'sb-agent-prep.mjs <BASE> --only=running — if the model then runs that Task in the foreground, use '
    + '.devflow/second-batch-evidence/tools/prep-agent-running-bg.mjs, see TEST-PLAN 第四轮修订)',
  );
}

/**
 * SB-T38 的断线刺激：一条只走 127.0.0.1 的直通 TCP 代理，页面经它访问被测实例。
 * `offline()` = 切掉现有连接（真实传输层断开）并在窗口内拒绝新连接 —— 就是"网断了 N 秒"；
 * `restore()` = 网络回来。实测走的是合同里「无通知的网络断开」那条路（服务端先发 detached
 * 的接管不在此列）。
 *
 * 为什么不用 `context.setOffline`：实测 Chromium 的 offline 模拟**不会**切断已经建立的
 * streaming fetch —— 应用内 20s 实测与同版最小复现（本地 SSE 服务 + 同一个 setOffline）
 * 都显示数据照收、断链后无任何中断痕迹，用它断不了链。同版本证据：
 * .devflow/second-batch-evidence/tools/probe-offline-breaks-stream.mjs。
 */
export async function startCuttableProxy(target) {
  const upstreamURL = new URL(target);
  const sockets = new Set();
  let holding = false;
  const cut = () => { for (const socket of [...sockets]) socket.destroy(); };
  const server = net.createServer(client => {
    if (holding) { client.destroy(); return; }
    const up = net.connect(Number(upstreamURL.port), upstreamURL.hostname);
    sockets.add(client); sockets.add(up);
    const drop = () => { sockets.delete(client); sockets.delete(up); client.destroy(); up.destroy(); };
    client.on('error', drop); up.on('error', drop);
    client.on('close', () => sockets.delete(client));
    up.on('close', () => sockets.delete(up));
    client.pipe(up); up.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    offline() { holding = true; cut(); },
    restore() { holding = false; },
    async close() { holding = true; cut(); await new Promise(resolve => server.close(resolve)); },
  };
}

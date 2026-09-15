// Second-batch (R11–R13) helper layer.
// Reuses the locked first-batch helpers instead of copying them; only the additions
// this batch needs (own fixture manifest, model guard, chat/SSE/stop contract probes,
// pane-identity observation) live here.
import fs from 'node:fs';
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
export const openFixtureSession = fb.openFixtureSession;

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

/** Opens a top-bar dock panel (文件 / 审查 / 监控 / …); expands the dock first when collapsed. */
export async function openDockPanel(page, name) {
  const panelButton = page.getByRole('button', { name, exact: true }).first();
  if (!(await panelButton.count())) {
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await expect(panelButton).toBeVisible();
  await clickThroughOverlays(page, panelButton);
}

export async function openMonitorPanel(page) {
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
 * elements exist. The observed control is `[data-testid=pane-split]` with options 1–6;
 * if the product needs another step to materialise a second pane this helper fails loudly
 * instead of guessing (see README "Observations to confirm").
 */
export async function ensurePaneCount(page, count) {
  const control = page.getByTestId('pane-split').first();
  if (!(await control.count())) {
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await expect(control, 'the 分屏 control must exist to observe pane identity').toBeVisible();
  await clickThroughOverlays(page, control);
  const option = page.getByRole('button', { name: String(count), exact: true });
  if (await option.count()) {
    await clickThroughOverlays(page, option.first());
  } else {
    const item = page.locator('[role=menuitem],[role=option]').filter({ hasText: new RegExp(`^\\s*${count}\\b`) }).first();
    await clickThroughOverlays(page, item);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await expect
    .poll(() => paneLocator(page).count(), {
      message: `expected ${count} chat pane(s) after choosing 分屏=${count}`,
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
  await openDockPanel(page, '监控');
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
  await pane.click({ position: { x: 24, y: 24 } }).catch(() => {});
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

export function modelSelectorText(page) {
  return page.getByRole('button', { name: /claude-|gpt-|默认|模型/ }).first();
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
// 观测补充（隔离实例 60094 实测，2026-09-11）：当前构建还没有 [data-testid=pane] /
// [data-pane-id]，分屏与窗格只能用真实产品控件点出来。以下定位器全部来自实测现象：
//   顶栏「设置」展开 dock → 按钮「分屏」（tooltip「分屏数量（1–6）」）→ 数字按钮 1–6；
//   窗格标题「分屏 N」「分屏 N · 当前」；空栏提示「点左侧任一会话填入本分屏（此栏已高亮为当前）」；
//   每栏关闭按钮「关闭此分屏（不结束会话 / 不杀进程）」。
//   [data-pane-id] / [data-owner-key] 一旦落地，paneScope 自动优先走合同钩子。
// ---------------------------------------------------------------------------

/** 合同要求的行为在当前构建里根本不存在（缺字段/缺入口）——是合同未实现，不是“通过了”。 */
export class ContractNotImplemented extends Error {
  constructor(message) {
    super(`CONTRACT_NOT_IMPLEMENTED: ${message}`);
    this.name = 'ContractNotImplemented';
  }
}

export function requireModelFixtures(reason) {
  if (process.env[MODEL_FLAG] !== '1') {
    throw new EnvironmentBlocked(
      `${MODEL_FLAG}=1 is required: ${reason} (prepare the disposable model account first; see README "Not preparable")`,
    );
  }
}

/** requireField 的别名，语义相同：夹具字段没备好是环境问题，不是产品失败。 */
export const fixtureValue = requireField;

/** 失败体的合同形状 {ok:false,code,error}；缺 ok/code 时抛 ContractNotImplemented。 */
export function expectFailureEnvelope(result, { status, code, label }) {
  expect(result.status, `${label}: HTTP status`).toBe(status);
  const body = result.body;
  if (!body || typeof body !== 'object' || body.ok !== false || typeof body.code !== 'string') {
    throw new ContractNotImplemented(
      `${label}: failure body must be {ok:false,code,error}; got ${JSON.stringify(body).slice(0, 160)}`,
    );
  }
  expect(body.code, `${label}: stable code`).toBe(code);
  expect(typeof body.error, `${label}: readable error sentence`).toBe('string');
  expect(body.error.length, `${label}: error sentence must not be empty`).toBeGreaterThan(0);
  expect(body.error, `${label}: error must not leak a local file path`).not.toMatch(/\/(Users|home)\//);
}

export async function getJson(request, baseURL, pathname) {
  const response = await request.get(`${baseURL}${pathname}`, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

/** 当前窗格数量：[data-pane-id] 优先，否则数「分屏 N」标题。 */
export async function paneCount(page) {
  return await page.evaluate(() => {
    const contractPanes = document.querySelectorAll('[data-pane-id]').length;
    if (contractPanes) return contractPanes;
    // 实测：分栏标题与“空栏提示”里都会出现「分屏 N」，按编号去重才是真实栏数；
    // 单栏布局没有任何「分屏 N」标题，此时就是 1 栏。
    const indexes = new Set();
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue;
      if (el.closest('header,[role=banner],aside')) continue; // 顶栏「分屏 N」按钮不算窗格
      const match = /^分屏\s(\d+)( · 当前)?$/.exec((el.textContent || '').trim());
      if (match) indexes.add(match[1]);
    }
    return indexes.size || 1;
  });
}

/**
 * 给第 n 个窗格打上只属于测试页面的作用域标记（属性名带 fb2 前缀，产品不认识），
 * 供本测试把断言限定在某一栏内。只改测试页面 DOM，不改产品行为。
 */
export async function paneScope(page, n) {
  const ok = await page.evaluate(index => {
    for (const m of document.querySelectorAll('[data-fb2-pane-scope]')) m.removeAttribute('data-fb2-pane-scope');
    const headers = [...document.querySelectorAll('*')].filter(el =>
      !el.children.length
      && !el.closest('header,[role=banner],aside')
      && /^分屏\s\d+( · 当前)?$/.test((el.textContent || '').trim()));
    const contractPanes = [...document.querySelectorAll('[data-pane-id]')];
    if (contractPanes.length) {
      const target = contractPanes[index - 1];
      if (!target) return false;
      target.setAttribute('data-fb2-pane-scope', String(index));
      return true;
    }
    const mine = headers.find(el => new RegExp(`^分屏\\s${index}( |$)`).test((el.textContent || '').trim()));
    if (!mine) {
      // 单栏布局没有「分屏 N」标题（实测）：作用域退化为“输入框往上、能罩住消息列表的那层容器”。
      const composer = document.querySelector('textarea, [contenteditable="true"]');
      let node = composer && composer.parentElement;
      let hops = 0;
      while (node && node.parentElement && hops < 8 && !node.querySelector('[data-message-id]')) {
        node = node.parentElement;
        hops += 1;
      }
      if (node) {
        node.setAttribute('data-fb2-pane-scope', String(index));
        return true;
      }
      return false;
    }
    // 实测：同一栏里「分屏 N」会出现两次（栏标题 + 空栏提示标题），只有“别的编号”才算边界。
    const mineIndex = ((mine.textContent || '').trim().match(/^分屏\s(\d+)/) || [])[1];
    let node = mine;
    while (node.parentElement) {
      const parent = node.parentElement;
      const reachesAnotherPane = headers.some(h => {
        if (h === mine) return false;
        const otherIndex = ((h.textContent || '').trim().match(/^分屏\s(\d+)/) || [])[1];
        return otherIndex && otherIndex !== mineIndex && parent.contains(h);
      });
      if (reachesAnotherPane) break;
      node = parent;
    }
    node.setAttribute('data-fb2-pane-scope', String(index));
    return true;
  }, n);
  if (!ok) {
    throw new ContractNotImplemented(
      `pane ${n}: neither [data-pane-id] nor a “分屏 ${n}” pane header is observable`,
    );
  }
  return page.locator(`[data-fb2-pane-scope="${n}"]`).first();
}

export async function paneText(page, n) {
  return (await (await paneScope(page, n)).innerText()).replace(/\s+/g, ' ');
}

/** 时变字段归一化后的窗格快照：只去掉相对时间与时钟，其余逐字保留。 */
export async function paneSnapshot(page, n) {
  return (await paneText(page, n))
    .replace(/刚刚|\d+\s*(秒|分钟|小时|天)前|\b\d{1,2}:\d{2}\b/g, 'T')
    .trim();
}

/** 分屏数量设为 n（1–6）：dock「分屏」→ 数字 n。 */
export async function openSplitPanes(page, n) {
  const split = page.getByRole('button', { name: '分屏', exact: true }).first();
  if (!(await split.count())) {
    await clickThroughOverlays(page, page.getByRole('button', { name: /^设置/ }).first());
  }
  await clickThroughOverlays(page, split);
  await clickThroughOverlays(page, page.getByRole('button', { name: String(n), exact: true }).first());
  await page.keyboard.press('Escape').catch(() => {});
  await expect.poll(() => paneCount(page), {
    message: `expected ${n} chat pane(s) after choosing 分屏=${n}`,
    timeout: 8_000,
  }).toBe(n);
}

/** 把“当前高亮窗格”切到第 n 栏：点该栏内部（空栏点提示区，非空栏点输入框）。 */
export async function activatePaneByHeader(page, n) {
  const scope = await paneScope(page, n);
  const hint = scope.getByText(/点左侧任一会话填入本分屏/);
  if (await hint.count()) {
    await clickThroughOverlays(page, hint.first());
  } else {
    await clickThroughOverlays(page, scope.getByRole('textbox').first());
  }
  await page.waitForTimeout(400);
}

/** 在第 n 栏的输入框里发送一条消息，返回这条消息的唯一标记。 */
export async function sendInPane(page, n, text) {
  const scope = await paneScope(page, n);
  const composer = scope.getByRole('textbox', { name: /打开命令/ }).first();
  await expect(composer, `composer of pane ${n}`).toBeVisible();
  await composer.fill(text);
  await page.keyboard.press('Enter');
  return text;
}

/** 关闭第 n 栏的分屏（不结束会话/进程）：从该栏标题往上找最近的「关闭此分屏」按钮。 */
export async function closePaneByIndex(page, n) {
  const ok = await page.evaluate(index => {
    for (const marked of document.querySelectorAll('[data-fb2-close-pane]')) marked.removeAttribute('data-fb2-close-pane');
    const headers = [...document.querySelectorAll('*')].filter(el =>
      !el.children.length
      && !el.closest('header,[role=banner],aside')
      && /^分屏\s\d+( · 当前)?$/.test((el.textContent || '').trim()));
    const mine = headers.find(el => new RegExp(`^分屏\\s${index}( |$)`).test((el.textContent || '').trim()));
    if (!mine) return false;
    let node = mine;
    while (node && !node.querySelector('button')) node = node.parentElement;
    while (node) {
      const button = [...node.querySelectorAll('button')]
        .find(el => /关闭此分屏/.test(`${el.getAttribute('title') || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`));
      if (button) {
        button.setAttribute('data-fb2-close-pane', String(index));
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }, n);
  if (!ok) throw new ContractNotImplemented(`pane ${n}: no “关闭此分屏” affordance is observable`);
  await clickThroughOverlays(page, page.locator(`[data-fb2-close-pane="${n}"]`).first());
  await page.waitForTimeout(800);
}

/** 点侧栏会话列表里的会话行（按标题前缀）；需要侧栏已经列出该会话。 */
export async function openSidebarSession(page, titleFragment) {
  const row = page.locator('aside').getByText(new RegExp(`^${escapeRegExpLocal(titleFragment)}`)).first();
  await expect(row, `sidebar row for ${titleFragment}`).toBeVisible();
  await clickThroughOverlays(page, row);
  await page.waitForTimeout(800);
}

function escapeRegExpLocal(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

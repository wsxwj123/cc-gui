// r198 界面操作层(搭法照 r197 / r146b 的 helpers/ui.mjs,自成一套)。
// 只通过页面(输入框 / 排队栏 / 卡片文字 / 按钮 / 弹框)、页面发出的 POST 及其应答、公开接口 GET /api/agents/active、
// 会话文件、假命令行的本机控制文件观察,不碰任何内部模块。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}
/** 刷新页面(路由与初始化脚本保留)。 */
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: mark }).first();

/** 通过侧栏搜索打开某条夹具会话(夹具工作区不在侧栏常规列表里,必须走搜索;搜索是全文的,mark 可以是会话里任意一段唯一文字)。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try {
    await expect(search).toHaveValue('', { timeout: 5_000 });
  } catch {
    await search.fill('');
    test.info().annotations.push({ type: '搜索词未自动清空(已兜底)', description: 'r198 openSessionBySearch' });
  }
  await page.waitForTimeout(800);
}

export const composer = (page, scope) => (scope || page).getByPlaceholder(/输入消息|开始一个新会话/).last();

/** 打字 + 回车。 */
export async function sendPrompt(page, text, scope) {
  const box = composer(page, scope);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}
/** 打字 + Cmd/Ctrl+Enter(并入这一轮)。 */
export async function sendSteerKey(page, text, scope) {
  const box = composer(page, scope);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('ControlOrMeta+Enter');
}

/** 主停止键(输入区的那一颗;卡片上若也有「停止…」按钮,它们在 DOM 里排在输入区之前)。 */
export const mainStopButton = (page) => page.getByRole('button', { name: /^停止/ }).last();
export const anyStopVisible = (page) => page.evaluate(() => [...document.querySelectorAll('button')].some((b) => {
  const t = ((b.innerText || '').trim()) || (b.getAttribute('aria-label') || '').trim() || (b.getAttribute('title') || '').trim();
  return t.startsWith('停止') && b.offsetParent !== null;
}));
export async function waitStopGone(page, timeout = 20_000, label = '') {
  try {
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => {
      const t = ((b.innerText || '').trim()) || (b.getAttribute('aria-label') || '').trim() || (b.getAttribute('title') || '').trim();
      return t.startsWith('停止') && b.offsetParent !== null;
    }), null, { polling: 'raf', timeout });
  } catch {
    throw new Error(`${label}停止键应消失,但 ${timeout} 毫秒内页面上一直还有停止键`);
  }
}
export const queueItem = (page, text) => page.locator('[data-testid="queue-item"]').filter({ hasText: text });
export const moveBtn = (scope) => scope.locator('[data-cgui="move-to-bg-btn"]');

/** 轮询到 fn 给出真值(返回它),超时抛带说明的错。 */
export async function until(fn, { timeout = 15_000, every = 150, message = '等待条件超时' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`${message}(等了 ${timeout} 毫秒)`);
    await new Promise((r) => setTimeout(r, every));
  }
}
export const bodyText = (page) => page.locator('body').innerText();
export const bodyHas = async (page, text) => (await bodyText(page)).includes(text);
export const waitBodyText = (page, text, timeout = 20_000) =>
  expect.poll(async () => (await bodyText(page)).includes(text), { timeout, intervals: [200], message: `页面上应出现「${text.slice(0, 60)}」` });
/** 整页可见文字里 phrase 出现几次。 */
export const phraseCount = async (page, phrase) => ((await bodyText(page)).split(phrase).length - 1);

// ---------------------------------------------------------------- 页面发出的请求录制
const pathOf = (req) => { try { return new URL(req.url()).pathname; } catch { return ''; } };
const jsonOf = (req) => { try { return req.postDataJSON(); } catch { return null; } };
const promptOf = (req) => { const j = jsonOf(req); return j && j.prompt != null ? String(j.prompt) : String(req.postData() || ''); };

/** 录 POST /api/chat。 */
export function trackChat(page) {
  const posts = [];
  page.on('request', (req) => { if (req.method() === 'POST' && pathOf(req) === '/api/chat') posts.push({ t: Date.now(), prompt: promptOf(req) }); });
  return { posts, postsWith: (s) => posts.filter((p) => p.prompt.includes(s)) };
}

/** 录 POST /api/chat/background-tasks:请求体、应答状态与应答体。 */
export function trackBg(page) {
  const calls = [];   // { t, body, status, resp }
  const seen = new WeakMap();
  page.on('request', (req) => {
    if (req.method() !== 'POST' || pathOf(req) !== '/api/chat/background-tasks') return;
    const c = { t: Date.now(), body: jsonOf(req), status: null, resp: null, done: false };
    seen.set(req, c); calls.push(c);
  });
  page.on('response', async (res) => {
    const c = seen.get(res.request());
    if (!c) return;
    c.status = res.status();
    try { c.resp = await res.json(); } catch { c.resp = null; }
    c.done = true; c.tDone = Date.now();
  });
  page.on('requestfailed', (req) => { const c = seen.get(req); if (c) { c.status = 0; c.done = true; } });
  return {
    calls,
    all: () => calls.filter((c) => !(c.body && c.body.toolUseId)),
    byTool: (id) => calls.filter((c) => c.body && c.body.toolUseId === id),
    withTool: () => calls.filter((c) => c.body && c.body.toolUseId),
  };
}

// ---------------------------------------------------------------- 弹框(原生 dialog 与应用自己的 role=dialog 两种都认)
export function armDialogs(page, { hold = false } = {}) {
  const rec = { native: [], pending: null, hold };
  page.on('dialog', (d) => {
    rec.native.push({ type: d.type(), message: d.message() });
    if (rec.hold) rec.pending = d; else d.accept().catch(() => {});
  });
  return rec;
}
const customDialog = (page) => page.locator('[role="dialog"], [role="alertdialog"]').filter({ hasText: /\S/ });
/** 弹框(原生或应用内)里出现了 text,或页面可见文字里出现了 text。 */
export const dialogShows = async (page, rec, text) =>
  rec.native.some((d) => d.message.includes(text))
  || (await customDialog(page).allInnerTexts().catch(() => [])).some((t) => t.includes(text));
export const anyCustomDialog = async (page) => (await customDialog(page).count().catch(() => 0)) > 0;
/** 关掉应用内弹框(点它的确定 / 知道了 / 关闭;不按 Esc —— Esc 会停止回合)。 */
export async function dismissCustomDialogs(page) {
  for (let i = 0; i < 3; i += 1) {
    const dlg = customDialog(page).first();
    if (!(await dlg.isVisible().catch(() => false))) return;
    const btn = dlg.getByRole('button', { name: /^(确定|确认|知道了|关闭|好的?|OK)$/ }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {}); else return;
    await page.waitForTimeout(300);
  }
}

// ---------------------------------------------------------------- 面板坞 / 窗格(抄 r146b 的做法)
export const paneCountNow = (page) => page.locator('[data-testid="pane"]').count();
export const paneAt = (page, i) => page.locator('[data-testid="pane"]').nth(i);
export async function openDock(page) {
  const probe = page.locator('[data-testid="pane-count"]').first();
  if (await probe.isVisible().catch(() => false)) return;
  await page.locator('[data-testid="panel-dock-toggle"]').click();
  await expect(probe, '面板坞应展开').toBeVisible({ timeout: 5_000 });
}
export async function setPanes(page, n) {
  if ((await paneCountNow(page)) === n) return;
  await openDock(page);
  const opt = page.getByTestId(`pane-count-${n}`).first();
  if (!(await opt.isVisible().catch(() => false))) await page.getByTestId('pane-count').first().click();
  await opt.click();
  await page.keyboard.press('Escape').catch(() => {});   // 此时没有进行中的回合,Esc 不会停止任何东西
  await expect.poll(() => paneCountNow(page), { message: `应有 ${n} 格`, timeout: 10_000 }).toBe(n);
  await page.waitForTimeout(500);
}
export async function focusPane(page, i) {
  const pane = paneAt(page, i);
  const hint = pane.getByText(/点左侧任一会话填入本分屏/).first();
  if (await hint.isVisible().catch(() => false)) await hint.click();
  else await pane.getByPlaceholder(/输入消息|开始一个新会话/).last().click();
  await page.waitForTimeout(300);
}
/** 打开右侧面板(面板坞里 title 等于 label 的按钮)。 */
export async function openRightPanel(page, label) {
  await openDock(page);
  await page.locator(`[data-cgui="panel-dock"] button[title="${label}"]`).first().click();
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------- 公开接口 GET /api/agents/active
/** 取会话进程条目(含 fgTasks / movedTasks / xsTurn 之一的、且文本里带这个会话编号的对象);没有返回 null。 */
export async function activeEntry(page, sid) {
  const json = await page.evaluate(async () => { const r = await fetch('/api/agents/active'); return r.ok ? r.json() : null; });
  const hits = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (!Array.isArray(o) && ('fgTasks' in o || 'movedTasks' in o || 'xsTurn' in o) && JSON.stringify(o).includes(sid)) hits.push(o);
    for (const v of Object.values(o)) walk(v);
  };
  walk(json);
  return hits[0] || null;
}

// ---------------------------------------------------------------- 卡片文字
export const footerText = (taskId, limit = '30m') => `已移到后台运行 · 任务 ${taskId} · 后台最长 ${limit},到点由命令行停止`;
/** 页面上"已移到后台运行 · 任务 <id>"出现几次。 */
export const movedFooterCount = (page, taskId) => phraseCount(page, `已移到后台运行 · 任务 ${taskId}`);
/** 卡片已出现(命令原文或描述任一可见)。 */
export const cardShown = async (page, step) => { const t = await bodyText(page); return t.includes(step.command) || (step.description && t.includes(step.description)); };
export async function waitCardShown(page, step, timeout = 20_000) {
  await until(() => cardShown(page, step), { timeout, message: `页面上应出现命令卡片(${step.command})` });
  return Date.now();
}
/** 若卡片折叠着、底栏不可见,点一下含命令文字的行把它展开(卡片是否默认折叠接口文件没写,这里兜底)。 */
export async function expandCardIfFolded(page, step, taskId) {
  if ((await movedFooterCount(page, taskId)) > 0) return;
  const el = page.getByText(step.description || step.command, { exact: false }).first();
  if (await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); await page.waitForTimeout(400); }
}
/** 含 footer 的最小卡片容器的整段文字(向上最多 10 层,直到容器里含命令原文或描述)。 */
export const cardTextAround = (page, footer, markers) => page.evaluate(({ footer: f, markers: m }) => {
  const all = [...document.querySelectorAll('body *')].filter((e) => (e.textContent || '').includes(f));
  const deepest = all.filter((e) => ![...e.children].some((c) => (c.textContent || '').includes(f))).pop();
  if (!deepest) return null;
  let cur = deepest;
  for (let i = 0; i < 10 && cur; i += 1) {
    const t = cur.innerText || '';
    if (m.some((x) => x && t.includes(x))) return t;
    cur = cur.parentElement;
  }
  return deepest.innerText || '';
}, { footer, markers });
/** 按钮所在的卡片容器里含 mine 里任一段、且不含 others 里任何一段。 */
export const btnOwnedBy = (page, mine, others) => page.evaluate(({ mine: a, others: b }) => {
  const btn = document.querySelector('[data-cgui="move-to-bg-btn"]');
  if (!btn) return { found: false };
  let cur = btn.parentElement;
  for (let i = 0; i < 10 && cur; i += 1) {
    const t = cur.innerText || '';
    if (a.some((x) => x && t.includes(x))) return { found: true, hasOthers: b.some((x) => x && t.includes(x)), level: i };
    cur = cur.parentElement;
  }
  return { found: false };
}, { mine, others });

// ---------------------------------------------------------------- 假命令行的本机控制文件
const rel = (ctl, sid, suffix) => path.join(ctl, `${sid}.${suffix}`);
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } };
export const setScenario = (ctl, sid, steps) => fs.writeFileSync(rel(ctl, sid, 'scenario.json'), JSON.stringify({ steps }));
export const setBgMode = (ctl, sid, mode) => fs.writeFileSync(rel(ctl, sid, 'bg-mode'), mode);
export const setInterruptDelay = (ctl, sid, ms) => fs.writeFileSync(rel(ctl, sid, 'interrupt-delay-ms'), String(ms));
export const openGate = (ctl, sid, name) => fs.writeFileSync(rel(ctl, sid, `gate-${name}`), String(Date.now()));
export const finishBgTasks = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, 'taskdone'), String(Date.now()));
export const killRun = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, 'kill'), '1');
export function taskStatus(ctl, sid, taskId) { try { return fs.readFileSync(rel(ctl, sid, `task-${taskId}`), 'utf8').trim(); } catch { return null; } }
export function controlLog(ctl, sid) {
  try {
    return fs.readFileSync(rel(ctl, sid, 'control.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
export const logOf = (ctl, sid, ev) => controlLog(ctl, sid).filter((e) => e.ev === ev);
export function runPid(ctl, sid) {
  try { const m = /pid=(\d+)/.exec(fs.readFileSync(rel(ctl, sid, 'started'), 'utf8')); return m ? Number(m[1]) : null; } catch { return null; }
}
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** 收尾:放行所有 gate、让本套件起过的每个假命令行退出(只按它们自己的控制文件,不碰别的进程)。 */
export function releaseAllRuns(ctl) {
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(path.join(ctl, `${m[1]}.gate-post`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.kill`), 'x');
  }
}

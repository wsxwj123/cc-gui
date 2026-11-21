// r196 界面操作层与观测层。只通过页面(文案 / role / data-* 锚点 / title)、页面发出的 POST /api/chat、公开接口 GET /api/agents/active、
// 会话文件、假命令行的控制文件观察;不读源码、不读应用内部状态。
// 打开会话 / 发消息 / 搜索的写法承自 r140 与 r203 套件(复制改用,不 import 它们)。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const CTL = process.env.R196_CTL;
export const API = process.env.R196_API_BASE;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (sid, suffix) => path.join(CTL, `${sid}${suffix}`);

// ───────────────────────── 进应用 / 打开会话 ─────────────────────────
/** 进应用并压掉旅游浮层 / 更新检查。split=true:第一次加载时写两格分屏。 */
export async function boot(page, { split = false } = {}) {
  await page.addInitScript((wantSplit) => {
    try {
      localStorage.setItem('cgui-tour-seen', '1');
      if (wantSplit && !sessionStorage.getItem('r196-split-written')) {
        localStorage.setItem('cgui-pane-count', '2');
        localStorage.setItem('cgui-active-tab-index', '0');
        sessionStorage.setItem('r196-split-written', '1');
      }
    } catch { /* 忽略 */ }
  }, split);
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}
export async function reloadApp(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 60_000 });
}

const hitRow = (page, mark) => page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();
/** 第一次打开某条夹具会话必须走搜索(夹具工作区不进侧栏常规列表)。 */
export async function openSessionBySearch(page, mark) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  await page.waitForTimeout(800);
}
export const sessionRow = (page, mark) => page.locator('[role=button].sidebar-item').filter({ hasText: mark }).first();
export async function switchTo(page, mark) {
  const row = sessionRow(page, mark);
  await expect(row, `侧栏里应能看到会话 ${mark}`).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.waitForTimeout(500);
}

// ───────────────────────── 窗格 / 输入框 / 排队栏 ─────────────────────────
export const panes = (page) => page.locator('[data-testid="pane"]');
export const paneKeys = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid=pane]')].map((p) => p.getAttribute('data-owner-key')));
export const paneText = (page, ownerKey) => page.evaluate((k) => {
  const pane = [...document.querySelectorAll('[data-testid=pane]')].find((p) => p.getAttribute('data-owner-key') === k);
  return pane ? (pane.innerText || pane.textContent || '') : null;
}, ownerKey);
export async function focusPane(page, i) {
  const pane = panes(page).nth(i);
  await expect(pane, `第 ${i + 1} 格应存在`).toBeVisible({ timeout: 15_000 });
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
}
export const composer = (page, scope) => (scope || page).getByPlaceholder(/输入消息|开始一个新会话/).last();
export async function sendPrompt(page, text, scope) {
  const box = composer(page, scope);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}
export const queueItems = (scope) => scope.locator('[data-testid="queue-item"]');
export const queueItemOf = (scope, text) => scope.locator('[data-testid="queue-item"]').filter({ hasText: text });
export const stopBtn = (page) => page.getByRole('button', { name: /^停止/ });
export const userBubbleCount = (page, text) => page.locator('.chat-user-bubble').filter({ hasText: text }).count();
/** 消息区里的附件卡片数(排除排队栏里的)。 */
export const attachmentCards = (page) => page.locator('[data-testid="attachment-item"]:not([data-testid="queue-item"] [data-testid="attachment-item"])').count();
/** 主会话修订(锁定后):已发消息上的附件图片 —— 消息区里含 text 的用户消息卡上,alt 为附件文件名的图片个数。
 *  (`attachment-item` 只标在输入框上方待发的附件上,已发消息的卡片不带它;卡头还有头像图片,所以按文件名认。) */
export const bubbleAttachmentImages = (page, text, name) => page.locator('[data-cgui="message-list"] [data-cgui="message-user"]')
  .filter({ hasText: text }).locator(`img[alt="${name}"]`).count();

// ───────────────────────── 图片附件 ─────────────────────────
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k += 1) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function pngBuffer(w, h) {
  const row = w * 3 + 1; const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y += 1) { raw[y * row] = 0; crypto.randomFillSync(raw, y * row + 1, w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** 往输入框加一张小图,等卡片出现且图片加载成功;返回上传后服务端存的文件名(取上传应答里 path 的末段)。 */
export async function addImage(page, name) {
  const uploads = [];
  const onResp = (r) => { if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/upload') uploads.push(r.json().catch(() => null)); };
  page.on('response', onResp);
  await page.locator('[data-cgui="composer"] input[type=file]').first().setInputFiles({ name, mimeType: 'image/png', buffer: pngBuffer(16, 16) });
  await expect.poll(() => page.evaluate((nm) => [...document.querySelectorAll('[data-testid="attachment-item"]')]
    .filter((c) => !c.closest('[data-testid="queue-item"]'))
    .some((c) => { const img = c.querySelector('img'); return Boolean(img) && img.alt === nm && img.complete && img.naturalWidth > 0; }), name),
  { message: `${name} 应上传完成(卡片里出现加载成功的图片)`, timeout: 30_000 }).toBe(true);
  page.off('response', onResp);
  const paths = [];
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'path' && typeof v === 'string') paths.push(v); else walk(v); } };
  for (const j of await Promise.all(uploads)) walk(j);
  expect(paths.length, '应从 /api/upload 应答里读到图片路径').toBeGreaterThan(0);
  return path.basename(paths[0]);
}

// ───────────────────────── 后台请求记录 / 拦截 ─────────────────────────
const isChat = (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/chat';
/** 记录每个 POST /api/chat:发出时刻、请求体、发出时各窗格显示的会话、应答状态与应答体。 */
export function recordChat(page) {
  const posts = [];
  const byReq = new Map();
  page.on('request', (req) => {
    if (!isChat(req)) return;
    let body = null; try { body = req.postDataJSON(); } catch { /* 留 null */ }
    const rec = { t: Date.now(), body, panes: null, status: null, resp: null, failed: false };
    posts.push(rec); byReq.set(req, rec);
    page.evaluate(() => [...document.querySelectorAll('[data-testid=pane]')].map((p) => p.getAttribute('data-owner-key'))).then((k) => { rec.panes = k; }).catch(() => {});
  });
  page.on('response', (res) => {
    const rec = byReq.get(res.request());
    if (!rec) return;
    rec.status = res.status();
    res.json().then((j) => { rec.resp = j; }).catch(() => {});
  });
  page.on('requestfailed', (req) => { const rec = byReq.get(req); if (rec) rec.failed = true; });
  return {
    posts,
    drains: () => posts.filter((p) => p.body && p.body.queuedDrain === true),
    withText: (text) => posts.filter((p) => p.body && String(p.body.prompt || '').includes(text)),
  };
}
export const routeChat = (page, handler) => page.route((url) => url.pathname === '/api/chat', (route) => {
  if (route.request().method() !== 'POST') return route.continue();
  return handler(route);
});
/** 回合编号:请求体里叫 *turnId* 的那个字段(没有则返回 null)。 */
export const turnIdOf = (body) => {
  if (!body) return null;
  if (body.clientTurnId != null) return body.clientTurnId;
  const k = Object.keys(body).find((x) => /turn.?id/i.test(x));
  return k ? body[k] : null;
};

// ───────────────────────── 假命令行控制 / 观察 ─────────────────────────
export const holdStart = (sid) => fs.writeFileSync(rel(sid, '.slow-ms'), '3600000');
export const releaseStart = (sid) => fs.writeFileSync(rel(sid, '.slow-ms'), '0');
export const setAuto = (sid, ms) => fs.writeFileSync(rel(sid, '.auto-ms'), String(ms));
export const setGlobal = (name, ms) => fs.writeFileSync(path.join(CTL, name), String(ms));
export const clearGlobal = (name) => { try { fs.unlinkSync(path.join(CTL, name)); } catch { /* 本来就没有 */ } };
export const releaseChunk = (sid) => fs.writeFileSync(rel(sid, '.chunk'), String(Date.now()));
export const releaseDone = (sid) => fs.writeFileSync(rel(sid, '.done'), String(Date.now()));
export const setScenario = (sid, steps) => fs.writeFileSync(rel(sid, '.scenario.json'), JSON.stringify({ steps }));
export const compactNow = (sid) => fs.writeFileSync(rel(sid, '.compact'), String(Date.now()));
export const finishBgTasks = (sid) => fs.writeFileSync(rel(sid, '.taskdone'), String(Date.now()));
export const phaseOf = (sid) => { try { return fs.readFileSync(rel(sid, '.phase'), 'utf8').trim(); } catch { return null; } };
export async function waitForPhase(sid, want, timeoutMs = 40_000) {
  const t0 = Date.now();
  while (phaseOf(sid) !== want) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 <${sid}>.phase = ${want} 超时(现在是 ${phaseOf(sid)})`);
    await sleep(100);
  }
}
const readJsonl = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
/** 这条会话的各回合 {ev:'start'|'end', n, text, t, why}。 */
export const roundsOf = (sid) => readJsonl(rel(sid, '.rounds.jsonl'));
export const endOfRound = (sid, textPart) => roundsOf(sid).find((r) => r.ev === 'end' && String(r.text).includes(textPart)) || null;
/** 起过的交互式命令行进程(某会话的)。 */
export const spawnsOf = (sid) => readJsonl(path.join(CTL, 'spawns.jsonl')).filter((s) => s.sid === sid);
/** 命令行收到过的用户消息(某会话的)。 */
export const receivedOf = (sid) => readJsonl(path.join(CTL, 'received.jsonl')).filter((s) => s.sid === sid);
export const receivedAll = () => readJsonl(path.join(CTL, 'received.jsonl'));
export const runPid = (sid) => { try { const m = /pid=(\d+)/.exec(fs.readFileSync(rel(sid, '.started'), 'utf8')); return m ? Number(m[1]) : null; } catch { return null; } };

/** GET /api/agents/active 里某会话的 chat-process 条目(没有 = null)。 */
export async function activeEntry(sid) {
  try {
    const j = await (await fetch(`${API}/api/agents/active`, { signal: AbortSignal.timeout(3000) })).json();
    return (j.agents || []).find((x) => x && x.kind === 'chat-process' && x.sessionId === sid) || null;
  } catch { return null; }
}
export const isBusyStatus = (e) => Boolean(e) && (e.status === 'streaming' || e.status === 'starting');

/** 收尾:让这个实例里所有会话的回合都自己走完(别把任何回合晾在停住状态)。 */
export function releaseAllRuns() {
  let names = [];
  try { names = fs.readdirSync(CTL); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(rel(m[1], '.slow-ms'), '0');
    fs.writeFileSync(rel(m[1], '.auto-ms'), '100');
    fs.writeFileSync(rel(m[1], '.chunk'), 'x');
    fs.writeFileSync(rel(m[1], '.done'), 'x');
  }
  clearGlobal('slow-ms');
}

// ───────────────────────── 回合推进(组合动作) ─────────────────────────
/** A 的第一轮发出 p1,等它吐出第一块文字(回合进行中);返回 A 的回合里文字的断言依据。 */
export async function startRunning(page, A, p1, scope) {
  await switchTo(page, A.mark);
  await sendPrompt(page, p1, scope);
  await expect(page.getByText(`R196-CHUNK1 ${A.sid.slice(0, 8)} 收到:${p1}`, { exact: false }).first(), 'A 的回合应吐出第一块文字(回合进行中)')
    .toBeVisible({ timeout: 40_000 });
  await expect(stopBtn(page).first(), '回合进行中应有可用的停止按钮').toBeEnabled({ timeout: 10_000 });
}
/** 在回合进行中排一条消息(输入框回车),等排队栏里出现它。 */
export async function queueMessage(page, text, scope) {
  await sendPrompt(page, text, scope);
  await expect.poll(() => queueItemOf(scope || page, text).count(), { message: `排队栏里应出现「${text.slice(0, 20)}…」`, timeout: 20_000, intervals: [250] }).toBe(1);
}
/** 放行 A 的这一轮直到收尾(phase=final),返回收尾时刻。 */
export async function finishTurn(sid) {
  releaseChunk(sid); await waitForPhase(sid, 'chunk2');
  releaseDone(sid); await waitForPhase(sid, 'final');
  return Date.now();
}
/** 会话文件里 userLineCount 达到 n(或超时)。 */
export async function waitUntil(fn, { timeout = 15_000, every = 200 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(every);
  }
}

// ───────────────────────── 顶栏模型 / 权限档 ─────────────────────────
const modelBtn = (page) => page.locator('header[data-cgui="topbar"] [data-cgui="model-selector"] button[title^="模型:"]').first();
export async function topModel(page) {
  const t = (await modelBtn(page).getAttribute('title')) || '';
  return t.replace(/^模型:\s*/, '').split('（')[0].trim();
}
const ALIAS_LABEL = { sonnet: 'Sonnet (alias)', opus: 'Opus (alias)', haiku: 'Haiku (alias)', fable: 'Fable (alias)' };
export async function selectModel(page, alias) {
  await modelBtn(page).click();
  const row = page.getByRole('button').filter({ hasText: ALIAS_LABEL[alias] }).first();
  await expect(row, `模型列表里应有「${ALIAS_LABEL[alias]}」行`).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect.poll(() => topModel(page), { message: `选了 ${alias} 之后顶栏应显示 ${alias}`, timeout: 10_000 }).toBe(alias);
}
const modeSelector = (page) => page.locator('[data-testid="permission-mode-selector"]').last();
/** 在权限档选择器里按 data-mode 选档(default = 逐步确认,bypassPermissions = 全部放行)。 */
export async function chooseMode(page, mode) {
  const listbox = page.locator('[role="listbox"]').filter({ has: page.locator('[role="option"]') }).last();
  await expect(modeSelector(page), '应有权限档选择器').toBeVisible({ timeout: 15_000 });
  await modeSelector(page).click();
  await expect(listbox, '选择器弹层应展开').toBeVisible({ timeout: 5_000 });
  const opt = page.locator(`[role="listbox"] [role="option"][data-mode="${mode}"]`);
  await expect(opt, `选择器里应有 data-mode="${mode}" 的选项`).toBeVisible({ timeout: 5_000 });
  await opt.click();
  await page.waitForTimeout(300);
}

export { test };

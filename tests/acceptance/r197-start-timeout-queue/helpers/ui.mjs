// r197 界面操作层(搭法照 r140 的 helpers/ui.mjs,精简自成一套)。只通过页面、本机控制文件、会话文件观察,不碰任何内部模块。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const PHRASE = '会话进程 15 秒内未完成初始化';
export const START_FAILED = '会话进程启动失败';

/** 进应用并压掉旅游浮层/更新检查。 */
export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch {} });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}

const hitRow = (page, mark) =>
  page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item')
    .filter({ hasText: mark }).first();

/** 通过侧栏搜索打开某条夹具会话(夹具工作区不在侧栏常规列表里,必须走搜索)。 */
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
    test.info().annotations.push({ type: '搜索词未自动清空(已兜底)', description: 'r197 openSessionBySearch' });
  }
  await page.waitForTimeout(800);
}

export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();

/** 打字 + 回车。 */
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}

export const stopButton = (page) => page.getByRole('button', { name: /^停止/ });
export const queueItem = (page, text) => page.locator('[data-testid="queue-item"]').filter({ hasText: text });

// ---------------------------------------------------------------- 发送接口录制(只看页面发出的 POST /api/chat 和后端应答)
const promptOf = (req) => {
  try { const j = req.postDataJSON(); if (j && j.prompt != null) return String(j.prompt); } catch { /* 不是 JSON */ }
  return String(req.postData() || '');
};
const isChatPost = (req) => {
  if (req.method() !== 'POST') return false;
  try { return new URL(req.url()).pathname === '/api/chat'; } catch { return false; }
};
export function trackChat(page) {
  const posts = [];   // { t, prompt }
  const resps = [];   // { t, status, body, prompt, sentAt }
  const sentAt = new WeakMap();
  page.on('request', (req) => {
    if (!isChatPost(req)) return;
    const t = Date.now();
    sentAt.set(req, t);
    posts.push({ t, prompt: promptOf(req) });
  });
  page.on('response', async (res) => {
    const req = res.request();
    if (!isChatPost(req)) return;
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    resps.push({ t: Date.now(), status: res.status(), body, prompt: promptOf(req), sentAt: sentAt.get(req) || null });
  });
  return {
    posts, resps,
    postsWith: (s) => posts.filter((p) => p.prompt.includes(s)),
    respWith: (s) => resps.filter((r) => r.prompt.includes(s)),
  };
}

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

// ---------------------------------------------------------------- 页面上"看得见的文字"读数
/** 页面可见文字里 phrase 出现几次(数整页文字,不只看某一个元素)。 */
export const phraseCount = (page, phrase = PHRASE) =>
  page.evaluate((p) => ((document.body.innerText || '').split(p).length - 1), phrase);

/** 一次取齐:超时句数、某条排队消息在排队栏里的个数、停止键个数。 */
export const probe = (page, queuedText) => page.evaluate(({ ph, q }) => {
  const body = document.body.innerText || '';
  const stops = [...document.querySelectorAll('button')].filter((b) => {
    const t = ((b.innerText || '').trim()) || (b.getAttribute('aria-label') || '').trim() || (b.getAttribute('title') || '').trim();
    return t.startsWith('停止') && b.offsetParent !== null;
  }).length;
  const queue = q
    ? [...document.querySelectorAll('[data-testid="queue-item"]')].filter((e) => (e.innerText || '').includes(q)).length
    : 0;
  return { phrase: body.split(ph).length - 1, queue, stops };
}, { ph: PHRASE, q: queuedText || '' });

/** 页内连续录制:每 100 毫秒数一次整页文字里超时句的出现次数,记下最大值与是否见过。 */
export async function installPhraseRecorder(page) {
  await page.evaluate((ph) => {
    const st = { max: 0, seen: false, startedAt: Date.now() };
    window.__r197 = st;
    setInterval(() => {
      const n = ((document.body.innerText || '').split(ph).length - 1);
      if (n > st.max) st.max = n;
      if (n > 0) st.seen = true;
    }, 100);
  }, PHRASE);
}
export const readPhraseRecorder = (page) => page.evaluate(() => ({ ...window.__r197 }));

/** 等"停止键"从页面上消失(raf 级轮询,抓得住只亮一瞬的空档)。 */
export async function waitStopGone(page, timeout = 15_000, label = '') {
  try {
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => {
      const t = ((b.innerText || '').trim()) || (b.getAttribute('aria-label') || '').trim() || (b.getAttribute('title') || '').trim();
      return t.startsWith('停止') && b.offsetParent !== null;
    }), null, { polling: 'raf', timeout });
  } catch {
    throw new Error(`${label}停止键应消失,但 ${timeout} 毫秒内页面上一直还有停止键`);
  }
}

/** 等某段文字出现在页面可见文字里。 */
export const waitBodyText = (page, text, timeout = 20_000) =>
  expect.poll(async () => (await page.locator('body').innerText()).includes(text), { timeout, intervals: [200] });

// ---------------------------------------------------------------- 假命令行的本机控制文件
export const rel = (ctl, sid, suffix) => path.join(ctl, `${sid}${suffix}`);
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* 本来就没有 */ } };
/** 把这条会话的回合无限期按住(命令行进程不吐任何事件)。 */
export const holdSession = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.slow-ms'), '3600000');
/** 只按住这条会话下一个到达的回合(命令行进程不吐任何事件);之后的回合不再被按住。 */
export const holdOnce = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.hold-once'), '1');
/** 之后这条会话的回合不停在中间,自己跑完。 */
export const autoRun = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.auto'), '1');
export const clearHold = (ctl, sid) => { rmQuiet(rel(ctl, sid, '.slow-ms')); rmQuiet(rel(ctl, sid, '.hold-once')); rmQuiet(rel(ctl, sid, '.auto')); };
/** 精确放行被按住的回合。 */
export const releaseSession = (ctl, sid) => { rmQuiet(rel(ctl, sid, '.go')); fs.writeFileSync(rel(ctl, sid, '.go'), String(Date.now())); };
export const releaseChunk2 = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.chunk'), String(Date.now()));
export const releaseTurnEnd = (ctl, sid) => fs.writeFileSync(rel(ctl, sid, '.done'), String(Date.now()));
/** 让这条会话下一个新起的命令行进程启动后静默 ms 毫秒就退出(不吐事件)。 */
export const dieOnStart = (ctl, sid, ms) => fs.writeFileSync(rel(ctl, sid, '.die'), String(ms));
/** 一轮开始前把上一轮残留的放行文件和阶段文件清掉。 */
export const resetTurnFiles = (ctl, sid) => { for (const s of ['.chunk', '.done', '.go', '.phase']) rmQuiet(rel(ctl, sid, s)); };
export const phaseOf = (ctl, sid) => { try { return fs.readFileSync(rel(ctl, sid, '.phase'), 'utf8').trim(); } catch { return null; } };
export async function waitForPhase(ctl, sid, want, timeoutMs = 40_000) {
  const t0 = Date.now();
  for (;;) {
    const p = phaseOf(ctl, sid);
    if (p === want) return p;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 <${sid}>.phase = ${want} 超时(现在是 ${p})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
export function runPid(ctl, sid) {
  try {
    const m = /pid=(\d+)/.exec(fs.readFileSync(rel(ctl, sid, '.started'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** 收尾:放行实例里所有停住的回合,别把任何进程晾在等待里。 */
export function releaseAllRuns(ctl) {
  let names = [];
  try { names = fs.readdirSync(ctl); } catch { return; }
  for (const name of names) {
    const m = /^(.+)\.started$/.exec(name);
    if (!m) continue;
    fs.writeFileSync(path.join(ctl, `${m[1]}.chunk`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.done`), 'x');
    fs.writeFileSync(path.join(ctl, `${m[1]}.go`), 'x');
  }
}

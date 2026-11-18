// r199 界面操作层。只通过页面、拦截 /api/agents/active(制造"页面还没认出这一轮在跑")、本机控制文件观察,不碰任何内部模块。
import { expect } from '@playwright/test';
import { sleep } from './lib.mjs';

export const HINT_NEW = '会话这一轮还在运行，这条已排队，这一轮结束后自动发送；要立刻发送，先点停止。';
export const HINT_CROSS = '会话正在处理跨会话消息，这条已排队，空闲后自动发送；要立刻发送，先点停止。';
export const HINT_CARD = '跨会话消息没有发出：会话这一轮还在运行。卡片已按最新状态刷新。';

export async function boot(page) {
  await page.addInitScript(() => { try { localStorage.setItem('cgui-tour-seen', '1'); } catch { /* 隐私模式 */ } });
  for (const api of ['**/api/version-check', '**/api/claude-version-check']) {
    await page.route(api, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ hasUpdate: false, localBuild: true }) }));
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-cgui="panel-dock"]')).toBeVisible({ timeout: 40_000 });
}
const hitRow = (page, mark) => page.locator('[data-cgui="sidebar"] [data-cgui="search-hit"], [data-cgui="sidebar"] button.sidebar-item').filter({ hasText: mark }).first();
/** 侧栏搜索打开夹具会话(夹具工作区不在侧栏常规列表里,必须走搜索)。 */
export async function openSessionBySearch(page, mark, replyText) {
  const search = page.getByRole('complementary').getByRole('textbox', { name: /搜索工作区/ });
  await expect(async () => {
    await search.click();
    await search.fill(mark);
    await expect(search).toHaveValue(mark, { timeout: 2_000 });
    await expect(hitRow(page, mark)).toBeVisible({ timeout: 8_000 });
  }).toPass({ timeout: 60_000 });
  await hitRow(page, mark).click();
  try { await expect(search).toHaveValue('', { timeout: 5_000 }); } catch { await search.fill(''); }
  if (replyText) await expect(page.getByText(replyText).first(), '历史会话应已打开').toBeVisible({ timeout: 20_000 });
}
export const composer = (page) => page.getByPlaceholder(/输入消息|开始一个新会话/).last();
export async function sendPrompt(page, text) {
  const box = composer(page);
  await expect(box).toBeVisible({ timeout: 15_000 });
  await box.fill(text);
  await box.press('Enter');
}
// 锁定前主会话修订(2026-11-19):按名字「停止」开头会先命中对话里后台命令卡片的停止键(停掉一条后台命令、不打断这一轮,页面也不记「已停止」),U21 因此时红时绿。改按主停止键的固定挂点。
export const stopButton = (page) => page.locator('[data-cgui="stop-btn"]');
export const queueItems = (page) => page.locator('[data-testid="queue-item"]');
export const bodyText = (page) => page.evaluate(() => document.body.innerText || '');
/** 每 150 毫秒数一次,直到整页可见文字里出现 phrase(提示可能是限时的小提示);返回 { seen, ms }。 */
export async function waitPhrase(page, phrase, ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await bodyText(page)).includes(phrase)) return { seen: true, ms: Date.now() - t0 };
    await sleep(150);
  }
  return { seen: false, ms };
}
/** 一次取齐:含 text 的排队项个数、停止键个数、整页文字里是否出现旧错误文案。 */
export const probe = (page, text) => page.evaluate((q) => {
  const body = document.body.innerText || '';
  const stops = [...document.querySelectorAll('button')].filter((b) => {
    const t = ((b.innerText || '').trim()) || (b.getAttribute('aria-label') || '').trim() || (b.getAttribute('title') || '').trim();
    return t.startsWith('停止') && b.offsetParent !== null;
  }).length;
  const queueTexts = [...document.querySelectorAll('[data-testid="queue-item"]')].map((e) => (e.innerText || '').trim());
  return { queued: queueTexts.filter((t) => q && t.includes(q)).length, queueTexts, stops, errorText: /CHAT_SESSION_BUSY|会话正在运行|发送失败/.test(body) };
}, text || '');

// ---------------- 发送接口录制 ----------------
const isChatPost = (req) => { if (req.method() !== 'POST') return false; try { return new URL(req.url()).pathname === '/api/chat'; } catch { return false; } };
const promptOf = (req) => { try { const j = req.postDataJSON(); if (j && j.prompt != null) return String(j.prompt); } catch { /* 不是 JSON */ } return String(req.postData() || ''); };
export function trackChat(page) {
  const posts = []; const resps = [];
  // 锁定前主会话修订(2026-11-19):另记页面去拿回合流的请求(GET /api/chat/<进程号>/stream)。
  // 「页面认出并接回了这一轮」以它为准 —— 有后台命令时主停止键一直亮着,停止键可见不能说明页面接住了这一轮。
  const streams = [];
  page.on('request', (req) => {
    if (isChatPost(req)) posts.push({ t: Date.now(), prompt: promptOf(req) });
    if (req.method() === 'GET') {
      const m = /\/api\/chat\/([^/?#]+)\/stream/.exec(req.url());
      if (m) streams.push({ t: Date.now(), pid: decodeURIComponent(m[1]) });
    }
  });
  page.on('response', async (res) => {
    const req = res.request();
    if (!isChatPost(req)) return;
    let body = null;
    try { body = await res.json(); } catch { /* 不是 JSON */ }
    resps.push({ t: Date.now(), status: res.status(), body, prompt: promptOf(req) });
  });
  return { posts, resps, streams, postsWith: (s) => posts.filter((p) => p.prompt.includes(s)), statusesOf: (s) => resps.filter((r) => r.prompt.includes(s)).map((r) => r.status), respWith: (s) => resps.filter((r) => r.prompt.includes(s)),
    streamsOf: (pid, since = 0) => streams.filter((x) => x.pid === String(pid) && x.t >= since) };
}
/** 拦 /api/agents/active:state.hide 为真时把该会话的 chat-process 条目拿掉(页面看不到这一轮在跑)。 */
export async function hideActive(page, sid) {
  const state = { hide: false };
  await page.route((url) => url.pathname === '/api/agents/active', async (route) => {
    if (!state.hide) { await route.continue(); return; }
    const resp = await route.fetch();
    let j = null;
    try { j = await resp.json(); } catch { j = null; }
    if (!j || !Array.isArray(j.agents)) { await route.fulfill({ response: resp }); return; }
    const agents = j.agents.filter((x) => !(x && x.kind === 'chat-process' && x.sessionId === sid));
    await route.fulfill({ status: resp.status(), contentType: 'application/json', body: JSON.stringify({ ...j, agents }) });
  });
  return state;
}
export const replyOf = (page, marker) => page.getByText(new RegExp(`R199-REPLY .*${marker}`)).first();

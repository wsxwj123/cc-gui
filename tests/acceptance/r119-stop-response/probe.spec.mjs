// r119 探路脚本(不是验收用例):把量法跑通、把数字打出来,给人看,不断言。
//   R119_PROBE=1 tests/acceptance/r119-stop-response/run.sh -g '探路'
// 默认(R119_PROBE 未设)整条 skip,不进验收结论。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { LONGS, SHORTS } from './helpers/fixtures.mjs';
import { analyze, clickStopButton, installProbe, pingPage, pressEsc, readProbe, resetProbe, streamIndex } from './helpers/measure.mjs';
import { boot, openSessionBySearch, sendPrompt, settleStreaming, switchTo, waitStreaming } from './helpers/ui.mjs';

const CTL = process.env.R119_CTL;
test.skip(!process.env.R119_PROBE, '探路脚本只在 R119_PROBE=1 时跑');

const setCtl = (name, value) => fs.writeFileSync(path.join(CTL, name), String(value));
const clearCtl = (name) => { try { fs.unlinkSync(path.join(CTL, name)); } catch { /* 本来就没有 */ } };
const fx = (n) => `R119 探路 第${n}轮:随便发一条,让桩吐起来。`;

async function openAndStream(page, { sid, mark }, prompt) {
  await switchTo(page, mark);
  await sendPrompt(page, prompt);
  await waitStreaming(page, sid);
  await settleStreaming(page, sid);
}

/** 网络时间线:记下 /api 上的请求/响应,标成"相对点击时刻"的毫秒。 */
function netWatch(page) {
  const events = [];
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname.startsWith('/api') || u.pathname.startsWith('/ws')) events.push({ k: `→ ${r.method()} ${u.pathname}`, t: Date.now() }); } catch { /* 忽略 */ } });
  page.on('response', (r) => { try { const u = new URL(r.url()); if (u.pathname.startsWith('/api') || u.pathname.startsWith('/ws')) events.push({ k: `← ${r.status()} ${u.pathname}`, t: Date.now() }); } catch { /* 忽略 */ } });
  page.on('requestfailed', (r) => { try { events.push({ k: `✗ ${new URL(r.url()).pathname}`, t: Date.now() }); } catch { /* 忽略 */ } });
  return { events, dump: (tIssue) => events.filter((e) => e.t >= tIssue - 6_000).map((e) => `${e.t - tIssue}ms ${e.k}`) };
}

async function measureAction(page, act, waitMs = 60_000) {
  await resetProbe(page);
  const pingBefore = await pingPage(page);
  const before = await streamIndex(page);
  const { tIssue } = await act(page);
  await page.waitForFunction(() => window.__r119.sigs.length > 0 || window.__r119.hints.length > 0, null, { timeout: waitMs, polling: 100 }).catch(() => {});
  const tEnd = Date.now();
  const snap = await readProbe(page);
  const res = analyze(snap, tIssue, tEnd);
  const after = await streamIndex(page);
  return { res, before, after, tIssue, pingBefore, tEnd };
}

test('探路 A:长会话载入后,DOM 里到底装了多少历史', async ({ page }) => {
  const { sid, mark } = LONGS[0];
  await boot(page);
  const t0 = Date.now();
  await openSessionBySearch(page, mark);
  const tOpen = Date.now() - t0;
  await switchTo(page, mark);
  await page.waitForTimeout(1_500);
  const stats = await page.evaluate(() => {
    const txt = document.body.textContent || '';
    const idx = [...txt.matchAll(/第 (\d+) 轮:继续排查/g)].map((m) => Number(m[1]));
    return {
      elements: document.querySelectorAll('*').length,
      bodyChars: txt.length,
      cards: document.querySelectorAll('.markdown-content').length,
      bubbles: document.querySelectorAll('.chat-user-bubble').length,
      toolish: (txt.match(/expect\(received\)/g) || []).length,
      turnsInDom: { first: idx[0] ?? null, last: idx[idx.length - 1] ?? null, count: idx.length },
    };
  });
  console.log(`[探路A] 打开夹具会话用时(含搜索)${tOpen}ms;`, JSON.stringify(stats));
  console.log('[探路A] 正文尾部:', JSON.stringify((await page.evaluate(() => (document.body.textContent || '').slice(-300)))));
  expect(true).toBe(true);
});

test('探路 B:长会话(默认节奏)点「停止」+ 网络时间线', async ({ page }) => {
  const { sid, mark } = LONGS[1];
  const net = netWatch(page);
  await boot(page);
  await openSessionBySearch(page, mark);
  await openAndStream(page, { sid, mark }, fx(1));
  await installProbe(page);
  await page.waitForTimeout(1_200);
  const { res, before, after, tIssue, pingBefore } = await measureAction(page, clickStopButton);
  console.log('[探路B] 点停止:', JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore }));
  console.log('[探路B] 网络:', JSON.stringify(net.dump(tIssue)));
  await page.waitForTimeout(4_000);
  console.log('[探路B] +4s 流式序号:', await streamIndex(page), '桩文件:', JSON.stringify(fs.readdirSync(CTL).filter((f) => /interrupted|killed$/.test(f))));
  expect(true).toBe(true);
});

test('探路 C:长会话 + 大块输出(每块 30KB/40ms)把主线程压住后点「停止」', async ({ page }) => {
  const { sid, mark } = LONGS[2];
  const net = netWatch(page);
  await boot(page);
  await openSessionBySearch(page, mark);
  setCtl('chunk-chars', 12_000);
  setCtl('chunk-ms', 60);
  await openAndStream(page, { sid, mark }, fx(2));
  await page.waitForTimeout(8_000);                  // 让当前这条消息涨到 MB 级
  await installProbe(page);
  await page.waitForTimeout(1_200);
  const size = await page.evaluate(() => (document.body.textContent || '').length);
  const pingAfter = await pingPage(page);
  const { res, before, after, tIssue, pingBefore } = await measureAction(page, clickStopButton, 20_000);
  console.log('[探路C] 页面正文', size, '字符;点停止:', JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore, pingAfter }));
  console.log('[探路C] 网络:', JSON.stringify(net.dump(tIssue)));
  await page.waitForTimeout(5_000);
  console.log('[探路C] +5s 流式序号:', await streamIndex(page), '桩文件:', JSON.stringify(fs.readdirSync(CTL).filter((f) => /interrupted|killed$/.test(f))));
  clearCtl('chunk-chars');
  clearCtl('chunk-ms');
  expect(true).toBe(true);
});

test('探路 J:停止之后,界面上到底显示什么(每秒采一次,看它什么时候回到"没在生成")', async ({ page }) => {
  const { sid, mark } = LONGS[15];
  await boot(page);
  await openSessionBySearch(page, mark);
  setCtl('chunk-chars', 12_000);
  setCtl('chunk-ms', 60);
  await openAndStream(page, { sid, mark }, fx(11));
  await page.waitForTimeout(5_000);
  await installProbe(page);
  await resetProbe(page);
  const { tIssue } = await clickStopButton(page);
  const rows = [];
  for (let i = 0; i < 24; i += 1) {
    await page.waitForTimeout(1_000);
    const snap = await page.evaluate(() => ({
      t: performance.now(),
      sig: window.__r119.sig,
      tailText: (document.body.textContent || '').slice(-600),
      btns: [...document.querySelectorAll('button,[role=button]')]
        .map((b) => ({ t: (b.textContent || '').trim().slice(0, 16), a: b.getAttribute('aria-label') || '', d: !!b.disabled || b.getAttribute('aria-disabled') === 'true', vis: !!b.offsetParent }))
        .filter((b) => /停止|发送|重试|中断|继续/.test(b.t + b.a)),
    }));
    const cli = Number((() => { try { return fs.readFileSync(path.join(CTL, `${sid}.streamed`), 'utf8'); } catch { return -1; } })());
    rows.push({ sec: i + 1, sig: snap.sig, cli, btns: JSON.stringify(snap.btns) });
    if (i === 0 || i === 3 || i === 9 || i === 23) rows[rows.length - 1].tail = snap.tailText.replace(/\s+/g, ' ').slice(-220);
  }
  console.log('[探路J] 停止后逐秒:', JSON.stringify(rows, null, 1));
  clearCtl('chunk-chars'); clearCtl('chunk-ms');
  expect(true).toBe(true);
});

test('探路 G:短会话 + 同样的大块输出(分离"历史长"与"本次输出大"两个变量)', async ({ page }) => {
  const { sid, mark } = SHORTS[1];
  await boot(page);
  await openSessionBySearch(page, mark);
  setCtl('chunk-chars', 12_000);
  setCtl('chunk-ms', 60);
  await openAndStream(page, { sid, mark }, fx(6));
  await page.waitForTimeout(8_000);
  await installProbe(page);
  await page.waitForTimeout(1_200);
  const size = await page.evaluate(() => (document.body.textContent || '').length);
  const { res, before, after, pingBefore } = await measureAction(page, clickStopButton, 20_000);
  console.log('[探路G] 短会话+大输出:页面正文', size, '字符;点停止:', JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore }));
  clearCtl('chunk-chars');
  clearCtl('chunk-ms');
  expect(true).toBe(true);
});

// 节奏扫描:同一个动作在不同"本次输出量"下的反应
const TEMPOS = [
  { name: 'T2 4KB/100ms(40KB/s)', chars: 4_000, ms: 100, pre: 8_000 },
  { name: 'T3 12KB/60ms(200KB/s)', chars: 12_000, ms: 60, pre: 8_000 },
];
for (const [i, t] of TEMPOS.entries()) {
  test(`探路 H${i + 1}:长会话 + 节奏 ${t.name}`, async ({ page }) => {
    const { sid, mark } = LONGS[5 + i];
    await boot(page);
    await openSessionBySearch(page, mark);
    setCtl('chunk-chars', t.chars);
    setCtl('chunk-ms', t.ms);
    await openAndStream(page, { sid, mark }, fx(7 + i));
    await page.waitForTimeout(t.pre);
    await installProbe(page);
    await page.waitForTimeout(1_000);
    const size = await page.evaluate(() => (document.body.textContent || '').length);
    const { res, before, after, pingBefore } = await measureAction(page, clickStopButton, 30_000);
    console.log(`[探路H${i + 1}] 长会话 ${t.name}:正文 ${size} 字符 点停止:`, JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore }));
    clearCtl('chunk-chars');
    clearCtl('chunk-ms');
    expect(true).toBe(true);
  });
  test(`探路 I${i + 1}:短会话 + 节奏 ${t.name}(对照)`, async ({ page }) => {
    const { sid, mark } = SHORTS[2 + i];
    await boot(page);
    await openSessionBySearch(page, mark);
    setCtl('chunk-chars', t.chars);
    setCtl('chunk-ms', t.ms);
    await openAndStream(page, { sid, mark }, fx(9 + i));
    await page.waitForTimeout(t.pre);
    await installProbe(page);
    await page.waitForTimeout(1_000);
    const size = await page.evaluate(() => (document.body.textContent || '').length);
    const { res, before, after, pingBefore } = await measureAction(page, clickStopButton, 30_000);
    console.log(`[探路I${i + 1}] 短会话 ${t.name}:正文 ${size} 字符 点停止:`, JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore }));
    clearCtl('chunk-chars');
    clearCtl('chunk-ms');
    expect(true).toBe(true);
  });
}

test('探路 D:短会话(默认节奏)点「停止」+ 网络时间线(对照组)', async ({ page }) => {
  const { sid, mark } = SHORTS[0];
  const net = netWatch(page);
  await boot(page);
  await openSessionBySearch(page, mark);
  await openAndStream(page, { sid, mark }, fx(3));
  await installProbe(page);
  await page.waitForTimeout(1_200);
  const { res, before, after, tIssue, pingBefore } = await measureAction(page, clickStopButton);
  console.log('[探路D] 短会话点停止:', JSON.stringify({ ...res, streamBefore: before, streamAfter: after, pingBefore }));
  console.log('[探路D] 网络:', JSON.stringify(net.dump(tIssue)));
  expect(true).toBe(true);
});

test('探路 E:长会话 + 大块输出,按 Esc', async ({ page }) => {
  const { sid, mark } = LONGS[3];
  await boot(page);
  await openSessionBySearch(page, mark);
  setCtl('chunk-chars', 12_000);
  setCtl('chunk-ms', 60);
  await openAndStream(page, { sid, mark }, fx(4));
  await page.waitForTimeout(8_000);
  await installProbe(page);
  await page.waitForTimeout(1_200);
  const { res, before, after } = await measureAction(page, pressEsc);
  console.log('[探路E] 长会话 Esc:', JSON.stringify({ ...res, streamBefore: before, streamAfter: after }));
  clearCtl('chunk-chars');
  clearCtl('chunk-ms');
  expect(true).toBe(true);
});

test('探路 F:大块输出下,别的东西还灵不灵(输入框打字/滚动)', async ({ page }) => {
  const { sid, mark } = LONGS[4];
  await boot(page);
  await openSessionBySearch(page, mark);
  setCtl('chunk-chars', 12_000);
  setCtl('chunk-ms', 60);
  await openAndStream(page, { sid, mark }, fx(5));
  await page.waitForTimeout(8_000);
  await installProbe(page);
  await resetProbe(page);
  const t0 = Date.now();
  await page.keyboard.press('a');
  const kbd = Date.now() - t0;
  const snap = await readProbe(page);
  const gaps = snap.beats.map((b) => Math.round(b.gap)).sort((a, b) => b - a).slice(0, 5);
  const fgaps = snap.frames.map((f) => Math.round(f.gap)).sort((a, b) => b - a).slice(0, 5);
  console.log('[探路F] 一次按键回应用时', kbd, 'ms; 近段最大时间片间隙(beat)', JSON.stringify(gaps), '(frame)', JSON.stringify(fgaps));
  clearCtl('chunk-chars');
  clearCtl('chunk-ms');
  expect(true).toBe(true);
});

test.afterAll(() => {
  const kills = [];
  for (const f of fs.readdirSync(CTL).filter((x) => x.endsWith('.pid'))) {
    const pid = Number(fs.readFileSync(path.join(CTL, f), 'utf8').trim());
    try { process.kill(pid, 'SIGKILL'); kills.push(pid); } catch { /* 已退 */ }
  }
  console.log('[探路] 收尾杀掉的桩进程:', JSON.stringify(kills));
});

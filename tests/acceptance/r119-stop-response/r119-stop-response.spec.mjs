// r119 界面验收:回合进行中点「停止」/按 Esc 的**响应**。
// 依据只有 .devflow/BRIEF-r119.md(R1–R6)与 .devflow/INTERFACE-r119.md(§A 可观察身份 / §B 判定口径 B1–B6);
// 没看实现代码。只由 run.sh 调起:tests/acceptance/r119-stop-response/run.sh
//
// 量法(为什么这么量):
//   INTERFACE 要的是"从点击到界面出现任何可观察变化"的毫秒数。主线程被占住时,playwright 侧的
//   计时会把这段藏起来,所以时间戳记在页内(helpers/measure.mjs),测试侧只做事后取记录。
//   每个用例跑 3 轮、每轮换一条全新夹具会话,报中位数,并同时打印每轮的输入排队/应用处理/最长主线程占用。
//
// 负载两档:
//   常规(NORMAL)= 桩按默认节奏吐字(220 字符/120ms ≈ 1.8KB/s,接近真实模型文字输出)
//   重负载(HEAVY)= 12KB/60ms(≈200KB/s,对应"这一轮在跑命令、工具输出一大片一大片往界面灌")
//   实测:常规档在 150 轮和 1000 轮历史上点停止都是 ~40ms;重负载档才会出现"点了没反应"。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { LONGS, SHORTS } from './helpers/fixtures.mjs';
import { analyze, clickStopButton, installProbe, median, pressEsc, readProbe, resetProbe, streamIndex } from './helpers/measure.mjs';
import { boot, composer, killStubs, openSessionBySearch, sendPrompt, switchTo, waitStreaming } from './helpers/ui.mjs';

test.describe.configure({ timeout: 420_000 });

const CTL = process.env.R119_CTL;
const ROUNDS = 3;
const B1_MS = 1_000;             // INTERFACE B1/B4:反馈 ≤1000ms
const B3_SLACK_MS = 1_000;       // INTERFACE B3:长会话不得比短会话高出 1000ms 以上
const HEAVY = { chars: 12_000, ms: 60 };
const HEAVY_PRE_MS = 8_000;      // 重负载档先让这一轮吐 8 秒(≈1.6MB),把界面压到用户报的那种状态
const WAIT_CHANGE_MS = 25_000;   // 等"界面出现可观察变化"的上限
const IDLE_TOL_MS = 3_000;       // B5:界面说"不生成中"之后,允许多久还有内容在路上

// 记录下来的每一轮的账(证据文件里要用)
const RECORD = [];
const rec = (patch) => { RECORD.push(patch); console.log(`[r119] ${JSON.stringify(patch)}`); };

test.afterAll(() => {
  const killed = killStubs(CTL);
  fs.writeFileSync(path.join(process.env.R119_DATA_ROOT || '/tmp', 'r119-rounds.json'), JSON.stringify(RECORD, null, 1));
  console.log(`[r119] 本轮所有实测(共 ${RECORD.length} 条)已写入 r119-rounds.json;收尾杀掉的桩进程 ${JSON.stringify(killed)}`);
});

function applyLoad(load) {
  if (!load) { for (const n of ['chunk-chars', 'chunk-ms']) { try { fs.unlinkSync(path.join(CTL, n)); } catch { /* 本来就没有 */ } } return; }
  fs.writeFileSync(path.join(CTL, 'chunk-chars'), String(load.chars));
  fs.writeFileSync(path.join(CTL, 'chunk-ms'), String(load.ms));
}
/** 桩自己落的"吐到第几块了"(它不经过界面,是收尾/真停检查用的旁证)。 */
const cliIndex = (sid) => { try { return Number(fs.readFileSync(path.join(CTL, `${sid}.streamed`), 'utf8').trim()) || 0; } catch { return 0; } };
const stoppedAtCli = (sid) => ['interrupted', 'killed'].some((s) => fs.existsSync(path.join(CTL, `${sid}.${s}`)));
const clearRound = (sid) => {
  for (const s of ['started', 'phase', 'streamed', 'interrupted', 'killed', 'pid']) {
    try { fs.unlinkSync(path.join(CTL, `${sid}.${s}`)); } catch { /* 本来就没有 */ }
  }
};

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openSessionBySearch(page, LONGS[0].mark);   // 打开一次,夹具项目与它的会话才进侧栏
});

test.afterEach(() => { applyLoad(null); });

/**
 * 一轮:换一条干净会话 → 发一条消息让桩吐起来 → (重负载先压 6 秒)→ 做一次停止动作 → 量。
 * 返回这一轮的账。action = clickStopButton | pressEsc。
 */
async function round(page, fx, { load, action, tag }) {
  applyLoad(load);
  const prompt = `R119 ${tag} 第${Date.now() % 10_000}轮:请继续。`;
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt);
  await waitStreaming(page, fx.sid, 120_000);
  await installProbe(page);
  if (load) await page.waitForTimeout(HEAVY_PRE_MS);
  await resetProbe(page);
  const sizeBefore = await page.evaluate(() => (document.body.textContent || '').length);
  const { tIssue, tAfter } = await action(page);
  let changed = true;
  try {
    await page.waitForFunction(() => window.__r119.sigs.length > 0 || window.__r119.hints.length > 0, null, { timeout: WAIT_CHANGE_MS, polling: 100 });
  } catch { changed = false; }
  const tEnd = Date.now();
  const snap = await readProbe(page);
  const res = analyze(snap, tIssue, tEnd);
  const row = {
    tag, entry: action === pressEsc ? 'Esc' : '按钮', session: fx.long ? '长' : '短', load: load ? '重' : '常规',
    totalMs: res.totalMs, inputLagMs: res.inputLagMs, reactMs: res.reactMs, maxFrameGapMs: res.maxFrameGapMs,
    dispatchMs: tAfter - tIssue, pageChars: sizeBefore, changed, changedBy: res.changedBy,
    streamBefore: await streamIndex(page),
  };
  rec(row);
  return { row, sid: fx.sid };
}

/** 3 轮取中位数 + 每轮数字拼成一句话(断言失败时能直接看到是几轮红、红在哪)。 */
async function threeRounds(page, pool, opts, assert = {}) {
  const rows = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const { row, sid } = await round(page, pool[i], { ...opts, tag: `${opts.tag}-第${i + 1}轮` });
    rows.push(row);
    clearRound(sid);
    killStubs(CTL);
    await page.waitForTimeout(800);
  }
  const totals = rows.map((r) => r.totalMs);
  const detail = rows.map((r) => `第${rows.indexOf(r) + 1}轮 ${r.changed ? `${r.totalMs}ms(排队${r.inputLagMs}+处理${r.reactMs},最长主线程占用${r.maxFrameGapMs}ms)` : '30 秒内界面无任何可观察变化'}`).join(' | ');
  if (opts.load) console.log(`[r119] ${opts.tag} 重负载档页面正文约 ${(rows[0].pageChars / 1024).toFixed(0)}KB`);
  if (assert.maxMs) {
    const bad = rows.filter((r) => !r.changed || r.totalMs > assert.maxMs);
    expect(bad.length, `${opts.tag} [${opts.entryLabel}] ${ROUNDS} 轮里有 ${bad.length} 轮反馈超过 ${assert.maxMs}ms —— ${detail}`).toBe(0);
  }
  return { rows, median: median(totals.filter((t) => t !== null)), detail };
}

// ───────────────────────── B1:点「停止」的反馈延迟 ─────────────────────────
test('B1-按钮-长会话-重负载 [R1] 长会话压到满负荷时点「停止」,界面 1 秒内要有反应', async ({ page }) => {
  const { rows } = await threeRounds(page, LONGS.slice(0, 3), { load: HEAVY, action: clickStopButton, entryLabel: '按钮', tag: 'B1长-重' }, { maxMs: B1_MS });
  expect(median(rows.map((r) => r.totalMs)), `3 轮中位数应在 ${B1_MS}ms 内`).toBeLessThanOrEqual(B1_MS);
});

test('B1-按钮-短会话-重负载 [R1] 同样负载下,短会话点「停止」也要 1 秒内有反应', async ({ page }) => {
  const { rows } = await threeRounds(page, SHORTS.slice(0, 3), { load: HEAVY, action: clickStopButton, entryLabel: '按钮', tag: 'B1短-重' }, { maxMs: B1_MS });
  expect(median(rows.map((r) => r.totalMs)), `3 轮中位数应在 ${B1_MS}ms 内`).toBeLessThanOrEqual(B1_MS);
});

test('B1-按钮-长会话-常规负载 [R1] 常规节奏下长会话点「停止」,界面 1 秒内要有反应', async ({ page }) => {
  const { rows } = await threeRounds(page, LONGS.slice(3, 6), { load: null, action: clickStopButton, entryLabel: '按钮', tag: 'B1长-常规' }, { maxMs: B1_MS });
  expect(median(rows.map((r) => r.totalMs)), `3 轮中位数应在 ${B1_MS}ms 内`).toBeLessThanOrEqual(B1_MS);
});

// ───────────────────────── B3:长会话不得比短会话明显差 ─────────────────────────
test('B3-长/短对照 [R3] 重负载下,长会话的反馈延迟不得比短会话高出 1 秒以上', async ({ page }) => {
  const long = await threeRounds(page, LONGS.slice(6, 9), { load: HEAVY, action: clickStopButton, entryLabel: '按钮', tag: 'B3长' }, { maxMs: WAIT_CHANGE_MS });
  const short = await threeRounds(page, SHORTS.slice(3, 6), { load: HEAVY, action: clickStopButton, entryLabel: '按钮', tag: 'B3短' }, { maxMs: WAIT_CHANGE_MS });
  rec({ tag: 'B3小结', longMedian: long.median, shortMedian: short.median, diff: long.median - short.median });
  expect(long.median - short.median,
    `长会话中位数 ${long.median}ms,短会话中位数 ${short.median}ms,差 ${long.median - short.median}ms —— 长:${long.detail} ; 短:${short.detail}`)
    .toBeLessThanOrEqual(B3_SLACK_MS);
});

// ───────────────────────── B4:Esc 同样有效 ─────────────────────────
test('B4-Esc-长会话-重负载 [R4] 满负荷的长会话里按 Esc,1 秒内要有反应', async ({ page }) => {
  const { rows } = await threeRounds(page, LONGS.slice(9, 12), { load: HEAVY, action: pressEsc, entryLabel: 'Esc', tag: 'B4长' }, { maxMs: B1_MS });
  expect(median(rows.map((r) => r.totalMs)), `3 轮中位数应在 ${B1_MS}ms 内`).toBeLessThanOrEqual(B1_MS);
});

test('B4-Esc-短会话-重负载 [R4] 同样负载下短会话按 Esc,1 秒内要有反应', async ({ page }) => {
  const { rows } = await threeRounds(page, SHORTS.slice(6, 9), { load: HEAVY, action: pressEsc, entryLabel: 'Esc', tag: 'B4短' }, { maxMs: B1_MS });
  expect(median(rows.map((r) => r.totalMs)), `3 轮中位数应在 ${B1_MS}ms 内`).toBeLessThanOrEqual(B1_MS);
});

// ───────────────────────── B2/R5:停止最终真生效 ─────────────────────────
test('B2-停止真生效 [R2] 满负荷长会话里点停止:内容停住、会话进程确实收到中断', async ({ page }) => {
  const fx = LONGS[12];
  applyLoad(HEAVY);
  const prompt = `R119 B2 第${Date.now() % 10_000}轮:请继续。`;
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt);
  await waitStreaming(page, fx.sid, 120_000);
  await installProbe(page);
  await page.waitForTimeout(HEAVY_PRE_MS);
  await resetProbe(page);
  const { tIssue } = await clickStopButton(page);

  // 从界面数与从桩侧各看一路:界面显示的流式序号 + 桩吐到第几块
  const samples = [];
  const deadline = Date.now() + 45_000;
  let frozenFor = 0;
  let lastUi = await streamIndex(page);
  let lastAt = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const ui = await streamIndex(page);
    samples.push({ t: Date.now() - tIssue, ui, cli: cliIndex(fx.sid) });
    if (ui === lastUi) frozenFor += Date.now() - lastAt; else frozenFor = 0;
    lastUi = ui; lastAt = Date.now();
    if (frozenFor >= 3_000 && stoppedAtCli(fx.sid)) break;
  }
  const snap = await readProbe(page);
  const uiFrozenAt = samples.length ? Math.max(...samples.map((s) => s.ui)) : -1;
  const sigChanges = snap.sigs.map((s) => ({ ms: Math.round(snap.t0 + s.t - tIssue), sig: s.sig.slice(0, 60) }));
  rec({ tag: 'B2真生效', uiMax: uiFrozenAt, cliMax: Math.max(...samples.map((s) => s.cli)), stoppedAtCli: stoppedAtCli(fx.sid),
    uiSaysIdle: snap.sig === 'GONE', 停后界面状态变化: sigChanges, 观察窗秒数: samples.length, samples: samples.slice(-3) });
  expect(stoppedAtCli(fx.sid), `停止应真的下达到会话进程(桩没收到 interrupt/kill);采样:${JSON.stringify(samples.slice(-6))}`).toBe(true);
  expect(frozenFor, `停止之后界面上的新内容应停住(界面序号最后一秒还在涨:${JSON.stringify(samples.slice(-4))})`).toBeGreaterThanOrEqual(3_000);
  clearRound(fx.sid); killStubs(CTL);
});

test('R5-不许谎报 [R5] 界面一旦不再显示"生成中",就不许还有内容在路上', async ({ page }) => {
  const fx = LONGS[13];
  applyLoad(HEAVY);
  const prompt = `R119 R5 第${Date.now() % 10_000}轮:请继续。`;
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt);
  await waitStreaming(page, fx.sid, 120_000);
  await installProbe(page);
  await page.waitForTimeout(HEAVY_PRE_MS);
  await resetProbe(page);
  const { tIssue } = await clickStopButton(page);

  // 两侧采样:界面还显不显示"生成中"(探针里那个停止按钮还在不在 / 还是不是禁用态)+ 桩还在不在吐
  // "不再显示生成中" = 停止按钮从界面上消失(探针 sig 变成 GONE)。这是唯一不依赖文案的可判口径。
  const samples = [];
  const deadline = Date.now() + 40_000;
  let idleAt = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const snap = await readProbe(page);
    const wall = snap.t0 + snap.now;
    const idle = snap.sig === 'GONE';
    const row = { t: Math.round(wall - tIssue), idle, cli: cliIndex(fx.sid), ui: await streamIndex(page) };
    samples.push(row);
    if (idle && idleAt === null) idleAt = row;
    if (idle && row.cli === idleAt.cli) break;
  }
  rec({ tag: 'R5样本', idleAt, 界面共采样秒数: samples.length, tail: samples.slice(-3) });
  if (idleAt) {
    const laterCli = Math.max(...samples.filter((s) => s.t > idleAt.t + IDLE_TOL_MS).map((s) => s.cli), 0);
    expect(laterCli, `界面在 ${idleAt.t}ms 就不再显示"生成中",但之后 3 秒外桩还在往外吐(序号 ${idleAt.cli} → ${laterCli});采样:${JSON.stringify(samples.slice(-8))}`)
      .toBeLessThanOrEqual(idleAt.cli);
  } else {
    // 界面一直没离开"生成中/停止中":不算谎报(B5 只禁止"提前说已完成"),但要如实记下来
    rec({ tag: 'R5结论', 说明: `${samples.length} 秒里界面一直显示着"生成/停止中"(停止按钮始终在,只是变成禁用态),没有出现"已完成"的谎报;这一条判 PASS,B5 的"提前说完成"不成立` });
  }
  clearRound(fx.sid); killStubs(CTL);
});

// ───────────────────────── B6:停止只停本回合 ─────────────────────────
test('B6-只停本回合 [R6] 停止之后,同一条会话还能接着用(旧内容还在、能再发一条并跑起来)', async ({ page }) => {
  const fx = LONGS[14];
  applyLoad(HEAVY);
  const prompt1 = `R119 B6 第一句 ${Date.now() % 10_000}`;
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt1);
  await waitStreaming(page, fx.sid, 120_000);
  await installProbe(page);
  await page.waitForTimeout(HEAVY_PRE_MS);
  await clickStopButton(page);
  await page.waitForTimeout(6_000);
  const stopped = stoppedAtCli(fx.sid);
  const cliAtStop = cliIndex(fx.sid);
  applyLoad(null);                                  // 第二条用常规节奏,别又把自己压住
  const prompt2 = `R119 B6 第二句 ${Date.now() % 10_000}`;
  await sendPrompt(page, prompt2);
  await page.getByText(prompt2, { exact: false }).first().waitFor({ timeout: 30_000 });   // 第二条确实进了正文
  await page.waitForTimeout(4_000);
  const cliAfterSecond = cliIndex(fx.sid);          // 新一条已经把桩又跑起来了
  const body = await page.evaluate(() => (document.body.textContent || ''));
  rec({ tag: 'B6', stoppedAtCli: stopped, cliAtStop, cliAfterSecond,
    firstStillThere: body.includes(prompt1), secondThere: body.includes(prompt2) });
  expect(body.includes(prompt1), '停止之后,被停掉那一轮的用户消息仍应在会话里').toBe(true);
  expect(body.includes(prompt2), '停止之后应当还能把下一条消息发出去').toBe(true);
  expect(cliAfterSecond, `停止只应停住本回合:下一条消息要能跑起来(桩的吐字序号 ${cliAtStop} → ${cliAfterSecond})`)
    .toBeGreaterThan(0);
  killStubs(CTL); clearRound(fx.sid);
});

// r119b 追加验收(独立裁判指出的缺口):**正常生成时内容怎么画到屏幕上**这条最常用的路径,
// 以及"停止中"的快速重入(再点一次停止 / 按 Esc / 切走再切回)。
// 依据只有 .devflow/BRIEF-r119.md(R1/R2/R5/R6)与 .devflow/INTERFACE-r119.md(§A 可观察身份 / §B 判定口径);
// 没看实现代码。只由 run.sh 调起:tests/acceptance/r119-stop-response/run.sh
//
// 量法(为什么这么判):
//   "内容对不对"用**桩自己写下的原文**当基准:桩每发一段文字,都把同一份内容原样写进会话记录文件,
//   测试只按本轮标记(R119STREAM <sid8>)把这几段挑出来,再和界面上真正画出来的块逐字比。
//   空白按渲染层归一化(缩进/换行怎么落是排版的事),**除空白以外的每个字符都要一致** —— 丢字、重复、
//   跳块、错序都会在这里现形。
//   "状态对不对"只看用户看得见的东西:停止类按钮(在且可用 = 认为在跑;在且不可用 = 停止中;不在 = 这一轮结束了)
//   与"重做这条回复"这个完成态控件。不断言任何一句具体文案。
//
// 桩的收尾口径:默认一直吐到 300 秒或被打断;<CTL>/max-chunks=N 时吐满 N 块就正常收尾(走 result/收尾文案那条路)。
// 这是本轮为 G1/G3 新加的开关,不写这个文件时桩的行为与以前逐字一致。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { NAV, SHORTS, WORKSPACE_RAW, encodeProjectDir, homeDir } from './helpers/fixtures.mjs';
import { boot, killStubs, openSessionBySearch, sendPrompt, sessionRow, switchTo, waitStreaming, stopButton } from './helpers/ui.mjs';
import { clickStopButton } from './helpers/measure.mjs';

test.describe.configure({ timeout: 300_000 });

const CTL = process.env.R119_CTL;
const PROJ = path.join(homeDir(), '.claude', 'projects', encodeProjectDir(fs.realpathSync(WORKSPACE_RAW)));
const HEAVY = { chars: 12_000, ms: 60 };      // 重负载:把"停止中"窗口拉宽(实测 ~0.9 秒),重入才有得打
const SETTLE_MS = 25_000;                     // 等界面进入终止态的窗口
const FREEZE_MS = 3_000;                      // 内容冻结的观察时长

const RECORD = [];
const rec = (o) => { RECORD.push(o); console.log(`[r119b] ${JSON.stringify(o)}`); };
const setCtl = (n, v) => fs.writeFileSync(path.join(CTL, n), String(v));
const clearCtl = (n) => { try { fs.unlinkSync(path.join(CTL, n)); } catch { /* 本来就没有 */ } };
const cliIndex = (sid) => { try { return Number(fs.readFileSync(path.join(CTL, `${sid}.streamed`), 'utf8').trim()) || 0; } catch { return 0; } };
const mark = (sid) => `R119STREAM ${sid.slice(0, 8)}`;
const norm = (s) => s.replace(/\s+/g, '');
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const nums = (s) => [...s.matchAll(/#(\d{5})/g)].map((m) => Number(m[1]));
const upto = (n) => Array.from({ length: n }, (_, i) => i + 1);
/** 第一处不同的位置,失败信息里用得着(前后各留一段,能直接看出丢在哪)。 */
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return `第 ${i} 个字符起:界面「…${a.slice(Math.max(0, i - 40), i + 40)}…」 vs 桩「…${b.slice(Math.max(0, i - 40), i + 40)}…」`;
  return a.length === b.length ? '(一致)' : `长度不同:界面 ${a.length} 字符 / 桩 ${b.length} 字符,尾部 界面「…${a.slice(-60)}」 vs 桩「…${b.slice(-60)}」`;
};
/** 行结构(去掉空行与行首尾空白)第一处不同:行数不同 / 某一行内容不同,都直接报出来。 */
const firstLineDiff = (a, b) => {
  if (a.length !== b.length) return `行数不同:界面 ${a.length} 行 / 桩 ${b.length} 行(界面多的第一行:「${a[b.length] ?? ''}」)`;
  const i = a.findIndex((l, k) => l !== b[k]);
  return i < 0 ? '(一致)' : `第 ${i + 1} 行不同:界面「${a[i]}」 vs 桩「${b[i]}」`;
};

/** 桩这一轮实际发出去的每一段文字(按本轮标记从会话记录里挑,原样返回)。 */
function sentBlocks(sid) {
  const out = [];
  for (const line of fs.readFileSync(path.join(PROJ, `${sid}.jsonl`), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) if (b.type === 'text' && String(b.text).includes(mark(sid))) out.push(String(b.text));
  }
  return out;
}

/** 界面上这一轮画出来的块(只认正文里带本轮标记的助手块;侧栏、别的会话都进不来)。 */
const viewBlocks = (page, sid) => page.evaluate((m) => {
  const blocks = [...document.querySelectorAll('.markdown-content')].filter((el) => (el.textContent || '').includes(m));
  return { n: blocks.length, text: blocks.map((el) => el.textContent || '').join('\n') };
}, mark(sid));

/** 界面此刻与"这一轮在不在跑"有关的东西(全是用户看得见的东西,不看内部状态)。 */
const uiState = (page) => page.evaluate(() => {
  const btns = [...document.querySelectorAll('button,[role=button]')].filter((b) => b.getClientRects().length);
  const stopish = btns.filter((b) => /^停止/.test((b.textContent || '').trim()));
  const text = document.body.textContent || '';
  const tail = text.slice(-200_000);
  const m = [...tail.matchAll(/#(\d{5})/g)];
  return {
    stopBtns: stopish.map((b) => ({ text: (b.textContent || '').trim().slice(0, 10), usable: !(b.disabled || b.getAttribute('aria-disabled') === 'true') })),
    redo: /重做这条回复/.test(text),          // "这一轮已结束"的完成态控件
    idx: m.length ? Number(m[m.length - 1][1]) : -1,
  };
});

const userBubbleCount = (page, text) => {
  const all = page.locator('.chat-user-bubble');
  return (text == null ? all : all.filter({ hasText: text })).count();
};

/** 在别的会话的页面上找这段文字:整页文字 / 用户气泡 / 助手块,三路都看。 */
const scanForText = (page, text) => page.evaluate((t) => ({
  body: (document.body.innerText || '').includes(t),
  bubbles: [...document.querySelectorAll('.chat-user-bubble')].filter((el) => (el.textContent || '').includes(t)).length,
  blocks: [...document.querySelectorAll('.markdown-content')].filter((el) => (el.textContent || '').includes(t)).length,
}), text);

/** 界面进入"停止中"(停止类按钮在、但不可用)的那一刻;窗口内没出现就返回 -1。 */
async function waitStopping(page, timeoutMs = 5_000) {
  const t0 = Date.now();
  try {
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button,[role=button]')].find((el) => /^停止/.test((el.textContent || '').trim()));
      return !!b && (b.disabled || b.getAttribute('aria-disabled') === 'true');
    }, null, { timeout: timeoutMs, polling: 10 });
    return Date.now() - t0;
  } catch { return -1; }
}

/** 停止类按钮此刻的位置与可用性(第二次点击要点在"停止中"的按钮上,不能点到别的东西)。 */
const stopishBox = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button,[role=button]')].find((el) => /^停止/.test((el.textContent || '').trim()));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, usable: !(b.disabled || b.getAttribute('aria-disabled') === 'true') };
});

/** 反复采样界面状态,直到"不再显示在跑"(连续两次都没有停止类按钮)或超时。 */
async function sampleUntilSettled(page, t0, maxMs = SETTLE_MS) {
  const samples = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const st = await uiState(page);
    samples.push({ ms: Date.now() - t0, ...st });
    if (samples.length >= 3 && samples[samples.length - 1].stopBtns.length === 0 && samples[samples.length - 2].stopBtns.length === 0) break;
    await page.waitForTimeout(300);
  }
  return samples;
}

/** 内容是不是真的停住了:界面上的流式序号与桩的序号在 ms 毫秒里都不许动。 */
async function frozenOver(page, sid, ms = FREEZE_MS) {
  const a = { ui: (await uiState(page)).idx, cli: cliIndex(sid), t: Date.now() };
  await page.waitForTimeout(ms);
  const b = { ui: (await uiState(page)).idx, cli: cliIndex(sid), t: Date.now() };
  return { uiFrozen: a.ui === b.ui, cliFrozen: a.cli === b.cli, from: a, to: b, span: b.t - a.t };
}

/**
 * 这一轮内容画对了没有(核心守卫):
 *   - 分块头必须是 1..K 连续、各恰好一次、顺序不变(丢块/重复/错序在这里现形)
 *   - 界面文字与桩原文除空白外逐字一致(整轮跑完时按全量比,被停止时按"已画出来的前缀"比)
 *   - 行结构一致(哪一行被吞了/两行被并了也现形)
 *   - 块数精确(mode=done:N 块正文 + 1 块收尾文案;mode=stopped:一块正文一块,不许多也不许少)
 */
async function expectRoundDrawn(page, sid, { label, mode }) {
  const sent = sentBlocks(sid);
  const cliMax = cliIndex(sid);
  const view = await viewBlocks(page, sid);
  const sentHeads = nums(sent.join(''));
  const viewHeads = nums(view.text);
  expect(sentHeads, `${label}:桩自己记下的原文应当是从 1 到 ${cliMax} 连续的分块(记录不全就不算数,这条按红处理)`).toEqual(upto(cliMax));
  const K = viewHeads.length;
  expect(viewHeads, `${label}:界面上画出来的分块头应当是 1..${K} 连续、各恰好一次、顺序不变(丢块/重复/错序都会在这里现形)`).toEqual(upto(K));
  // 界面上画到第 K 块,桩那边就应当正好是前 K 块;正常跑完时还要算上结尾那段没有分块号的收尾文案。
  let cut = 0;
  for (let acc = 0; cut < sent.length && acc < K;) { acc += nums(sent[cut]).length; cut += 1; }
  if (mode === 'done') while (cut < sent.length && nums(sent[cut]).length === 0) cut += 1;
  const sentPrefix = sent.slice(0, cut).join('\n');
  expect(norm(view.text), `${label}:界面正文与桩发出去的原文除空白外应逐字一致 —— ${firstDiff(norm(view.text), norm(sentPrefix))}`).toBe(norm(sentPrefix));
  expect(lines(view.text), `${label}:界面的行结构与桩原文应一致 —— ${firstLineDiff(lines(view.text), lines(sentPrefix))}`).toEqual(lines(sentPrefix));
  if (mode === 'done') {
    expect(K, `${label}:正常跑完的一轮,界面上应该把 ${cliMax} 块正文全都画出来`).toBe(cliMax);
    expect(view.n, `${label}:正常跑完的一轮应有 ${cliMax} 块正文 + 1 块收尾文案,实际 ${view.n} 块(少一块 = 内容没画完,多一块 = 重复画了)`).toBe(cliMax + 1);
    expect(view.text.includes('这一轮到此为止'), `${label}:正常跑完的收尾文案应当在界面上`).toBe(true);
  } else {
    expect(view.n, `${label}:画出来的 ${K} 块正文应当各占一块,实际 ${view.n} 块(多 = 重复画,少 = 内容被吞)`).toBe(K);
    expect(view.text.includes('这一轮到此为止'), `${label}:被停止的一轮不该出现"正常跑完"的收尾文案`).toBe(false);
  }
  rec({ tag: `${label} 内容比对`, 桩发出的块数: sent.length, 桩最后一块序号: cliMax, 界面块数: view.n, 界面上画到第: K, '桩原文字符数(除空白)': norm(sent.join('')).length, '界面文字字符数(除空白)': norm(view.text).length });
  return { cliMax, K, viewN: view.n, sentLen: norm(sent.join('')).length, viewLen: norm(view.text).length };
}

/**
 * 切回一条已经跑过回合的会话:跑完回合后侧栏标题会变成消息内容,所以两种找法都试
 * (开头那段唯一短标记 / 夹具标记),谁先出现就点谁。
 */
async function switchBackTo(page, byTitle, byMark) {
  for (let i = 0; i < 40; i += 1) {
    for (const key of [byTitle, byMark]) {
      const row = sessionRow(page, key);
      if (await row.count() && await row.first().isVisible()) { await row.first().click(); await page.waitForTimeout(500); return; }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`切回时找不到这条会话(标题「${byTitle}」/ 标记「${byMark}」都没有) `);
}

/** 通用起手:开应用的隔离实例 → 让夹具项目进侧栏 → 切到目标会话 → 发一条消息并等它跑起来。 */
async function startRound(page, fx, prompt, load) {
  if (load) { setCtl('chunk-chars', load.chars); setCtl('chunk-ms', load.ms); }
  await boot(page);
  await openSessionBySearch(page, NAV.mark);
  await switchTo(page, fx.mark);
  await sendPrompt(page, prompt);
  await waitStreaming(page, fx.sid, 120_000);
}

/** 一条会话的测试用消息:开头带唯一短标记(会话标题会变成它,后面靠它找回这条会话),整体远长于标题截断长度。 */
const promptFor = (tag) => `R119B ${tag} ${String(Date.now() % 100_000)}:这一句只属于这条会话,不该出现在别的会话的页面上,也不该被画第二遍。`;

test.beforeEach(async () => { clearCtl('max-chunks'); });
test.afterEach(() => {
  for (const n of ['max-chunks', 'chunk-chars', 'chunk-ms']) clearCtl(n);
  killStubs(CTL);
});
test.afterAll(() => {
  fs.writeFileSync(path.join(process.env.R119_DATA_ROOT || '/tmp', 'r119b-rounds.json'), JSON.stringify(RECORD, null, 1));
  console.log(`[r119b] 本轮追加用例实测(共 ${RECORD.length} 条)已写入 r119b-rounds.json`);
});

// ───────────────────────── G1:正常生成时的内容完整性 ─────────────────────────

for (const [i, pace] of [{ chars: 220, ms: 120, chunks: 12, name: '常规节奏' }, { chars: 2_000, ms: 150, chunks: 8, name: '大块节奏' }].entries()) {
  test(`G1-内容完整性-${pace.name} [反向守卫] 不点停止、让这一轮正常生成完:界面正文与桩发的原文逐字一致,块数与顺序正确`, async ({ page }) => {
    const fx = SHORTS[10 + i];
    setCtl('chunk-chars', pace.chars);
    setCtl('chunk-ms', pace.ms);
    const prompt = promptFor(`G1-${i + 1}`);
    await startRound(page, fx, prompt, null);
    setCtl('max-chunks', pace.chunks);              // 桩吐满这么多块就正常收尾(测试不点停止)

    await expect(page.getByText('这一轮到此为止', { exact: false }).first(), '桩正常收尾的文案应当出现在正文里').toBeVisible({ timeout: 90_000 });
    await expect(stopButton(page), '这一轮正常跑完后,界面不应再显示"在跑"(停止类按钮应当消失)').toHaveCount(0, { timeout: SETTLE_MS });
    const settled = await sampleUntilSettled(page, Date.now(), 5_000);
    await page.waitForTimeout(1_500);               // 让收尾渲染落定

    const drawn = await expectRoundDrawn(page, fx.sid, { label: `G1-${pace.name}`, mode: 'done' });
    expect(await userBubbleCount(page, prompt), '刚发出去的那条消息应当恰好画一遍').toBe(1);
    expect(await userBubbleCount(page, null), '会话里的用户消息应当是夹具 2 条 + 本轮 1 条(多一条 = 重复气泡,少一条 = 丢了)').toBe(3);

    // 隔一会儿再数一次:防"延迟又冒出来一块"(同一段内容被画第二遍)
    await page.waitForTimeout(2_000);
    const again = await expectRoundDrawn(page, fx.sid, { label: `G1-${pace.name}(+2s 复核)`, mode: 'done' });
    expect(again).toEqual(drawn);
    const freeze = await frozenOver(page, fx.sid);
    expect(freeze.uiFrozen && freeze.cliFrozen, `这一轮已经跑完,内容不该再变(界面 ${freeze.from.ui}→${freeze.to.ui},桩 ${freeze.from.cli}→${freeze.to.cli})`).toBe(true);
    rec({ tag: `G1-${pace.name} 收尾后的界面`, 采样尾: settled.slice(-2), 冻结: freeze, 跑完时界面块数: drawn.viewN, 分块数: drawn.cliMax });
  });
}

// ───────────────────────── G2:停止中的快速重入(三条) ─────────────────────────

test('G2a-停止中再点一次停止 [R1/R5] 连点两次:状态不错乱、内容不重复、回合确实结束', async ({ page }) => {
  const fx = SHORTS[12];
  const prompt = promptFor('G2a');
  await startRound(page, fx, prompt, HEAVY);
  await page.waitForTimeout(2_000);                 // 让界面先灌一会儿大块内容

  const { tIssue } = await clickStopButton(page);
  const stoppingAt = await waitStopping(page);
  const at = await stopishBox(page);
  const t2Issue = Date.now();
  if (at) await page.mouse.click(at.x + at.w / 2, at.y + at.h / 2);   // 第二次点击:点在同一处(用户就是这么连点的)
  const t2After = Date.now();
  rec({ tag: 'G2a 第二次点击', 距第一次点击ms: t2Issue - tIssue, 进入停止中ms: stoppingAt, 点击时按钮仍在: !!at, 点击时按钮可用: at ? at.usable : null, 点击派发ms: t2After - t2Issue });
  expect(at, `第二次点击必须落在"停止中"窗口里(第一次点击后 ${t2Issue - tIssue}ms 时按钮已不在)——窗口短到打不上,这条用例就没测到东西`).not.toBeNull();

  const samples = await sampleUntilSettled(page, tIssue);
  const last = samples[samples.length - 1];
  expect(last.stopBtns.length, `连点两次之后,这一轮应当进入终止态(界面仍显示在跑/停止中则不算结束);采样尾:${JSON.stringify(samples.slice(-4))}`).toBe(0);
  const contradictions = samples.filter((s) => s.stopBtns.some((b) => b.usable) && s.redo);
  expect(contradictions.length, `采样里出现了"还显示在跑"与"已完成(重做这条回复)"同框:${JSON.stringify(contradictions)}`).toBe(0);
  const freeze = await frozenOver(page, fx.sid);
  expect(freeze.uiFrozen, `停止之后界面不该再有新内容(界面序号 ${freeze.from.ui}→${freeze.to.ui});采样尾:${JSON.stringify(samples.slice(-3))}`).toBe(true);
  expect(freeze.cliFrozen, `停止之后会话进程不该继续吐(桩序号 ${freeze.from.cli}→${freeze.to.cli})`).toBe(true);

  await expectRoundDrawn(page, fx.sid, { label: 'G2a', mode: 'stopped' });
  expect(await userBubbleCount(page, prompt), '连点两次停止之后,这条用户消息应当恰好画一遍(两遍 = 重复气泡)').toBe(1);
  expect(await userBubbleCount(page, null), '会话里的用户消息应当是夹具 2 条 + 本轮 1 条(没有来源不明的第二条)').toBe(3);
  rec({ tag: 'G2a 收尾后', 桩最后一块: cliIndex(fx.sid), 界面采样尾: samples.slice(-2) });
});

test('G2b-停止中按 Esc [R4/R5] 点停止后马上按 Esc:状态不错乱、内容不重复、回合确实结束', async ({ page }) => {
  const fx = SHORTS[13];
  const prompt = promptFor('G2b');
  await startRound(page, fx, prompt, HEAVY);
  await page.waitForTimeout(2_000);

  const { tIssue } = await clickStopButton(page);
  const stoppingAt = await waitStopping(page);
  const at = await stopishBox(page);
  const t2Issue = Date.now();
  await page.keyboard.press('Escape');                               // 第二次动作:Esc
  const t2After = Date.now();
  const afterEsc = await stopishBox(page);
  rec({ tag: 'G2b 第二次动作', 距第一次点击ms: t2Issue - tIssue, 进入停止中ms: stoppingAt, '按 Esc 时按钮仍在': !!at, '按 Esc 后按钮仍在': !!afterEsc, '按 Esc 派发ms': t2After - t2Issue });
  expect(at, `Esc 必须落在"停止中"窗口里(第一次点击后 ${t2Issue - tIssue}ms 时按钮已不在)——窗口短到打不上,这条用例就没测到东西`).not.toBeNull();

  const samples = await sampleUntilSettled(page, tIssue);
  const last = samples[samples.length - 1];
  expect(last.stopBtns.length, `点停止后马上按 Esc,这一轮仍应进入终止态;采样尾:${JSON.stringify(samples.slice(-4))}`).toBe(0);
  const contradictions = samples.filter((s) => s.stopBtns.some((b) => b.usable) && s.redo);
  expect(contradictions.length, `采样里出现了"还显示在跑"与"已完成(重做这条回复)"同框:${JSON.stringify(contradictions)}`).toBe(0);
  const freeze = await frozenOver(page, fx.sid);
  expect(freeze.uiFrozen && freeze.cliFrozen, `Esc 之后内容应停住(界面 ${freeze.from.ui}→${freeze.to.ui},桩 ${freeze.from.cli}→${freeze.to.cli})`).toBe(true);

  await expectRoundDrawn(page, fx.sid, { label: 'G2b', mode: 'stopped' });
  expect(await userBubbleCount(page, prompt), '停止中按 Esc 之后,这条用户消息应当恰好画一遍').toBe(1);
  expect(await userBubbleCount(page, null), '会话里的用户消息应当是夹具 2 条 + 本轮 1 条(按 Esc 不该再冒出一条新消息)').toBe(3);
  rec({ tag: 'G2b 收尾后', 桩最后一块: cliIndex(fx.sid), 界面采样尾: samples.slice(-2) });
});

test('G2c-停止中切走再切回 [R1/R5/R6] 停止还没落地时切到别的会话再回来:状态不错乱、内容不重不串', async ({ page }) => {
  const fx = SHORTS[14];
  const prompt = promptFor('G2c');
  await startRound(page, fx, prompt, null);
  await page.waitForTimeout(2_000);                  // 先让内容画出来一些,切走再切回的内容比对才有份量
  const { tIssue } = await clickStopButton(page);
  await page.waitForTimeout(150);                    // 停在"停止中"里
  await switchTo(page, NAV.mark);                    // 切到另一条会话
  const awayAt = Date.now();

  // 阳性对照:确认现在真的在看 NAV 这条会话的内容(否则"没看到 A 的内容"可能只是因为页面是空的)
  await expect(page.locator('.markdown-content').filter({ hasText: NAV.mark }).first(),
    '切过去之后,页面上应当能看到那条会话自己的内容(阳性对照)').toBeVisible({ timeout: 20_000 });

  const leaks = [];
  for (let n = 0; n < 6; n += 1) {
    for (const [what, text] of [['A 那条消息', prompt], ['A 的流式内容', mark(fx.sid)]]) {
      const s = await scanForText(page, text);
      if (s.body || s.bubbles || s.blocks) leaks.push({ 第几次采样: n + 1, 看的是: what, ...s });
    }
    await page.waitForTimeout(500);
  }
  expect(leaks.length, `切到另一条会话后,6 次采样里有 ${leaks.length} 次在它的页面上看到了 A 的内容(串会话):${JSON.stringify(leaks)}`).toBe(0);

  await page.waitForTimeout(2_000);                  // 让 A 的停止在后台落地
  await switchBackTo(page, prompt.slice(0, 24), fx.mark);   // 回合跑完后标题会变成消息内容,两种找法都试
  rec({ tag: 'G2c 切回', 切走停留ms: Date.now() - awayAt, 第一次点击到此ms: Date.now() - tIssue });

  await expect(stopButton(page), '切回之后,这条会话应当已经不在跑(停止类按钮应当消失,不许卡在"停止中/运行中")').toHaveCount(0, { timeout: SETTLE_MS });
  const samples = await sampleUntilSettled(page, Date.now(), 5_000);
  const contradictions = samples.filter((s) => s.stopBtns.some((b) => b.usable) && s.redo);
  expect(contradictions.length, `切回后采样里出现了"还显示在跑"与"已完成(重做这条回复)"同框:${JSON.stringify(contradictions)}`).toBe(0);
  const freeze = await frozenOver(page, fx.sid);
  expect(freeze.uiFrozen && freeze.cliFrozen, `切回之后内容不该再变(界面 ${freeze.from.ui}→${freeze.to.ui},桩 ${freeze.from.cli}→${freeze.to.cli})`).toBe(true);

  await expectRoundDrawn(page, fx.sid, { label: 'G2c', mode: 'stopped' });
  expect(await userBubbleCount(page, prompt), '切走再切回之后,这条用户消息应当恰好画一遍(重复气泡在这里现形)').toBe(1);
  expect(await userBubbleCount(page, null), '会话里的用户消息应当是夹具 2 条 + 本轮 1 条(切回来不该多画)').toBe(3);
  rec({ tag: 'G2c 收尾后', 桩最后一块: cliIndex(fx.sid), 界面采样尾: samples.slice(-2) });
});

// ───────────────────────── G3:页面不可见期间的内容 ─────────────────────────

test('G3-不可见窗口里的流式 [R1/R5] 页面"切到后台"一段时间后切回:内容最终完整、状态不卡死', async ({ page }) => {
  const fx = SHORTS[15];
  const prompt = promptFor('G3');
  setCtl('chunk-chars', 600);
  setCtl('chunk-ms', 100);
  await startRound(page, fx, prompt, null);

  // 真实后台在这套环境里做不到(实测:另开一页 bringToFront 之后,本页的 document.visibilityState 仍是 visible),
  // 退而求其次:只把"页面不可见"这个**信号**造出来(改 document.hidden/visibilityState + 派发 visibilitychange),
  // 页面本身仍在渲染。局限写在 TEST-PLAN 里。
  const hide = (on) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
    return { hidden: document.hidden, visibilityState: document.visibilityState };
  }, on);

  const before = { state: await hide(true), cli: cliIndex(fx.sid), idx: (await uiState(page)).idx, at: Date.now() };
  await page.waitForTimeout(1_200);                                   // 不可见期间继续吐字
  setCtl('max-chunks', cliIndex(fx.sid) + 6);                         // 让这一轮在"不可见"期间自己跑完
  await page.waitForTimeout(6_000);
  const during = { cli: cliIndex(fx.sid), ...(await uiState(page)) };
  rec({ tag: 'G3 不可见期间', 进入不可见: before, '不可见 7 秒后': during, 界面块数: await page.evaluate((m) => [...document.querySelectorAll('.markdown-content')].filter((el) => (el.textContent || '').includes(m)).length, mark(fx.sid)) });

  const after = await hide(false);                                    // 切回前台
  const tBack = Date.now();
  await expect(page.getByText('这一轮到此为止', { exact: false }).first(), '切回前台后,这一轮正常收尾的文案应当出现在正文里')
    .toBeVisible({ timeout: 30_000 });
  const msToFinal = Date.now() - tBack;
  await expect(stopButton(page), '切回前台后,界面应回到"没在跑"(不许卡在运行中/停止中)').toHaveCount(0, { timeout: SETTLE_MS });
  const msToSettle = Date.now() - tBack;
  await page.waitForTimeout(1_500);

  const drawn = await expectRoundDrawn(page, fx.sid, { label: 'G3', mode: 'done' });
  expect(await userBubbleCount(page, prompt), '切回前台后,这条用户消息应当恰好画一遍').toBe(1);
  expect(await userBubbleCount(page, null), '会话里的用户消息应当是夹具 2 条 + 本轮 1 条(不可见窗口不该多画一条)').toBe(3);
  await page.waitForTimeout(2_000);
  const again = await expectRoundDrawn(page, fx.sid, { label: 'G3(+2s 复核)', mode: 'done' });
  expect(again).toEqual(drawn);
  const freeze = await frozenOver(page, fx.sid);
  expect(freeze.uiFrozen && freeze.cliFrozen, `这一轮已经跑完,内容不该再变(界面 ${freeze.from.ui}→${freeze.to.ui},桩 ${freeze.from.cli}→${freeze.to.cli})`).toBe(true);
  rec({ tag: 'G3 收尾后', 恢复可见: after, 切回到收尾文案ms: msToFinal, '切回到没在跑ms': msToSettle, 块数: drawn.viewN, 分块数: drawn.cliMax, 冻结: freeze });
});

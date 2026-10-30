// r152b 后台任务没结束时配置变化不另起新进程 —— 验收。依据 .devflow/r152b-dup-process-接口.md 的"行为清单"(12 条),
// 用例 B1–B12 与行为号一一对应(行为 9 是界面用例,拆成 B9a "应答带 configDeferred:true → 出现提示行" 与 B9b "应答没有该字段 → 不出现" 两条)。
//   修复前预期:B1 B2 B3 B7 B9a B12 红(沿用原进程 / configDeferred / 提示行没出现);B4 B5 B6 B8 B9b B10 B11 绿(回归守卫;B11 在含"只比工作目录"实现的版本上应红)。
// 场景:T 的第一回合(effort low)里起一个后台命令 / 后台子代理且不报它结束 → 回合结束、空闲 8 秒 → 再发一条(换 effort 等)。
// B1/B2/B3/B7/B10 的旧进程用夹具 hold 造成"被后台任务吊着、关输入也不退"(真命令行手上有活的后台任务时就是这样),所以修复前会看到同一会话两个进程。
// 每条后端用例一个一次性实例(临时 HOME、自挑端口、用例自己 stop);界面用例用 run.sh 起的共享实例 + dev server。
// 断言一律把几个可观察事实收进一个对象一次比较(失败时对象 diff 直接看出哪一项不对)。
import { test, expect } from '@playwright/test';
import { uniq, makeWorkspace, homeDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { shared as sharedC, waitFor, readStream } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceP2 } from '../r151c-xsession-p2/helpers/p2.mjs';
import { boot, openSessionBySearch, sendPrompt } from '../r151b-xsession-p1/helpers/ui.mjs';
import { sleep, settle, newT, chatStart, writeHeldScript, modelLog, switchLog, releaseAll } from './helpers/r.mjs';
import {
  idleProcess, sendSecond, fxBgEnd, bgEndLog, alive, observeSameProcess, sameProcessExpected,
  observeReplaced, replacedExpected, observeNotReused, notReusedExpected, lastActiveJson,
  seedSettingsWithAllow, addDenyRuleExternally, touchSettingsNonPermission,
} from './helpers/dup.mjs';

test.describe.configure({ timeout: 360_000 });

/** 起一个一次性实例,并在 finally 里由用例自己停。 */
const startInst = (tag) => startInstanceP2(`r152b-${tag}`);
const raw = (r) => `第二条应答原文:${String(r && r.text).slice(0, 400)};进程条目(最近一次读取)${lastActiveJson()}`;

// ============================ 延后:带着活的后台任务、配置不一致 → 沿用原进程 ============================

test('B1 行为1 空闲进程带着没结束的后台命令、换思考强度再发一条:不另起新进程——应答 reused:true + configDeferred:true,进程号不变,进程数仍为 1,这条消息由原进程处理', async () => {
  const inst = await startInst('b1');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b1');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b1', run, bg: 'bash', effort: 'low', holdOld: true });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b1', run, effort: 'high' });
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect(facts, `原进程 ${p1};${raw(r2)}`).toEqual(sameProcessExpected(p1, true));
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B2 行为2 空闲进程带着没结束的后台子代理、换思考强度再发一条:同 B1——沿用原进程,应答 reused:true + configDeferred:true,进程数仍为 1', async () => {
  const inst = await startInst('b2');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b2');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b2', run, bg: 'agent', effort: 'low', holdOld: true });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b2', run, effort: 'high' });
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect(facts, `原进程 ${p1};${raw(r2)}`).toEqual(sameProcessExpected(p1, true));
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B3 行为3 同 B1 但请求里 keepAlive:false(界面「会话常驻」关):仍沿用原进程、不另起,应答 reused:true + configDeferred:true', async () => {
  const inst = await startInst('b3');
  const run = uniq('');
  let T = null;
  let held = null;
  try {
    T = newT(inst, 'b3');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b3', run, bg: 'bash', effort: 'low', holdOld: true });
    // 第二回合压住不结束:会话常驻关时,回合一结束进程是否被收掉不是本条要验的;压住它才能在"回合进行中"稳定地看进程数与进程号。
    held = writeHeldScript(inst, `b3held${run}`);
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b3', run, effort: 'low', extra: { keepAlive: false }, scriptName: held.name }); // effort 与第一条相同(都是 low):这条和第一条只差 keepAlive:false
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect(facts, `原进程 ${p1};${raw(r2)}`).toEqual(sameProcessExpected(p1, true));
  } finally {
    if (held) held.release();
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ 回归:该关旧开新的照旧关旧开新 ============================

test('B4 (回归)行为4 后台命令已结束(收到终态通知)后换思考强度再发一条:关旧开新——进程号变了,reused 不为 true,没有 configDeferred,旧进程退出,进程数为 1', async () => {
  const inst = await startInst('b4');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b4');
    const { r1, p1, bgIds } = await idleProcess(inst, T, { tag: 'b4', run, bg: 'bash', effort: 'low' });
    fxBgEnd(inst.ctl, T.sid, { pid: p1, ...bgIds, status: 'completed', summary: 'sleep 120 已结束' });
    const emitted = await waitFor(() => bgEndLog(inst.ctl, T.sid).find((x) => x.pid === p1) || null, 8_000, 100);
    expect(emitted, `夹具生效:旧进程吐出了后台命令的终态通知(记录:${JSON.stringify(bgEndLog(inst.ctl, T.sid))})`).toBeTruthy();
    await sleep(1_500);
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b4', run, effort: 'high' });
    const facts = await observeReplaced(inst, T, { p1, r1, r2, marker });
    expect(facts, `旧进程 ${p1};${raw(r2)}`).toEqual(replacedExpected());
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B5 (回归)行为5 空闲进程手上没有后台任务、换思考强度再发一条:关旧开新——进程号变了,reused 不为 true,没有 configDeferred,旧进程退出,进程数为 1', async () => {
  const inst = await startInst('b5');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b5');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b5', run, bg: null, effort: 'low' });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b5', run, effort: 'high' });
    const facts = await observeReplaced(inst, T, { p1, r1, r2, marker });
    expect(facts, `旧进程 ${p1};${raw(r2)}`).toEqual(replacedExpected());
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B6 (回归)行为6 空闲进程带着没结束的后台命令、配置一致再发一条:照常复用——reused:true,没有 configDeferred 这个字段,进程号不变,进程数 1', async () => {
  const inst = await startInst('b6');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b6');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b6', run, bg: 'bash', effort: 'low' });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b6', run, effort: 'low' });
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect(facts, `原进程 ${p1};${raw(r2)}`).toEqual(sameProcessExpected(p1, false));
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B7 行为7 延后配置的同时请求里模型不同、权限档不同:模型与权限档照常热切到原进程,应答仍是 reused:true + configDeferred:true', async () => {
  const inst = await startInst('b7');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b7');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b7', run, bg: 'bash', effort: 'low', mode: 'default', model: 'r151-chat', holdOld: true });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b7', run, effort: 'high', mode: 'plan', model: 'r151-reasoner' });
    const modelHot = () => modelLog(inst.ctl, T.sid).some((x) => x.pid === p1 && x.model === 'r151-reasoner' && x.action === 'passed');
    const modeHot = () => switchLog(inst.ctl, T.sid).some((x) => x.pid === p1 && x.mode === 'plan' && x.action === 'passed');
    await waitFor(() => modelHot() && modeHot(), 8_000, 100);
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect({ ...facts, modelHotSwitchedOnOriginal: modelHot(), modeHotSwitchedOnOriginal: modeHot() },
      `原进程 ${p1};${raw(r2)};换模型记录 ${JSON.stringify(modelLog(inst.ctl, T.sid))};切档记录 ${JSON.stringify(switchLog(inst.ctl, T.sid))}`)
      .toEqual({ ...sameProcessExpected(p1, true), modelHotSwitchedOnOriginal: true, modeHotSwitchedOnOriginal: true });
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B8 (回归)行为8 延后之后后台任务全部结束、再发一条(配置仍与旧进程不一致):关旧开新——换了进程,旧进程退出,进程数为 1', async () => {
  const inst = await startInst('b8');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b8');
    const { r1, p1, bgIds } = await idleProcess(inst, T, { tag: 'b8', run, bg: 'bash', effort: 'low' });
    // 第二条换思考强度(修复后 = 延后到原进程;修复前 = 另起新进程):这一步的结果是 B1 的事,本条只摆场景、不断言。
    const m2 = await sendSecond(inst, T, { tag: 'b8', run, label: '第二条', effort: 'high' });
    expect(m2.r2.status, `前置:第二条发出(${raw(m2.r2)})`).toBe(200);
    if (m2.r2.body && m2.r2.body.pid) await readStream(m2.r2.body.pid, { timeoutMs: 25_000, base: inst.c.base });
    await settle(8_000);
    // 后台命令结束:旧进程还活着就必须吐出终态通知(夹具自检);已经没了(修复前它在第二条时已被换掉)就没有可发的。
    const p1Alive = alive(p1);
    fxBgEnd(inst.ctl, T.sid, { pid: p1, ...bgIds, status: 'completed', summary: 'sleep 120 已结束' });
    const emitted = Boolean(await waitFor(() => bgEndLog(inst.ctl, T.sid).find((x) => x.pid === p1) || null, p1Alive ? 8_000 : 1_000, 100));
    expect({ p1Alive, emitted }, `夹具自检:旧进程 ${p1} 还活着时必须吐出终态通知(记录:${JSON.stringify(bgEndLog(inst.ctl, T.sid))})`).toEqual({ p1Alive, emitted: p1Alive });
    await sleep(1_500);
    const m3 = await sendSecond(inst, T, { tag: 'b8', run, label: '第三条', effort: 'high' });
    const facts = await observeReplaced(inst, T, { p1, r1, r2: m3.r2, marker: m3.marker, checkReused: false });
    expect(facts, `旧进程 ${p1};第二条应答 ${JSON.stringify(m2.r2.body)};第三条:${raw(m3.r2)}`).toEqual(replacedExpected(false));
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B10 (回归)行为10 延后的条件都满足(空闲进程带着活的后台命令、配置不一致)但请求的工作目录不同:不沿用——关旧开新,应答进程号变了、reused 不为 true、没有 configDeferred', async () => {
  const inst = await startInst('b10');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b10');
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b10', run, bg: 'bash', effort: 'low', holdOld: true });
    const cwd2 = makeWorkspace(`b10-other-${run}`);
    expect(cwd2, '前置:请求里的工作目录和会话原来的不同').not.toBe(T.cwd);
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b10', run, effort: 'high', extra: { cwd: cwd2 } });
    const facts = await observeNotReused(inst, T, { p1, r1, r2, marker, cwd2 });
    // 旧进程因后台命令继续活着是已知现状(本轮不处理):这里不断言它退没退、进程数是几。
    expect(facts, `原进程 ${p1};原工作目录 ${T.cwd};新工作目录 ${cwd2};${raw(r2)}`).toEqual(notReusedExpected());
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B11 (回归)行为11 延后的条件都满足(空闲进程带着活的后台命令),但请求之前设置文件的权限里被外部新加了一条 deny 规则、请求本身与第一条配置一致:不沿用——关旧开新,应答进程号变了、reused 不为 true、没有 configDeferred', async () => {
  const inst = await startInst('b11');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b11');
    seedSettingsWithAllow(inst.home);   // 第一回合之前就是一份有内容的设置文件(permissions 里已有一条 allow)
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b11', run, bg: 'bash', effort: 'low', holdOld: true });
    // 空闲后外部直接改设置文件:只在 permissions 里追加一条 deny,其余键一字不改(配置文件指纹不变,只有"外部权限改动"变了)。
    const rule = 'Bash(rm -rf /tmp/r152b-nothing:*)';
    const edit = addDenyRuleExternally(inst.home, rule);
    expect({ otherKeysUnchanged: edit.otherKeysUnchanged, denyRules: edit.denyRules }, `前置:外部只在 permissions 里追加了一条 deny(设置文件现状 ${edit.text.replace(/\s+/g, ' ')})`)
      .toEqual({ otherKeysUnchanged: true, denyRules: [rule] });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b11', run, effort: 'low' });   // 请求本身与第一条配置一致
    const facts = await observeNotReused(inst, T, { p1, r1, r2, marker, cwd2: T.cwd });
    // 旧进程因后台命令继续活着是已知现状:这里不断言它退没退、进程数是几。
    expect(facts, `原进程 ${p1};外部新加的 deny 规则 ${rule};${raw(r2)}`).toEqual(notReusedExpected());
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

test('B12 行为12 空闲进程带着活的后台命令,但请求之前设置文件被外部改了一个无关的顶层键(theme)、请求本身与第一条配置一致:仍沿用原进程——应答 reused:true + configDeferred:true,进程号不变,进程数仍为 1,这条消息由原进程处理', async () => {
  const inst = await startInst('b12');
  const run = uniq('');
  let T = null;
  try {
    T = newT(inst, 'b12');
    seedSettingsWithAllow(inst.home);   // 同 B11:第一回合之前就是一份有内容的设置文件
    const { r1, p1 } = await idleProcess(inst, T, { tag: 'b12', run, bg: 'bash', effort: 'low', holdOld: true });
    // 空闲后外部直接改设置文件:只新增一个无关的顶层键 theme,permissions 和其余键一字不改。
    const edit = touchSettingsNonPermission(inst.home, 'theme', 'dark');
    expect({ changedKeys: edit.changedKeys, permissionsUntouched: edit.permissionsUntouched }, `前置:外部只改了一个无关的顶层键 theme(设置文件现状 ${edit.text.replace(/\s+/g, ' ')})`)
      .toEqual({ changedKeys: ['theme'], permissionsUntouched: true });
    const { r2, marker } = await sendSecond(inst, T, { tag: 'b12', run, effort: 'low' });   // 请求本身与第一条配置一致
    const facts = await observeSameProcess(inst, T, { p1, r1, r2, marker });
    expect(facts, `原进程 ${p1};外部只改了 theme;${raw(r2)}`).toEqual(sameProcessExpected(p1, true));
  } finally {
    if (T) releaseAll(inst, T.sid);
    await inst.stop();
  }
});

// ============================ 界面:发送应答带 configDeferred:true → 出现一行提示(共享实例 + dev server) ============================

/** 共享实例里给一条新会话造一个跑完一回合的存活进程,空闲 8 秒。 */
async function sharedIdle(tag) {
  const T = newT({ home: homeDir() }, tag);
  const r = await chatStart(sharedC, T, { prompt: `R152B ${tag} 第一回合`, mode: 'default', postMs: 40_000 });
  expect(r.status, `前置:共享实例里 ${T.sid} 跑一个回合(${String(r.text).slice(0, 240)})`).toBe(200);
  if (r.body && r.body.pid) await readStream(r.body.pid, { timeoutMs: 25_000, base: sharedC.base });
  await sleep(8_000);
  return T;
}
/** 页面上同时含"后台任务"和"生效"的文字行(按渲染后的可见文字逐行找,不依赖 DOM 结构)。 */
const noticeLines = (page) => page.evaluate(() => String(document.body.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s.includes('后台任务') && s.includes('生效')));

/** 拦下界面发出的 POST /api/chat 的应答:在真实应答 JSON 上加(withField)或去掉 configDeferred;打开会话 T,在界面里发一条。 */
async function uiSend(page, T, { withField, tag }) {
  const seen = [];
  await page.route((url) => url.pathname === '/api/chat', async (route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const resp = await route.fetch();
    let real = null;
    try { real = await resp.json(); } catch { real = null; }
    if (!real || typeof real !== 'object') { seen.push({ status: resp.status(), real: null }); await route.fulfill({ response: resp }); return; }
    const { configDeferred: _drop, ...rest } = real;
    const sent = withField ? { ...rest, configDeferred: true } : rest;
    seen.push({ status: resp.status(), real, sent });
    await route.fulfill({ status: resp.status(), contentType: 'application/json', body: JSON.stringify(sent) });
  });
  await boot(page);
  await openSessionBySearch(page, T.title, T.reply);
  const before = await noticeLines(page);
  const marker = `R152BUI${tag}${uniq('')}`;
  await sendPrompt(page, marker);
  return { seen, before, marker };
}

test('B9a 行为9 界面:发送应答带 configDeferred:true 时,界面出现一行提示(文案含"后台任务"和"生效")', async ({ page }) => {
  test.skip(!process.env.R151B_UI_BASE || !process.env.R151B_CTL, '需要 run.sh 起的共享实例 + dev server');
  const T = await sharedIdle('b9a');
  const ui = await uiSend(page, T, { withField: true, tag: 'a' });
  // 提示可能是限时的小提示:每 150 毫秒采样,看到就停,最多 20 秒。
  let lines = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    lines = await noticeLines(page);
    if (lines.length) break;
    await page.waitForTimeout(150);
  }
  expect({
    noticeBeforeSending: ui.before,
    postsIntercepted: ui.seen.length,
    answerGivenToPageHadConfigDeferredTrue: ui.seen.length === 1 && Boolean(ui.seen[0].sent) && ui.seen[0].sent.configDeferred === true,
    noticeShown: lines.length >= 1,
    distinctNoticeTexts: new Set(lines).size,
  }, `提示行 ${JSON.stringify(lines)};拦到的应答 ${JSON.stringify(ui.seen).slice(0, 600)}`)
    .toEqual({ noticeBeforeSending: [], postsIntercepted: 1, answerGivenToPageHadConfigDeferredTrue: true, noticeShown: true, distinctNoticeTexts: 1 });
});

test('B9b (回归)行为9 界面:发送应答没有 configDeferred 字段时,不出现这行提示', async ({ page }) => {
  test.skip(!process.env.R151B_UI_BASE || !process.env.R151B_CTL, '需要 run.sh 起的共享实例 + dev server');
  const T = await sharedIdle('b9b');
  const ui = await uiSend(page, T, { withField: false, tag: 'b' });
  // 先等这条消息的回复显示出来(应答已处理完),再多等 3 秒:提示若会出现,早该出现了。
  const esc = ui.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect(page.getByText(new RegExp(`R151-REPLY.*${esc}`)).first(), '前置:这条消息的回复已显示').toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(3_000);
  const lines = await noticeLines(page);
  expect({
    noticeBeforeSending: ui.before,
    postsIntercepted: ui.seen.length,
    answerGivenToPageHasConfigDeferredKey: ui.seen.length === 1 && Boolean(ui.seen[0].sent) && Object.prototype.hasOwnProperty.call(ui.seen[0].sent, 'configDeferred'),
    noticeLines: lines,
  }, `拦到的应答 ${JSON.stringify(ui.seen).slice(0, 600)}`)
    .toEqual({ noticeBeforeSending: [], postsIntercepted: 1, answerGivenToPageHasConfigDeferredKey: false, noticeLines: [] });
});

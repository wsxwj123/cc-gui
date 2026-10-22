// r151s 静默超时可设置 —— 验收(看门狗部分)。S07–S12 依据 .devflow/r151s-stall-timeout-接口.md 的"行为清单":
//   S07 设置 10m 用 600000 档、结束版 · S08 设置 20m 用 1200000 档、结束版 · S09 设置 never 只提示一次、进程不被中止、停止可用 ·
//   S10(相邻)没设过设置仍按 5 分钟、结束版且带新的末尾一句 · S11 CGUI_STALL_MS=2000 优先于设置(两种到点动作) ·
//   S12 静默期间把设置改成 never → 这一次改为只提示。
// 做法:一次性实例 + 假 claude(先吐一次 Task 子代理调用,之后静默);用 helpers/stall-dur-shim.cjs 把服务进程里时长恰为
// 300000 / 600000 / 1200000 的定时器分别映射成"短时长"或"远长时长"——没被选中的那一档一律映射成远长于测试等待的时长,
// 所以"提示什么时候出现"就等于"服务端用了哪一档"。断言写死修复后应有的行为,不识别代码是否已实现。
import { test, expect } from '@playwright/test';
import { waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import {
  sleep, SENTENCE, FAR_MS, startSilence, disposeSilence, waitNotice, stallNotices, procPids, isGone, dump,
} from './helpers/s.mjs';

test.describe.configure({ timeout: 120_000 });

const SHORT = 2500;   // 被选中那一档映射成的"短时长"(毫秒)
const headRe = (n, unit) => new RegExp(`上游超过\\s*${n}\\s*${unit}\\s*无后续输出`);
const GENERIC_HEAD = /上游超过\s*(\S.*?)\s*无后续输出/;
const MAP_ONLY = (key, ms) => ({ 300000: FAR_MS, 600000: FAR_MS, 1200000: FAR_MS, [key]: ms });

/** 结束版文字:含时长句 + 已结束本回合并重置连接,不含只提示版的话,并以固定一句结尾。 */
const endChecks = (text, n, unit) => ({
  head: headRe(n, unit).test(text),
  endedAndReset: text.includes('已结束本回合并重置连接'),
  noHintWording: !text.includes('不自动结束本回合'),
  endsWithSentence: text.endsWith(SENTENCE),
});
const END_OK = { head: true, endedAndReset: true, noHintWording: true, endsWithSentence: true };
/** 只提示版文字:含时长句 + 不自动结束本回合,不含"已结束本回合",并以固定一句结尾。n 为 null 时只要求有时长句。 */
const hintChecks = (text, n, unit) => ({
  head: n === null ? GENERIC_HEAD.test(text) : headRe(n, unit).test(text),
  hintWording: text.includes('不自动结束本回合'),
  noEndedWording: !text.includes('已结束本回合'),
  endsWithSentence: text.endsWith(SENTENCE),
});
const HINT_OK = { head: true, hintWording: true, noEndedWording: true, endsWithSentence: true };
const alive = async (s) => (await procPids(s.inst.c, s.T.sid)).includes(Number(s.cliPid));
const sleepUntil = (ts) => sleep(Math.max(0, ts - Date.now()));

test('S07 设置 10m、不设 CGUI_STALL_MS(600000 档映射成短时长,300000 档映射成远长):静默后收到结束版 stall_notice,文字含 10 分钟,会话进程被中止', async () => {
  let s = null;
  try {
    s = await startSilence({ tag: 's07', prefs: { stallTimeout: '10m' }, timerMap: MAP_ONLY(600000, SHORT) });
    const n = await waitNotice(s, 1, 10_000);
    expect(n, `静默 ${SHORT}ms(600000 档)之后应收到 stall_notice(10 秒内没等到;${dump(s)})`).toBeTruthy();
    expect(endChecks(n.text, 10, '分钟'), `结束版文字应含「上游超过 10 分钟无后续输出」「已结束本回合并重置连接」并以固定一句结尾(实际:${JSON.stringify(n.text)})`).toEqual(END_OK);
    expect(await isGone(s.inst, s.T.sid, s.cliPid), `结束版:会话进程 ${s.cliPid} 应被中止(进程列表里消失)`).toBe(true);
  } finally { await disposeSilence(s); }
});

test('S08 设置 20m(1200000 档映射成短时长,另两档映射成远长):静默后收到结束版 stall_notice,文字含 20 分钟,会话进程被中止', async () => {
  let s = null;
  try {
    s = await startSilence({ tag: 's08', prefs: { stallTimeout: '20m' }, timerMap: MAP_ONLY(1200000, SHORT) });
    const n = await waitNotice(s, 1, 10_000);
    expect(n, `静默 ${SHORT}ms(1200000 档)之后应收到 stall_notice(10 秒内没等到;${dump(s)})`).toBeTruthy();
    expect(endChecks(n.text, 20, '分钟'), `结束版文字应含「上游超过 20 分钟无后续输出」「已结束本回合并重置连接」并以固定一句结尾(实际:${JSON.stringify(n.text)})`).toEqual(END_OK);
    expect(await isGone(s.inst, s.T.sid, s.cliPid), `结束版:会话进程 ${s.cliPid} 应被中止(进程列表里消失)`).toBe(true);
  } finally { await disposeSilence(s); }
});

test('S09 设置 never(300000 档映射成短时长,另两档映射成远长):静默后只收到 1 条只提示版 stall_notice(含 5 分钟与不自动结束本回合),进程仍在运行;再等两倍短时长没有第 2 条;调用停止后回合结束', async () => {
  let s = null;
  try {
    s = await startSilence({ tag: 's09', prefs: { stallTimeout: 'never' }, timerMap: MAP_ONLY(300000, SHORT) });
    const n = await waitNotice(s, 1, 10_000);
    expect(n, `静默 ${SHORT}ms(300000 档)之后应收到 1 条 stall_notice(10 秒内没等到;${dump(s)})`).toBeTruthy();
    expect(hintChecks(n.text, 5, '分钟'), `只提示版文字应含「上游超过 5 分钟无后续输出」「不自动结束本回合」、不含「已结束本回合」并以固定一句结尾(实际:${JSON.stringify(n.text)})`).toEqual(HINT_OK);
    expect(await alive(s), `只提示版:会话进程 ${s.cliPid} 不应被中止(${dump(s)})`).toBe(true);
    // 再等两倍短时长:同一段静默只提示一次
    await sleepUntil(n.at + 2 * SHORT + 300);
    const notices = stallNotices(s.stream.events);
    expect(notices.map((e) => e.text), `再等两倍短时长后只应有 1 条 stall_notice(实际 ${notices.length} 条)`).toHaveLength(1);
    expect(await alive(s), `再等两倍短时长后进程 ${s.cliPid} 仍应在运行(${dump(s)})`).toBe(true);
    // 界面上的停止照旧可用:POST /api/chat/:pid/stop → 200,回合随后结束
    const stop = await s.inst.c.post(`/api/chat/${encodeURIComponent(s.pid)}/stop`, {});
    expect(stop.status, `调用停止应 200(应答原文:${String(stop.text).slice(0, 240)})`).toBe(200);
    const ended = await waitFor(async () => (
      s.stream.ended
      || s.stream.events.some((e) => e && (e.type === 'done' || e.type === 'result'))
      || !(await procPids(s.inst.c, s.T.sid)).includes(Number(s.cliPid))
    ) || null, 10_000, 100);
    expect(ended, `停止之后回合应结束(事件流结束 / 出现 done|result / 进程消失 三者之一;${dump(s)})`).toBe(true);
  } finally { await disposeSilence(s); }
});

test('S10(相邻)没设过设置、300000 档映射成短时长:收到结束版 stall_notice,文字含 5 分钟、已结束本回合并重置连接,并以「时长可在 设置 → 会话 → 静默超时 中修改。」结尾,会话进程照旧被中止', async () => {
  let s = null;
  try {
    s = await startSilence({ tag: 's10', prefs: undefined, timerMap: MAP_ONLY(300000, SHORT) });
    const n = await waitNotice(s, 1, 10_000);
    expect(n, `默认(5 分钟 = 300000 档)静默 ${SHORT}ms 之后应收到 stall_notice(10 秒内没等到;${dump(s)})`).toBeTruthy();
    expect(endChecks(n.text, 5, '分钟'), `结束版文字应含「上游超过 5 分钟无后续输出」「已结束本回合并重置连接」并以固定一句结尾(实际:${JSON.stringify(n.text)})`).toEqual(END_OK);
    expect(await isGone(s.inst, s.T.sid, s.cliPid), `默认设置:会话进程 ${s.cliPid} 应照旧被中止`).toBe(true);
  } finally { await disposeSilence(s); }
});

test('S11 CGUI_STALL_MS=2000:设置 20m 时约 2 秒收到结束版 stall_notice(含 2 秒)且进程被中止;设置 never 时约 2 秒收到只提示版(含 2 秒),等到第 6 秒进程仍在运行', async () => {
  const ENV = { CGUI_STALL_MS: '2000' };
  const out = {};
  // 前半:20m → 到点结束回合
  let a = null;
  try {
    a = await startSilence({ tag: 's11a', prefs: { stallTimeout: '20m' }, envExtra: ENV });
    const n = await waitNotice(a, 1, 10_000);
    out.endNotice = n ? { checks: endChecks(n.text, 2, '秒'), offsetOk: n.at - a.t0 >= 1200 && n.at - a.t0 <= 5000, text: n.text, offsetMs: n.at - a.t0 } : null;
    out.endGone = n ? await isGone(a.inst, a.T.sid, a.cliPid) : null;
    out.endDump = dump(a);
  } finally { await disposeSilence(a); }
  // 后半:never → 到点只提示,第 6 秒进程仍在
  let b = null;
  try {
    b = await startSilence({ tag: 's11b', prefs: { stallTimeout: 'never' }, envExtra: ENV });
    const n = await waitNotice(b, 1, 10_000);
    out.hintNotice = n ? { checks: hintChecks(n.text, 2, '秒'), offsetOk: n.at - b.t0 >= 1200 && n.at - b.t0 <= 5000, text: n.text, offsetMs: n.at - b.t0 } : null;
    await sleepUntil(b.t0 + 6000);
    out.hintAliveAt6s = await alive(b);
    out.hintNoticeCount = stallNotices(b.stream.events).length;
    out.hintDump = dump(b);
  } finally { await disposeSilence(b); }
  const why = JSON.stringify(out);
  expect(out.endNotice, `20m:约 2 秒应收到 stall_notice(没等到;${out.endDump})`).toBeTruthy();
  expect(out.endNotice.checks, `20m:结束版文字应含「上游超过 2 秒无后续输出」「已结束本回合并重置连接」并以固定一句结尾(${why})`).toEqual(END_OK);
  expect(out.endNotice.offsetOk, `20m:提示应在静默后约 2 秒(1.2–5 秒内)出现(实际 ${out.endNotice.offsetMs}ms)`).toBe(true);
  expect(out.endGone, '20m:会话进程应被中止').toBe(true);
  expect(out.hintNotice, `never:约 2 秒应收到 stall_notice(没等到;${out.hintDump})`).toBeTruthy();
  expect(out.hintNotice.checks, `never:只提示版文字应含「上游超过 2 秒无后续输出」「不自动结束本回合」、不含「已结束本回合」并以固定一句结尾(${why})`).toEqual(HINT_OK);
  expect(out.hintNotice.offsetOk, `never:提示应在静默后约 2 秒(1.2–5 秒内)出现(实际 ${out.hintNotice.offsetMs}ms)`).toBe(true);
  expect({ aliveAt6s: out.hintAliveAt6s, noticeCount: out.hintNoticeCount }, `never:等到第 6 秒进程仍在运行且只提示过 1 次(${out.hintDump})`).toEqual({ aliveAt6s: true, noticeCount: 1 });
});

test('S12 设置 10m(600000 档映射成约 4 秒);静默开始后约 1 秒 PUT {"value":"never"} → 约第 4 秒收到只提示版 stall_notice;到静默开始后第 7 秒进程仍在运行', async () => {
  let s = null;
  try {
    s = await startSilence({ tag: 's12', prefs: { stallTimeout: '10m' }, timerMap: MAP_ONLY(600000, 4000) });
    await sleepUntil(s.t0 + 1000);
    const put = await s.inst.c.put('/api/prefs/stall-timeout', { value: 'never' });
    expect({ status: put.status, body: put.body }, `静默开始后约 1 秒把设置改成 never(PUT 应答原文:${String(put.text).slice(0, 240)})`)
      .toEqual({ status: 200, body: { ok: true, value: 'never' } });
    const n = await waitNotice(s, 1, 9_000);
    expect(n, `约第 4 秒应收到 stall_notice(9 秒内没等到;${dump(s)})`).toBeTruthy();
    const offset = n.at - s.t0;
    expect(hintChecks(n.text, null, ''), `改成 never 之后到点应只提示:含「不自动结束本回合」、不含「已结束本回合」并以固定一句结尾(实际:${JSON.stringify(n.text)})`).toEqual(HINT_OK);
    expect(offset >= 3000 && offset <= 6500, `提示应在静默开始后约 4 秒出现(3–6.5 秒内),实际 ${offset}ms`).toBe(true);
    await sleepUntil(s.t0 + 7000);
    expect(await alive(s), `静默开始后第 7 秒进程 ${s.cliPid} 仍应在运行(${dump(s)})`).toBe(true);
    expect(stallNotices(s.stream.events), '同一段静默只提示一次').toHaveLength(1);
  } finally { await disposeSilence(s); }
});

// r151u 两个用例文件共用的辅助:起/收实例、(乙)开场、状态采样、流的 done 判定。只走 HTTP / SSE / 假命令行记录,不 import 产品代码。
// 判定函数里互相独立的子条款用 expect.soft:一条用例红的时候能一次看全哪几条子条款不成立;夹具前置(引导受理、第二个 result 吐出)用硬断言。
import { expect } from '@playwright/test';
import { startInstance } from './inst.mjs';
import { sleep, sleepUntil, start, waitIdle, histogram, isLife, IMMEDIATE_MS, TOL_MS } from './t.mjs';

export const LIM = IMMEDIATE_MS + TOL_MS;      // "2 秒内"的判定线(含 0.3 秒轮询误差)
export const NORMAL_WIN = [3_500, 6_000];      // "约 4 秒后收尾":对应 result 后 3.5–6 秒
export const SUB_WIN = [3_500, 9_000];         // 子代理回合:对应 result 后 3.5–9 秒
const SAMPLE_GAP_MAX = 300 + TOL_MS;           // 接口文件"每隔不超过 0.3 秒采样一次"的夹具自检线(含轮询误差)

/** 起实例 → 跑 fn(inst, track) → 无论成败都断开登记过的流并 stop 实例(只停自己的 pid)。 */
export async function withInst(tag, fn) {
  const inst = await startInstance(tag, {});
  const undo = [];
  try { await fn(inst, (x) => { undo.push(() => (x.abort ? x.abort() : x.close())); return x; }); } finally {
    for (const u of undo) { try { u(); } catch { /* 忽略 */ } }
    await inst.stop();
  }
}

/** 假命令行原样吐一条输入建议事件。 */
export const PS = (text) => ({ emit: { type: 'prompt_suggestion', suggestion: text } });
/** 主 agent(parent_tool_use_id 为空)的一次 Agent 工具调用 = 派子代理。 */
export const AGENT = (id) => ({ toolUse: { id, name: 'Agent', input: { description: 'U151 子代理', prompt: '等一会儿再返回', subagent_type: 'general-purpose' } } });
const kinds = (ses) => JSON.stringify(ses.emits().map((e) => `${e.ev}/${e.sub || ''}`));

/** 前置:回合进行中调引导接口,必须 200 并受理,且命令行收到(吐出 queued)。 */
export async function steerOk(ses, label, key) {
  const st = await ses.steer(label, key);
  expect({ status: st.status, body: st.body }, `前置:回合进行中调用引导接口应 200 并受理(${st.text})`).toMatchObject({ status: 200, body: { ok: true, accepted: true, duplicate: false } });
  const q = await ses.waitEmit(isLife('queued', st.uuid), 5_000);
  expect(q, `夹具生效:服务端把引导连同 uuid 推给了命令行(命令行 stdin 末尾:${JSON.stringify(ses.inst.stdinLines(ses.sid).slice(-2).map((x) => x.line.slice(0, 160)))})`).toBeTruthy();
  return st;
}

/**
 * (乙)开场:发送(显式带输入预测开关)→ 开流 S1 → 回合中调引导(脚本 b)→ 放行 holdA → 等假命令行另起第二回合(started)。
 * firstSteps = 第一回合脚本(须含 {waitFile: ses.f('holdA')}),secondDef = 第二回合(引导)脚本。返回 { s1, started }。
 */
export async function startSeparate(ses, track, label, suggest, firstSteps, secondDef) {
  ses.script('a', { steps: firstSteps });
  ses.script('b', secondDef);
  const { s1 } = await start(ses, label, 'a', suggest);
  track(s1);
  const st = await steerOk(ses, `${label} 引导`, 'b');
  ses.release('holdA');
  const started = await ses.waitEmit(isLife('started', st.uuid), 8_000);
  expect(started, `夹具生效:第一回合 result 后假命令行另起了第二回合(started;${kinds(ses)})`).toBeTruthy();
  return { s1, started };
}

/** 从 fromMs 起每 stepMs 采一次 agents/active 状态,直到假命令行吐出第 n 个 result(或到 capMs)。返回 [{ t, s }]。 */
export async function sampleUntilResult(ses, n, fromMs, capMs, stepMs = 100) {
  await sleepUntil(fromMs);
  const out = [];
  while (Date.now() < capMs) {
    out.push({ t: Date.now(), s: await ses.status() });
    if (ses.results().length >= n) break;
    await sleep(stepMs);
  }
  return out;
}

/** [tFrom, tTo] 内的采样没有一次是 idle;并自检采样够密(间隔不超过 0.3 秒 + 轮询误差)。 */
export function expectNotIdleDuring(samples, tFrom, tTo, what) {
  const inWin = samples.filter((x) => x.t >= tFrom && x.t <= tTo);
  const edges = [tFrom, ...inWin.map((x) => x.t), tTo];
  const maxGap = Math.max(...edges.slice(1).map((t, i) => t - edges[i]));
  expect.soft(maxGap, `夹具:${what}采样间隔最大 ${maxGap}ms,应不超过 ${SAMPLE_GAP_MAX}ms(窗内共 ${inWin.length} 次)`).toBeLessThanOrEqual(SAMPLE_GAP_MAX);
  const idle = inWin.filter((x) => x.s === 'idle');
  expect.soft(idle.length, `${what},agents/active 不应报 idle;实际 ${idle.length}/${inWin.length} 次报 idle,首次在起点后 ${idle.length ? idle[0].t - tFrom : '-'}ms(状态分布 ${histogram(inWin)})`).toBe(0);
}

/** 流在 tLimit(第二回合 result 的吐出时刻)之前没有收到 done。 */
export function expectNoDoneBefore(s, tLimit, what) {
  const at = s.doneAt();
  expect.soft(at === null || at >= tLimit, `${what}:第二回合 result 之前不应收到 done,实际 done 比 result 早 ${at === null ? '-' : tLimit - at}ms 到(${s.summary()})`).toBe(true);
}

/** 流收到了 want 里的全部正文。 */
export function expectTexts(s, want, what) {
  expect.soft(s.texts(), `${what}:应收到正文 ${want.join('、')}(${s.summary()})`).toEqual(expect.arrayContaining(want));
}

/** 流在基准时刻 tFrom 之后 lo–hi 毫秒内收到 {"type":"done"},且随后被服务端关闭(不靠客户端超时)。 */
export async function expectDoneWithin(s, tFrom, lo, hi, what) {
  const d = await s.waitDone(Math.max(0, tFrom + hi + 500 - Date.now()));
  expect.soft(d, `${what}:基准时刻后 ${hi}ms 内应收到 {"type":"done"},等到线仍没有(${s.summary()})`).toBeTruthy();
  if (!d) return;
  const delay = s.doneAt() - tFrom;
  expect.soft(delay >= lo && delay <= hi, `${what}:done 应在基准时刻后 ${lo}–${hi}ms 内到达,实测 ${delay}ms(${s.summary()})`).toBe(true);
  expect.soft(await s.waitClosed(2_000), `${what}:收到 done 后服务端应在 2 秒内关闭这条流(${s.summary()})`).toBe(true);
}

/** 会话在 tFrom 之后 limit 毫秒内稳定报 idle。 */
export async function expectIdleBy(ses, tFrom, what, limit = LIM) {
  const r = await waitIdle(ses, { settleFrom: tFrom, by: tFrom + limit });
  expect.soft(r.ok, `${what}:应在 ${limit}ms 内报 idle(最后一次采样 ${JSON.stringify(r.last)};${await ses.diag()})`).toBe(true);
}

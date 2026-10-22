// E. 进程与提示(行为 14、15)。一次性实例 + 假 claude;环境变量经 envExtra 只给服务进程。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uniq } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { waitFor, writeScript, readStream } from '../r151b-xsession-p1/helpers/api.mjs';
import { newT, procPids, lastTurnPid, streamT, stallNotices, stallText, isTaskToolUseEvent, releaseWait } from '../r151h-stall-watchdog/helpers/h.mjs';
import { startInstanceQ } from './helpers/inst.mjs';

test.describe.configure({ timeout: 120_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMER_SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'stall-timer-shim.cjs');

test('Q14 CGUI_KEEPALIVE_IDLE_MS=99999999999(超出上限,当没设)→ 回合结束 5 秒后常驻进程仍在', async () => {
  const inst = await startInstanceQ('q14', { envExtra: { CGUI_KEEPALIVE_IDLE_MS: '99999999999' } });
  try {
    const run = uniq('');
    const T = newT(inst, 'q14');
    const scriptName = `q14-${run}`;
    writeScript(scriptName, [{ say: `R151Q q14 回合完 ${run}` }], inst.ctl);
    const r = await inst.c.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, permissionMode: 'default', prompt: `R151Q-Q14-${run} R151S:${scriptName}` }, { timeoutMs: 30_000 });
    expect(r.status, `前置:发出消息(${String(r.text).slice(0, 200)})`).toBe(200);
    const evs = await readStream(r.body.pid, { timeoutMs: 25_000, base: inst.base });
    expect(evs.some((e) => e && (e.type === 'result' || e.type === 'done')), '前置:这一回合结束了').toBe(true);
    const cliPid = lastTurnPid(inst.ctl, T.sid);
    expect(cliPid, '前置:假 claude 记下了这一回合的进程号').toBeTruthy();
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) { samples.push((await procPids(inst.c, T.sid)).includes(Number(cliPid))); await sleep(250); }
    expect({ samples: samples.length, aliveEverySample: samples.every(Boolean) }, `回合结束后 5 秒内每次采样常驻进程 ${cliPid} 都应在(进程列表:${JSON.stringify(await procPids(inst.c, T.sid))})`)
      .toEqual({ samples: samples.length, aliveEverySample: true });
  } finally { await inst.stop(); }
});

const taskToolUse = (run) => ({ toolUse: { id: `toolu_q15_task_${run}`, name: 'Task', input: { subagent_type: 'general-purpose', description: 'Q15 起过的子代理', prompt: '等一会儿再返回' } } });
/** 起一个"只有 Task 子代理、之后静默"的回合,返回静默看门狗提示的文字(等不到 = null)。 */
async function stallNoticeText(inst, tag, run) {
  const T = newT(inst, tag);
  const scriptName = `q15-${tag}-${run}`; const never = `${scriptName}-never`;
  writeScript(scriptName, [taskToolUse(run), { waitFile: never }], inst.ctl);
  const r = await inst.c.post('/api/chat', { sessionId: T.sid, cwd: T.cwd, permissionMode: 'default', prompt: `R151Q-${tag}-${run} R151S:${scriptName}` }, { timeoutMs: 30_000 });
  expect(r.status, `前置:发出消息(${String(r.text).slice(0, 200)})`).toBe(200);
  const stream = streamT(inst.base, r.body.pid);
  try {
    await stream.ready;
    expect(await stream.waitFor(isTaskToolUseEvent, 10_000), '夹具生效:事件流里有带 Task 工具调用的 assistant 消息').toBeTruthy();
    const notice = await waitFor(() => stallNotices(stream.events)[0] || null, 12_000, 100);
    return notice ? stallText(notice) : null;
  } finally { releaseWait(inst.ctl, never); stream.stop(); }
}

test('Q15 静默看门狗提示:CGUI_STALL_MS=2000 → 写"2 秒";默认阈值(相邻)仍写"5 分钟"', async () => {
  const run = uniq('');
  const A = await startInstanceQ('q15-short', { envExtra: { CGUI_STALL_MS: '2000' } });
  let textA = null;
  try { textA = await stallNoticeText(A, 'a', run); } finally { await A.stop(); }
  // 默认阈值那一半:不设 CGUI_STALL_MS,夹具垫片只把 300000ms 的定时器缩成 1.5 秒,好在测试里看到提示文案
  const B = await startInstanceQ('q15-default', { requireShims: [TIMER_SHIM], envExtra: { R151Q_STALL_TIMER_MS: '1500' } });
  let textB = null;
  try { textB = await stallNoticeText(B, 'b', run); } finally { await B.stop(); }
  expect.soft(String(textA), 'CGUI_STALL_MS=2000 时的提示应含"2 秒"').toContain('2 秒');
  expect.soft(String(textA), 'CGUI_STALL_MS=2000 时的提示不应再写"5 分钟"').not.toContain('5 分钟');
  expect.soft(String(textB), '默认阈值的提示仍应含"5 分钟"').toContain('5 分钟');
});

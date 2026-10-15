// 行为清单 16:信封的来源与中和。
// 第一段(假 CLI):逐字比对进程收到的文本 —— 来源地址 gui:user、来源名六步清洗、正文按定稿规则中和、对结果再中和一次不变。
// 第二段(本机真 claude CLI,模型请求只到本地假接口):目标回合 result.origin 的 name / body。没有真 CLI 时只跳过第二段。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, makeWorkspace, realCliPath } from './helpers/fixtures.mjs';
import {
  xs, chat, readStream, waitFor, inputRecords, laneRequests, envelope, cleanName, NEUTRAL_RAW, NEUTRAL_EXPECTED, ID_RE,
} from './helpers/api.mjs';
import { note } from './helpers/ui.mjs';

test.describe.configure({ timeout: 240_000 });
const api = xs();
const inputsFor = (cwd) => inputRecords().filter((s) => s.cwd === cwd);

/** 转发 → 认领 → 兑换,返回 { m, msg(收件列表里的消息对象), r(兑换应答) }。 */
async function deliver(fromSid, target, body) {
  const [m] = await api.send(fromSid, [target.sid], body);
  const msg = await api.find(target.sid, m.id);
  const token = await api.claimOk(m.id);
  const r = await chat({ sessionId: target.sid, cwd: target.cwd, prompt: 'x', xsMessageId: m.id, xsToken: token });
  expect(r.status, `兑换应 200(${r.text.slice(0, 300)})`).toBe(200);
  return { m, msg, r };
}
async function received(cwd, before) {
  const l = await waitFor(() => { const x = inputsFor(cwd).slice(before); return x.length ? x : null; }, 15_000);
  return (l || []).map((x) => x.content);
}

test('X16 信封:来源地址 gui:user、来源名清洗、正文中和(含写法变体与原样不变的写法)、再中和一次不变;真 CLI 的 result.origin 的 name / body 与之一致', async () => {
  await api.on();
  const title = `  R151B"甲"<源>\t标题​${'长'.repeat(70)}😀尾  `;
  const A = seedSession(`x16-a-${uniq('')}`, { title });
  const B = seedSession(`x16-b-${uniq('')}`);
  let expectedName = '';

  await test.step('正文中和 + 来源名清洗(逐字)', async () => {
    const n0 = inputsFor(B.cwd).length;
    const { msg, r } = await deliver(A.sid, B, NEUTRAL_RAW);
    expectedName = cleanName(`用户转发自 ${msg.from.title}`);
    expect(expectedName.length <= 64, '前提:清洗后的来源名不超过 64').toBe(true);
    await readStream(r.body.pid, { timeoutMs: 25_000 });
    expect(await received(B.cwd, n0)).toEqual([envelope('gui:user', expectedName, NEUTRAL_EXPECTED)]);
    expect((await api.waitStatus(B.sid, msg.id, 'done')).status, '前置:处理完').toBe('done');
  });

  await test.step('对中和结果再中和一次:不再变化', async () => {
    const n0 = inputsFor(B.cwd).length;
    const { r } = await deliver(A.sid, B, NEUTRAL_EXPECTED);
    await readStream(r.body.pid, { timeoutMs: 25_000 });
    expect(await received(B.cwd, n0)).toEqual([envelope('gui:user', expectedName, NEUTRAL_EXPECTED)]);
  });

  await test.step('没有来源会话时来源名为"用户"', async () => {
    const n0 = inputsFor(B.cwd).length;
    const { r } = await deliver(null, B, 'R151B x16 无来源');
    await readStream(r.body.pid, { timeoutMs: 25_000 });
    expect(await received(B.cwd, n0)).toEqual([envelope('gui:user', '用户', 'R151B x16 无来源')]);
  });

  await test.step('真 CLI:目标回合 result.origin 的 name = 来源名,body = 中和后的正文', async () => {
    if (!realCliPath()) { note('本机没有真 claude CLI:跳过 result.origin 一段'); return; }
    const cwd = makeWorkspace(`real-x16-${uniq('')}`);
    const lane0 = laneRequests('real').length;
    const first = await chat({ cwd, prompt: 'R151B-X16-REAL 先建会话' });
    expect(first.status, `真 CLI 新会话 200(${first.text.slice(0, 200)})`).toBe(200);
    const evs0 = await readStream(first.body.pid, { timeoutMs: 90_000 });
    const sid = (first.body && first.body.sessionId) || (evs0.find((e) => e && typeof e.session_id === 'string' && ID_RE.test(e.session_id)) || {}).session_id;
    expect(ID_RE.test(String(sid)), `前置:拿到真 CLI 会话 id(事件:${evs0.map((e) => e.type).join(',')})`).toBe(true);
    expect(laneRequests('real').length, '前置:真 CLI 的模型请求打到了本地假接口').toBeGreaterThan(lane0);
    const target = { sid, cwd };
    expect(await waitFor(async () => (await api.sessions(`?ids=${sid}`)).body?.sessions?.length === 1, 15_000), '前置:真 CLI 会话已落盘').toBeTruthy();
    const { r } = await deliver(A.sid, target, NEUTRAL_RAW);
    const evs = await readStream(r.body.pid, { timeoutMs: 90_000 });
    const res = evs.find((e) => e && e.type === 'result' && e.origin);
    expect(res && res.origin, `目标回合的 result 应带 origin(事件:${evs.map((e) => e.type).join(',')})`).toBeTruthy();
    expect(res.origin).toMatchObject({ kind: 'peer', from: 'gui:user', name: expectedName, body: NEUTRAL_EXPECTED });
  });
});

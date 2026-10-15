// 行为清单 25:原生 SendMessage 引导。本机真 claude CLI(经 GUI 起,模型请求只到本地假接口的 real 车道);
// 假接口按提示词里的标记让"模型"调用 SendMessage,"模型看到的拒绝原因" = 下一次模型请求里这次调用的 tool_result 文字。
// 收件方的名字取自 CLI 自己的会话登记表(临时 HOME 下 .claude/sessions/<pid>.json 的 name;2026-10-15 对 CLI 2.1.296 实测的写法)。
// 没覆盖:子代理发起的 SendMessage。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, makeWorkspace, realCliPath, homeDir } from './helpers/fixtures.mjs';
import { xs, chat, readStream, waitFor, setLane, laneRequests, REFUSAL, ID_RE } from './helpers/api.mjs';

test.describe.configure({ timeout: 360_000 });
const api = xs();

function registry() {
  const d = path.join(homeDir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  return files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
const liveName = (cwd) => waitFor(() => { const e = registry().find((x) => x.cwd === cwd && x.name); return e ? e.name : null; }, 20_000);
const sidOf = (res, evs) => (res.body && res.body.sessionId) || (evs.find((e) => e && typeof e.session_id === 'string' && ID_RE.test(e.session_id)) || {}).session_id;

/** 跑一回合,返回这回合里"模型"新看到的、本车道工具调用的结果文字。 */
async function turn(body) {
  const seen = new Set(laneRequests('real').flatMap((r) => r.toolResults.map((t) => t.id)));
  const res = await chat({ permissionMode: 'bypassPermissions', ...body });
  expect(res.status, `回合应 200(${res.text.slice(0, 200)})`).toBe(200);
  const evs = await readStream(res.body.pid, { timeoutMs: 150_000 });
  const fresh = [];
  for (const r of laneRequests('real')) for (const t of r.toolResults) if (!seen.has(t.id)) { seen.add(t.id); fresh.push(t.text); }
  return { res, evs, results: fresh };
}
const delivered = (watch) => laneRequests('real').some((r) => r.userTexts.some((t) => t.includes(watch)));

test('X25 原生 SendMessage:开关开时发给本 GUI 另一个会话 → 被拒、不送达,模型看到定稿的拒绝原因;目标不是 GUI 会话 → 不受影响;开关关 → 不受影响', async () => {
  test.skip(!realCliPath(), '本机没有真 claude CLI');
  const run = uniq('');
  const onWatch = `R151B-NATIVE-ON-${run}`;
  const offWatch = `R151B-NATIVE-OFF-${run}`;
  const cwdC = makeWorkspace(`real-x25c-${run}`);
  const cwdA = makeWorkspace(`real-x25a-${run}`);
  const lane = (cName) => setLane('real', { watch: [onWatch, offWatch], scripts: {
    [`X25A-ON-${run}`]: [{ name: 'SendMessage', input: { to: cName, summary: 'r151b', message: `${onWatch} 你好` } }],
    [`X25A-NOBODY-${run}`]: [{ name: 'SendMessage', input: { to: 'r151b-nobody', summary: 'r151b', message: 'R151B 发给不存在的会话' } }],
    [`X25A-OFF-${run}`]: [{ name: 'SendMessage', input: { to: cName, summary: 'r151b', message: `${offWatch} 你好` } }],
  } });
  await api.off();
  lane('placeholder');
  const c0 = await turn({ cwd: cwdC, prompt: `R151B-X25C-${run} 你好` });
  const sidC = sidOf(c0.res, c0.evs);
  expect(ID_RE.test(String(sidC)), '前置:GUI 会话 C 已建').toBe(true);
  let nameC = await liveName(cwdC);
  expect(nameC, '前置:C 在 CLI 会话登记表里(进程常驻)').toBeTruthy();
  lane(nameC);
  let sidA = null;

  await test.step('开关关:发给 GUI 会话 C → 不受影响,照常送达', async () => {
    const a = await turn({ cwd: cwdA, prompt: `X25A-OFF-${run} 请发消息` });
    sidA = sidOf(a.res, a.evs);
    expect(a.results.length, `模型应拿到这次调用的结果(实际:${JSON.stringify(a.results)})`).toBe(1);
    expect(a.results[0], '开关关时不引导').not.toContain(REFUSAL);
    expect(a.results[0], '开关关时 C 可达').not.toContain('No agent named');
    expect(await waitFor(() => delivered(offWatch), 45_000), 'C 收到了这条原生消息').toBeTruthy();
  });

  await test.step('开关开:发给 GUI 会话 C → 被拒,拒绝原因逐字,C 没收到', async () => {
    await api.on();
    await turn({ cwd: cwdC, sessionId: sidC, prompt: `R151B-X25C-${run} 开了以后` });
    nameC = await liveName(cwdC);
    expect(nameC, '前置:C 仍在登记表里').toBeTruthy();
    lane(nameC);
    const a = await turn({ cwd: cwdA, sessionId: sidA, prompt: `X25A-ON-${run} 再发一次` });
    expect(a.results.length, `模型应拿到这次调用的结果(实际:${JSON.stringify(a.results)})`).toBe(1);
    expect(a.results[0], '模型看到的拒绝原因').toContain(REFUSAL);
    await new Promise((r) => setTimeout(r, 4_000));
    expect(delivered(onWatch), 'C 不应收到这条消息').toBe(false);
  });

  await test.step('开关开:目标不是本 GUI 的会话 → 不受影响(CLI 原生的找不到收件方)', async () => {
    const a = await turn({ cwd: cwdA, sessionId: sidA, prompt: `X25A-NOBODY-${run} 发给别人` });
    expect(a.results.length).toBe(1);
    expect(a.results[0]).not.toContain(REFUSAL);
    expect(a.results[0]).toContain("No agent named 'r151b-nobody'");
  });
});

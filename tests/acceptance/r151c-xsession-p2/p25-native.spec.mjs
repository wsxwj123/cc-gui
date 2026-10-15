// 二期行为清单 25:原生 SendMessage 引导换二期拒绝原因;bridge: / did: 地址与终端会话不受影响;先修项里能从外部观察的"损坏留存保留 7 天"。
// 做法照一期 X25:真 CLI 经 GUI 起,假接口让"模型"调用 SendMessage,"模型看到的拒绝原因" = 下一次模型请求里的 tool_result;
// 收件方名字取 CLI 自己的会话登记表(临时 HOME 下 .claude/sessions/<pid>.json 的 name)。
// 没覆盖:先修项里"会话失效时窗格留在原会话""重发被拦时保留修正提示"(接口文件只引用了方案章节,没给可观察的触发条件)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { uniq, makeWorkspace, realCliPath, homeDir, xsDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, waitFor, REFUSAL } from '../r151b-xsession-p1/helpers/api.mjs';
import { REFUSAL_P2, laneReq, aiCalls, startInstanceP2 } from './helpers/p2.mjs';

test.describe.configure({ timeout: 360_000 });
const api = xs();
function registry() {
  const d = path.join(homeDir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  return files.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
const liveName = (cwd) => waitFor(() => { const e = registry().find((x) => x.cwd === cwd && x.name); return e ? e.name : null; }, 20_000);

test('P25 开关开:模型对本 GUI 另一会话调原生 SendMessage → 被拒,原因为二期文案、不送达;bridge: / did: 地址与终端会话不受影响;先修项:损坏留存保留 7 天', async () => {
  await test.step('先修项:损坏留存文件(messages.json.corrupt-*)保留 7 天 —— 超过 7 天的在服务启动时删除,不到 7 天的保留', async () => {
  const inst = await startInstanceP2('p25b');
  try {
    const dir = xsDir(inst.home);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'messages.json.corrupt-r151c-old');
    const young = path.join(dir, 'messages.json.corrupt-r151c-young');
    fs.writeFileSync(old, '{"坏的'); fs.writeFileSync(young, '{"坏的');
    const day = 86_400_000;
    fs.utimesSync(old, new Date(Date.now() - 8 * day), new Date(Date.now() - 8 * day));
    fs.utimesSync(young, new Date(Date.now() - 6 * day), new Date(Date.now() - 6 * day));
    await inst.restart();
    await new Promise((res) => setTimeout(res, 1_500));
    expect([fs.existsSync(old), fs.existsSync(young)], '8 天前的删除、6 天前的保留').toEqual([false, true]);
  } finally { await inst.stop(); }
  });
  test.skip(!realCliPath(), '本机没有真 claude CLI');
  await api.on();
  const run = uniq('');
  const watch = `R151C-NATIVE-${run}`;
  const cwdC = makeWorkspace(`real-p25c-${run}`);
  const C = await aiCalls(shared, { cwd: cwdC, steps: [] });
  expect(C.sid, '前置:GUI 会话 C 已建').toBeTruthy();
  const nameC = await liveName(cwdC);
  expect(nameC, '前置:C 在 CLI 会话登记表里(进程常驻)').toBeTruthy();
  const send = (to, message) => ({ name: 'SendMessage', input: { to, summary: 'r151c', message } });
  const r = await aiCalls(shared, { cwd: makeWorkspace(`real-p25a-${run}`), watch: [watch], steps: [
    send(nameC, `${watch} 你好`), send(`bridge:r151c-${run}`, 'R151C bridge'), send(`did:r151c-${run}`, 'R151C did'), send('r151c-nobody', 'R151C 终端会话'),
  ] });
  expect(r.results.length, `模型应拿到 4 个工具结果(实际:${JSON.stringify(r.results.map((x) => x.text.slice(0, 120)))})`).toBe(4);
  expect(r.results[0].text, '发给 GUI 会话 → 二期拒绝原因').toContain(REFUSAL_P2);
  expect(r.results[0].text, '不再是一期文案').not.toContain(REFUSAL);
  for (const [i, label] of [[1, 'bridge:'], [2, 'did:'], [3, '终端会话']]) {
    expect(r.results[i].text, `${label} 不受影响`).not.toContain(REFUSAL_P2);
    expect(r.results[i].text, `${label} 不受影响(一期文案也没有)`).not.toContain(REFUSAL);
  }
  await new Promise((res) => setTimeout(res, 4_000));
  expect(laneReq('real').some((q) => q.userTexts.some((t) => t.includes(watch))), 'C 没有收到这条原生消息').toBe(false);
});

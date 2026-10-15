// 行为清单 23、24:历史里的 peer-message 条目与气泡、直播时按 result.origin 补来源气泡。
// 会话记录里跨会话消息那一行的写法取自本机真实 CLI 2.1.296 的实录(origin / turnOrigin:"peer" / promptSource:"system" / isMeta);
// "旧 CLI 2.1.273"的写法按接口文件:promptSource:"sdk"、没有 turnOrigin。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, encodeProjectDir } from './helpers/fixtures.mjs';
import { xs, get, writeScript } from './helpers/api.mjs';
import { boot, openSessionBySearch, sendPrompt } from './helpers/ui.mjs';

test.describe.configure({ timeout: 180_000 });
const api = xs();
// 既有历史接口要带 projectHash(= 记录所在的项目目录名)
const history = (s) => get(`/api/sessions/${s.sid}/messages?projectHash=${encodeURIComponent(encodeProjectDir(s.cwd))}`);
const items = (r) => (Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.messages) ? r.body.messages : []));
const project = (arr) => JSON.parse(JSON.stringify(arr, (k, v) => (['parentUuid', 'leafUuid', 'parentId', 'sessionId', 'cwd'].includes(k) ? undefined : v)));

function linesFor(mark, k, { withPeers }) {
  const sid = k;
  const ts = (n) => new Date(Date.parse('2026-10-02T08:00:00.000Z') + n * 1000).toISOString();
  const asst = (n, parent, text) => ({ type: 'assistant', uuid: `${sid.slice(0, 8)}-a${n}`, parentUuid: parent, timestamp: ts(n * 2), requestId: `req_${n}`,
    message: { id: `msg_${sid.slice(0, 8)}_${n}`, type: 'message', role: 'assistant', model: 'r151-chat', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  const u0 = { type: 'user', uuid: `${sid.slice(0, 8)}-u0`, parentUuid: null, timestamp: ts(0), promptSource: 'sdk', turnOrigin: 'sdk', message: { role: 'user', content: `${mark} 首条提问` } };
  const p1 = { type: 'user', uuid: `${sid.slice(0, 8)}-p1`, parentUuid: `${sid.slice(0, 8)}-a1`, timestamp: ts(3), isMeta: true, promptSource: 'system', turnOrigin: 'peer',
    origin: { kind: 'peer', from: 'gui:user', name: '用户转发自 R151B甲', body: 'R151B 正文一', hostInjected: true },
    message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="gui:user" from-name="用户转发自 R151B甲">\nR151B 正文一\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.' } };
  const p2 = { type: 'user', uuid: `${sid.slice(0, 8)}-p2`, parentUuid: `${sid.slice(0, 8)}-a2`, timestamp: ts(5), isMeta: true, promptSource: 'sdk',
    origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/r151b.sock' }, message: { role: 'user', content: 'R151B 无法识别的文本' } };
  const p3 = { type: 'user', uuid: `${sid.slice(0, 8)}-p3`, parentUuid: `${sid.slice(0, 8)}-a3`, timestamp: ts(7), isMeta: true, promptSource: 'system',
    origin: { kind: 'peer', senderTaskId: 'task_r151b', name: '子代理', body: 'R151B 子代理回传' }, message: { role: 'user', content: 'R151B 子代理回传原文' } };
  const a1 = asst(1, u0.uuid, `${mark} 回复一`);
  const a2 = asst(2, withPeers ? p1.uuid : a1.uuid, `${mark} 回复二`);
  const a3 = asst(3, withPeers ? p2.uuid : a2.uuid, `${mark} 回复三`);
  const a4 = asst(4, p3.uuid, `${mark} 回复四`);
  return [{ type: 'summary', summary: `${mark} 历史`, leafUuid: a4.uuid }, u0, a1, ...(withPeers ? [p1] : []), a2, ...(withPeers ? [p2] : []), a3, p3, a4];
}

test('X23 历史:origin.kind=peer 且不是子代理回传的行 → 触发的回复之前出现 peer-message 条目(新旧 CLI 写法都认);首条提问不变、不算用户提问;总开关关着也显示', async ({ page }) => {
  await api.off();
  const mark = uniq('R151BX23');
  const k = `x23${Date.now().toString(36).slice(-5)}`;
  const s1 = seedSession(`x23-s1-${mark}`, { lines: [] });
  seedSession(`x23-s1-${mark}`, { sid: s1.sid, cwd: s1.cwd, lines: linesFor(mark, k, { withPeers: true }) });

  const r1 = await history(s1);
  expect(r1.status, `历史接口 200(${r1.text.slice(0, 200)})`).toBe(200);
  const h1 = items(r1);
  expect.soft(h1.filter((x) => x && x.type === 'user').map((x) => x.text), '首条提问不变;跨会话消息那几行不算用户提问')
    .toEqual([`${mark} 首条提问`]);
  const peers = h1.filter((x) => x && x.type === 'peer-message');
  expect(peers.map(({ type, uuid, timestamp, fromName, from, body }) => ({ type, uuid, timestamp, fromName, from, body })), 'peer-message 条目').toEqual([
    { type: 'peer-message', uuid: `${k}-p1`, timestamp: '2026-10-02T08:00:03.000Z', fromName: '用户转发自 R151B甲', from: 'gui:user', body: 'R151B 正文一' },
    { type: 'peer-message', uuid: `${k}-p2`, timestamp: '2026-10-02T08:00:05.000Z', fromName: null, from: 'uds:/tmp/cc-socks/r151b.sock', body: null },
  ]);
  expect(peers[0].hostInjected, 'hostInjected 照抄 origin').toBe(true);
  expect(Boolean(peers[1].hostInjected), 'origin 没有 hostInjected').toBe(false);
  for (const [p, reply] of [[peers[0], '回复二'], [peers[1], '回复三']]) {
    const next = h1[h1.indexOf(p) + 1];
    expect(JSON.stringify(next), `${p.uuid} 紧挨在它触发的回复之前`).toContain(`${mark} ${reply}`);
  }
  expect(JSON.stringify(peers), '子代理回传不算').not.toContain('子代理');

  await boot(page);
  // "<mark> 历史"只写在 summary 行,侧栏的会话标题和搜索都不用它;改按首条提问(= 会话标题,也是消息文字)搜
  await openSessionBySearch(page, `${mark} 首条提问`, `${mark} 回复四`);
  const bubbles = page.getByTestId('peer-message');
  await expect(bubbles, '界面显示两个 peer-message 气泡').toHaveCount(2, { timeout: 15_000 });
  await expect(bubbles.nth(0)).toHaveAttribute('data-via', 'gui');
  await expect(bubbles.nth(0).getByTestId('peer-message-from')).toContainText('用户转发自 R151B甲');
  await expect(bubbles.nth(0)).toContainText('R151B 正文一');
  await expect(bubbles.nth(1).getByTestId('peer-message-from')).toHaveText('来自另一个会话');
  await expect(bubbles.nth(1)).toContainText('（内容未能解析）');
});

test('X24 直播:result 带 origin.kind=peer、没有 senderTaskId / hostInjected → 该回合前补 peer-message 气泡(data-via=native);名字缺失"来自另一个会话",正文缺失"(内容未能解析)"', async ({ page }) => {
  await api.off();
  const mark = uniq('R151BX24');
  const s = seedSession(`x24-${mark}`, { title: `${mark} 直播` });
  const scripts = {
    x24a: { origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/a.sock', name: 'R151B乙', body: 'R151B 直播正文' } },
    x24b: { origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/b.sock' } },
    x24c: { origin: { kind: 'peer', from: 'gui:user', name: 'R151B丙', body: 'R151B 丙正文', hostInjected: true } },
    x24d: { origin: { kind: 'peer', name: 'R151B丁', body: 'R151B 丁正文', senderTaskId: 'task_r151b' } },
  };
  for (const [k, result] of Object.entries(scripts)) writeScript(k, [{ say: `${mark} 回复-${k}` }, { result }]);
  await boot(page);
  await openSessionBySearch(page, mark, s.reply);
  const native = page.locator('[data-testid="peer-message"][data-via="native"]');

  await sendPrompt(page, `${mark} 一 R151S:x24a`);
  await expect(page.getByText(`${mark} 回复-x24a`).first()).toBeVisible({ timeout: 20_000 });
  await expect(native).toHaveCount(1, { timeout: 10_000 });
  await expect(native.nth(0).getByTestId('peer-message-from'), '"来自 <名字>"').toHaveText(/^来自\s?R151B乙$/);
  await expect(native.nth(0)).toContainText('R151B 直播正文');
  const yb = (await native.nth(0).boundingBox()).y;
  const yr = (await page.getByText(`${mark} 回复-x24a`).first().boundingBox()).y;
  expect(yb < yr, '气泡在该回合的回复之前').toBe(true);

  await sendPrompt(page, `${mark} 二 R151S:x24b`);
  await expect(page.getByText(`${mark} 回复-x24b`).first()).toBeVisible({ timeout: 20_000 });
  await expect(native).toHaveCount(2, { timeout: 10_000 });
  await expect(native.nth(1).getByTestId('peer-message-from')).toHaveText('来自另一个会话');
  await expect(native.nth(1)).toContainText('（内容未能解析）');

  for (const k of ['x24c', 'x24d']) {
    await sendPrompt(page, `${mark} ${k} R151S:${k}`);
    await expect(page.getByText(`${mark} 回复-${k}`).first()).toBeVisible({ timeout: 20_000 });
  }
  await page.waitForTimeout(1_000);
  await expect(native, 'hostInjected / senderTaskId 的不补气泡').toHaveCount(2);
  expect(await page.getByTestId('peer-message').count(), '一共只有两个来源气泡').toBe(2);
});

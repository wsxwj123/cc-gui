// r151e 行为清单 F(15)与"对外行为变化"第 7 点:添加项目(PUT /api/settings {_addProject:"<绝对路径>"})时把它移出隐藏列表。
// 15(相邻回归):偏好文件正常 → 隐藏列表里没有 X 了,其它偏好(会话的自定义标题、跨会话总开关等)不变。
// 15b(对外行为变化第 7 点第二句,行为清单没有单列):偏好文件读不出时这一步跳过,添加项目本身照常成功,偏好文件不被改写。
// 隐藏列表里存的是项目列表 GET /api/projects 各项的 hash。项目 X = 一个落了会话记录的工作目录。
// 每条用例一个一次性实例;用例结束无论成败都把偏好文件权限改回原值。
import { test, expect } from '@playwright/test';
import { seedSession, uniq, newSid } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceP2 } from '../r151c-xsession-p2/helpers/p2.mjs';
import { setHidden, prefsBytes, prefsJson, makePrefsUnreadable, projectHashOf, sleep } from './helpers/e.mjs';

test.describe.configure({ timeout: 120_000 });

/** 偏好里有某会话的自定义标题、跨会话总开关开着、隐藏列表 = [X 的 hash]。返回 { inst, X, xHash }。 */
async function stage(tag) {
  const sid = newSid();
  const inst = await startInstanceP2(tag, { prefs: { customTitles: { [sid]: 'R151E 自定义标题' } } });
  await xs(inst.c, inst.home).on();
  const X = seedSession(`${tag}-x-${uniq('')}`, { home: inst.home });
  const xHash = await projectHashOf(inst.c, X.cwd);
  const h = await setHidden(inst.c, [xHash]);
  expect([h.status, h.body], `前置:把 X 放进隐藏列表(${h.text.slice(0, 200)})`).toEqual([200, { ok: true, hidden: [xHash] }]);
  const p = prefsJson(inst.home);
  expect({ hidden: p && p.hiddenProjects, titles: p && p.customTitles }, '前置:偏好文件里隐藏列表有 X,另有会话的自定义标题')
    .toEqual({ hidden: [xHash], titles: { [sid]: 'R151E 自定义标题' } });
  return { inst, X, xHash };
}

test('E15 添加项目时移出隐藏列表(相邻回归):隐藏列表里有项目 X、另有会话的自定义标题 → PUT /api/settings {_addProject:X} 成功;之后隐藏列表里没有 X,其它偏好不变', async () => {
  const { inst, X, xHash } = await stage('e15');
  try {
    const before = prefsJson(inst.home);
    const r = await inst.c.put('/api/settings', { _addProject: X.cwd });
    expect(r.status, `添加项目成功(应答原文:${r.text.slice(0, 200)})`).toBe(200);
    let g = null;
    await waitFor(async () => { g = await inst.c.get('/api/prefs/hidden-projects'); return g.body && Array.isArray(g.body.hidden) && !g.body.hidden.includes(xHash); }, 5_000, 200);
    const after = prefsJson(inst.home) || {};
    const others = (o) => Object.fromEntries(Object.keys(before).filter((k) => k !== 'hiddenProjects').map((k) => [k, o[k]]));
    expect({ apiHidesX: Boolean(g && g.body && Array.isArray(g.body.hidden) && g.body.hidden.includes(xHash)), fileHidesX: (after.hiddenProjects || []).includes(xHash), others: others(after) },
      `之后 GET 隐藏列表:${g && g.text.slice(0, 200)}`)
      .toEqual({ apiHidesX: false, fileHidesX: false, others: others(before) });
  } finally {
    await inst.stop();
  }
});

test('E15b 偏好文件读不出时添加项目:移出隐藏列表这一步跳过,PUT /api/settings {_addProject:X} 照常成功(200);恢复可读后偏好文件逐字节不变', async () => {
  const { inst, X } = await stage('e15b');
  let restore = null;
  try {
    const before = prefsBytes(inst.home);
    restore = makePrefsUnreadable(inst.home);
    const r = await inst.c.put('/api/settings', { _addProject: X.cwd });
    await sleep(1_500);
    restore();
    await sleep(1_500);
    const after = prefsBytes(inst.home);
    expect(r.status, `添加项目本身照常成功(应答原文:${r.text.slice(0, 200)})`).toBe(200);
    expect(after.toString('utf8'), '恢复可读后偏好文件逐字节不变(移出隐藏列表这一步跳过,不以空白内容覆盖)').toBe(before.toString('utf8'));
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});

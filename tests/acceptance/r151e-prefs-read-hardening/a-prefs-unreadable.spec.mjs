// r151e 行为清单 A(1–6):偏好文件读不出时,修改偏好的操作都不写文件(回已有的写失败响应,文件逐字节不变);
// 文件不存在照旧新建;内容正常时只改该改的键;内容坏了(不是合法 JSON 对象)时先原样备份成 prefs.json.corrupt*,再从空白写入。
// 每条用例一个一次性实例(要改偏好文件的权限 / 内容,不碰别的用例)。"读不出" = 偏好文件权限 000、所在目录仍可写;
// 用例结束无论成败都把权限改回原值。读不出期间的操作做完后先等一会儿再恢复可读,恢复后再等一会儿才读文件:
// 既不让异步写入在恢复之后才落盘而漏判,也能抓住"恢复可读之后才补写"。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, newSid, makeWorkspace, encodeProjectDir, prefsPath, guiDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { startInstanceP2 } from '../r151c-xsession-p2/helpers/p2.mjs';
import { setHidden, prefsBytes, prefsJson, makePrefsUnreadable, sleep } from './helpers/e.mjs';

test.describe.configure({ timeout: 120_000 });

/** 起一次性实例:偏好文件里已有隐藏列表 ["p1"](经偏好接口写入)、跨会话总开关开着。prefs = 起服务前另外写进偏好文件的内容。 */
async function startWithP1AndXsOn(tag, prefs = {}) {
  const inst = await startInstanceP2(tag, { prefs });
  const r = await setHidden(inst.c, ['p1']);
  expect([r.status, r.body], `前置:PUT /api/prefs/hidden-projects {hidden:["p1"]}(${r.text.slice(0, 200)})`).toEqual([200, { ok: true, hidden: ['p1'] }]);
  await xs(inst.c, inst.home).on();
  const p = prefsJson(inst.home);
  expect(p && p.hiddenProjects, '前置:偏好文件里的隐藏列表是 ["p1"]').toEqual(['p1']);
  return inst;
}
const errorText = (r) => Boolean(r.body && typeof r.body.error === 'string' && r.body.error.length > 0);

test('E01 偏好文件读不出时改隐藏项目:PUT /api/prefs/hidden-projects {hidden:["p2"]} → 500 {error};恢复可读后偏好文件与设为读不出之前逐字节相同', async () => {
  const inst = await startWithP1AndXsOn('e01');
  let restore = null;
  try {
    const before = prefsBytes(inst.home);
    restore = makePrefsUnreadable(inst.home);
    const r = await setHidden(inst.c, ['p2']);
    await sleep(1_500);
    restore();
    await sleep(1_500);
    const after = prefsBytes(inst.home);
    expect({ status: r.status, hasErrorText: errorText(r) }, `写偏好失败应回 500 {error}(应答原文:${r.text.slice(0, 200)})`)
      .toEqual({ status: 500, hasErrorText: true });
    expect(after.toString('utf8'), '恢复可读后偏好文件与设为读不出之前逐字节相同(不得以空白内容整份覆盖)').toBe(before.toString('utf8'));
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});

test('E02 偏好文件读不出时关跨会话总开关:PUT /api/xsession/config {enabled:false} → 500 code:"STORAGE_WRITE_FAILED";恢复可读后偏好文件逐字节不变,GET /api/xsession/config 的 enabled 仍为 true', async () => {
  const inst = await startWithP1AndXsOn('e02');
  let restore = null;
  try {
    const before = prefsBytes(inst.home);
    restore = makePrefsUnreadable(inst.home);
    const r = await inst.c.put('/api/xsession/config', { enabled: false });
    await sleep(1_500);
    restore();
    await sleep(1_500);
    const after = prefsBytes(inst.home);
    const cfg = await inst.c.get('/api/xsession/config');
    expect({ status: r.status, code: r.body && r.body.code }, `应答原文:${r.text.slice(0, 200)}`).toEqual({ status: 500, code: 'STORAGE_WRITE_FAILED' });
    expect(after.toString('utf8'), '恢复可读后偏好文件逐字节不变').toBe(before.toString('utf8'));
    expect([cfg.status, cfg.body && cfg.body.enabled], `恢复可读后 GET /api/xsession/config(${cfg.text.slice(0, 200)})`).toEqual([200, true]);
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});

test('E03 偏好文件读不出时删会话:偏好里有会话 S 的自定义标题 → DELETE /api/sessions/:S 的返回与偏好可读时删同类会话的返回一致;恢复可读后偏好文件逐字节不变', async () => {
  const sid0 = newSid(); const sid1 = newSid();
  const titles = { [sid0]: 'R151E 自定义标题零', [sid1]: 'R151E 自定义标题一' };
  const inst = await startInstanceP2('e03', { prefs: { customTitles: titles, hiddenProjects: ['p1'] } });
  let restore = null;
  try {
    await xs(inst.c, inst.home).on();
    const cwd = makeWorkspace(`e03-${uniq('')}`);
    const S0 = seedSession('e03-s0', { home: inst.home, sid: sid0, cwd });
    const S = seedSession('e03-s', { home: inst.home, sid: sid1, cwd });
    const del = (s) => inst.c.call('DELETE', `/api/sessions/${s.sid}?projectHash=${encodeURIComponent(encodeProjectDir(s.cwd))}`);
    // 返回里出现的会话 id 换成占位符,两次删除的返回才能逐项比较
    const norm = (r, sid) => ({ status: r.status, body: r.body === null ? r.text.split(sid).join('<SID>') : JSON.parse(JSON.stringify(r.body).split(sid).join('<SID>')) });

    // 对照:偏好文件可读时删 S0 —— 也用来确认"删会话会把该会话的自定义标题从偏好文件里一并清掉"(这条用例的前提)
    const base = norm(await del(S0), S0.sid);
    let t = null;
    await waitFor(() => { const p = prefsJson(inst.home); t = (p && p.customTitles) || null; return t && !(S0.sid in t); }, 5_000, 200);
    expect({ fileGone: !fs.existsSync(S0.file), s0TitleGone: Boolean(t) && !(S0.sid in t), sTitle: t && t[S.sid] },
      `前置:偏好可读时删会话 = 记录文件删掉,偏好里它的自定义标题一并清掉,别的会话的标题不动(对照删除的返回:${JSON.stringify(base).slice(0, 200)})`)
      .toEqual({ fileGone: true, s0TitleGone: true, sTitle: titles[S.sid] });

    const before = prefsBytes(inst.home);
    restore = makePrefsUnreadable(inst.home);
    const got = norm(await del(S), S.sid);
    await sleep(2_000);
    restore();
    await sleep(1_500);
    const after = prefsBytes(inst.home);
    expect(got, '偏好文件读不出时删会话 S,删除接口的返回与偏好可读时删 S0 的返回一致').toEqual(base);
    expect(after.toString('utf8'), '恢复可读后偏好文件逐字节不变').toBe(before.toString('utf8'));
  } finally {
    if (restore) restore();
    await inst.stop();
  }
});

test('E04 偏好文件不存在时改隐藏项目(相邻回归):PUT {hidden:["p2"]} → 200 {ok:true, hidden:["p2"]};之后 GET 得到 ["p2"];偏好文件被新建', async () => {
  const inst = await startInstanceP2('e04');
  try {
    fs.unlinkSync(prefsPath(inst.home));
    expect(fs.existsSync(prefsPath(inst.home)), '前置:偏好文件已不存在').toBe(false);
    const r = await setHidden(inst.c, ['p2']);
    const g = await inst.c.get('/api/prefs/hidden-projects');
    expect({ put: [r.status, r.body], get: [g.status, g.body && g.body.hidden], created: fs.existsSync(prefsPath(inst.home)) },
      `PUT 应答:${r.text.slice(0, 200)};GET 应答:${g.text.slice(0, 200)}`)
      .toEqual({ put: [200, { ok: true, hidden: ['p2'] }], get: [200, ['p2']], created: true });
  } finally {
    await inst.stop();
  }
});

test('E05 偏好文件正常时改隐藏项目(相邻回归):PUT {hidden:["p2"]} → 200;隐藏列表变成 ["p2"],偏好文件里的其它内容(跨会话总开关、会话的自定义标题等)不变', async () => {
  const sid = newSid();
  const inst = await startWithP1AndXsOn('e05', { customTitles: { [sid]: 'R151E 自定义标题' } });
  try {
    const before = prefsJson(inst.home);
    expect(before && before.customTitles, '前置:偏好文件里有会话的自定义标题').toEqual({ [sid]: 'R151E 自定义标题' });
    const r = await setHidden(inst.c, ['p2']);
    const after = prefsJson(inst.home);
    const rest = (o) => { const { hiddenProjects, ...x } = o || {}; return x; };
    expect([r.status, r.body], `应答原文:${r.text.slice(0, 200)}`).toEqual([200, { ok: true, hidden: ['p2'] }]);
    expect({ hidden: after && after.hiddenProjects, others: rest(after) }, '隐藏列表换成 ["p2"],其它键原样保留')
      .toEqual({ hidden: ['p2'], others: rest(before) });
  } finally {
    await inst.stop();
  }
});

test('E06 偏好文件内容是截断的 JSON:PUT {hidden:["p2"]} → 200;之后偏好文件是合法 JSON、隐藏列表 ["p2"];同目录多出一个 prefs.json.corrupt 开头的备份,内容与坏内容逐字节相同', async () => {
  const inst = await startInstanceP2('e06');
  try {
    const BAD = '{"hiddenProjects": [';
    const dir = guiDir(inst.home);
    const backups = () => fs.readdirSync(dir).filter((n) => n.startsWith('prefs.json.corrupt')).sort();
    expect(backups(), '前置:还没有备份文件').toEqual([]);
    fs.writeFileSync(prefsPath(inst.home), BAD);
    const r = await setHidden(inst.c, ['p2']);
    const text = fs.readFileSync(prefsPath(inst.home), 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const found = backups();
    expect(r.status, `写入照常成功(应答原文:${r.text.slice(0, 200)})`).toBe(200);
    expect({ jsonObject: Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed), hidden: parsed && parsed.hiddenProjects },
      `之后的偏好文件内容:${text.slice(0, 200)}`).toEqual({ jsonObject: true, hidden: ['p2'] });
    expect({ count: found.length, content: found.length === 1 ? fs.readFileSync(path.join(dir, found[0]), 'utf8') : null },
      `同目录的备份文件:${JSON.stringify(found)}`).toEqual({ count: 1, content: BAD });
  } finally {
    await inst.stop();
  }
});

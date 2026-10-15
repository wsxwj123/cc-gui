// 二期行为清单 1、2、3、5、6:开关关时的工具表与参数、GET/PUT config 的二期字段、接收设置接口、档案随回合建立与随删除清除。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedSession, uniq, newSid, prefsPath, guiDir, claudeDir, xsDir, makeWorkspace, realCliPath, encodeProjectDir } from '../r151b-xsession-p1/helpers/fixtures.mjs';
import { xs, shared, expectError, chat, readText, readJson, spawnRecords, waitFor } from '../r151b-xsession-p1/helpers/api.mjs';
import { SM, LS, laneReq, aiCalls, setInbound, entry, profileTurn, wsT, startInstanceP2 } from './helpers/p2.mjs';

test.describe.configure({ timeout: 300_000 });
const DISABLED_TEXT = '跨会话消息未开启';
const cfgOf = (enabled, used = 0) => ({
  enabled, autoPaused: false,
  limits: { chainDepth: 4, targetsPerSend: 8, sendsPerTurn: 16, bodyBytes: 32768, pendingPerSession: 50 },
  autoBudget: { limit: 20, windowMs: 600000, used },
  nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 },
});
/** 让偏好目录写不进去(目录只读 + prefs.json 只读);返回恢复函数。 */
function lockPrefs(home) {
  const d = guiDir(home); const f = prefsPath(home);
  fs.chmodSync(f, 0o444); fs.chmodSync(d, 0o555);
  return () => { fs.chmodSync(d, 0o755); fs.chmodSync(f, 0o644); };
}

test('P01 总开关关:会话工具表里没有 mcp__ccgui-sessions__*;起会话的参数里没有本功能;PUT …/inbound → 409 XS_DISABLED(打开后,同一会话下一条消息的工具表里才有这两个工具)', async () => {
  const api = xs();
  await api.off();
  const s = seedSession(`p01-${uniq('')}`);
  expectError(await setInbound(shared, s.sid, 'auto'), 409, 'XS_DISABLED', DISABLED_TEXT, '开关关时改接收设置');

  const f = seedSession(`p01-f-${uniq('')}`);
  const n0 = spawnRecords().length;
  const r = await chat({ sessionId: f.sid, cwd: f.cwd, prompt: 'R151C p01 普通回合 R151EXIT' });
  expect(r.status, `普通回合 200(${r.text.slice(0, 200)})`).toBe(200);
  const sp = await waitFor(() => spawnRecords().slice(n0).find((x) => x.interactive && x.cwd === f.cwd), 15_000);
  expect(sp, '前置:起了 CLI 进程').toBeTruthy();
  expect(JSON.stringify(sp.argv), '开关关时起会话的参数里没有本功能的工具服务').not.toContain('ccgui-sessions');

  test.skip(!realCliPath(), '本机没有真 claude CLI,工具表部分无法观测');
  const cwd = makeWorkspace(`real-p01-${uniq('')}`);
  const names = (from) => laneReq('real').slice(from).filter((q) => q.kind === 'main').flatMap((q) => q.toolNames);
  let k = laneReq('real').length;
  const t1 = await aiCalls(shared, { cwd, mode: 'default', steps: [] });
  expect(names(k).length, '前置:关时这一回合有带工具表的模型请求').toBeGreaterThan(0);
  expect(names(k).filter((n) => n.startsWith('mcp__ccgui-sessions__')), '开关关:工具表里没有 mcp__ccgui-sessions__*').toEqual([]);
  await api.on();
  try {
    k = laneReq('real').length;
    await aiCalls(shared, { cwd, sid: t1.sid, mode: 'default', steps: [] });
    const on = names(k);
    expect(on.includes(SM) && on.includes(LS), `开关开后同一会话下一条消息:工具表里有 ${SM} 与 ${LS}(实际含 ccgui 的:${JSON.stringify(on.filter((n) => n.includes('ccgui')))})`).toBe(true);
  } finally { await api.off(); }
});

test('P02 GET config:一期字段之外多 autoPaused、autoBudget{limit:20,windowMs:600000,used}、limits.chainDepth/targetsPerSend/sendsPerTurn(4/8/16);偏好里 xsAutoPaused 非布尔按 false、不改写文件', async () => {
  const inst = await startInstanceP2('p02');
  try {
    const off = await inst.c.get('/api/xsession/config');
    expect(off.status).toBe(200);
    expect(off.body, '开关关时的 config').toEqual(cfgOf(false));
    expect((await inst.c.put('/api/xsession/config', { enabled: true })).status, '前置:打开开关').toBe(200);
    expect((await inst.c.get('/api/xsession/config')).body, '开关开时的 config').toEqual(cfgOf(true));
    const p = JSON.parse(readText(prefsPath(inst.home)));
    fs.writeFileSync(prefsPath(inst.home), JSON.stringify({ ...p, xsAutoPaused: 'yes' }, null, 2));
    await inst.restart();
    const before = readText(prefsPath(inst.home));
    const r = await inst.c.get('/api/xsession/config');
    expect(r.status).toBe(200);
    expect(r.body.autoPaused, 'xsAutoPaused 是非布尔手写值 → 按 false').toBe(false);
    expect(readText(prefsPath(inst.home)), '读到非法值不改写偏好文件').toBe(before);
  } finally { await inst.stop(); }
});

test('P03 PUT config {autoPaused:false} → 200 {ok,enabled,autoPaused:false} 并广播 xs:config;非法请求体 → 400 XS_INVALID_INPUT 文件不变不广播;写盘失败 → 500 STORAGE_WRITE_FAILED 状态不变', async () => {
  const inst = await startInstanceP2('p03');
  const ws = await wsT(inst.base);
  let unlock = null;
  try {
    const c = inst.c;
    expect((await c.put('/api/xsession/config', { autoPaused: false })).body, '开关关、本来没暂停 → 200').toEqual({ ok: true, enabled: false, autoPaused: false });
    expect((await c.put('/api/xsession/config', { enabled: true })).status, '前置:打开开关').toBe(200);
    const n0 = ws.msgs.length;
    const r = await c.put('/api/xsession/config', { autoPaused: false });
    expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
    expect(r.body).toEqual({ ok: true, enabled: true, autoPaused: false });
    const ev = await ws.waitFor((m) => ws.msgs.indexOf(m) >= n0 && m.type === 'xs:config');
    expect(ev && { enabled: ev.enabled, autoPaused: ev.autoPaused }, '广播 xs:config {enabled:true, autoPaused:false}').toEqual({ enabled: true, autoPaused: false });
    const both = await c.put('/api/xsession/config', { enabled: true, autoPaused: false });
    expect([both.status, both.body], '两个键同时给').toEqual([200, { ok: true, enabled: true, autoPaused: false }]);

    const before = readText(prefsPath(inst.home));
    const n1 = ws.msgs.length;
    for (const [label, body] of [
      ['数组', '[]'], ['字符串', '"x"'], ['null', 'null'], ['空对象', {}], ['未知键', { autoPaused: false, foo: 1 }], ['chainLimit', { enabled: true, chainLimit: 4 }],
      ['autoPaused:true', { autoPaused: true }], ['enabled + autoPaused:true', { enabled: true, autoPaused: true }],
      ['autoPaused 是字符串', { autoPaused: 'false' }], ['autoPaused 是 null', { autoPaused: null }], ['autoPaused 是 0', { autoPaused: 0 }], ['enabled 非布尔', { enabled: 'true' }],
    ]) {
      expectError(await c.put('/api/xsession/config', body), 400, 'XS_INVALID_INPUT', undefined, label);
      expect(readText(prefsPath(inst.home)), `${label}:偏好文件不变`).toBe(before);
    }
    await new Promise((res) => setTimeout(res, 500));
    expect(ws.msgs.slice(n1).filter((m) => m.type === 'xs:config'), '非法请求不广播').toEqual([]);

    unlock = lockPrefs(inst.home);
    const n2 = ws.msgs.length;
    const w = await c.put('/api/xsession/config', { enabled: false });
    expectError(w, 500, 'STORAGE_WRITE_FAILED', undefined, '写偏好失败');
    unlock(); unlock = null;
    const after = await c.get('/api/xsession/config');
    expect([after.body.enabled, after.body.autoPaused], '写盘失败后 enabled / autoPaused 不变').toEqual([true, false]);
    await new Promise((res) => setTimeout(res, 500));
    expect(ws.msgs.slice(n2).filter((m) => m.type === 'xs:config'), '写盘失败不广播').toEqual([]);
  } finally { if (unlock) unlock(); ws.close(); await inst.stop(); }
});

test('P05 PUT …/sessions/:id/inbound {mode} → 200 {ok,sessionId,mode} 并广播 xs:inbound,会话列表 inbound 随之变化(auto 写键、card 删键);400 → 404 → 500 XS_LIST_FAILED / STORAGE_WRITE_FAILED 按序,设置不变不广播', async () => {
  const inst = await startInstanceP2('p05');
  const ws = await wsT(inst.base);
  const projects = path.join(claudeDir(inst.home), 'projects');
  let unlock = null;
  try {
    const c = inst.c;
    const B = seedSession(`p05-b-${uniq('')}`, { home: inst.home });
    expect((await c.put('/api/xsession/config', { enabled: true })).status, '前置:打开开关').toBe(200);
    expect((await entry(c, B.sid)).inbound, '默认 card').toBe('card');
    const r = await setInbound(c, B.sid, 'auto');
    expect([r.status, r.body], `改成 auto(${r.text.slice(0, 200)})`).toEqual([200, { ok: true, sessionId: B.sid, mode: 'auto' }]);
    const ev = await ws.waitFor((m) => m.type === 'xs:inbound' && m.sessionId === B.sid);
    expect(ev && ev.mode, '广播 xs:inbound {sessionId, mode:"auto"}').toBe('auto');
    expect((await entry(c, B.sid)).inbound, '会话列表随之变成 auto').toBe('auto');
    expect((readJson(prefsPath(inst.home)).xsInbound || {})[B.sid], 'auto 写进 xsInbound').toBe('auto');
    const r2 = await setInbound(c, B.sid, 'card');
    expect([r2.status, r2.body]).toEqual([200, { ok: true, sessionId: B.sid, mode: 'card' }]);
    expect((await entry(c, B.sid)).inbound).toBe('card');
    expect(Object.keys(readJson(prefsPath(inst.home)).xsInbound || {}), 'card 删键').not.toContain(B.sid);

    const n0 = ws.msgs.length;
    const ghost = newSid();
    expectError(await c.put('/api/xsession/sessions/not-a-session-id/inbound', { mode: 'auto' }), 400, 'XS_INVALID_INPUT', undefined, 'id 形状不对');
    expectError(await setInbound(c, B.sid, 'manual'), 400, 'XS_INVALID_INPUT', undefined, 'mode 非法');
    expectError(await c.put(`/api/xsession/sessions/${B.sid}/inbound`, {}), 400, 'XS_INVALID_INPUT', undefined, '缺 mode');
    expectError(await setInbound(c, ghost, 'bad'), 400, 'XS_INVALID_INPUT', undefined, 'mode 非法 + 会话不存在 → 先判 400');
    expectError(await setInbound(c, ghost, 'auto'), 404, 'XS_TARGET_NOT_FOUND', undefined, '会话不存在');
    fs.chmodSync(projects, 0o000);
    try {
      expectError(await setInbound(c, B.sid, 'auto'), 500, 'XS_LIST_FAILED', undefined, '读会话列表失败');
    } finally { fs.chmodSync(projects, 0o755); }
    unlock = lockPrefs(inst.home);
    expectError(await setInbound(c, B.sid, 'auto'), 500, 'STORAGE_WRITE_FAILED', undefined, '写偏好失败');
    unlock(); unlock = null;
    expect((await entry(c, B.sid)).inbound, '失败后设置不变').toBe('card');
    await new Promise((res) => setTimeout(res, 500));
    expect(ws.msgs.slice(n0).filter((m) => m.type === 'xs:inbound'), '失败不广播').toEqual([]);
  } finally { if (unlock) unlock(); try { fs.chmodSync(projects, 0o755); } catch { /* */ } ws.close(); await inst.stop(); }
});

test('P06 会话开始过一个回合后 → 会话列表 hasProfile:true;会话删除后其接收设置与档案一并清除', async () => {
  const inst = await startInstanceP2('p06');
  try {
    const c = inst.c;
    expect((await c.put('/api/xsession/config', { enabled: true })).status, '前置:打开开关').toBe(200);
    const B = seedSession(`p06-b-${uniq('')}`, { home: inst.home });
    expect((await entry(c, B.sid)).hasProfile, '还没开始过回合 → false').toBe(false);
    await profileTurn(c, B);
    await expect.poll(async () => (await entry(c, B.sid) || {}).hasProfile, { timeout: 10_000, message: '开始过一个回合 → true' }).toBe(true);
    expect((await setInbound(c, B.sid, 'auto')).status, '前置:设为自动处理').toBe(200);

    const del = await c.call('DELETE', `/api/sessions/${B.sid}?projectHash=${encodeURIComponent(encodeProjectDir(B.cwd))}`);
    expect(del.status, `前置:删除会话(${del.text.slice(0, 200)})`).toBeLessThan(300);
    await new Promise((res) => setTimeout(res, 800));
    expect(Object.keys(readJson(prefsPath(inst.home)).xsInbound || {}), '接收设置已清除').not.toContain(B.sid);
    expect(String(readText(path.join(xsDir(inst.home), 'profiles.json')) || ''), '档案已清除').not.toContain(B.sid);
    seedSession(`p06-b2-${uniq('')}`, { home: inst.home, sid: B.sid, cwd: B.cwd });
    const again = await entry(c, B.sid);
    expect.soft(again && { inbound: again.inbound, hasProfile: again.hasProfile }, '同一 id 重新落盘后是全新的接收设置与档案').toEqual({ inbound: 'card', hasProfile: false });
  } finally { await inst.stop(); }
});

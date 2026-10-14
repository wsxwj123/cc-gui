// D 组:服务端对 auto 的门控(INTERFACE Y.3.1 末)—— POST /api/chat 降级、POST /api/chat/permission-mode 拒绝。
// 会话进程是挂在 PATH 上的假 claude:它记下自己被拉起时的 --permission-mode,以及宿主发来的每个控制请求。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  post, expectError, startTurn, readStream, waitSpawn, controlRecords, useProvider, useOfficial, tpAutoOn, tpAutoOff,
  resetOverrides, stripRunKeys, snapshot, SETTINGS,
} from './helpers/api.mjs';
import { ERR, DOWNGRADE } from './helpers/texts.mjs';
import { provider } from './helpers/scenes.mjs';

const PM = '/api/chat/permission-mode';
let n = 0;
const ws = (tag) => `d-${tag}-${Date.now().toString(36)}-${(n += 1)}`;

let saved = {};
test.beforeEach(async () => {
  saved = snapshot([SETTINGS()]);
  await tpAutoOff();
  resetOverrides({});
});
// 收尾:切 provider 会改写 CLI 设置(settings.json),还原成用例开始前的样子,别把本组的场景留给后面的组
test.afterEach(async () => { for (const [p, c] of Object.entries(saved)) if (c !== null) fs.writeFileSync(p, c); });

async function thirdParty() { const id = await provider('main'); await useProvider(id); return id; }

test.describe('D POST /api/chat 的 auto 门控', () => {
  test('D1 第三方 + 开关关 + permissionMode:"auto" → 不报错(200),应答多出 permissionModeDowngraded', async () => {
    await thirdParty();
    const { res } = await startTurn(ws('d1'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.permissionModeDowngraded).toEqual(DOWNGRADE);
  });

  test('D1b 第三方 + 开关关 + auto → 会话进程按 --permission-mode default 起(不是 auto)', async () => {
    await thirdParty();
    const { res, cwd } = await startTurn(ws('d1b'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    const rec = await waitSpawn(cwd);
    expect(rec, '应起了会话进程').not.toBeNull();
    expect(rec.mode).toBe('default');
  });

  test('D1c 第三方 + 开关关 + auto → 该回合事件流里有一条带 reason 的 mode_mismatch', async () => {
    await thirdParty();
    const { res } = await startTurn(ws('d1c'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    const evs = await readStream(res.body.pid);
    const mm = evs.filter((e) => e.type === 'system' && e.subtype === 'mode_mismatch' && e.reason === DOWNGRADE.reason).map(stripRunKeys);
    expect(mm, `事件流:${JSON.stringify(evs.map((e) => `${e.type}/${e.subtype || ''}`))}`).toEqual([{ type: 'system', subtype: 'mode_mismatch', ...DOWNGRADE }]);
  });

  test('D1d 降级应答保留原有字段(ok、pid、runId、status)', async () => {
    await thirdParty();
    const { res } = await startTurn(ws('d1d'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    for (const k of ['ok', 'pid', 'runId', 'status']) expect(res.body, `应答应有 ${k}`).toHaveProperty(k);
  });

  test('D2 第三方 + 开关开 + auto → 应答里没有 permissionModeDowngraded 键,会话进程按 auto 起', async () => {
    await thirdParty();
    await tpAutoOn();
    const { res, cwd } = await startTurn(ws('d2'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    expect(res.body).not.toHaveProperty('permissionModeDowngraded');
    expect((await waitSpawn(cwd)).mode).toBe('auto');
  });

  test('D2b 第三方 + 开关开 + auto → 事件流里没有 reason 为 third-party-auto-disabled 的 mode_mismatch', async () => {
    await thirdParty();
    await tpAutoOn();
    const { res } = await startTurn(ws('d2b'), { permissionMode: 'auto' });
    const evs = await readStream(res.body.pid);
    expect(evs.filter((e) => e.subtype === 'mode_mismatch' && e.reason === DOWNGRADE.reason)).toEqual([]);
  });

  test('D3 官方 + 开关关 + auto → 与改动前相同:不降级、没有 permissionModeDowngraded 键、进程按 auto 起', async () => {
    await useOfficial();
    const { res, cwd } = await startTurn(ws('d3'), { permissionMode: 'auto' });
    expect(res.status, res.text).toBe(200);
    expect(res.body).not.toHaveProperty('permissionModeDowngraded');
    expect((await waitSpawn(cwd)).mode).toBe('auto');
  });

  // 改动前(2026-10-14 在未改动的工作树上实测)GUI 起进程时用的 --permission-mode:接受编辑由 GUI 自己实现,进程按 default 起。
  const SPAWN_MODE_BEFORE = { default: 'default', acceptEdits: 'default', plan: 'plan' };
  for (const mode of Object.keys(SPAWN_MODE_BEFORE)) {
    test(`D4 第三方 + 开关关 + permissionMode:"${mode}" → 不受门控:没有 permissionModeDowngraded 键,进程启动档位与改动前相同`, async () => {
      await thirdParty();
      const { res, cwd } = await startTurn(ws(`d4-${mode}`), { permissionMode: mode });
      expect(res.status, res.text).toBe(200);
      expect(res.body).not.toHaveProperty('permissionModeDowngraded');
      expect((await waitSpawn(cwd)).mode).toBe(SPAWN_MODE_BEFORE[mode]);
    });
  }

  test('D9 既有的 mode_mismatch(请求 plan、CLI 报 default)没有 reason 键(与改动前相同)', async () => {
    await thirdParty();
    const { res } = await startTurn(ws('d9'), { permissionMode: 'plan', prompt: 'R151 D9 R151INIT:default' });
    expect(res.status, res.text).toBe(200);
    const evs = await readStream(res.body.pid);
    const mm = evs.filter((e) => e.type === 'system' && e.subtype === 'mode_mismatch');
    expect(mm.length, '前置:应出现既有的 mode_mismatch').toBeGreaterThan(0);
    for (const e of mm) expect(e).not.toHaveProperty('reason');
  });
});

test.describe('D POST /api/chat/permission-mode 的 auto 门控', () => {
  /** 起一个常驻会话进程,等回合结束,返回 { sid, pid(进程号) }。 */
  async function liveSession(tag) {
    const { res, cwd } = await startTurn(ws(tag), { permissionMode: 'default', keepAlive: true });
    expect(res.status, res.text).toBe(200);
    await readStream(res.body.pid);
    const rec = await waitSpawn(cwd);
    expect(rec, '前置:会话进程应已起来').not.toBeNull();
    return { sid: rec.sid, osPid: rec.pid };
  }
  const setModeCalls = (osPid) => controlRecords().filter((c) => c.pid === osPid && c.request && c.request.subtype === 'set_permission_mode');

  test('D5 第三方 + 开关关 + mode:"auto" → 409 THIRD_PARTY_AUTO_DISABLED「第三方 provider 的「自动」档未开启」', async () => {
    await thirdParty();
    const { sid } = await liveSession('d5');
    const r = await post(PM, { sessionId: sid, mode: 'auto' });
    expectError(r, ERR.TP_AUTO_DISABLED);
  });

  test('D5b 第三方 + 开关关 + mode:"auto" 被拒后,会话进程没有收到任何切档请求', async () => {
    await thirdParty();
    const { sid, osPid } = await liveSession('d5b');
    const before = setModeCalls(osPid).length;
    await post(PM, { sessionId: sid, mode: 'auto' });
    await new Promise((r) => setTimeout(r, 800));
    expect(setModeCalls(osPid).length).toBe(before);
  });

  test('D6 第三方 + 开关开 + mode:"auto" → 照常切档(200),会话进程收到 set_permission_mode auto', async () => {
    await thirdParty();
    await tpAutoOn();
    const { sid, osPid } = await liveSession('d6');
    const r = await post(PM, { sessionId: sid, mode: 'auto' });
    expect(r.status, r.text).toBe(200);
    await expect.poll(() => setModeCalls(osPid).some((c) => c.request.mode === 'auto'), { timeout: 5_000 }).toBe(true);
  });

  test('D7 官方 + 开关关 + mode:"auto" → 与改动前相同:200,会话进程收到 set_permission_mode auto', async () => {
    await useOfficial();
    const { sid, osPid } = await liveSession('d7');
    const r = await post(PM, { sessionId: sid, mode: 'auto' });
    expect(r.status, r.text).toBe(200);
    await expect.poll(() => setModeCalls(osPid).some((c) => c.request.mode === 'auto'), { timeout: 5_000 }).toBe(true);
  });

  test('D8 第三方 + 开关关 + mode:"plan" → 不受门控(200)', async () => {
    await thirdParty();
    const { sid } = await liveSession('d8');
    const r = await post(PM, { sessionId: sid, mode: 'plan' });
    expect(r.status, r.text).toBe(200);
  });
});

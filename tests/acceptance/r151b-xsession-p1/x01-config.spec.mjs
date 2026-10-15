// 行为清单 1–3:总开关(默认关、PUT 校验、手写非法值)。
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { startInstance } from './helpers/instance.mjs';
import { seedSession, uniq, prefsPath, xsDir, newSid } from './helpers/fixtures.mjs';
import { xs, put, expectError, wsCollector, readText, writeJson, listTree, turnRecords, chat, waitFor } from './helpers/api.mjs';
import { boot, openSessionBySearch } from './helpers/ui.mjs';

const softDisabled = (r, what) => {
  const raw = `(应答原文:${String(r.text).slice(0, 200)})`;
  expect.soft(r.status, `${what}:状态码应 409${raw}`).toBe(409);
  expect.soft(r.body && r.body.ok, `${what}:ok`).toBe(false);
  expect.soft(r.body && r.body.code, `${what}:code`).toBe('XS_DISABLED');
  expect.soft(r.body && r.body.error, `${what}:error 文案`).toBe('跨会话消息未开启');
};

test('X01 总开关关(默认):config 回 enabled:false;其余 /api/xsession/* 回 409 XS_DISABLED;页面没有本功能元素;不产生 xsession 目录下的文件', async ({ page }) => {
  await test.step('页面(共享实例,开关关):助手回复上没有转发按钮,没有卡片区、侧栏计数、转发对话框', async () => {
    await xs().off();
    const mark = uniq('R151BX01U');
    const s = seedSession(`x01-ui-${mark}`, { title: `${mark} 关着的会话` });
    await boot(page);
    await openSessionBySearch(page, mark, s.reply);
    await page.getByText(s.reply).first().hover();
    await page.waitForTimeout(500);
    for (const id of ['xs-forward-btn', 'xs-forward-dialog', 'xs-inbox', 'xs-card', 'xs-unread', 'xs-unread-project', 'xs-paused-banner']) {
      expect.soft(await page.getByTestId(id).count(), `开关关着时不应出现 data-testid="${id}"`).toBe(0);
    }
  });

  const inst = await startInstance('x01');
  try {
    const api = xs(inst.c, inst.home);
    const A = seedSession(`x01-a-${uniq('')}`, { home: inst.home });
    const B = seedSession(`x01-b-${uniq('')}`, { home: inst.home });
    const anyId = newSid();
    await test.step('GET /api/xsession/config → 200,enabled:false;一期字段齐,二期字段不出现', async () => {
      const r = await api.config();
      expect.soft(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
      expect.soft(r.body, 'config 应答体').toEqual({ enabled: false, limits: { bodyBytes: 32768, pendingPerSession: 50 }, nativeGuard: { lastFailureAt: null }, stored: { unfinished: 0 } });
    });
    await test.step('其余接口一律 409 XS_DISABLED', async () => {
      softDisabled(await api.sessions(), 'GET /api/xsession/sessions');
      softDisabled(await api.pending(), 'GET /api/xsession/pending');
      softDisabled(await api.list(B.sid), 'GET /api/xsession/messages');
      softDisabled(await api.post({ to: [B.sid], body: 'R151B x01', fromSessionId: A.sid }), 'POST /api/xsession/messages');
      softDisabled(await api.claim(anyId), 'POST …/claim');
      softDisabled(await api.release(anyId), 'POST …/release');
      softDisabled(await api.dismiss(anyId), 'POST …/dismiss');
    });
    await test.step('跑一个普通回合后,HOME 下 .claude-gui/xsession/ 里没有任何文件', async () => {
      const r = await chat({ cwd: A.cwd, sessionId: A.sid, prompt: 'R151B x01 普通回合 R151EXIT' }, inst.c);
      expect.soft(r.status, `普通回合应 200(${r.text.slice(0, 200)})`).toBe(200);
      await waitFor(() => turnRecords(inst.ctl).some((t) => t.sid === A.sid), 15_000);
      const tree = listTree(xsDir(inst.home));
      expect(tree === null || tree.length === 0, `不应产生文件,实际:${JSON.stringify(tree)}`).toBe(true);
    });
  } finally { await inst.stop(); }
});

test('X02 PUT config {enabled:true} → 200 {ok:true,enabled:true} 并广播 xs:config;非法请求体 → 400 XS_INVALID_INPUT 且偏好文件不变', async () => {
  const api = xs();
  await api.off();
  const ws = await wsCollector();
  try {
    const r = await api.setConfig({ enabled: true });
    expect(r.status, `状态码(${r.text.slice(0, 200)})`).toBe(200);
    expect(r.body, '一期应答没有 autoPaused').toEqual({ ok: true, enabled: true });
    const ev = await ws.waitFor((m) => m && m.type === 'xs:config' && m.enabled === true);
    expect(ev, '应广播 { type:"xs:config", enabled:true }').not.toBeNull();
    expect(ev, '一期广播里没有 autoPaused').not.toHaveProperty('autoPaused');
    expect((await api.config()).body.enabled, '之后 GET config 为 true').toBe(true);

    const before = readText(prefsPath());
    const bad = [
      ['请求体是数组', '[]'], ['请求体是字符串', '"on"'], ['请求体是 null', 'null'], ['空对象(没有能认的键)', {}],
      ['一期带 autoPaused', { enabled: true, autoPaused: false }], ['只有 autoPaused', { autoPaused: false }],
      ['chainLimit', { enabled: true, chainLimit: 3 }], ['未知键', { enabled: false, foo: 1 }],
      ['enabled 是字符串', { enabled: 'true' }], ['enabled 是数字', { enabled: 1 }], ['enabled 是 null', { enabled: null }],
    ];
    for (const [label, body] of bad) {
      const r2 = await api.setConfig(body);
      expectError(r2, 400, 'XS_INVALID_INPUT', undefined, label);
      expect(readText(prefsPath()), `${label}:偏好文件不应变`).toBe(before);
    }
    expect((await api.config()).body.enabled, '非法请求之后开关仍是 true').toBe(true);

    const r3 = await put(`/api/xsession/sessions/${newSid()}/inbound`, { mode: 'auto' });
    expect(r3.status, '【二期】接收设置接口一期不存在 → 404').toBe(404);
    expect(String(r3.body && r3.body.code), '404 不是本节的错误体').not.toMatch(/^XS_/);
  } finally { ws.close(); await api.off(); }
});

test('X03 偏好文件里 xsEnabled 是非布尔手写值 → GET config 按 false 回 200,不报错、不改写文件', async () => {
  const inst = await startInstance('x03', { prefs: { xsEnabled: 'true' } });
  try {
    for (const [label, value] of [['字符串 "true"', 'true'], ['数字 1', 1]]) {
      if (value !== 'true') {
        const p = JSON.parse(readText(prefsPath(inst.home)));
        writeJson(prefsPath(inst.home), { ...p, xsEnabled: value });
        await inst.restart();
      }
      const before = readText(prefsPath(inst.home));
      const api = xs(inst.c, inst.home);
      const r = await api.config();
      expect(r.status, `${label}:状态码(${r.text.slice(0, 200)})`).toBe(200);
      expect(r.body.enabled, `${label}:按 false`).toBe(false);
      expectError(await api.pending(), 409, 'XS_DISABLED', '跨会话消息未开启', `${label}:按关处理`);
      expect(readText(prefsPath(inst.home)), `${label}:偏好文件不应被改写`).toBe(before);
    }
  } finally { await inst.stop(); }
});

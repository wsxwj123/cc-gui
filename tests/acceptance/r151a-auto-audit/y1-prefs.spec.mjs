// A 组:第三方 auto 总开关的偏好接口(INTERFACE Y.3.1 前两个接口 + "写入失败"条)。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  get, put, call, expectError, wsCollector, readJson, readText, writeJson, snapshot, expectUnchanged, withReadOnly, tpAutoOff,
  PREFS, GUI_DIR,
} from './helpers/api.mjs';
import { ERR } from './helpers/texts.mjs';

const P = '/api/prefs/third-party-auto';
let savedPrefs = null;

test.beforeEach(async () => {
  savedPrefs = readText(PREFS());
  await tpAutoOff();
});
test.afterEach(async () => {
  // 还原偏好文件(有的用例会删掉 / 写坏它)
  try { fs.chmodSync(GUI_DIR(), 0o755); } catch { /* */ }
  if (savedPrefs !== null) fs.writeFileSync(PREFS(), savedPrefs);
});

test.describe('A 开关偏好接口 · 读', () => {
  test('A1 偏好文件里没有 thirdPartyAuto 键时,读到 {enabled:false}', async () => {
    const prefs = readJson(PREFS()); delete prefs.thirdPartyAuto; writeJson(PREFS(), prefs);
    const r = await get(P);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  test('A2 偏好文件不存在时,读到 {enabled:false}', async () => {
    fs.rmSync(PREFS());
    const r = await get(P);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  for (const [label, value] of [['字符串 "true"', 'true'], ['数字 1', 1], ['null', null], ['对象 {}', {}]]) {
    test(`A3 偏好文件里的值是${label}(不是布尔)时,读到 {enabled:false}`, async () => {
      const prefs = readJson(PREFS()); prefs.thirdPartyAuto = value; writeJson(PREFS(), prefs);
      const r = await get(P);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ enabled: false });
    });
  }

  test('A4 偏好文件损坏(不是合法 JSON)时,仍回 200 {enabled:false}', async () => {
    fs.writeFileSync(PREFS(), '{"thirdPartyAuto": true,,,  <<损坏>>');
    const r = await get(P);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  test('A4b 读取不改写偏好文件(损坏的文件读完仍是原样)', async () => {
    const broken = '{"thirdPartyAuto": tru';
    fs.writeFileSync(PREFS(), broken);
    await get(P);
    expect(readText(PREFS())).toBe(broken);
  });
});

test.describe('A 开关偏好接口 · 写', () => {
  test('A5 PUT {enabled:true} → 200 {ok:true, enabled:true},随后读到 true', async () => {
    const r = await put(P, { enabled: true });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, enabled: true });
    expect((await get(P)).body).toEqual({ enabled: true });
  });

  test('A5b PUT 落盘:prefs.json 里 thirdPartyAuto === true,且原有的其它偏好键不丢', async () => {
    const before = readJson(PREFS());
    await put(P, { enabled: true });
    const after = readJson(PREFS());
    expect(after.thirdPartyAuto).toBe(true);
    for (const [k, v] of Object.entries(before)) if (k !== 'thirdPartyAuto') expect(after[k], `原有键 ${k}`).toEqual(v);
  });

  test('A6 开着时 PUT {enabled:false} → 200 {ok:true, enabled:false},文件里变成 false', async () => {
    expect((await put(P, { enabled: true })).status).toBe(200);
    const r = await put(P, { enabled: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, enabled: false });
    expect(readJson(PREFS()).thirdPartyAuto).toBe(false);
    expect((await get(P)).body).toEqual({ enabled: false });
  });

  test('A7 PUT 成功后向 WS 客户端广播 {type:"third-party-auto", enabled:true}', async () => {
    const ws = await wsCollector();
    try {
      await put(P, { enabled: true });
      const msg = await ws.waitFor((m) => m.type === 'third-party-auto', 5_000);
      expect(msg, '应收到 third-party-auto 广播').not.toBeNull();
      expect(msg).toEqual({ type: 'third-party-auto', enabled: true });
    } finally { ws.close(); }
  });

  test('A11 幂等:连续两次 PUT {enabled:true} 都回 200 且结果一致', async () => {
    const a = await put(P, { enabled: true });
    const b = await put(P, { enabled: true });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual({ ok: true, enabled: true });
    expect(readJson(PREFS()).thirdPartyAuto).toBe(true);
  });

  test('A12 并发:同时发 10 个 true/false 交替的 PUT,全部 200,最后读到的值与文件一致,文件仍是合法 JSON 且其它键不丢', async () => {
    const before = readJson(PREFS());
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => put(P, { enabled: i % 2 === 0 })));
    expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
    const file = readJson(PREFS());
    expect(file, 'prefs.json 应仍是合法 JSON').not.toBeNull();
    expect(typeof file.thirdPartyAuto).toBe('boolean');
    expect((await get(P)).body).toEqual({ enabled: file.thirdPartyAuto });
    expect(file.releaseNotesSeen).toBe(before.releaseNotesSeen);
  });
});

test.describe('A 开关偏好接口 · 非法输入(400 INVALID_INPUT,不写文件、不广播)', () => {
  // 顶层 JSON 原始值(字符串、布尔)由既有的全局 JSON 解析层在进入路由前拒绝(INTERFACE 第 9 行):只断言 400,应答体不在约定内
  for (const [label, raw] of [['请求体是 JSON 字符串 "true"', '"true"'], ['请求体是 JSON 布尔 true', 'true']]) {
    test(`A8p ${label}(顶层原始值)→ 400(由全局 JSON 解析层拒绝,应答体形态不在约定内)`, async () => {
      const r = await call('PUT', P, raw);
      expect(r.status, `应答原文:${r.text.slice(0, 200)}`).toBe(400);
    });
  }
  const cases = [
    ['请求体是数组 []', '[]'],
    ['请求体是空对象 {}', '{}'],
    ['enabled 是字符串 "true"', '{"enabled":"true"}'],
    ['enabled 是数字 1', '{"enabled":1}'],
    ['enabled 是 null', '{"enabled":null}'],
    ['enabled 是数组 [true]', '{"enabled":[true]}'],
  ];
  for (const [label, raw] of cases) {
    test(`A8 ${label} → 400 INVALID_INPUT「enabled 必须是布尔值」,文件不变、无广播`, async () => {
      const before = snapshot([PREFS()]);
      const ws = await wsCollector();
      try {
        const r = await call('PUT', P, raw);
        expectError(r, ERR.PREF_INVALID, label);
        expectUnchanged(before, label);
        expect(await ws.waitFor((m) => m.type === 'third-party-auto', 1_500), '不应广播').toBeNull();
      } finally { ws.close(); }
    });
  }
});

test.describe('A 开关偏好接口 · 落盘失败', () => {
  test('A10 偏好文件写不进去 → 500 STORAGE_WRITE_FAILED「保存失败,请重试」,文件不变、不广播、读到的仍是旧值', async () => {
    const before = snapshot([PREFS()]);
    const ws = await wsCollector();
    try {
      const r = await withReadOnly([PREFS(), GUI_DIR()], () => put(P, { enabled: true }));
      expectError(r, ERR.STORAGE, '写盘失败');
      expectUnchanged(before, '写盘失败');
      expect(await ws.waitFor((m) => m.type === 'third-party-auto', 1_500), '写失败不应广播').toBeNull();
      expect((await get(P)).body).toEqual({ enabled: false });
    } finally { ws.close(); }
  });
});

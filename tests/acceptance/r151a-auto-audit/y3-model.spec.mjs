// C 组:PUT /api/auto-audit/model(INTERFACE Y.3.1)—— 正常写入、规范化、错误码与校验顺序、落盘失败、广播。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  get, put, call, expectError, wsCollector, useProvider, useOfficial, tpAutoOff, resetOverrides, settingsEnv, readJson,
  snapshot, expectUnchanged, withReadOnly, OVERRIDES, SETTINGS, PREFS, GUI_DIR, CLAUDE_DIR, OFFICIAL_ID,
} from './helpers/api.mjs';
import { ERR, APPLY_FAILED } from './helpers/texts.mjs';
import { provider, LONG_MODEL } from './helpers/scenes.mjs';

const M = '/api/auto-audit/model';
const S = '/api/auto-audit/status';
const sonnetOf = (id) => { const o = readJson(OVERRIDES()) || {}; return o[id] && o[id].tierModels ? o[id].tierModels.sonnet : undefined; };
let saved = {};

test.beforeEach(async () => {
  saved = snapshot([SETTINGS(), OVERRIDES()]);
  await tpAutoOff();
  resetOverrides({});
});
test.afterEach(async () => {
  for (const d of [GUI_DIR(), CLAUDE_DIR()]) { try { fs.chmodSync(d, 0o755); } catch { /* */ } }
  for (const [p, c] of Object.entries(saved)) { if (c === null) { try { fs.rmSync(p); } catch { /* */ } } else fs.writeFileSync(p, c); }
});

test.describe('C 审核模型 · 正常写入', () => {
  test('C1 当前在用的第三方 provider 设审核模型 → 200 {ok:true, providerId, auditModel, reapplied:true, warning:null}', async () => {
    const id = await provider('main'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'r151-reasoner' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, providerId: id, auditModel: 'r151-reasoner', reapplied: true, warning: null });
  });

  test('C1b 落盘:provider-overrides.json 里 <providerId>.tierModels.sonnet 等于新值', async () => {
    const id = await provider('main'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-reasoner' });
    expect(sonnetOf(id)).toBe('r151-reasoner');
  });

  test('C1c 生效:settings.json 的 env.ANTHROPIC_DEFAULT_SONNET_MODEL 等于新值', async () => {
    const id = await provider('main'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-reasoner' });
    expect(settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('r151-reasoner');
  });

  test('C1d 写入后 status 显示 auditModel = 新值、auditModelSource:"tier"', async () => {
    const id = await provider('main'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-reasoner' });
    const s = await get(S);
    expect(s.status, s.text).toBe(200);
    expect(s.body).toMatchObject({ providerId: id, auditModel: 'r151-reasoner', auditModelSource: 'tier' });
  });

  test('C2 该 provider 自己配的其它档位(opus / haiku)与默认模型在写入后保持不变', async () => {
    const id = await provider('tiers'); await useProvider(id);
    const before = settingsEnv();
    expect(before.ANTHROPIC_DEFAULT_OPUS_MODEL, '前置').toBe('r151-reasoner');
    expect(before.ANTHROPIC_DEFAULT_HAIKU_MODEL, '前置').toBe('r151-mini');
    const r = await put(M, { providerId: id, model: 'r151-chat' });
    expect(r.status, r.text).toBe(200);
    const after = settingsEnv();
    expect(after.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('r151-chat');
    expect(after.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('r151-reasoner');
    expect(after.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('r151-mini');
    expect(after.ANTHROPIC_MODEL).toBe(before.ANTHROPIC_MODEL);
  });

  test('C2b 覆盖层里该 provider 已有的默认模型覆盖与 opus 档覆盖,写入后保持不变', async () => {
    const id = await provider('main');
    resetOverrides({ [id]: { defaultModel: 'r151-reasoner', tierModels: { opus: 'r151-chat' } } });
    await useProvider(id);
    const r = await put(M, { providerId: id, model: 'r151-chat' });
    expect(r.status, r.text).toBe(200);
    const o = readJson(OVERRIDES())[id];
    expect(o.defaultModel).toBe('r151-reasoner');
    expect(o.tierModels.opus).toBe('r151-chat');
    expect(o.tierModels.sonnet).toBe('r151-chat');
  });

  test('C2c 覆盖层里别的 provider 的条目写入后逐字不变', async () => {
    const id = await provider('main'); await useProvider(id);
    const otherEntry = { defaultModel: 'r151-chat', tierModels: { haiku: 'r151-chat' } };
    resetOverrides({ 'r151-some-other-provider': otherEntry });
    const r = await put(M, { providerId: id, model: 'r151-reasoner' });
    expect(r.status, r.text).toBe(200);
    expect(readJson(OVERRIDES())['r151-some-other-provider']).toEqual(otherEntry);
  });

  test('C3 model 为空串 → 清掉 sonnet 档:200 auditModel:null,覆盖层里不再有 sonnet 档', async () => {
    const id = await provider('main'); await useProvider(id);
    expect((await put(M, { providerId: id, model: 'r151-reasoner' })).status, '前置:先设一个').toBe(200);
    const r = await put(M, { providerId: id, model: '' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ ok: true, providerId: id, auditModel: null });
    expect(sonnetOf(id) === undefined || sonnetOf(id) === null || sonnetOf(id) === '').toBe(true);
  });

  test('C3b 清掉后回到"等于默认模型":settings.json 的 sonnet 档 = 默认模型,status 来源为 "default"', async () => {
    const id = await provider('main'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-reasoner' });
    await put(M, { providerId: id, model: '' });
    expect(settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('r151-chat');
    const s = await get(S);
    expect(s.body).toMatchObject({ auditModel: 'r151-chat', auditModelSource: 'default' });
  });

  test('C3c 清掉 sonnet 档后,该 provider 自己配的 opus / haiku 档仍不变', async () => {
    const id = await provider('tiers'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-chat' });
    const r = await put(M, { providerId: id, model: '' });
    expect(r.status, r.text).toBe(200);
    const env = settingsEnv();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('r151-reasoner');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('r151-mini');
  });

  test('C6 给不在用的 provider 设:200 reapplied:false、warning:null,settings.json 不变,覆盖层已写入', async () => {
    const cur = await provider('main'); await useProvider(cur);
    const other = await provider('other');
    const before = snapshot([SETTINGS()]);
    const r = await put(M, { providerId: other, model: 'r151-reasoner' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, providerId: other, auditModel: 'r151-reasoner', reapplied: false, warning: null });
    expectUnchanged(before, '给不在用的 provider 设审核模型');
    expect(sonnetOf(other)).toBe('r151-reasoner');
  });

  test('C7 写入成功后广播 {type:"auto-audit", status},status 与随后 GET status 的应答相同', async () => {
    const id = await provider('main'); await useProvider(id);
    const ws = await wsCollector();
    try {
      const r = await put(M, { providerId: id, model: 'r151-reasoner' });
      expect(r.status, r.text).toBe(200);
      const msg = await ws.waitFor((m) => m.type === 'auto-audit', 5_000);
      expect(msg, '应收到 auto-audit 广播').not.toBeNull();
      const s = await get(S);
      expect(msg.status).toEqual(s.body);
      expect(msg.status.auditModel).toBe('r151-reasoner');
    } finally { ws.close(); }
  });

  test('C22 幂等:同一个值连写两次都 200,覆盖层内容相同', async () => {
    const id = await provider('main'); await useProvider(id);
    const a = await put(M, { providerId: id, model: 'r151-reasoner' });
    const o1 = fs.readFileSync(OVERRIDES(), 'utf8');
    const b = await put(M, { providerId: id, model: 'r151-reasoner' });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(readJson(OVERRIDES())).toEqual(JSON.parse(o1));
  });
});

test.describe('C 审核模型 · 名字的规范化与边界', () => {
  for (const [label, input] of [
    ['首尾空白(空格与制表符)', '  r151-reasoner \t'],
    ['结尾 [1m]', 'r151-reasoner[1m]'],
    ['结尾 [1M](大写)', 'r151-reasoner[1M]'],
    ['首尾空白 + 结尾 [1m]', '  r151-reasoner[1m]  '],
  ]) {
    test(`C4 ${label}:先去掉再处理,存的、生效的、应答里的都是 "r151-reasoner"`, async () => {
      const id = await provider('main'); await useProvider(id);
      const r = await put(M, { providerId: id, model: input });
      expect(r.status, r.text).toBe(200);
      expect(r.body.auditModel).toBe('r151-reasoner');
      expect(sonnetOf(id)).toBe('r151-reasoner');
      expect(settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('r151-reasoner');
    });
  }

  test('C4e 只有空白的 model:去空白后为空串 → 按"清掉 sonnet 档"处理(200,auditModel:null)', async () => {
    const id = await provider('main'); await useProvider(id);
    await put(M, { providerId: id, model: 'r151-reasoner' });
    const r = await put(M, { providerId: id, model: '   ' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.auditModel).toBeNull();
  });

  for (const [label, name] of [['中文模型名', '深度求索-对话'], ['带 / : @ 的模型名', 'org/model:v1@2'], ['超长模型名(>256 字符)', LONG_MODEL]]) {
    test(`C19 ${label}(在列表里)→ 200,按原样存入覆盖层并写进 settings.json`, async () => {
      const id = await provider('odd'); await useProvider(id);
      const r = await put(M, { providerId: id, model: name });
      expect(r.status, r.text).toBe(200);
      expect(r.body.auditModel).toBe(name);
      expect(sonnetOf(id)).toBe(name);
      expect(settingsEnv().ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(name);
    });
  }

  test('C15 近似但可用的名字 claude-sonnet-5(不以 claude-sonnet-5-5 开头)→ 200', async () => {
    const id = await provider('claude'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'claude-sonnet-5' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.auditModel).toBe('claude-sonnet-5');
  });
});

test.describe('C 审核模型 · 错误码(任何 4xx 都不改文件、不广播)', () => {
  const invalid = [
    ['请求体是数组', '[]'],
    ['请求体是字符串', '"r151-chat"'],
    ['providerId 缺失', JSON.stringify({ model: 'r151-chat' })],
    ['providerId 是空串', JSON.stringify({ providerId: '', model: 'r151-chat' })],
    ['providerId 是数字', JSON.stringify({ providerId: 123, model: 'r151-chat' })],
    ['model 缺失', JSON.stringify({ providerId: '__ID__' })],
    ['model 是 null', JSON.stringify({ providerId: '__ID__', model: null })],
    ['model 是数字', JSON.stringify({ providerId: '__ID__', model: 5 })],
  ];
  for (const [label, raw] of invalid) {
    test(`C8 ${label} → 400 INVALID_INPUT「providerId 与 model 必须是字符串」`, async () => {
      const id = await provider('main'); await useProvider(id);
      const before = snapshot([SETTINGS(), OVERRIDES(), PREFS()]);
      const ws = await wsCollector();
      try {
        const r = await call('PUT', M, raw.replace('__ID__', id));
        expectError(r, ERR.MODEL_INVALID, label);
        expectUnchanged(before, label);
        expect(await ws.waitFor((m) => m.type === 'auto-audit', 1_200), '4xx 不应广播').toBeNull();
      } finally { ws.close(); }
    });
  }

  test('C9 provider 不存在 → 404 PROVIDER_NOT_FOUND「provider 不存在」,文件不变', async () => {
    const id = await provider('main'); await useProvider(id);
    const before = snapshot([SETTINGS(), OVERRIDES()]);
    const r = await put(M, { providerId: 'r151-no-such-provider', model: 'r151-chat' });
    expectError(r, ERR.PROVIDER_NOT_FOUND);
    expectUnchanged(before, 'provider 不存在');
  });

  test('C10 官方端点 provider → 400 OFFICIAL_PROVIDER「官方端点不使用此设置」,文件不变', async () => {
    await useOfficial();
    const before = snapshot([SETTINGS(), OVERRIDES()]);
    const r = await put(M, { providerId: OFFICIAL_ID, model: 'claude-sonnet-4-6' });
    expectError(r, ERR.OFFICIAL_PROVIDER);
    expectUnchanged(before, '官方端点');
  });

  test('C11 取不到该 provider 的模型列表(上游 500、配置为空)→ 409 PROVIDER_MODELS_UNAVAILABLE,文件不变', async () => {
    const id = await provider('down'); await useProvider(id);
    const before = snapshot([SETTINGS(), OVERRIDES()]);
    const r = await put(M, { providerId: id, model: 'r151-chat' });
    expectError(r, ERR.MODELS_UNAVAILABLE);
    expectUnchanged(before, '模型列表取不到');
  });

  test('C12 该 provider 的模型列表为空 → 409 PROVIDER_MODELS_UNAVAILABLE', async () => {
    const id = await provider('empty'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'r151-chat' });
    expectError(r, ERR.MODELS_UNAVAILABLE);
  });

  test('C13 模型不在该 provider 的列表里 → 400 MODEL_NOT_IN_PROVIDER,文件不变', async () => {
    const id = await provider('main'); await useProvider(id);
    const before = snapshot([SETTINGS(), OVERRIDES()]);
    const r = await put(M, { providerId: id, model: 'gpt-r151-nonexistent' });
    expectError(r, ERR.MODEL_NOT_IN_PROVIDER);
    expectUnchanged(before, '不在列表');
  });

  test('C13b 大小写不同的名字(R151-REASONER)不算在列表里 → 400 MODEL_NOT_IN_PROVIDER', async () => {
    const id = await provider('main'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'R151-REASONER' });
    expectError(r, ERR.MODEL_NOT_IN_PROVIDER);
  });

  for (const name of ['claude-sonnet-5-5', 'Claude-Opus-5-5-20261101', 'claude-sonnet-5-5[1m]']) {
    test(`C14 CLI 不认的审核型号 ${name}(在列表里)→ 400 MODEL_UNUSABLE_AS_AUDITOR,文件不变`, async () => {
      const id = await provider('claude'); await useProvider(id);
      const before = snapshot([SETTINGS(), OVERRIDES()]);
      const r = await put(M, { providerId: id, model: name });
      expectError(r, ERR.MODEL_UNUSABLE);
      expectUnchanged(before, name);
    });
  }

  test('C17 覆盖层写不进去 → 500 STORAGE_WRITE_FAILED「保存失败,请重试」,覆盖层与 settings.json 都不变、不广播', async () => {
    const id = await provider('main'); await useProvider(id);
    const before = snapshot([SETTINGS(), OVERRIDES()]);
    const ws = await wsCollector();
    try {
      const r = await withReadOnly([OVERRIDES(), GUI_DIR()], () => put(M, { providerId: id, model: 'r151-reasoner' }));
      expectError(r, ERR.STORAGE, '覆盖层写失败');
      expectUnchanged(before, '覆盖层写失败');
      expect(await ws.waitFor((m) => m.type === 'auto-audit', 1_200), '写失败不应广播').toBeNull();
    } finally { ws.close(); }
  });

  test('C18 覆盖层已保存但 settings.json 写不进去 → 200 {ok:true, reapplied:false, warning:"APPLY_FAILED"},覆盖层有新值、settings.json 不变', async () => {
    const id = await provider('main'); await useProvider(id);
    const before = snapshot([SETTINGS()]);
    const r = await withReadOnly([SETTINGS(), CLAUDE_DIR()], () => put(M, { providerId: id, model: 'r151-reasoner' }));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ ok: true, providerId: id, auditModel: 'r151-reasoner', reapplied: false, warning: APPLY_FAILED });
    expect(sonnetOf(id)).toBe('r151-reasoner');
    expectUnchanged(before, 'APPLY_FAILED');
  });
});

test.describe('C 审核模型 · 校验顺序(命中第一条即返回)', () => {
  test('C16a provider 不存在 且 model 不是字符串 → 先报 400 INVALID_INPUT(第 1 条先于第 2 条)', async () => {
    const r = await put(M, { providerId: 'r151-no-such-provider', model: 7 });
    expectError(r, ERR.MODEL_INVALID);
  });

  test('C16b 不存在的 provider 配 CLI 不认的型号 → 404 PROVIDER_NOT_FOUND(第 2 条先于第 6 条)', async () => {
    const r = await put(M, { providerId: 'r151-no-such-provider', model: 'claude-sonnet-5-5' });
    expectError(r, ERR.PROVIDER_NOT_FOUND);
  });

  test('C16c 官方 provider 配一个不在任何列表里的名字 → 400 OFFICIAL_PROVIDER(第 3 条先于第 4、5 条)', async () => {
    await useOfficial();
    const r = await put(M, { providerId: OFFICIAL_ID, model: 'gpt-r151-nonexistent' });
    expectError(r, ERR.OFFICIAL_PROVIDER);
  });

  test('C16d 模型列表取不到 且 model 不在列表 → 409 PROVIDER_MODELS_UNAVAILABLE(第 4 条先于第 5 条)', async () => {
    const id = await provider('down'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'gpt-r151-nonexistent' });
    expectError(r, ERR.MODELS_UNAVAILABLE);
  });

  test('C16e 模型列表取不到 时,即使 model 为空串(清除)也 → 409(第 4 条不看 model)', async () => {
    const id = await provider('down'); await useProvider(id);
    const r = await put(M, { providerId: id, model: '' });
    expectError(r, ERR.MODELS_UNAVAILABLE);
  });

  test('C16f 不在列表 且 以 claude-sonnet-5-5 开头 → 400 MODEL_NOT_IN_PROVIDER(第 5 条先于第 6 条)', async () => {
    const id = await provider('claude'); await useProvider(id);
    const r = await put(M, { providerId: id, model: 'claude-sonnet-5-5-beta' });
    expectError(r, ERR.MODEL_NOT_IN_PROVIDER);
  });

  test('C16g 覆盖层只读 且 model 不在列表 → 400 MODEL_NOT_IN_PROVIDER(4xx 先于落盘失败)', async () => {
    const id = await provider('main'); await useProvider(id);
    const r = await withReadOnly([OVERRIDES(), GUI_DIR()], () => put(M, { providerId: id, model: 'gpt-r151-nonexistent' }));
    expectError(r, ERR.MODEL_NOT_IN_PROVIDER);
  });
});

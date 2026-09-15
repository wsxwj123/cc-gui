// PA-6xx：D 项（套餐余量：判定按预设身份 + 三类/④ 文案）与 E 项（matchPresetByBaseURL）。
// 契约 §10.4 / §10.5 / §10.8。
import { test, expect } from '@playwright/test';
import {
  getRuntime, getProviderQuota, createCustomProvider, listCustomProviders, switchProvider,
  presetMatch, QUOTA_NOTE, QUOTA_REASONS, CLASS2_HOSTS, EnvironmentBlocked,
} from './helpers/pa-runtime.mjs';

const PROVIDER_DEFS = {
  // §10.11②：自填 baseURL 的 openai 型第三方会走 One-API 兜底候选（非空）→ 失败 = 第 ① 类，
  // 因此它不能用来验第 ③ 类；第 ③ 类的构造见 unregisteredNonOpenAI。
  unregistered: {
    name: 'PA Quota 未登记(openai)', type: 'openai',
    baseURL: 'https://pa-not-registered.invalid/v1', apiKey: 'pa-placeholder', models: ['pa-model'],
  },
  // §10.11② + §10.4 文案表第 ③ 类判据「非 openai 型且无任何匹配候选」：候选为空才会走第 ③ 类。
  unregisteredNonOpenAI: {
    name: 'PA Quota 未登记(非 openai)', type: 'anthropic',
    baseURL: 'https://pa-unregistered.example/v1', apiKey: 'pa-placeholder', models: ['pa-model'],
  },
  listed: {
    name: 'PA Quota 名单内', type: 'anthropic',
    baseURL: 'https://api.anthropic.com', apiKey: 'pa-placeholder', models: ['claude-opus-5'],
  },
  unreachable: {
    name: 'PA Quota 不可达', type: 'openai',
    baseURL: 'http://127.0.0.1:9/v1', apiKey: 'pa-placeholder', models: ['pa-model'],
  },
  openaiPreset: {
    name: 'PA Quota OpenAI', type: 'openai',
    baseURL: 'https://api.openai.com/v1', apiKey: 'pa-placeholder', models: ['gpt-5.6-sol'],
  },
};

const ids = {};

test.beforeAll(async ({ request }) => {
  const { baseURL } = getRuntime();
  const existing = await listCustomProviders(request, baseURL);
  for (const [key, def] of Object.entries(PROVIDER_DEFS)) {
    const hit = existing.find(row => row?.name === def.name);
    if (hit) { ids[key] = hit.id; continue; }
    const created = await createCustomProvider(request, baseURL, def);
    if (created.status !== 200 || !created.body?.id) {
      throw new EnvironmentBlocked(`建不出夹具 provider「${def.name}」：HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
    }
    ids[key] = created.body.id;
  }
});

async function quotaOf(request, baseURL, key) {
  const switched = await switchProvider(request, baseURL, ids[key]);
  expect(switched.status, `切换到夹具 provider ${key} 必须成功`).toBe(200);
  const result = await getProviderQuota(request, baseURL);
  expect(result.status).toBe(200);
  return result.body;
}

// ---------------------------------------------------------------------------
// D 项：/api/provider-quota
// ---------------------------------------------------------------------------

test('PA-601 第③类（未登记）：候选为空（非 openai 型、host 未登记）→ no-endpoint +「未登记额度接口」文案', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'unregisteredNonOpenAI');
  expect(body.ok).toBe(false);
  expect(body.reason, 'reason 闭集内').toBe('no-endpoint');
  expect(QUOTA_NOTE.class3).toBe(body.note);
  expect(body.note, '旧的「不提供额度接口」串已作废').not.toBe(QUOTA_NOTE.oldSingle);
});

test('PA-618 自填 baseURL 的 openai 型第三方：候选非空（One-API 兜底）→ 失败落第①类 network', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'unregistered');
  expect(body.ok).toBe(false);
  expect(body.reason, '§10.11② 定论：自填第三方默认落第①类').toBe('network');
  expect(body.note, '第①类原文案').toBe(QUOTA_NOTE.class1Network);
  expect(body.note, '不得回第③类的「未登记」串').not.toBe(QUOTA_NOTE.class3);
});

test('PA-602 第②类（名单内未接入）：api.anthropic.com → 「有额度接口，本期尚未接入」文案', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'listed');
  expect(body.ok).toBe(false);
  expect(body.reason).toBe('no-endpoint');
  expect(body.note).toBe(QUOTA_NOTE.class2);
  expect(CLASS2_HOSTS, 'OPENAI 已从第②类名单移除').not.toContain('openai.com');
});

test('PA-603 第①类文案不变：不可达的已接入 provider → network + 「网络不可达或超时」原文案', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'unreachable');
  expect(body.ok).toBe(false);
  expect(body.reason).toBe('network');
  expect(body.note).toBe(QUOTA_NOTE.class1Network);
});

test('PA-604 reason 闭集：任何 provider 的 reason 都必须落在 {no-endpoint,network,auth,blocked} 内', async ({ request }) => {
  const { baseURL } = getRuntime();
  for (const key of Object.keys(PROVIDER_DEFS)) {
    const body = await quotaOf(request, baseURL, key);
    expect(QUOTA_REASONS, `${key} 的 reason 越界：${body.reason}`).toContain(body.reason);
    expect(body.reason, '本次不得新增 not-implemented').not.toBe('not-implemented');
  }
});

test('PA-605 失败不写 0：ok:false 时不得出现 0 值条目或部分字段', async ({ request }) => {
  const { baseURL } = getRuntime();
  for (const key of ['unregistered', 'unreachable']) {
    const body = await quotaOf(request, baseURL, key);
    expect(body.ok).toBe(false);
    if (body.items !== undefined && body.items !== null) {
      expect(Array.isArray(body.items) && body.items.length === 0,
        `${key} 失败时不得回部分字段或 0 余额`).toBe(true);
    }
    const text = JSON.stringify(body);
    expect(text, `${key} 不得伪造 0 余额`).not.toMatch(/"used"\s*:\s*0|"remaining"\s*:\s*0|"balance"\s*:\s*0/);
  }
});

test('PA-606 OpenAI 预设：走本机 codex 通道 → note 属于 ④ 类三串之一，且不是「密钥被拒」', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'openaiPreset');
  expect(body.ok).toBe(false);
  expect([QUOTA_NOTE.codexNoBinary, QUOTA_NOTE.codexNotLoggedIn, QUOTA_NOTE.codexFailed],
    `OpenAI 预设必须走 ④ 类文案，实际 note=${body.note}`).toContain(body.note);
  expect(body.note, '出现 ① 类的密钥被拒串 = 拿 provider key 打了 api.openai.com').not.toBe(QUOTA_NOTE.class1Auth);
});

test('PA-607 reason 与 note 必须同源：no-endpoint 不得配 ① 类文案', async ({ request }) => {
  const { baseURL } = getRuntime();
  const body = await quotaOf(request, baseURL, 'listed');
  const class1Notes = [QUOTA_NOTE.class1Network, QUOTA_NOTE.class1Auth, QUOTA_NOTE.class1Blocked];
  if (body.reason === 'no-endpoint') {
    expect(class1Notes).not.toContain(body.note);
  }
});

test('PA-608 缓存回放：60s 内第二次请求应标 degraded 并带说明（现行语义）', async ({ request }) => {
  const { baseURL } = getRuntime();
  await quotaOf(request, baseURL, 'unreachable');
  const second = await getProviderQuota(request, baseURL);
  expect(second.status).toBe(200);
  expect(second.body.degraded, '缓存回放必须自曝 degraded，不能伪装成新鲜结果').toBe(true);
  expect(typeof second.body.note === 'string' && second.body.note.length > 0, 'degraded 必须带说明').toBe(true);
});

test('PA-609 智谱 CN：quota 与余额是两个独立候选，独立计成败（需真 key → 环境不成立）', async () => {
  throw new EnvironmentBlocked(
    '需要一把真实的智谱 CN（open.bigmodel.cn）密钥才能观察「余额候选失败不拖垮 quota 候选」；'
    + '契约 §10.4 也只公布了失败文案（{ok:false,official:false,reason,note}），候选清单本身没有对外可观察字段 —— 见 README',
  );
});

test('PA-610 凭证只发该 key 的域族（需抓包夹具 → 环境不成立）', async () => {
  throw new EnvironmentBlocked(
    '要在出口侧证明「CN 族 key 不发 api.z.ai、Z.ai key 不发 CN 族」，需要一个能记录出站请求的代理夹具；'
    + '本套件未搭，见 README「Not preparable」',
  );
});

// ---------------------------------------------------------------------------
// E 项：matchPresetByBaseURL（§10.8）
// ---------------------------------------------------------------------------

test('PA-611 自反性：预设表里每一条的 baseURL 自匹配都能命中自己', async () => {
  const { matchPresetByBaseURL, BUILTIN_PROVIDERS } = await presetMatch();
  const presets = Array.isArray(BUILTIN_PROVIDERS) ? BUILTIN_PROVIDERS : Object.values(BUILTIN_PROVIDERS || {});
  expect(presets.length, '预设表非空').toBeGreaterThan(0);
  for (const preset of presets) {
    const result = matchPresetByBaseURL(preset.baseURL, { type: preset.type });
    expect(result?.matched, `${preset.id} 的 baseURL ${preset.baseURL} 必须命中自己`).toBe(true);
    const ids = (result.candidates || []).map(item => item?.id);
    expect(ids, `${preset.id} 必须在 candidates 里`).toContain(preset.id);
    expect(result.host, 'host 必须回传').toBe(new URL(preset.baseURL).hostname.toLowerCase());
  }
});

test('PA-612 同一家的多个入口：open.bigmodel.cn/api/anthropic 命中并列出全部同 host 预设', async () => {
  const { matchPresetByBaseURL } = await presetMatch();
  const result = matchPresetByBaseURL('https://open.bigmodel.cn/api/anthropic', { type: 'anthropic' });
  expect(result.matched).toBe(true);
  expect(result.candidates.length, '同 host 的预设应有多条（含 anthropic 协议入口）').toBeGreaterThanOrEqual(2);
  expect(result.preset.type, '建议目标优先同 type').toBe('anthropic');
  expect(result.candidates.some(item => item.id === 'zhipu-glm'), 'candidates 含 CN 族预设').toBe(true);
});

test('PA-613 不同身份：api.z.ai 与 open.bigmodel.cn 各自只命中自己的预设族', async () => {
  const { matchPresetByBaseURL } = await presetMatch();
  const zai = matchPresetByBaseURL('https://api.z.ai/api/paas/v4');
  const cn = matchPresetByBaseURL('https://open.bigmodel.cn/api/paas/v4');
  expect(zai.matched && cn.matched).toBe(true);
  expect(zai.host).not.toBe(cn.host);
  const zaiIds = zai.candidates.map(item => item.id);
  const cnIds = cn.candidates.map(item => item.id);
  expect(zaiIds.some(id => /^zai-/.test(id)), 'api.z.ai 命中 zai-* 预设').toBe(true);
  expect(zaiIds.some(id => /^zhipu-|^glm-/.test(id)), 'api.z.ai 不得命中智谱 CN 预设').toBe(false);
  expect(cnIds.some(id => /^zhipu-|^glm-/.test(id)), 'open.bigmodel.cn 命中 CN 预设').toBe(true);
  expect(cnIds.some(id => /^zai-/.test(id)), 'open.bigmodel.cn 不得命中 zai-*').toBe(false);
});

test('PA-614 非法输入：非字符串 / 空串 / 非法 URL / 无 host 一律 {matched:false} 且不抛', async () => {
  const { matchPresetByBaseURL } = await presetMatch();
  const bad = [undefined, null, '', '   ', 'not a url', 'http://', 'file:///tmp/x', 42, {}, []];
  for (const value of bad) {
    let result;
    expect(() => { result = matchPresetByBaseURL(value); }, `matchPresetByBaseURL(${String(value)}) 不得抛`).not.toThrow();
    expect(result?.matched, `matchPresetByBaseURL(${String(value)}) 应报未命中`).toBe(false);
  }
});

test('PA-615 不做子域近似：coding.dashscope.aliyuncs.com 与 dashscope.aliyuncs.com 各自判定', async () => {
  const { matchPresetByBaseURL } = await presetMatch();
  const parent = matchPresetByBaseURL('https://dashscope.aliyuncs.com/api/v1');
  const child = matchPresetByBaseURL('https://coding.dashscope.aliyuncs.com/api/v1');
  if (child.matched) {
    expect(child.host, '子域必须按自己的 host 判定').toBe('coding.dashscope.aliyuncs.com');
  }
  expect(parent.host).toBe('dashscope.aliyuncs.com');
  expect(child.host).not.toBe(parent.host);
});

test('PA-616 host 归一：大小写、末尾点、默认端口都要归一后再比', async () => {
  const { matchPresetByBaseURL } = await presetMatch();
  const base = matchPresetByBaseURL('https://open.bigmodel.cn/api/paas/v4');
  const shouty = matchPresetByBaseURL('HTTPS://OPEN.BIGMODEL.CN/api/paas/v4');
  const ported = matchPresetByBaseURL('https://open.bigmodel.cn:443/api/paas/v4');
  expect(shouty.matched).toBe(true);
  expect(ported.matched).toBe(true);
  expect(shouty.host).toBe(base.host);
  expect(ported.host).toBe(base.host);
});

test('PA-617 建议目标口径：同 type 优先，否则预设表声明顺序第一条；candidates 按声明顺序', async () => {
  const { matchPresetByBaseURL, BUILTIN_PROVIDERS } = await presetMatch();
  const presets = Array.isArray(BUILTIN_PROVIDERS) ? BUILTIN_PROVIDERS : Object.values(BUILTIN_PROVIDERS || {});
  const order = new Map(presets.map((preset, index) => [preset.id, index]));
  const result = matchPresetByBaseURL('https://open.bigmodel.cn/api/anthropic', { type: 'anthropic' });
  const declared = result.candidates.map(item => order.get(item.id));
  expect(declared, 'candidates 必须按预设表声明顺序').toEqual([...declared].sort((a, b) => a - b));
  const sameType = result.candidates.filter(item => item.type === 'anthropic');
  if (sameType.length) {
    expect(result.preset.type, '同 type 存在时建议目标必须用它').toBe('anthropic');
  } else {
    expect(result.preset.id, '否则取声明顺序第一条').toBe(result.candidates[0].id);
  }
});

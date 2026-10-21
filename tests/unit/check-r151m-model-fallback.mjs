// 单测:r151m claude 模型名兜底映射(接口文件第 2 节规则 1–4 + 日志去重)。
// 直接 import 真函数,不复制实现。覆盖:
//   - resolveFallbackModel:缺失/空/非字符串、列表内(含 claude 名)、default 优先、
//     models[0] 回落、两者都缺、非 claude 名、大小写/下划线形态、纯函数不改入参。
//   - noteModelFallback:同组合只记一次、不同组合各记一次、未映射不记、可注入 logger、
//     默认 console.warn 路径、日志只含模型名不含 key/token 字样。
//   - setOpenAIUpstream:model(视觉回退)与 defaultModel(映射目标)分开存,不再互相覆盖;
//     只传一边时另一边兜底;upstreamNoVision 读 model 而非 defaultModel;测试快照是副本。
// 变异哨兵(每条都实际验证过红):
//   S1 去掉规则 2(models.includes 提前返回)→ t2b 红
//   S2 去掉 defaultModel 优先、恒用 models[0] → t3a 红
//   S3 去掉 models[0] 回落 → t3c 红
//   S4 去掉 CLAUDE_MODEL_RE 的 i 标志 → t4a 红
//   S5 去掉 noteModelFallback 的 loggedPairs 去重 → t5a 红
//   S6 setter 里 model 又写成 defaultModel(旧 bug)→ t9a 红
import assert from 'node:assert/strict';
import {
  resolveFallbackModel,
  noteModelFallback,
  resetModelFallbackLogState,
} from '../../server/utils/model-fallback.js';
import {
  setOpenAIUpstream,
  getOpenAIUpstreamForTest,
  upstreamNoVision,
} from '../../server/services/openai-proxy.js';

const DEFAULT = 'deepseek/x';
const LIST = [DEFAULT, 'deepseek/v3'];

// ── t1 规则 1:没有 model(缺失/空串/非字符串)一律原样 ────────────────────
{
  for (const missing of [undefined, null, '', 42, 0, false, {}, []]) {
    assert.equal(
      resolveFallbackModel(missing, { models: LIST, defaultModel: DEFAULT }),
      missing,
      `t1: 非有效字符串 model 必须原样返回(${JSON.stringify(missing)})`,
    );
  }
}

// ── t2 规则 2:列表内(含 claude 名)不映射,优先于规则 3 ──────────────────
{
  assert.equal(resolveFallbackModel(DEFAULT, { models: LIST, defaultModel: DEFAULT }), DEFAULT, 't2a: 列表内 provider 模型不改');
  assert.equal(
    resolveFallbackModel('claude-opus-4-7', { models: ['claude-opus-4-7', DEFAULT], defaultModel: DEFAULT }),
    'claude-opus-4-7',
    't2b: 列表内 claude 名不得被改写(规则 2 优先于规则 3)',
  );
  assert.equal(resolveFallbackModel('deepseek/v3', { models: LIST, defaultModel: 'other' }), 'deepseek/v3', 't2c: 列表非首项也不改');
  // 列表里有非字符串脏项不影响 includes 判定
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: [null, 7, 'claude-opus-4-7'], defaultModel: DEFAULT }), 'claude-opus-4-7', 't2d: 脏列表仍按字符串匹配');
}

// ── t3 规则 3:claude 名 → defaultModel;default 缺 → models[0];都缺 → 原名 ─
{
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: LIST, defaultModel: DEFAULT }), DEFAULT, 't3a: defaultModel 优先于 models[0]');
  assert.equal(resolveFallbackModel('claude-sonnet-4-6', { models: [], defaultModel: DEFAULT }), DEFAULT, 't3b: models 空数组仍用 default');
  assert.equal(resolveFallbackModel('claude-3-5-haiku-20241022', { models: LIST }), DEFAULT, 't3c: default 缺失回落 models[0]');
  assert.equal(resolveFallbackModel('claude-3-5-haiku-20241022', { models: LIST, defaultModel: '' }), DEFAULT, 't3d: 空串 default 视同缺失');
  assert.equal(resolveFallbackModel('claude-3-5-haiku-20241022', { models: LIST, defaultModel: 7 }), DEFAULT, 't3e: 非字符串 default 视同缺失');
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: [], defaultModel: '' }), 'claude-opus-4-7', 't3f: 两者都缺原样转发');
  assert.equal(resolveFallbackModel('claude-opus-4-7', {}), 'claude-opus-4-7', 't3g: 空配置原样转发');
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: 'deepseek/x', defaultModel: DEFAULT }), DEFAULT, 't3h: models 非数组不影响 default');
  assert.equal(resolveFallbackModel('claude-opus-4-7', { models: [42, null] }), 'claude-opus-4-7', 't3i: models[0] 非字符串不凭空猜');
}

// ── t4 claude 形态与规则 4:大小写/下划线/裸 claude 命中,其它一律不动 ──────
{
  const cfg = { models: LIST, defaultModel: DEFAULT };
  for (const name of ['claude', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-3-5-haiku', 'CLAUDE-OPUS-4-7', 'Claude_3']) {
    assert.equal(resolveFallbackModel(name, cfg), DEFAULT, `t4a: ${name} 应命中规则 3`);
  }
  for (const name of ['claudex', 'claude3', 'gpt-4o', 'gpt-not-in-list', 'deepseek/other', 'claude opus', 'claude.']) {
    assert.equal(resolveFallbackModel(name, cfg), name, `t4b: ${name} 不匹配 claude 形态,原样转发`);
  }
  // 空 providers 列表的非 claude 名同样原样
  assert.equal(resolveFallbackModel('deepseek/other', {}), 'deepseek/other', 't4c: 非 claude 未知名不猜');
}

// ── t5 纯函数:不改入参对象/数组 ──────────────────────────────────────────
{
  const models = Object.freeze(['deepseek/x', 'deepseek/v3']);
  const opts = Object.freeze({ models, defaultModel: 'deepseek/x' });
  const requested = 'claude-opus-4-7';
  assert.equal(resolveFallbackModel(requested, opts), 'deepseek/x', 't5a: 正常映射');
  assert.equal(requested, 'claude-opus-4-7', 't5b: 不改 requested');
  assert.deepEqual(opts.models, ['deepseek/x', 'deepseek/v3'], 't5c: 不改 models');
  assert.equal(opts.defaultModel, 'deepseek/x', 't5d: 不改 defaultModel');
}

// ── t6 noteModelFallback:同组合只记一次,不同组合各记一次 ─────────────────
{
  resetModelFallbackLogState();
  const lines = [];
  const logger = { warn: (line) => lines.push(String(line)) };
  assert.equal(noteModelFallback('claude-opus-4-7', DEFAULT, logger), true, 't6a: 首次映射记日志');
  assert.equal(noteModelFallback('claude-opus-4-7', DEFAULT, logger), false, 't6b: 同组合第二次不再记');
  assert.equal(noteModelFallback('claude-opus-4-7', DEFAULT, logger), false, 't6c: 同组合第三次仍不再记');
  assert.equal(lines.length, 1, 't6d: 同组合只落一条');
  assert.ok(lines[0].includes('claude-opus-4-7') && lines[0].includes(DEFAULT), 't6e: 日志含两个模型名');
  assert.ok(!/sk-|token|api[_-]?key/i.test(lines[0]), 't6f: 日志不含 key/token 字样');

  assert.equal(noteModelFallback('claude-sonnet-4-6', DEFAULT, logger), true, 't6g: 新 requested 再记');
  assert.equal(noteModelFallback('claude-opus-4-7', 'deepseek/v3', logger), true, 't6h: 新 mapped 再记');
  assert.equal(lines.length, 3, 't6i: 不同组合各一条');
}

// ── t7 noteModelFallback:未映射/非法参数不记日志 ──────────────────────────
{
  resetModelFallbackLogState();
  const lines = [];
  const logger = { warn: (line) => lines.push(String(line)) };
  assert.equal(noteModelFallback('deepseek/x', 'deepseek/x', logger), false, 't7a: 未映射不记');
  assert.equal(noteModelFallback('', DEFAULT, logger), false, 't7b: 空 requested 不记');
  assert.equal(noteModelFallback('claude-opus-4-7', '', logger), false, 't7c: 空 mapped 不记');
  assert.equal(noteModelFallback(42, DEFAULT, logger), false, 't7d: 非字符串 requested 不记');
  assert.equal(noteModelFallback('claude-opus-4-7', null, logger), false, 't7e: 非字符串 mapped 不记');
  assert.equal(lines.length, 0, 't7f: 以上均不得落日志');
}

// ── t8 默认出口 = console.warn,且被捕获时仍只一次(去重跨 logger 生效)────
{
  resetModelFallbackLogState();
  const originalWarn = console.warn;
  const captured = [];
  console.warn = (...args) => captured.push(args.join(' '));
  try {
    assert.equal(noteModelFallback('claude-log-once-unit', DEFAULT), true, 't8a: 默认出口记录');
    assert.equal(noteModelFallback('claude-log-once-unit', DEFAULT), false, 't8b: 默认出口不重复记录');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(captured.length, 1, 't8c: console.warn 只收到一条');
  assert.ok(captured[0].includes('claude-log-once-unit') && captured[0].includes(DEFAULT), 't8d: 捕获行含两个模型名');
}

// ── t9 setOpenAIUpstream:model(视觉回退)与 defaultModel(映射目标)分开存 ──
{
  const base = { baseURL: 'https://relay.example.com/v1/', apiKey: 'unit-test-key' };

  setOpenAIUpstream({ ...base, model: 'vision-model', defaultModel: 'map-target', models: ['map-target', 7, '', 'vision-model'] });
  let up = getOpenAIUpstreamForTest();
  assert.equal(up.model, 'vision-model', 't9a: model 保留传入值,不被 defaultModel 覆盖');
  assert.equal(up.defaultModel, 'map-target', 't9b: defaultModel 优先取传入的 defaultModel');
  assert.deepEqual(up.models, ['map-target', 'vision-model'], 't9c: models 过滤非字符串/空串');
  assert.equal(up.baseURL, 'https://relay.example.com/v1', 't9d: baseURL 去尾斜杠');

  // 只传 model(旧调用点)→ defaultModel 兜底
  setOpenAIUpstream({ ...base, model: 'only-model' });
  up = getOpenAIUpstreamForTest();
  assert.equal(up.model, 'only-model', 't9e: 只传 model 时 model 保留');
  assert.equal(up.defaultModel, 'only-model', 't9f: 只传 model 时 defaultModel 兜底');

  // 只传 defaultModel → model 兜底(视觉回退不因此丢值)
  setOpenAIUpstream({ ...base, defaultModel: 'only-default' });
  up = getOpenAIUpstreamForTest();
  assert.equal(up.model, 'only-default', 't9g: 只传 defaultModel 时 model 兜底');
  assert.equal(up.defaultModel, 'only-default', 't9h: 只传 defaultModel 时 defaultModel 保留');

  // 视觉回退必须读 model:两个模型视觉能力相反,defaultModel 固定为有视觉的 gpt-4o
  setOpenAIUpstream({ ...base, model: 'deepseek-v4-flash-vision-exp', defaultModel: 'gpt-4o', models: ['gpt-4o'] });
  assert.equal(upstreamNoVision(), false, 't9i: upstreamNoVision 按 model(有视觉)判,不按 defaultModel');
  setOpenAIUpstream({ ...base, model: 'deepseek-v4-pro', defaultModel: 'gpt-4o', models: ['gpt-4o'] });
  assert.equal(upstreamNoVision(), true, 't9j: upstreamNoVision 按 model(无视觉)判,不被 defaultModel 的有视觉覆盖');

  // 快照是副本:改返回值不影响代理内部状态
  const snap = getOpenAIUpstreamForTest();
  snap.model = 'tampered';
  snap.defaultModel = 'tampered';
  snap.models.push('injected');
  up = getOpenAIUpstreamForTest();
  assert.equal(up.model, 'deepseek-v4-pro', 't9k: 改快照 model 不影响内部');
  assert.equal(up.defaultModel, 'gpt-4o', 't9l: 改快照 defaultModel 不影响内部');
  assert.deepEqual(up.models, ['gpt-4o'], 't9m: 改快照 models 不影响内部');

  assert.equal(setOpenAIUpstream(null), null, 't9n: 传 null 清空上游');
  assert.equal(getOpenAIUpstreamForTest(), null, 't9o: 清空后快照为 null');
}

console.log('check-r151m-model-fallback: all assertions passed');

#!/usr/bin/env node
// E 项:baseURL 撞内置预设的提示判据(INTERFACE §10.8)+ 两条抑制条件。
// Run: node tests/unit/check-preset-match.mjs
//
// 守的是四件事:
//   ① 建议目标怎么挑:命中一条给它自己;命中多条按**当前协议**(type)优先,否则预设表声明
//      顺序第一条 —— 选错目标会把用户的 Anthropic 入口换成 OpenAI 入口;
//   ② 两条抑制条件(防空弹):编辑态没动 URL 不提示、刚选完内置模板不提示;
//   ③ 纯函数、零副作用:提示判据只回答"要不要提示、提示哪条",**绝不改用户配置**
//      (不静默替换是这一项的红线 —— 改不改由用户点,不由这里定);
//   ④ 口径与 D 项同一份:命中判据是 host 逐字相等(同一家的任意协议入口都算命中)。
import assert from 'node:assert/strict';
import { matchPresetByBaseURL, BUILTIN_PROVIDERS } from '../../server/utils/builtin-providers.js';
import { presetSuggestion } from '../../client/src/utils/builtinProviders.js';

// ── ① 命中一条 / 命中多条(type 优先 → 声明顺序) ──────────────────────────
{
  // 同一家的两个协议入口 = 同一条身份(host 相等),但建议目标要按当前协议挑
  const ds = presetSuggestion('https://api.deepseek.com/anthropic', { type: 'anthropic' });
  assert.equal(ds.preset.id, 'deepseek-anthropic', 'anthropic 协议下应建议 anthropic 入口');
  assert.deepEqual(ds.candidates.map((c) => c.id), ['deepseek-official', 'deepseek-anthropic'],
    'candidates 是全部同 host 预设(声明顺序),不只是建议目标');
  assert.equal(presetSuggestion('https://api.deepseek.com/anthropic', { type: 'openai' }).preset.id,
    'deepseek-official', 'openai 协议下应建议 openai 入口');
  assert.equal(presetSuggestion('https://api.deepseek.com', { type: 'openai' }).preset.id,
    'deepseek-official', 'open.bigmodel 之外的单命中路径照旧');

  // 三命中:智谱 CN(openai 兼容 / 编码套餐 / anthropic 兼容)
  const cn = presetSuggestion('https://open.bigmodel.cn/api/anthropic', { type: 'anthropic' });
  assert.deepEqual(cn.candidates.map((c) => c.id), ['zhipu-glm', 'glm-coding', 'glm-anthropic']);
  assert.equal(cn.preset.id, 'glm-anthropic', '同 type 优先');
  // 不传 type(新增表单的 type 恒有值,这里钉的是"没传时取声明顺序第一条")
  assert.equal(presetSuggestion('https://open.bigmodel.cn/api/anthropic').preset.id, 'zhipu-glm');
  assert.equal(cn.host, 'open.bigmodel.cn', 'host 回传归一值,弹窗正文与测试都用它');

  // 同家不同身份:api.z.ai 不许命中智谱 CN 预设(反之亦然)
  const zai = presetSuggestion('https://api.z.ai/api/paas/v4', { type: 'openai' });
  assert.ok(zai.candidates.every((c) => /^zai-/.test(c.id)), 'api.z.ai 只命中 zai-* 预设');
}

// ── ② 两条抑制条件(防空弹) ──────────────────────────────────────────────
{
  const url = 'https://open.bigmodel.cn/api/anthropic';
  const tpl = { id: 'glm-anthropic', baseURL: url, type: 'anthropic' };

  // 抑制①:编辑态没动 Base URL → 不提示(否则改个名字、改个单价都要再问一遍)
  assert.equal(presetSuggestion(url, { type: 'anthropic', initialBaseURL: url }), null,
    'baseURL 与打开表单时的初值相同 → 不提示');
  assert.notEqual(presetSuggestion(url, { type: 'anthropic', initialBaseURL: 'https://api.deepseek.com' }), null,
    'URL 被改过 → 照常提示');

  // 抑制②:最近一次经内置模板下拉选的就是这条预设且此后没改 URL → 不提示
  assert.equal(presetSuggestion(url, { type: 'anthropic', template: tpl }), null,
    '刚选完该模板 → 不提示');
  // 模板填的 URL 被改成了别家的入口 → 是别家的事,要提示
  assert.equal(presetSuggestion('https://api.deepseek.com', { type: 'openai', template: tpl }).preset.id,
    'deepseek-official', '模板填 A、用户改成 B → 提示 B');
  // 选完模板又切了协议:同一串 URL 的建议目标变成另一条预设 → 是新信息,要提示
  assert.equal(presetSuggestion(url, { type: 'openai', template: tpl }).preset.id, 'zhipu-glm',
    '同 URL 但建议目标已不是当初那条模板 → 提示');
  // 抑制①优先:两条同时成立也不提示
  assert.equal(presetSuggestion(url, { type: 'anthropic', initialBaseURL: url, template: tpl }), null);
}

// ── ③ 不命中 / 非法输入:一律 null,且**不抛** ────────────────────────────
{
  assert.equal(presetSuggestion('https://my-relay.example.com/v1', { type: 'openai' }), null,
    '自填第三方 host 不在预设表 → 不提示');
  for (const bad of [undefined, null, '', '   ', 'not a url', 'http://', 'file:///tmp/x', 42, {}, []]) {
    let r;
    assert.doesNotThrow(() => { r = presetSuggestion(bad, { type: 'openai' }); }, `${String(bad)} 不得抛`);
    assert.equal(r, null, `${String(bad)} 应报"不提示"`);
  }
  // 非法输入也不许被抑制条件救回来(判据顺序:先判命中)
  assert.equal(presetSuggestion('not a url', { initialBaseURL: 'not a url' }), null);
}

// ── ④ 纯函数、零副作用:不静默替换用户配置 ──────────────────────────────
{
  const ctx = Object.freeze({ type: 'anthropic', initialBaseURL: '', template: null });
  const input = 'https://open.bigmodel.cn/api/anthropic';
  const r = presetSuggestion(input, ctx);
  assert.equal(input, 'https://open.bigmodel.cn/api/anthropic', '入参字符串不可能被改(不可变类型,钉住写法)');
  // 返回的是预设表里的那条对象(建议目标),不是用户输入的回声 —— 调用方据此填三个字段
  assert.equal(r.preset, BUILTIN_PROVIDERS.find((p) => p.id === 'glm-anthropic'),
    '建议目标是预设表里原样的一条(取它的 name/type/baseURL)');
  // 2026-09-21 r122 补两家中转站预设(dmxapi、yunwu):43 → 45。
  assert.equal(BUILTIN_PROVIDERS.length, 45, '预设表仍是 45 条(E 与 D 共用同一份)');
  // 返回值里没有"已经替你改好了"这类字段:切不切由用户点,判据只给建议
  assert.deepEqual(Object.keys(r).sort(), ['candidates', 'host', 'matched', 'preset']);
}

console.log('✅ check-preset-match 通过');

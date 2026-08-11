#!/usr/bin/env node
// R8-6 徽章分母 B 方案护栏(contextWindow.js pickCliContextWindow + App.jsx 接线)。
// 语义依据(spike-a 实测,CLI 2.1.227):result.modelUsage 按模型累积,entry 形态
// { inputTokens, outputTokens, cacheRead/CreationInputTokens, costUSD, contextWindow,
//   maxOutputTokens, canonicalModel, provider },contextWindow=CLI 自认口径(压缩执行
// 按它算)= 分母最权威来源。
// 两条红线:① 匹配策略保守(exact > 单 entry > 不取),错分母比没分母更糟;
// ② result.usage / modelUsage 的 *Tokens 是整轮累积口径,绝不进"当前占用"
//   (memory context-badge-usage-source 历史事故,分子只来自 message_start/delta)。
// 变异哨兵:删 pickCliContextWindow 的 exact 匹配分支 → 「多 entry 有 exact」断言红。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickCliContextWindow } from '../../client/src/utils/contextWindow.js';

// fixture:spike-a 真实 entry 形态
const entry = (contextWindow, extra = {}) => ({
  inputTokens: 4, outputTokens: 220, cacheReadInputTokens: 14093, cacheCreationInputTokens: 384,
  webSearchRequests: 0, costUSD: 0.0134, contextWindow, maxOutputTokens: 64000,
  canonicalModel: 'claude-sonnet-4-6', provider: 'anthropic', ...extra,
});

// ── ① exact 命中 ─────────────────────────────────────────────────────────
{
  const mu = { 'claude-sonnet-4-6': entry(200000) };
  assert.deepEqual(pickCliContextWindow(mu, 'claude-sonnet-4-6'),
    { window: 200000, matchedModel: 'claude-sonnet-4-6' }, 'exact 命中取该 entry');
}
// 多 entry(主模型 + 子代理 haiku)有 exact → 仍取 exact(变异哨兵:删 exact 分支这里红)
{
  const mu = {
    'claude-sonnet-4-6': entry(200000),
    'claude-haiku-4-5-20251001': entry(200000, { canonicalModel: 'claude-haiku-4-5' }),
  };
  assert.deepEqual(pickCliContextWindow(mu, 'claude-sonnet-4-6'),
    { window: 200000, matchedModel: 'claude-sonnet-4-6' }, '多 entry 时 exact 精确命中,不猜');
}

// ── ② exact 未命中且仅一个 entry → 用之(别名差异的常态兜底) ─────────────
{
  const mu = { 'claude-opus-5': entry(1000000) };
  assert.deepEqual(pickCliContextWindow(mu, 'opus'),
    { window: 1000000, matchedModel: 'claude-opus-5' }, '单 entry 兜底(GUI 别名≠完整 id)');
  assert.deepEqual(pickCliContextWindow(mu, null),
    { window: 1000000, matchedModel: 'claude-opus-5' }, 'modelId 缺失(reattach 没赶上 message_start)同走单 entry');
}

// ── ③ 多 entry 且无 exact → 不取(保持现状,错分母比没分母更糟) ───────────
{
  const mu = { 'claude-sonnet-4-6': entry(200000), 'claude-haiku-4-5': entry(200000) };
  assert.equal(pickCliContextWindow(mu, 'claude-opus-5'), null, '多 entry 无 exact 不猜');
  assert.equal(pickCliContextWindow(mu, null), null, '多 entry 无 modelId 也不猜');
}

// ── ④ 非法值丢弃 / 缺失静默 ─────────────────────────────────────────────
assert.equal(pickCliContextWindow(undefined, 'x'), null, 'modelUsage 缺失(老 CLI/第三方裸转发)→ null');
assert.equal(pickCliContextWindow(null, 'x'), null, 'null → null');
assert.equal(pickCliContextWindow([], 'x'), null, '数组形态 → null');
assert.equal(pickCliContextWindow({ m: entry(0) }, 'm'), null, 'contextWindow=0 丢弃');
assert.equal(pickCliContextWindow({ m: entry(-1) }, 'm'), null, '负数丢弃');
assert.equal(pickCliContextWindow({ m: entry(NaN) }, 'm'), null, 'NaN 丢弃');
assert.equal(pickCliContextWindow({ m: entry('200000') }, 'm'), null, '字符串数字丢弃(必须真 number)');
assert.equal(pickCliContextWindow({ m: entry(Infinity) }, 'm'), null, 'Infinity 丢弃');
// exact 命中但值非法 → 不落到别的 entry(保守)
assert.equal(pickCliContextWindow({ a: entry(NaN), b: entry(200000) }, 'a'), null,
  'exact 值非法时不偷取其他 entry');

// ── ⑤ 缓存覆盖方向(与 App.jsx 接线同构):cli 覆盖 provider,provider 不覆盖 cli ──
{
  const cache = new Map(); const meta = new Map();
  const writeCli = (m, w) => { cache.set(m, w); meta.set(m, { source: 'cli', at: Date.now() }); };
  const writeProvider = (m, w) => {   // 照抄 useResolvedWindow 的 fetch 回写守卫
    if (meta.get(m)?.source !== 'cli') { cache.set(m, w); meta.set(m, { source: 'provider', at: Date.now() }); }
  };
  writeProvider('claude-sonnet-4-6', 262144);     // provider 手配先到
  writeCli('claude-sonnet-4-6', 200000);          // CLI 自报覆盖它
  assert.equal(cache.get('claude-sonnet-4-6'), 200000, 'cli 覆盖 provider');
  writeProvider('claude-sonnet-4-6', 262144);     // fetch 在飞晚归
  assert.equal(cache.get('claude-sonnet-4-6'), 200000, 'provider 不得覆盖 cli(单行道)');
  assert.equal(meta.get('claude-sonnet-4-6').source, 'cli', '来源标注保持 cli');
}

// ── ⑥ 源码守卫:App.jsx 接线 + 分子红线 ─────────────────────────────────
{
  const app = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'src', 'App.jsx'), 'utf8');
  // 接线:result 分支消费 modelUsage 走纯函数,写缓存标 cli
  assert.ok(/pickCliContextWindow\(event\.modelUsage, turnModel\)/.test(app),
    'result 分支必须经 pickCliContextWindow(turnModel exact 匹配)');
  assert.ok(/source: 'cli'/.test(app), '写入必须标 source:cli');
  // fetch 回写守卫:provider 不覆盖 cli
  assert.ok(/resolvedWindowMeta\.get\(model\)\?\.source !== 'cli'/.test(app),
    'useResolvedWindow 回写前必须查 cli 标注(provider 不覆盖 cli)');
  // 红线(历史事故 context-badge-usage-source):分子仍只来自 message_start/message_delta。
  // R8-6 的 result.modelUsage 块内绝不许出现 setLiveContextUsage / *Tokens 累积字段。
  const blkStart = app.indexOf("event.type === 'result' && event.modelUsage");
  assert.ok(blkStart > -1, 'R8-6 result.modelUsage 分支存在');
  const blk = app.slice(blkStart, app.indexOf('}\n          }', blkStart));
  assert.ok(!/setLiveContextUsage/.test(blk), 'R8-6 块绝不写徽章分子(usage 累积口径红线)');
  assert.ok(!/inputTokens|cacheReadInputTokens/.test(blk), 'R8-6 块只读 contextWindow,不碰 *Tokens');
  // 分子来源不变:message_start / message_delta 的即时 usage 写入仍在
  assert.ok(/setLiveContextUsage\(\{ \.\.\.u, _ts: Date\.now\(\) \}\)/.test(app), '分子仍来自 message_start');
  assert.ok(/setLiveContextUsage\(\{ \.\.\.ev\.usage, _ts: Date\.now\(\) \}\)/.test(app), '分子仍来自 message_delta');
  // 优先级链结构不动:[1m] 显式 > resolvedWindow > measuredCtx > nativeContextWindow
  assert.ok(/resolvedWindow \|\| measuredCtx\?\.windowTokens \|\| nativeContextWindow\(currentModel\)/.test(app),
    '分母优先级链结构原样(cli 值经 resolvedWindow 缓存参战,不改链)');
}

console.log('✓ check-badge-cli-window: 匹配四策略 + 非法值 + 覆盖单行道 + 分子红线守卫 全过');

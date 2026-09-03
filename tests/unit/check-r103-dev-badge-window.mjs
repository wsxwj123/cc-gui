#!/usr/bin/env node
// r103 开发侧自测:徽章分母来源优先级(resolveBadgeWindow 纯函数)+ 三处接线源码锁。
// node tests/unit/check-r103-dev-badge-window.mjs
//
// 事故语义:CLI 对它不认识的第三方模型名 result.modelUsage[*].contextWindow 恒 200,000,
// 而 GUI 已用 CLAUDE_CODE_MAX_CONTEXT_TOKENS 把 CLI 的真实窗口/压缩线抬到手填值 →
// 旧的"cli 单行道覆盖"让徽章分母与 CLI 实际压缩行为相反。新优先级:
//   [1m] > 压缩联动下发值(linked) > provider 手填/实抓/规则表(provider) > CLI 自报(cli)。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveBadgeWindow } from '../../client/src/utils/contextWindow.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── ① 用户实报场景:第三方手填 1M + CLI 自报 200k → 分母仍 1M ──────────────
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, providerWindow: 1_000_000, model: 'k3' }),
  { window: 1_000_000, source: 'provider' }, '手填 1M 不被 CLI 自报的 200k 顶掉');
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 1_048_576, model: 'kimi-k3' }),
  { window: 1_048_576, source: 'linked' }, '压缩联动下发值优先于 CLI 自报');
// linked 与 provider 同在 → linked 赢(它才是真下发给 CLI 的那个值)
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: 300_000, providerWindow: 1_000_000, model: 'x' }),
  { window: 300_000, source: 'linked' }, 'linked > provider');

// ── ② 官方 claude:GUI 侧无来源 → 采 CLI 自报 200k(无回归) ────────────────
assert.deepEqual(
  resolveBadgeWindow({ cliWindow: 200_000, linkedWindow: null, providerWindow: null, model: 'claude-sonnet-4-6' }),
  { window: 200_000, source: 'cli' }, '官方模型仍按 CLI 自报');

// ── ③ 无任何来源 → null(调用方落实测缓存/本地兜底表) ─────────────────────
assert.deepEqual(resolveBadgeWindow({ model: 'unknown-model' }),
  { window: null, source: null }, '全空 → null');
assert.deepEqual(resolveBadgeWindow(), { window: null, source: null }, '无参数不炸');

// ── ④ [1m] 后缀最优先(与 CLI 口径一致的 1,000,000 整) ────────────────────
assert.deepEqual(resolveBadgeWindow({ cliWindow: 200_000, providerWindow: 262_144, model: 'k3[1m]' }),
  { window: 1_000_000, source: '1m' }, '[1m] 压过一切');

// ── ⑤ 非法值一律不参战(0 / 负 / NaN / 字符串) ────────────────────────────
for (const bad of [0, -1, NaN, Infinity, '1000000', null, undefined]) {
  assert.deepEqual(
    resolveBadgeWindow({ cliWindow: 200_000, providerWindow: bad, model: 'k3' }),
    { window: 200_000, source: 'cli' }, `providerWindow=${String(bad)} 非法 → 落 cli`);
}

// ── ⑥ 源码锁:R8-6 不再无条件覆盖 + 服务端下发 + 前端接线 ──────────────────
{
  const app = readFileSync(join(root, 'client', 'src', 'App.jsx'), 'utf8');
  const blkStart = app.indexOf("event.type === 'result' && event.modelUsage");
  assert.ok(blkStart > -1, 'R8-6 分支存在');
  const blk = app.slice(blkStart, blkStart + 1800);
  assert.ok(/resolveBadgeWindow\(/.test(blk), 'R8-6 必须经 resolveBadgeWindow 定优先级');
  assert.ok(/picked\.source === 'cli'/.test(blk), "R8-6 仅在 cli 胜出时写缓存(不再无条件覆盖)");
  // 红线:分子口径不动
  assert.ok(!/setLiveContextUsage/.test(blk), 'R8-6 块绝不写徽章分子');
  assert.ok(!/inputTokens|cacheReadInputTokens/.test(blk), 'R8-6 块只读 contextWindow');
  // 服务端下发的联动窗口有接线
  assert.ok(/subtype === 'context_window'/.test(app), '客户端消费服务端下发的 context_window 事件');
  assert.ok(/source: 'linked'/.test(app), '下发值写缓存标 source:linked');
  // 分母来源脚注
  assert.ok(/winSourceLabel/.test(app), '徽章弹层分母来源标签函数存在');
}
{
  const chat = readFileSync(join(root, 'server', 'routes', 'chat.js'), 'utf8');
  assert.ok(/export function resolveLinkedWindowInfo/.test(chat), '服务端导出 resolveLinkedWindowInfo');
  assert.ok(/subtype: 'context_window'/.test(chat), 'init 后随流下发 context_window');
  assert.ok(/linkedContextWindow/.test(chat), '下发字段含 linkedContextWindow');
  // /api/model-window 带 source
  assert.ok(/resolveDisplayWindowInfo/.test(chat), '/api/model-window 复用带 source 的解析');
}

console.log('✓ check-r103-dev-badge-window: 优先级四档 + 非法值 + 源码锁 全过');
